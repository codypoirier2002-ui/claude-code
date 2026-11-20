// bulb.cpp — a 7-second dive into a power-8 Mandelbulb, rendered from math alone.
//
// No textures, no meshes, no assets: every pixel comes from the distance
// estimator below. The renderer is a CPU ray marcher built on AVX-512, where a
// 16-lane SIMD packet carries 16 sub-pixel samples of one pixel, so one vector
// op advances 16 rays that are nearly identical (very little lane divergence).
//
//   * distance-estimated sphere tracing, hit threshold = a fraction of the pixel cone
//   * orbit-trap material, pixel-footprint normals, scale-relative AO
//   * cone-traced soft shadows from a low raking key light
//   * 16 stratified samples per pixel, splatted through a Gaussian filter
//   * HDR -> multi-scale bloom -> ACES filmic -> sRGB, temporal film grain
//
// Build: g++ -O3 -march=native -ffast-math -fopenmp bulb.cpp -o bulb
// Usage: ./bulb <outdir> <W> <H> <spp:1|2|4|8|16> <first> <last> [fps] [seconds]
//        ./bulb still <file.ppm> <W> <H> <spp> <u in 0..1>

#include <immintrin.h>
#include <omp.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// ============================================================ SIMD float x16
struct F {
    __m512 v;
    F() {}
    F(__m512 a) : v(a) {}
    F(float a) : v(_mm512_set1_ps(a)) {}
};
typedef __mmask16 M;
static inline F operator+(F a, F b) { return _mm512_add_ps(a.v, b.v); }
static inline F operator-(F a, F b) { return _mm512_sub_ps(a.v, b.v); }
static inline F operator*(F a, F b) { return _mm512_mul_ps(a.v, b.v); }
static inline F operator/(F a, F b) { return _mm512_div_ps(a.v, b.v); }
static inline F operator-(F a) { return _mm512_xor_ps(a.v, _mm512_set1_ps(-0.0f)); }
static inline M operator<(F a, F b) { return _mm512_cmp_ps_mask(a.v, b.v, _CMP_LT_OQ); }
static inline M operator>(F a, F b) { return _mm512_cmp_ps_mask(a.v, b.v, _CMP_GT_OQ); }
static inline M operator<=(F a, F b) { return _mm512_cmp_ps_mask(a.v, b.v, _CMP_LE_OQ); }
static inline F sel(M m, F a, F b) { return _mm512_mask_blend_ps(m, b.v, a.v); }  // m ? a : b
static inline F vmin(F a, F b) { return _mm512_min_ps(a.v, b.v); }
static inline F vmax(F a, F b) { return _mm512_max_ps(a.v, b.v); }
static inline F vabs(F a) { return _mm512_abs_ps(a.v); }
static inline F vsqrt(F a) { return _mm512_sqrt_ps(a.v); }
static inline F vfloor(F a) { return _mm512_roundscale_ps(a.v, _MM_FROUND_TO_NEG_INF | _MM_FROUND_NO_EXC); }
static inline F clampf(F x, float a, float b) { return vmin(vmax(x, F(a)), F(b)); }
static inline F sat(F x) { return clampf(x, 0.f, 1.f); }
static inline F mix(F a, F b, F t) { return a + (b - a) * t; }
static inline F vrsqrt(F x) {  // rsqrt14 + one Newton step ~ full float precision
    F y = _mm512_rsqrt14_ps(x.v);
    return y * (F(1.5f) - F(0.5f) * x * y * y);
}
static inline F vlog2(F x) {
    F e = _mm512_getexp_ps(x.v);
    F m = _mm512_getmant_ps(x.v, _MM_MANT_NORM_1_2, _MM_MANT_SIGN_zero);
    F z = (m - 1.f) / (m + 1.f), z2 = z * z;
    F p = 1.f / 13.f;
    p = p * z2 + 1.f / 11.f; p = p * z2 + 1.f / 9.f; p = p * z2 + 1.f / 7.f;
    p = p * z2 + 1.f / 5.f;  p = p * z2 + 1.f / 3.f; p = p * z2 + 1.f;
    return e + (2.f * 1.4426950409f) * z * p;
}
static inline F vexp2(F x) {
    x = clampf(x, -126.f, 126.f);
    F i = vfloor(x);
    F g = (x - i - 0.5f) * 0.69314718f;
    F p = 1.f / 5040.f;
    p = p * g + 1.f / 720.f; p = p * g + 1.f / 120.f; p = p * g + 1.f / 24.f;
    p = p * g + 1.f / 6.f;   p = p * g + 0.5f;        p = p * g + 1.f; p = p * g + 1.f;
    return _mm512_scalef_ps((p * 1.41421356f).v, i.v);
}
static inline F vpow(F x, F y) { return vexp2(y * vlog2(vmax(x, F(1e-30f)))); }
static inline F vexp(F x) { return vexp2(x * 1.4426950409f); }
static inline F vsmooth(F x) { x = sat(x); return x * x * (3.f - 2.f * x); }
static inline F vss(float a, float b, F x) { return vsmooth((x - a) * (1.f / (b - a))); }

// ============================================================ vec3 (scalar + packet)
struct v3 { float x, y, z; };
static inline v3 operator+(v3 a, v3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
static inline v3 operator-(v3 a, v3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
static inline v3 operator*(v3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
static inline float dot(v3 a, v3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static inline v3 cross(v3 a, v3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
static inline float len(v3 a) { return std::sqrt(dot(a, a)); }
static inline v3 norm(v3 a) { return a * (1.f / len(a)); }
static inline v3 lerp3(v3 a, v3 b, float t) { return a + (b - a) * t; }

struct V3 {
    F x, y, z;
    V3() {}
    V3(F a, F b, F c) : x(a), y(b), z(c) {}
    V3(v3 a) : x(a.x), y(a.y), z(a.z) {}
};
static inline V3 operator+(const V3& a, const V3& b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
static inline V3 operator-(const V3& a, const V3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
static inline V3 operator*(const V3& a, F s) { return {a.x * s, a.y * s, a.z * s}; }
static inline F dot(const V3& a, const V3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static inline V3 normalize(const V3& a) { F r = vrsqrt(dot(a, a)); return a * r; }
static inline V3 mix(const V3& a, const V3& b, F t) { return {mix(a.x, b.x, t), mix(a.y, b.y, t), mix(a.z, b.z, t)}; }
static inline V3 sel(M m, const V3& a, const V3& b) { return {sel(m, a.x, b.x), sel(m, a.y, b.y), sel(m, a.z, b.z)}; }
static inline V3 vmul(const V3& a, const V3& b) { return {a.x * b.x, a.y * b.y, a.z * b.z}; }

// ============================================================ the fractal
static int gIter = 12;
static const float kBound = 1.25f;  // bounding sphere radius

// Power-8 Mandelbulb, trig-free form of z -> z^8 + c (y is the polar axis).
// Returns the distance estimate 0.25*log(m)*sqrt(m)/dz; optional orbit trap.
template <bool TRAP>
static inline F mandel(const V3& p, F* trap) {
    F wx = p.x, wy = p.y, wz = p.z;
    F m = wx * wx + wy * wy + wz * wz;
    F dz = 1.f;
    F tx, ty, tz, tw;
    if (TRAP) { tx = 1e10f; ty = 1e10f; tz = 1e10f; tw = 1e10f; }
    M alive = (M)0xFFFF;
    for (int i = 0; i < gIter; i++) {
        F sm = vsqrt(m);
        F ndz = 8.f * m * m * m * sm * dz + 1.f;
        F x = wx, x2 = x * x, x4 = x2 * x2;
        F y = wy, y2 = y * y, y4 = y2 * y2;
        F z = wz, z2 = z * z, z4 = z2 * z2;
        F k3 = vmax(x2 + z2, F(1e-8f));
        F r = vrsqrt(k3), r2 = r * r;
        F k2 = r2 * r2 * r2 * r;  // k3^-3.5
        F k1 = x4 + y4 + z4 - 6.f * y2 * z2 - 6.f * x2 * y2 + 2.f * z2 * x2;
        F k4 = x2 - y2 + z2;
        F k12 = k1 * k2;
        F nx = p.x + 64.f * x * y * z * (x2 - z2) * k4 * (x4 - 6.f * x2 * z2 + z4) * k12;
        F ny = p.y - 16.f * y2 * k3 * k4 * k4 + k1 * k1;
        F nz = p.z - 8.f * y * k4 * (x4 * x4 - 28.f * x4 * x2 * z2 + 70.f * x4 * z4 - 28.f * x2 * z2 * z4 + z4 * z4) * k12;
        F nm = nx * nx + ny * ny + nz * nz;
        wx = sel(alive, nx, wx); wy = sel(alive, ny, wy); wz = sel(alive, nz, wz);
        dz = sel(alive, ndz, dz); m = sel(alive, nm, m);
        if (TRAP) {
            tx = sel(alive, vmin(tx, vabs(nx)), tx);
            ty = sel(alive, vmin(ty, vabs(ny)), ty);
            tz = sel(alive, vmin(tz, vabs(nz)), tz);
            tw = sel(alive, vmin(tw, nm), tw);
        }
        alive &= (m <= F(256.f));
        if (!alive) break;
    }
    if (TRAP) { trap[0] = tx; trap[1] = ty; trap[2] = tz; trap[3] = tw; }
    return 0.25f * vlog2(m) * 0.69314718f * vsqrt(m) / dz;
}
static inline F de(const V3& p) { return mandel<false>(p, nullptr); }
static float deScalar(v3 p) { F d = de(V3(p)); alignas(64) float o[16]; _mm512_store_ps(o, d.v); return o[0]; }
static v3 normalScalar(v3 p, float h) {
    float a = deScalar(p + v3{h, -h, -h}), b = deScalar(p + v3{-h, -h, h});
    float c = deScalar(p + v3{-h, h, -h}), d = deScalar(p + v3{h, h, h});
    return norm(v3{a - b - c + d, -a - b + c + d, -a + b - c + d});
}

// ============================================================ scene + camera
struct Cam {
    v3 pos, fwd, right, up;
    float tanHalf;
    float scale;  // distance camera -> subject; sets fog/AO scale
};

struct Scene {
    v3 L;           // key light direction (towards light)
    v3 cam0;        // opening camera position (looks at the origin)
    v3 target;      // point on the surface we dive into
    v3 tn;          // surface normal there
    float s0, s1;   // start / end camera distance to target
    v3 dir0, dir1;  // start / end direction target -> camera
    float fov0, fov1, upK, orbit;
};
static Scene gScene;

static float smootherstep(float x) { x = std::min(1.f, std::max(0.f, x)); return x * x * x * (x * (x * 6 - 15) + 10); }
static v3 sph(float azDeg, float elDeg) {
    float a = azDeg * 0.0174532925f, e = elDeg * 0.0174532925f;
    return {std::cos(e) * std::sin(a), std::sin(e), std::cos(e) * std::cos(a)};
}
static v3 slerp(v3 a, v3 b, float t) {
    float c = std::min(1.f, std::max(-1.f, dot(a, b)));
    float th = std::acos(c);
    if (th < 1e-4f) return norm(lerp3(a, b, t));
    float s = std::sin(th);
    return a * (std::sin((1 - t) * th) / s) + b * (std::sin(t * th) / s);
}
static v3 rotAxis(v3 v, v3 k, float a) {
    return v * std::cos(a) + cross(k, v) * std::sin(a) + k * (dot(k, v) * (1 - std::cos(a)));
}
static float envf(const char* k, float d) { const char* v = std::getenv(k); return v ? (float)std::atof(v) : d; }

static void basis(v3 pos, v3 look, v3 upHint, v3& f, v3& r, v3& u) {
    f = norm(look - pos);
    r = norm(cross(f, upHint));
    u = cross(r, f);
}

static void setupScene() {
    Scene& S = gScene;
    int savedIter = gIter;
    gIter = 14;  // locate the target with a converged DE, independent of render settings
    S.fov0 = envf("FOV0", 34.f);
    S.fov1 = envf("FOV1", 50.f);
    S.cam0 = sph(envf("AZ0", 20.f), envf("EL0", 24.f)) * envf("R0", 3.6f);
    S.L = sph(envf("LAZ", -40.f), envf("LEL", 32.f));
    // pick the dive target through a screen position of the opening shot
    v3 f, r, u;
    basis(S.cam0, v3{0, 0, 0}, v3{0, 1, 0}, f, r, u);
    float th0 = std::tan(0.5f * S.fov0 * 0.0174532925f);
    v3 rd = norm(f + r * (envf("SX", 0.0f) * th0) + u * (envf("SY", 0.0f) * th0));
    float t = 0;
    for (int i = 0; i < 20000; i++) {
        float h = deScalar(S.cam0 + rd * t);
        if (h < 2e-7f || t > 10.f) break;
        t += h * 0.5f;
    }
    S.target = S.cam0 + rd * t;
    S.tn = normalScalar(S.target, 1e-5f);
    S.s0 = len(S.cam0 - S.target);
    S.s1 = envf("S1", 0.004f);
    S.dir0 = norm(S.cam0 - S.target);
    // end direction: tilt the incoming view toward the surface normal, then swing around it
    v3 d1 = slerp(S.dir0, S.tn, envf("TILT", 0.35f));
    S.dir1 = norm(rotAxis(d1, S.tn, envf("SWING", 0.f) * 0.0174532925f));
    S.upK = envf("UPK", 0.4f);
    S.orbit = envf("ORB", 0.f) * 0.0174532925f;
    gIter = savedIter;
}

static Cam cameraAt(float u, int W, int H) {
    const Scene& S = gScene;
    // ease: gentle start, steady dive, soft landing
    float e = 0.3f * u + 0.7f * smootherstep(u);
    float s = S.s0 * std::pow(S.s1 / S.s0, e);
    float ed = smootherstep(u);
    v3 dir = slerp(S.dir0, S.dir1, ed);
    dir = rotAxis(dir, S.tn, S.orbit * std::sin(3.14159265f * ed * 0.5f));
    Cam c;
    c.pos = S.target + dir * s;
    // aim: from the bulb's centre at the start to the target as we dive
    float w = std::pow(s / S.s0, 1.6f);
    v3 look = lerp3(S.target, v3{0, 0, 0}, w);
    v3 up = norm(lerp3(v3{0, 1, 0}, S.tn, S.upK * ed));
    basis(c.pos, look, up, c.fwd, c.right, c.up);
    float fov = S.fov0 + (S.fov1 - S.fov0) * ed;
    c.tanHalf = std::tan(0.5f * fov * 0.0174532925f);
    c.scale = s;
    (void)W; (void)H;
    return c;
}

// ============================================================ lighting
static const v3 kSun = {3.3f, 2.55f, 1.85f};
static const v3 kSky = {0.17f, 0.24f, 0.44f};
static const v3 kFill = {0.14f, 0.20f, 0.44f};
static const v3 kBack = {0.12f, 0.09f, 0.07f};
static const v3 kRim = {0.35f, 0.50f, 0.85f};

static inline V3 background(const V3& rd, const V3& L) {
    F up = sat(rd.y * 0.5f + 0.5f);
    V3 lo(v3{0.010f, 0.011f, 0.016f}), hi(v3{0.004f, 0.006f, 0.014f});
    V3 c = mix(lo, hi, up);
    F sd = vmax(dot(rd, L), F(0.f));
    F g = 0.035f * vpow(sd, F(5.f)) + 0.08f * vpow(sd, F(48.f));
    c = c + V3(v3{1.0f, 0.62f, 0.34f}) * g;
    return c;
}

struct Quality {
    int maxSteps = 300;
    float stepK = 0.85f;
    float epsPx = 0.35f;   // hit threshold, fraction of the pixel cone
    float nrmPx = 0.9f;    // normal epsilon, fraction of the pixel cone
    int shSteps = 96;
    float shK = 9.f;       // penumbra sharpness
};
static Quality gQ;
static float gRefineThr = 0.035f;
static double gLastRefineFrac = 0;
static void initQuality() {
    if (const char* v = std::getenv("ITER")) gIter = std::atoi(v);
    if (const char* v = std::getenv("REFINE")) gRefineThr = (float)std::atof(v);
    if (const char* v = std::getenv("SHSTEPS")) gQ.shSteps = std::atoi(v);
    if (const char* v = std::getenv("MAXSTEPS")) gQ.maxSteps = std::atoi(v);
    if (const char* v = std::getenv("STEPK")) gQ.stepK = (float)std::atof(v);
    if (const char* v = std::getenv("EPSPX")) gQ.epsPx = (float)std::atof(v);
}
static bool gDebug = std::getenv("DBG") != nullptr;
static bool gAgx = std::getenv("ACES") == nullptr;
static float gPunch = std::getenv("PUNCH") ? (float)std::atof(std::getenv("PUNCH")) : 2.5f;

static void shadePacket(const Cam& cam, float pixAngle, const V3& rd, V3& out) {
    const v3 Ls = gScene.L;
    V3 L(Ls);
    V3 ro(cam.pos);
    // bounding sphere
    F b = dot(ro, rd);
    float c = dot(cam.pos, cam.pos) - kBound * kBound;
    F disc = b * b - c;
    F sq = vsqrt(vmax(disc, F(0.f)));
    F t0 = vmax(-b - sq, F(0.f)), t1 = -b + sq;
    M active = (disc > F(0.f)) & (t1 > F(0.f));
    V3 bg = background(rd, L);
    if (!active) { out = bg; return; }

    const float epsK = gQ.epsPx * pixAngle;
    F t = t0;
    M hit = 0;
    for (int i = 0; i < gQ.maxSteps && active; i++) {
        F d = de(ro + rd * t);
        M h = active & (d < F(epsK) * t);
        hit |= h;
        active &= ~h;
        t = sel(active, t + d * gQ.stepK, t);
        active &= (t < t1);
    }
    hit |= active;  // out of steps: we are grazing the surface
    if (!hit) { out = bg; return; }

    V3 p = ro + rd * t;
    F eps = F(epsK) * t;
    // pixel-footprint tetrahedral normal (pre-filters sub-pixel detail)
    F hN = F(gQ.nrmPx * pixAngle) * t;
    F d0 = de(p + V3(hN, -hN, -hN)), d1 = de(p + V3(-hN, -hN, hN));
    F d2 = de(p + V3(-hN, hN, -hN)), d3 = de(p + V3(hN, hN, hN));
    V3 n = normalize(V3(d0 - d1 - d2 + d3, -d0 - d1 + d2 + d3, -d0 + d1 - d2 + d3));
    F tr[4];
    mandel<true>(p, tr);

    // ambient occlusion, radius proportional to depth => same look at every zoom level
    F aoR = 0.05f * t;
    F occ = 0.f, sca = 1.f;
    for (int i = 0; i < 6; i++) {
        F hh = aoR * (0.05f + 0.95f * (float)i / 5.f);
        F dd = de(p + n * hh);
        occ = occ + (hh - vmax(dd, F(0.f))) * sca;
        sca = sca * 0.82f;
    }
    F ao = sat(1.f - 1.25f * occ / aoR);
    ao = ao * ao;

    // cone-traced soft shadow toward the key light
    F nl = dot(n, L);
    F sha = 1.f;
    M lit = hit & (nl > F(0.f));
    if (lit) {
        V3 so = p + n * (eps * 2.f);
        F bs = dot(so, L);
        F cs = dot(so, so) - kBound * kBound;
        F te = -bs + vsqrt(vmax(bs * bs - cs, F(0.f)));
        F st = eps * 3.f;
        F res = 1.f;
        M act = lit;
        for (int i = 0; i < gQ.shSteps && act; i++) {
            F h = de(so + L * st);
            res = sel(act, vmin(res, F(gQ.shK) * h / st), res);
            st = sel(act, st + vmax(h * 0.9f, eps), st);
            act &= (res > F(0.003f)) & (st < te);
        }
        sha = vsmooth(res);
    }

    // orbit-trap material: lapis in the recesses, verdigris on the slopes, gold on the crests
    F tw = tr[3], ty = tr[1], tz = tr[2], tx = tr[0];
    if (gDebug) { out = V3(sel(hit, tw * 0.5f, F(0.f)), sel(hit, ty, F(0.f)), sel(hit, tz * 0.5f, F(0.f))); return; }
    F cGold = vss(0.62f, 1.02f, tw);
    F cVerd = vss(0.03f, 0.22f, ty);
    F cLap = 1.f - vss(0.08f, 0.70f, tz);
    F cBone = vss(1.0f, 1.25f, tw) * (1.f - vss(0.0f, 0.35f, tx));
    V3 alb(v3{0.030f, 0.040f, 0.090f});
    alb = mix(alb, V3(v3{0.035f, 0.200f, 0.175f}), cVerd);
    alb = mix(alb, V3(v3{0.020f, 0.050f, 0.230f}), cLap * (1.f - cGold) * 0.8f);
    alb = mix(alb, V3(v3{0.560f, 0.300f, 0.085f}), cGold);
    alb = mix(alb, V3(v3{0.780f, 0.700f, 0.560f}), cBone * 0.6f);
    F trapOcc = sat(0.15f + 0.95f * vss(0.2f, 0.9f, tw));
    F occT = ao * trapOcc;

    V3 hv = normalize(L - rd);
    F nh = sat(dot(n, hv)), lh = sat(dot(L, hv));
    F om = 1.f - lh, om2 = om * om;
    F fres = 0.04f + 0.96f * om2 * om2 * om;
    F gold = cGold;
    F shin = mix(F(20.f), F(90.f), gold);
    F spe = vpow(nh, shin) * ((shin + 8.f) * (1.f / 25.13f)) * fres * sat(nl) * sha;
    F skyT = sat(0.55f + 0.45f * n.y);
    V3 bdir(v3{-Ls.x, 0.f, -Ls.z});
    bdir = normalize(bdir);
    F bac = sat(dot(n, bdir) * 0.5f + 0.5f);
    F fr = 1.f + dot(n, rd);
    F rim = sat(fr) * sat(fr) * sat(fr);

    // cool fill from the side opposite the key, wrapped, unshadowed (occlusion only)
    V3 fdir = normalize(V3(v3{-Ls.x, 0.25f, -Ls.z}));
    F fil = sat(dot(n, fdir) * 0.6f + 0.4f);
    V3 lin = V3(kSun) * (sat(nl) * sha) + V3(kSky) * (skyT * occT) + V3(kBack) * (bac * occT) +
             V3(kFill) * (fil * occT) + V3(kRim) * (rim * occT * 0.6f);
    V3 col = vmul(alb, lin);
    V3 specTint = mix(V3(v3{0.9f, 0.95f, 1.0f}), V3(v3{1.0f, 0.78f, 0.45f}), gold);
    col = col + vmul(specTint, V3(kSun)) * (spe * mix(F(0.35f), F(1.1f), gold));
    // glow from deep recesses (warm, like light trapped in the folds)
    F deep = (1.f - vss(0.1f, 0.5f, tw)) * occT;
    col = col + V3(v3{0.20f, 0.06f, 0.015f}) * (deep * 0.04f);

    // scale-relative atmospheric perspective
    F fog = 1.f - vexp(-0.07f * (t / cam.scale));
    col = mix(col, bg, fog);
    out = sel(hit, col, bg);
}

// ============================================================ framebuffer + post
struct Image {
    int w, h;
    std::vector<float> p;  // rgb
    Image(int W = 0, int H = 0) : w(W), h(H), p((size_t)W * H * 3, 0.f) {}
    float* at(int x, int y) { return &p[((size_t)y * w + x) * 3]; }
};

static inline uint32_t hash32(uint32_t x) {
    x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16;
    return x;
}
static inline float rnd01(uint32_t& s) { s = hash32(s + 0x9e3779b9U); return (s >> 8) * (1.0f / 16777216.0f); }

static const float kFiltR = 1.25f, kFiltSigma = 0.42f;

// One SIMD packet = 16 samples at continuous pixel positions (fx, fy). Shades them and
// splats each into the accumulation buffer A (rgb + weight) through a Gaussian filter.
// Returns each lane's perceptual luminance in lum[] for adaptive refinement.
static void tracePacket(const Cam& cam, int W, int H, float pixAngle, const float* fx, const float* fy, float* A, float* lum) {
    alignas(64) float dx[16], dy[16], dz[16], cr[16], cg[16], cb[16];
    for (int k = 0; k < 16; k++) {
        float u = (fx[k] - W * 0.5f) / (H * 0.5f) * cam.tanHalf;
        float v = -(fy[k] - H * 0.5f) / (H * 0.5f) * cam.tanHalf;
        v3 d = norm(cam.fwd + cam.right * u + cam.up * v);
        dx[k] = d.x; dy[k] = d.y; dz[k] = d.z;
    }
    V3 rd(_mm512_load_ps(dx), _mm512_load_ps(dy), _mm512_load_ps(dz));
    V3 col;
    shadePacket(cam, pixAngle, rd, col);
    _mm512_store_ps(cr, col.x.v); _mm512_store_ps(cg, col.y.v); _mm512_store_ps(cb, col.z.v);
    const float i2s = 1.f / (2 * kFiltSigma * kFiltSigma);
    const float g0 = std::exp(-kFiltR * kFiltR * i2s);
    for (int k = 0; k < 16; k++) {
        float r = cr[k], g = cg[k], b = cb[k];
        float l = 0.2126f * r + 0.7152f * g + 0.0722f * b;
        if (!(l == l)) { r = g = b = 0; l = 0; }
        const float cap = 12.f;
        if (l > cap) { float s = cap / l; r *= s; g *= s; b *= s; l = cap; }
        lum[k] = std::sqrt(l / (1.f + l));
        int x0 = std::max(0, (int)std::floor(fx[k] - kFiltR - 0.5f) + 1), x1 = std::min(W - 1, (int)std::floor(fx[k] + kFiltR - 0.5f));
        int y0 = std::max(0, (int)std::floor(fy[k] - kFiltR - 0.5f) + 1), y1 = std::min(H - 1, (int)std::floor(fy[k] + kFiltR - 0.5f));
        float wxs[4] = {0, 0, 0, 0}, wys[4] = {0, 0, 0, 0};
        for (int x = x0; x <= x1 && x - x0 < 4; x++) { float d = x + 0.5f - fx[k]; wxs[x - x0] = std::max(0.f, std::exp(-d * d * i2s) - g0); }
        for (int y = y0; y <= y1 && y - y0 < 4; y++) { float d = y + 0.5f - fy[k]; wys[y - y0] = std::max(0.f, std::exp(-d * d * i2s) - g0); }
        for (int y = y0; y <= y1 && y - y0 < 4; y++)
            for (int x = x0; x <= x1 && x - x0 < 4; x++) {
                float w = wxs[x - x0] * wys[y - y0];
                float* q = A + ((size_t)y * W + x) * 4;
                q[0] += r * w; q[1] += g * w; q[2] += b * w; q[3] += w;
            }
    }
}


// spp 1..16 = fixed sampling; spp 0 = adaptive (4 spp everywhere, +16 where needed)
static void renderHDR(const Cam& cam, int W, int H, int spp, uint32_t seed, Image& img) {
    bool adaptive = spp == 0;
    if (adaptive) spp = 4;
    int bw, bh, gx, gy;
    switch (spp) {
        case 16: bw = 1; bh = 1; gx = 4; gy = 4; break;
        case 8:  bw = 2; bh = 1; gx = 4; gy = 2; break;
        case 4:  bw = 2; bh = 2; gx = 2; gy = 2; break;
        case 2:  bw = 4; bh = 2; gx = 2; gy = 1; break;
        default: bw = 4; bh = 4; gx = 1; gy = 1; spp = 1; break;
    }
    const float pixAngle = 2.f * cam.tanHalf / H;
    int nt = omp_get_max_threads();
    std::vector<std::vector<float>> acc(nt, std::vector<float>((size_t)W * H * 4, 0.f));
    std::vector<float> lmin, lmax;
    if (adaptive) { lmin.assign((size_t)W * H, 1e9f); lmax.assign((size_t)W * H, -1e9f); }
    int nby = (H + bh - 1) / bh, nbx = (W + bw - 1) / bw;
#pragma omp parallel for schedule(dynamic, 1)
    for (int by = 0; by < nby; by++) {
        float* A = acc[omp_get_thread_num()].data();
        alignas(64) float fx[16], fy[16], lum[16];
        int pxs[16], pys[16];
        for (int bx = 0; bx < nbx; bx++) {
            for (int k = 0; k < 16; k++) {
                int pi = k / spp, si = k % spp;
                int px = bx * bw + pi % bw, py = by * bh + pi / bw;
                uint32_t s = hash32((uint32_t)px * 1973u + (uint32_t)py * 9277u + seed * 26699u + (uint32_t)si * 101u);
                float jx = ((si % gx) + rnd01(s)) / gx, jy = ((si / gx) + rnd01(s)) / gy;
                fx[k] = px + jx; fy[k] = py + jy; pxs[k] = px; pys[k] = py;
            }
            tracePacket(cam, W, H, pixAngle, fx, fy, A, lum);
            if (adaptive)
                for (int k = 0; k < 16; k++) {
                    if (pxs[k] >= W || pys[k] >= H) continue;
                    size_t i = (size_t)pys[k] * W + pxs[k];
                    lmin[i] = std::min(lmin[i], lum[k]); lmax[i] = std::max(lmax[i], lum[k]);
                }
        }
    }
    if (adaptive) {
        // refine pixels whose samples disagree, plus their 8 neighbours
        std::vector<uint8_t> need((size_t)W * H, 0);
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) {
                size_t i = (size_t)y * W + x;
                if (lmax[i] - lmin[i] > gRefineThr)
                    for (int j = -1; j <= 1; j++)
                        for (int k = -1; k <= 1; k++) {
                            int xx = x + k, yy = y + j;
                            if (xx >= 0 && yy >= 0 && xx < W && yy < H) need[(size_t)yy * W + xx] = 1;
                        }
            }
        std::vector<int> list;
        for (size_t i = 0; i < need.size(); i++) if (need[i]) list.push_back((int)i);
        gLastRefineFrac = (double)list.size() / ((double)W * H);
#pragma omp parallel for schedule(dynamic, 64)
        for (size_t n = 0; n < list.size(); n++) {
            float* A = acc[omp_get_thread_num()].data();
            alignas(64) float fx[16], fy[16], lum[16];
            int px = list[n] % W, py = list[n] / W;
            for (int k = 0; k < 16; k++) {
                uint32_t s = hash32((uint32_t)px * 7411u + (uint32_t)py * 3571u + seed * 40503u + (uint32_t)k * 977u + 0x5bd1e995u);
                fx[k] = px + ((k % 4) + rnd01(s)) * 0.25f;
                fy[k] = py + ((k / 4) + rnd01(s)) * 0.25f;
            }
            tracePacket(cam, W, H, pixAngle, fx, fy, A, lum);
        }
    }
    img = Image(W, H);
#pragma omp parallel for
    for (int i = 0; i < W * H; i++) {
        float s[4] = {0, 0, 0, 0};
        for (int t = 0; t < nt; t++) for (int c = 0; c < 4; c++) s[c] += acc[t][(size_t)i * 4 + c];
        float iw = s[3] > 0 ? 1.f / s[3] : 0.f;
        img.p[(size_t)i * 3 + 0] = s[0] * iw; img.p[(size_t)i * 3 + 1] = s[1] * iw; img.p[(size_t)i * 3 + 2] = s[2] * iw;
    }
}

static Image downsample(const Image& s) {  // 2x down, 4x4 tent
    Image d(std::max(1, s.w / 2), std::max(1, s.h / 2));
    const float k[4] = {1, 3, 3, 1};
#pragma omp parallel for
    for (int y = 0; y < d.h; y++)
        for (int x = 0; x < d.w; x++) {
            float acc[3] = {0, 0, 0}, ws = 0;
            for (int j = 0; j < 4; j++)
                for (int i = 0; i < 4; i++) {
                    int sx = std::min(s.w - 1, std::max(0, 2 * x - 1 + i)), sy = std::min(s.h - 1, std::max(0, 2 * y - 1 + j));
                    float w = k[i] * k[j];
                    const float* q = &s.p[((size_t)sy * s.w + sx) * 3];
                    acc[0] += q[0] * w; acc[1] += q[1] * w; acc[2] += q[2] * w; ws += w;
                }
            float* o = d.at(x, y);
            o[0] = acc[0] / ws; o[1] = acc[1] / ws; o[2] = acc[2] / ws;
        }
    return d;
}
static void sampleBilinear(const Image& s, float x, float y, float* o) {
    x = std::min((float)s.w - 1.001f, std::max(0.f, x)); y = std::min((float)s.h - 1.001f, std::max(0.f, y));
    int x0 = (int)x, y0 = (int)y; float fx = x - x0, fy = y - y0;
    int x1 = std::min(s.w - 1, x0 + 1), y1 = std::min(s.h - 1, y0 + 1);
    for (int c = 0; c < 3; c++) {
        float a = s.p[((size_t)y0 * s.w + x0) * 3 + c], b = s.p[((size_t)y0 * s.w + x1) * 3 + c];
        float cc = s.p[((size_t)y1 * s.w + x0) * 3 + c], d = s.p[((size_t)y1 * s.w + x1) * 3 + c];
        o[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
    }
}
static Image upsampleAdd(const Image& small, const Image& big) {  // tent upsample + add
    Image o(big.w, big.h);
    float sx = (float)small.w / big.w, sy = (float)small.h / big.h;
#pragma omp parallel for
    for (int y = 0; y < big.h; y++)
        for (int x = 0; x < big.w; x++) {
            float acc[3] = {0, 0, 0};
            const float off[3] = {-1, 0, 1}, wk[3] = {1, 2, 1};
            for (int j = 0; j < 3; j++)
                for (int i = 0; i < 3; i++) {
                    float q[3];
                    sampleBilinear(small, (x + 0.5f + off[i]) * sx - 0.5f, (y + 0.5f + off[j]) * sy - 0.5f, q);
                    float w = wk[i] * wk[j] / 16.f;
                    acc[0] += q[0] * w; acc[1] += q[1] * w; acc[2] += q[2] * w;
                }
            const float* b = &big.p[((size_t)y * big.w + x) * 3];
            float* d = o.at(x, y);
            d[0] = acc[0] + b[0]; d[1] = acc[1] + b[1]; d[2] = acc[2] + b[2];
        }
    return o;
}

static inline float aces(float x) {  // Narkowicz fit, applied per channel after a mild gamut tweak
    const float a = 2.51f, b = 0.03f, c = 2.43f, d = 0.59f, e = 0.14f;
    return std::min(1.f, std::max(0.f, (x * (a * x + b)) / (x * (c * x + d) + e)));
}
// AgX (Sobotka), polynomial fit after Wrensch; output is display-encoded
static inline void agx(float* c, float punch) {
    float r = c[0], g = c[1], b = c[2];
    float ir = 0.842479062253094f * r + 0.0784335999999992f * g + 0.0792237451477643f * b;
    float ig = 0.0423282422610123f * r + 0.878468636469772f * g + 0.0791661274605434f * b;
    float ib = 0.0423756549057051f * r + 0.0784336f * g + 0.879142973793104f * b;
    const float mn = -12.47393f, mx = 4.026069f;
    float v[3] = {ir, ig, ib};
    for (int i = 0; i < 3; i++) {
        float x = std::log2(std::max(v[i], 1e-10f));
        x = (std::min(mx, std::max(mn, x)) - mn) / (mx - mn);
        float x2 = x * x, x4 = x2 * x2;
        v[i] = 15.5f * x4 * x2 - 40.14f * x4 * x + 31.96f * x4 - 6.868f * x2 * x + 0.4298f * x2 + 0.1191f * x - 0.00232f;
    }
    // look: a little extra contrast and saturation
    float l = 0.2126f * v[0] + 0.7152f * v[1] + 0.0722f * v[2];
    for (int i = 0; i < 3; i++) {
        float p = std::pow(std::max(v[i], 0.f), 1.f + 0.12f * punch);
        v[i] = p;
    }
    l = 0.2126f * v[0] + 0.7152f * v[1] + 0.0722f * v[2];
    for (int i = 0; i < 3; i++) v[i] = l + (v[i] - l) * (1.f + 0.18f * punch);
    c[0] = 1.19687900512017f * v[0] - 0.0980208811401368f * v[1] - 0.0990297440797205f * v[2];
    c[1] = -0.0528968517574562f * v[0] + 1.15190312990417f * v[1] - 0.0989611768448433f * v[2];
    c[2] = -0.0529716355144438f * v[0] - 0.0980434501171241f * v[1] + 1.15107367264116f * v[2];
}
static inline float srgb(float x) { return x <= 0.0031308f ? 12.92f * x : 1.055f * std::pow(x, 1.f / 2.4f) - 0.055f; }

static void post(const Image& hdr, uint32_t seed, float fade, std::vector<uint16_t>& out) {
    // multi-scale bloom pyramid
    std::vector<Image> pyr;
    pyr.push_back(downsample(hdr));
    while ((int)pyr.size() < 7 && pyr.back().w > 8) pyr.push_back(downsample(pyr.back()));
    Image acc = pyr.back();
    for (int i = (int)pyr.size() - 2; i >= 0; i--) acc = upsampleAdd(acc, pyr[i]);
    float nl = (float)pyr.size();
    Image bloom(hdr.w, hdr.h);
    {
        Image zero(hdr.w, hdr.h);
        bloom = upsampleAdd(acc, zero);
    }
    const int W = hdr.w, H = hdr.h;
    out.assign((size_t)W * H * 3, 0);
    const float exposure = envf("EXPO", 1.6f), bloomK = 0.05f;
#pragma omp parallel for
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) {
            const float* h = &hdr.p[((size_t)y * W + x) * 3];
            const float* bl = &bloom.p[((size_t)y * W + x) * 3];
            float u = (x + 0.5f) / W - 0.5f, v = (y + 0.5f) / H - 0.5f;
            float r2 = (u * u * (16.f / 9.f) + v * v) * 1.8f;
            float vig = 1.f / (1.f + r2 * r2 * 0.9f + r2 * 0.25f);
            uint32_t s = hash32((uint32_t)(x * 7919 + y * 104729) ^ (seed * 2654435761U));
            float n1 = rnd01(s), n2 = rnd01(s);
            float gauss = std::sqrt(-2.f * std::log(std::max(1e-7f, n1))) * std::cos(6.2831853f * n2);
            float lum = 0.f;
            float c3[3];
            for (int c = 0; c < 3; c++) {
                float lin = (h[c] * (1.f - bloomK) + bl[c] / nl * bloomK) * exposure * vig * fade;
                c3[c] = lin;
            }
            // subtle filmic split-tone: cool shadows, warm highlights
            lum = 0.2126f * c3[0] + 0.7152f * c3[1] + 0.0722f * c3[2];
            float shadowW = 1.f / (1.f + lum * 40.f);
            c3[0] *= 1.f - 0.06f * shadowW; c3[2] *= 1.f + 0.10f * shadowW;
            float disp[3];
            if (gAgx) { disp[0] = c3[0]; disp[1] = c3[1]; disp[2] = c3[2]; agx(disp, gPunch); }
            else for (int c = 0; c < 3; c++) disp[c] = srgb(aces(c3[c]));
            for (int c = 0; c < 3; c++) {
                float d = std::min(1.f, std::max(0.f, disp[c]));
                float g = gauss * 0.0075f * (0.35f + 0.65f * std::sqrt(std::max(0.f, d * (1.f - d)) * 2.f));
                d = std::min(1.f, std::max(0.f, d + g));
                out[((size_t)y * W + x) * 3 + c] = (uint16_t)std::lround(d * 65535.f);
            }
        }
    }
}

static bool writePPM16(const std::string& path, int W, int H, const std::vector<uint16_t>& px) {
    std::string tmp = path + ".tmp";
    FILE* f = std::fopen(tmp.c_str(), "wb");
    if (!f) return false;
    std::fprintf(f, "P6\n%d %d\n65535\n", W, H);
    std::vector<uint8_t> row((size_t)W * 6);
    for (int y = 0; y < H; y++) {
        for (int i = 0; i < W * 3; i++) { uint16_t v = px[(size_t)y * W * 3 + i]; row[i * 2] = v >> 8; row[i * 2 + 1] = v & 255; }
        std::fwrite(row.data(), 1, row.size(), f);
    }
    std::fclose(f);
    return std::rename(tmp.c_str(), path.c_str()) == 0;
}

static bool exists(const std::string& p) { FILE* f = std::fopen(p.c_str(), "rb"); if (f) { std::fclose(f); return true; } return false; }

static void renderOne(float u, int W, int H, int spp, uint32_t seed, float fade, const std::string& path) {
    auto t0 = std::chrono::steady_clock::now();
    Cam cam = cameraAt(u, W, H);
    Image hdr;
    renderHDR(cam, W, H, spp, seed, hdr);
    std::vector<uint16_t> px;
    if (std::getenv("NOPOST")) {
        px.resize(hdr.p.size());
        for (size_t i = 0; i < px.size(); i++) px[i] = (uint16_t)std::lround(std::min(1.f, std::max(0.f, hdr.p[i])) * 65535.f);
    } else post(hdr, seed, fade, px);
    writePPM16(path, W, H, px);
    double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    std::printf("%s  u=%.4f  scale=%.5f  camDE/scale=%.3f  refine=%.3f  %.1fs\n", path.c_str(), u, cam.scale,
                deScalar(cam.pos) / cam.scale, gLastRefineFrac, sec);
    std::fflush(stdout);
}

int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "see header for usage\n"); return 1; }
    initQuality();
    setupScene();
    std::printf("target (%.5f %.5f %.5f)  n (%.3f %.3f %.3f)\n", gScene.target.x, gScene.target.y, gScene.target.z,
                gScene.tn.x, gScene.tn.y, gScene.tn.z);
    if (std::string(argv[1]) == "still") {
        std::string path = argv[2];
        int W = std::atoi(argv[3]), H = std::atoi(argv[4]), spp = std::atoi(argv[5]);
        float u = std::atof(argv[6]);
        renderOne(u, W, H, spp, 1234u, 1.f, path);
        return 0;
    }
    if (std::string(argv[1]) == "path") {  // print camera clearance along the path
        for (int i = 0; i <= 40; i++) {
            float u = i / 40.f; Cam c = cameraAt(u, 16, 9);
            std::printf("u=%.3f scale=%.5f clearance=%.3f\n", u, c.scale, deScalar(c.pos) / c.scale);
        }
        return 0;
    }
    std::string dir = argv[1];
    int W = std::atoi(argv[2]), H = std::atoi(argv[3]), spp = std::atoi(argv[4]);
    int f0 = std::atoi(argv[5]), f1 = std::atoi(argv[6]);
    float fps = argc > 7 ? std::atof(argv[7]) : 60.f;
    float secs = argc > 8 ? std::atof(argv[8]) : 7.f;
    int nFrames = (int)std::lround(fps * secs);
    for (int f = f0; f <= f1 && f < nFrames; f++) {
        char name[512];
        std::snprintf(name, sizeof name, "%s/f%04d.ppm", dir.c_str(), f);
        if (exists(name)) continue;
        float u = (float)f / (nFrames - 1);
        float tsec = f / fps;
        float fade = std::min(1.f, tsec / 0.6f);
        fade = fade * fade * (3 - 2 * fade);
        float fadeOut = std::min(1.f, (secs - tsec) / 0.5f);
        fade *= std::max(0.f, fadeOut * fadeOut * (3 - 2 * fadeOut));
        renderOne(u, W, H, spp, 7777u + (uint32_t)f, fade, name);
    }
    return 0;
}
