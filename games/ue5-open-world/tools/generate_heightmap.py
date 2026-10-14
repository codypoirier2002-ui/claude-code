"""Generate the terrain for the open-world demo.

Writes, from the values in scripts/ow_config.py:
  OW_Height_505.png / .r16     16-bit heightmap for Landscape > Import from File
  OW_Weight_Auto_505.png       8-bit weightmap for the "Auto" paint layer
  OW_Weight_Road_505.png       8-bit weightmap for the "Road" paint layer
  OW_Backdrop_Height_505.png   optional coarse mountain landscape (Option B)
  OW_Preview.png               colour map of the layout, to check before importing
  OW_Layout.json               lake, road, cabin, spawn, fence, boulder and mountain
                               positions read by the Unreal-side scripts

No extra packages needed. Run it either way:
  * Inside Unreal (recommended - files go to <Project>/Saved/OpenWorld where the
    other scripts look for them): Tools > Execute Python Script... and pick this
    file, or type this in the Output Log command box (Cmd mode):
      py "C:/path/to/OpenWorldTools/tools/generate_heightmap.py"
  * From Windows Python: py generate_heightmap.py "C:/path/to/<Project>/Saved/OpenWorld"
    (without the folder argument the files go to OpenWorldTools/output instead)
It takes about 10-30 seconds.
"""
import json
import math
import os
import random
import struct
import sys
import zlib

_here = globals().get("__file__")
if _here:
    _HERE = os.path.dirname(os.path.abspath(_here))
else:  # pasted into a console: set OW_ROOT to the ue5-open-world folder
    _HERE = os.path.join(os.environ.get("OW_ROOT", os.getcwd()), "tools")
sys.path.insert(0, os.path.normpath(os.path.join(_HERE, "..", "scripts")))
import ow_config as C  # noqa: E402

N = C.LANDSCAPE_RESOLUTION
CELL_M = C.LANDSCAPE_SCALE_XY_CM / 100.0
HALF = C.HALF_SIZE_M


# ---------------------------------------------------------------------------
# Small maths helpers
# ---------------------------------------------------------------------------
def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(e0, e1, x):
    if e0 == e1:
        return 0.0 if x < e0 else 1.0
    t = clamp((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def smooth_max(a, b, k):
    h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0)
    return lerp(b, a, h) + k * h * (1.0 - h)


def _grad(ix, iy, seed):
    h = (ix * 374761393 + iy * 668265263 + seed * 982451653) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    a = (h & 0xFFFF) / 65535.0 * 6.283185307179586
    return math.cos(a), math.sin(a)


def gradient_noise(x, y, seed):
    """Perlin-style gradient noise, roughly -1..1."""
    ix = math.floor(x)
    iy = math.floor(y)
    fx = x - ix
    fy = y - iy
    ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
    uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
    g00 = _grad(ix, iy, seed)
    g10 = _grad(ix + 1, iy, seed)
    g01 = _grad(ix, iy + 1, seed)
    g11 = _grad(ix + 1, iy + 1, seed)
    n00 = g00[0] * fx + g00[1] * fy
    n10 = g10[0] * (fx - 1) + g10[1] * fy
    n01 = g01[0] * fx + g01[1] * (fy - 1)
    n11 = g11[0] * (fx - 1) + g11[1] * (fy - 1)
    return 1.414 * lerp(lerp(n00, n10, ux), lerp(n01, n11, ux), uy)


def fbm(x, y, octaves, seed, gain=0.5):
    total, amp, norm = 0.0, 1.0, 0.0
    c, s = 0.8, 0.6  # rotate each octave to hide the lattice
    for o in range(octaves):
        total += amp * gradient_noise(x, y, seed + o * 101)
        norm += amp
        x, y = (x * c - y * s) * 2.03, (x * s + y * c) * 2.03
        amp *= gain
    return total / norm


def ridged(x, y, octaves, seed):
    total, amp, norm, prev = 0.0, 1.0, 0.0, 1.0
    c, s = 0.8, 0.6
    for o in range(octaves):
        n = 1.0 - abs(gradient_noise(x, y, seed + o * 131))
        n *= n
        total += n * amp * prev
        norm += amp
        prev = n
        x, y = (x * c - y * s) * 2.1, (x * s + y * c) * 2.1
        amp *= 0.5
    return total / norm


def catmull_rom(points, step_m):
    """Sample a centripetal-free (uniform) Catmull-Rom curve every ~step_m metres."""
    pts = [points[0]] + list(points) + [points[-1]]
    dense = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        seg_len = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
        steps = max(2, int(seg_len / (step_m * 0.25)))
        for k in range(steps):
            t = k / float(steps)
            t2, t3 = t * t, t * t * t
            x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                       + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
            y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                       + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
            dense.append((x, y))
    dense.append(tuple(points[-1]))
    # resample at an even spacing
    out = [dense[0]]
    acc = 0.0
    for a, b in zip(dense, dense[1:]):
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        while acc + seg >= step_m and seg > 0:
            t = (step_m - acc) / seg
            a = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            seg = math.hypot(b[0] - a[0], b[1] - a[1])
            out.append(a)
            acc = 0.0
        acc += seg
    if math.hypot(out[-1][0] - points[-1][0], out[-1][1] - points[-1][1]) > step_m * 0.3:
        out.append(tuple(points[-1]))
    return out


def point_segment_distance(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0.0, 1.0)
    return math.hypot(px - (ax + dx * t), py - (ay + dy * t)), t


# ---------------------------------------------------------------------------
# Layout features
# ---------------------------------------------------------------------------
LAKE_ROT = math.radians(C.LAKE_ROTATION_DEG)
LAKE_COS, LAKE_SIN = math.cos(LAKE_ROT), math.sin(LAKE_ROT)


def lake_radius_factor(theta):
    return 1.0 + 0.09 * math.sin(3.0 * theta + 0.7) + 0.05 * math.sin(4.0 * theta + 2.1)


def lake_signed_distance(x, y):
    """Approximate signed distance to the shoreline in metres (negative = in the water)."""
    dx, dy = x - C.LAKE_CENTER_M[0], y - C.LAKE_CENTER_M[1]
    lx = dx * LAKE_COS + dy * LAKE_SIN
    ly = -dx * LAKE_SIN + dy * LAKE_COS
    rx, ry = C.LAKE_RADII_M
    theta = math.atan2(ly / ry, lx / rx)
    rho = math.hypot(lx / rx, ly / ry)
    radius_here = math.hypot(rx * math.cos(theta), ry * math.sin(theta))
    return (rho - lake_radius_factor(theta)) * radius_here


def lake_shore_point(theta, outset_m=0.0):
    rx, ry = C.LAKE_RADII_M
    f = lake_radius_factor(theta)
    lx, ly = rx * f * math.cos(theta), ry * f * math.sin(theta)
    if outset_m:
        n = math.hypot(lx / (rx * rx), ly / (ry * ry)) or 1.0
        lx += outset_m * (lx / (rx * rx)) / n
        ly += outset_m * (ly / (ry * ry)) / n
    x = C.LAKE_CENTER_M[0] + lx * LAKE_COS - ly * LAKE_SIN
    y = C.LAKE_CENTER_M[1] + lx * LAKE_SIN + ly * LAKE_COS
    return x, y


ROAD = catmull_rom(C.ROAD_CONTROL_POINTS_M, 1.0)
ROAD_CUM = [0.0]
for _a, _b in zip(ROAD, ROAD[1:]):
    ROAD_CUM.append(ROAD_CUM[-1] + math.hypot(_b[0] - _a[0], _b[1] - _a[1]))
ROAD_LENGTH = ROAD_CUM[-1]


def road_point_at(fraction):
    target = clamp(fraction, 0.0, 1.0) * ROAD_LENGTH
    for i in range(1, len(ROAD)):
        if ROAD_CUM[i] >= target:
            seg = ROAD_CUM[i] - ROAD_CUM[i - 1] or 1.0
            t = (target - ROAD_CUM[i - 1]) / seg
            a, b = ROAD[i - 1], ROAD[i]
            return (lerp(a[0], b[0], t), lerp(a[1], b[1], t)), math.atan2(b[1] - a[1], b[0] - a[0]), i
    a, b = ROAD[-2], ROAD[-1]
    return ROAD[-1], math.atan2(b[1] - a[1], b[0] - a[0]), len(ROAD) - 1


SPAWN_XY, _SPAWN_HEADING, SPAWN_INDEX = road_point_at(C.PLAYER_SPAWN_ROAD_FRACTION)
_tilt_dx = SPAWN_XY[0] - C.LAKE_CENTER_M[0]
_tilt_dy = SPAWN_XY[1] - C.LAKE_CENTER_M[1]
TILT_LEN = math.hypot(_tilt_dx, _tilt_dy)
TILT_DIR = (_tilt_dx / TILT_LEN, _tilt_dy / TILT_LEN)

ROCK_KNOLLS = [  # (x, y, radius_m, height_m): steep outcrops that show the rock blend
    (-150.0, -120.0, 26.0, 13.0),
    (150.0, -150.0, 30.0, 15.0),   # across the lake from the spawn point
    (120.0, 140.0, 22.0, 11.0),
]

_ROAD_COARSE = ROAD[::8] + [ROAD[-1]]


def distance_to_road_coarse(x, y):
    best = 1e9
    for a, b in zip(_ROAD_COARSE, _ROAD_COARSE[1:]):
        d, _ = point_segment_distance(x, y, a[0], a[1], b[0], b[1])
        if d < best:
            best = d
    return best


def natural_height(x, y, seed):
    """Terrain before the road and cabin pad are cut in (metres)."""
    w = 1.0 / C.HILL_WAVELENGTH_M
    hills = fbm(x * w, y * w, 5, seed) * C.HILL_AMPLITUDE_M
    hills += fbm(x / 23.0, y / 23.0, 3, seed + 7) * 0.6  # small undulation

    # keep a clear sightline from the spawn point down to the lake
    d_view, t_view = point_segment_distance(x, y, SPAWN_XY[0], SPAWN_XY[1], C.LAKE_CENTER_M[0], C.LAKE_CENTER_M[1])
    if t_view < 1.0:
        hills *= lerp(0.2, 1.0, smoothstep(20.0, 75.0, d_view))

    along = ((x - C.LAKE_CENTER_M[0]) * TILT_DIR[0] + (y - C.LAKE_CENTER_M[1]) * TILT_DIR[1]) / TILT_LEN
    tilt = C.GLOBAL_TILT_M * clamp(along, -0.6, 1.3)
    h = C.BASE_HEIGHT_M + hills + tilt

    for kx, ky, kr, kh in ROCK_KNOLLS:
        r = math.hypot(x - kx, y - ky)
        if r < kr * 1.6:
            ang = math.atan2(y - ky, x - kx)
            edge = kr * (1.0 + 0.18 * gradient_noise(math.cos(ang) * 1.5 + kx, math.sin(ang) * 1.5 + ky, seed + 3))
            core = 1.0 - smoothstep(edge * 0.55, edge, r)
            terraces = 0.85 + 0.15 * math.floor(core * 4.0) / 4.0
            h += kh * core * terraces + 1.5 * ridged(x / 9.0, y / 9.0, 2, seed + 11) * core

    # raised rim along the border, with a saddle where the road leaves
    # rounded-square distance to the border (p-norm) so the corners have no crease
    d_edge = HALF - (abs(x) ** 8 + abs(y) ** 8) ** 0.125
    rim = 1.0 - smoothstep(0.0, C.EDGE_BERM_WIDTH_M, d_edge)
    if rim > 0.0:
        rim = rim ** 1.3 * (0.55 + 0.8 * (0.5 + 0.5 * fbm(x / 110.0, y / 110.0, 3, seed + 5)))
        saddle = lerp(0.35, 1.0, smoothstep(12.0, 70.0, distance_to_road_coarse(x, y)))
        h += C.EDGE_BERM_HEIGHT_M * rim * saddle

    # never dip below the lake surface away from the lake
    return smooth_max(h, C.WATER_LEVEL_M + 3.2, 2.0)


def shaped_height(x, y, seed):
    """Natural terrain with the lake basin carved in (no road / pad yet)."""
    h = natural_height(x, y, seed)
    d = lake_signed_distance(x, y)
    if d < 0.0:
        depth = C.LAKE_MAX_DEPTH_M * smoothstep(0.0, 16.0, -d)
        return C.WATER_LEVEL_M - depth + 0.25 * gradient_noise(x / 7.0, y / 7.0, seed + 13) * smoothstep(0.0, 6.0, -d)
    if d < C.LAKE_SHORE_BLEND_M:
        # concave bowl: gentle at the water, steepening further out, so nothing hides the lake
        t = (d / C.LAKE_SHORE_BLEND_M) ** 1.6
        return lerp(C.WATER_LEVEL_M + C.LAKE_SHORE_SLOPE * d, h, t)
    return h


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
def build(out_dir):
    seed = C.SEED
    rng = random.Random(seed)
    os.makedirs(out_dir, exist_ok=True)

    def to_xy(i, j):
        return i * CELL_M - HALF, j * CELL_M - HALF

    print("[OW] sculpting %dx%d terrain..." % (N, N))
    height = [0.0] * (N * N)
    for j in range(N):
        for i in range(N):
            x, y = to_xy(i, j)
            height[j * N + i] = shaped_height(x, y, seed)

    # cabin pad: flatten to the height at its centre
    cx, cy = C.CABIN_CENTER_M
    pad_h = shaped_height(cx, cy, seed)
    pad_r = C.CABIN_PAD_HALF_M
    for j in range(N):
        for i in range(N):
            x, y = to_xy(i, j)
            d = max(abs(x - cx), abs(y - cy))
            if d < pad_r + 14.0:
                w = 1.0 - smoothstep(pad_r, pad_r + 14.0, d)
                k = j * N + i
                height[k] = lerp(height[k], pad_h, w)

    # road: smooth height profile with a grade limit, then cut it in
    print("[OW] cutting the road (%.0f m)..." % ROAD_LENGTH)
    raw = [shaped_height(x, y, seed) for x, y in ROAD]
    win = 15
    prof = []
    for k in range(len(raw)):
        lo, hi = max(0, k - win), min(len(raw), k + win + 1)
        prof.append(sum(raw[lo:hi]) / (hi - lo))
    grade = C.ROAD_MAX_GRADE
    for _ in range(3):
        for k in range(1, len(prof)):
            step = ROAD_CUM[k] - ROAD_CUM[k - 1]
            prof[k] = clamp(prof[k], prof[k - 1] - grade * step, prof[k - 1] + grade * step)
        for k in range(len(prof) - 2, -1, -1):
            step = ROAD_CUM[k + 1] - ROAD_CUM[k]
            prof[k] = clamp(prof[k], prof[k + 1] - grade * step, prof[k + 1] + grade * step)
    # blend the last stretch into the cabin pad
    for k in range(len(prof)):
        t = smoothstep(ROAD_LENGTH - 30.0, ROAD_LENGTH - 4.0, ROAD_CUM[k])
        prof[k] = lerp(prof[k], pad_h, t)
    road_h = [p - C.ROAD_SINK_M for p in prof]

    reach = C.ROAD_HALF_WIDTH_M + C.ROAD_SHOULDER_M + 1.0
    best_d = {}
    best_h = {}
    for (x, y), rh in zip(ROAD, road_h):
        i0, i1 = int((x - reach + HALF) / CELL_M), int((x + reach + HALF) / CELL_M) + 1
        j0, j1 = int((y - reach + HALF) / CELL_M), int((y + reach + HALF) / CELL_M) + 1
        for j in range(max(0, j0), min(N, j1 + 1)):
            for i in range(max(0, i0), min(N, i1 + 1)):
                px, py = to_xy(i, j)
                d = math.hypot(px - x, py - y)
                k = j * N + i
                if d < best_d.get(k, 1e9):
                    best_d[k] = d
                    best_h[k] = rh
    road_w = [0] * (N * N)
    for k, d in best_d.items():
        j, i = divmod(k, N)
        px, py = to_xy(i, j)
        w = 1.0 - smoothstep(C.ROAD_HALF_WIDTH_M + 0.4, C.ROAD_HALF_WIDTH_M + C.ROAD_SHOULDER_M, d)
        height[k] = lerp(height[k], best_h[k] + (C.ROAD_SINK_M if d > C.ROAD_HALF_WIDTH_M else 0.0) * w, w)
        ragged = d + 0.45 * gradient_noise(px / 2.5, py / 2.5, seed + 17)
        road_w[k] = int(round(255.0 * (1.0 - smoothstep(C.ROAD_HALF_WIDTH_M - 0.6, C.ROAD_HALF_WIDTH_M + 0.7, ragged))))

    # ------------------------------------------------------------------
    # encode and write
    # ------------------------------------------------------------------
    zs = C.LANDSCAPE_SCALE_Z
    h16 = [int(clamp(round(32768 + h * 128.0 * 100.0 / zs), 0, 65535)) for h in height]
    rows16 = [struct.pack(">%dH" % N, *h16[j * N:(j + 1) * N]) for j in range(N)]
    write_png(os.path.join(out_dir, C.HEIGHTMAP_FILE), N, N, rows16, 16, 0)
    with open(os.path.join(out_dir, C.HEIGHTMAP_RAW_FILE), "wb") as fh:
        fh.write(struct.pack("<%dH" % (N * N), *h16))

    auto_w = [255 - v for v in road_w]
    write_png(os.path.join(out_dir, C.WEIGHT_FILES["Road"]), N, N,
              [bytes(road_w[j * N:(j + 1) * N]) for j in range(N)], 8, 0)
    write_png(os.path.join(out_dir, C.WEIGHT_FILES["Auto"]), N, N,
              [bytes(auto_w[j * N:(j + 1) * N]) for j in range(N)], 8, 0)

    layout = make_layout(rng, height, road_h, pad_h)
    with open(os.path.join(out_dir, C.LAYOUT_FILE), "w") as fh:
        json.dump(layout, fh, indent=1)

    write_preview(os.path.join(out_dir, C.PREVIEW_FILE), height, road_w, layout)
    build_backdrop(os.path.join(out_dir, C.BACKDROP_HEIGHTMAP_FILE), seed)

    hmin, hmax = min(height), max(height)
    print("[OW] height range %.1f m .. %.1f m (water %.1f m)" % (hmin, hmax, C.WATER_LEVEL_M))
    print("[OW] wrote files to %s" % out_dir)
    return layout


def sample_height(height, x, y):
    fi = clamp((x + HALF) / CELL_M, 0.0, N - 1.001)
    fj = clamp((y + HALF) / CELL_M, 0.0, N - 1.001)
    i, j = int(fi), int(fj)
    tx, ty = fi - i, fj - j
    a = height[j * N + i]
    b = height[j * N + i + 1]
    c = height[(j + 1) * N + i]
    d = height[(j + 1) * N + i + 1]
    return lerp(lerp(a, b, tx), lerp(c, d, tx), ty)


def make_layout(rng, height, road_h, pad_h):
    r1 = lambda v: round(v, 2)  # noqa: E731
    lake_pts = []
    for k in range(C.LAKE_SPLINE_POINTS):
        th = 2.0 * math.pi * k / C.LAKE_SPLINE_POINTS
        x, y = lake_shore_point(th, C.LAKE_SPLINE_OUTSET_M)
        lake_pts.append([r1(x), r1(y)])

    road_pts = [[r1(x), r1(y), r1(h)] for k, ((x, y), h) in enumerate(zip(ROAD, road_h)) if k % 2 == 0]

    sx, sy = SPAWN_XY
    spawn_h = sample_height(height, sx, sy)
    spawn_yaw = math.degrees(math.atan2(C.LAKE_CENTER_M[1] - sy, C.LAKE_CENTER_M[0] - sx))

    cx, cy = C.CABIN_CENTER_M
    cabin_yaw = C.CABIN_YAW_DEG
    if cabin_yaw is None:
        cabin_yaw = math.degrees(math.atan2(C.LAKE_CENTER_M[1] - cy, C.LAKE_CENTER_M[0] - cx))

    # fence: offset polyline along part of the road, cut into equal segments
    f0, f1 = C.FENCE_ROAD_RANGE
    off = C.ROAD_HALF_WIDTH_M + C.FENCE_OFFSET_M
    line = []
    for k in range(len(ROAD)):
        frac = ROAD_CUM[k] / ROAD_LENGTH
        if f0 <= frac <= f1:
            a = ROAD[max(0, k - 1)]
            b = ROAD[min(len(ROAD) - 1, k + 1)]
            hd = math.atan2(b[1] - a[1], b[0] - a[0])
            nx, ny = -math.sin(hd) * C.FENCE_SIDE, math.cos(hd) * C.FENCE_SIDE
            line.append((ROAD[k][0] + nx * off, ROAD[k][1] + ny * off))
    segs = []
    seg_len = C.FENCE_SEGMENT_LENGTH_M
    if line:
        start = line[0]
        idx = 1
        while idx < len(line):
            # walk along the polyline until we are seg_len away (chord length)
            while idx < len(line) and math.hypot(line[idx][0] - start[0], line[idx][1] - start[1]) < seg_len:
                idx += 1
            if idx >= len(line):
                break
            a, b = line[idx - 1], line[idx]
            # solve |a + t(b-a) - start| = seg_len for t in [0, 1]
            dx, dy = b[0] - a[0], b[1] - a[1]
            fx, fy = a[0] - start[0], a[1] - start[1]
            qa = dx * dx + dy * dy
            qb = 2 * (fx * dx + fy * dy)
            qc = fx * fx + fy * fy - seg_len * seg_len
            disc = max(0.0, qb * qb - 4 * qa * qc)
            t = clamp((-qb + math.sqrt(disc)) / (2 * qa), 0.0, 1.0) if qa > 0 else 0.0
            end = (a[0] + dx * t, a[1] + dy * t)
            segs.append({
                "start_m": [r1(start[0]), r1(start[1])],
                "end_m": [r1(end[0]), r1(end[1])],
                "yaw_deg": r1(math.degrees(math.atan2(end[1] - start[1], end[0] - start[0]))),
            })
            start = end

    inner = HALF - C.PLAYABLE_INSET_M
    boulders = []
    tries = 0
    while len(boulders) < C.BOULDER_COUNT and tries < 2000:
        tries += 1
        frac = rng.uniform(0.04, 0.97)
        (px, py), hd, _ = road_point_at(frac)
        side = rng.choice((-1, 1))
        dist = C.ROAD_HALF_WIDTH_M + rng.uniform(*C.BOULDER_OFFSET_RANGE_M)
        bx, by = px - math.sin(hd) * side * dist, py + math.cos(hd) * side * dist
        if max(abs(bx), abs(by)) > inner - 3.0:
            continue
        if f0 - 0.02 <= frac <= f1 + 0.02 and side == C.FENCE_SIDE:
            continue  # keep the fence side clear
        if max(abs(bx - cx), abs(by - cy)) < C.CABIN_PAD_HALF_M + 2.0:
            continue
        if any(math.hypot(bx - b["position_m"][0], by - b["position_m"][1]) < 7.0 for b in boulders):
            continue
        boulders.append({"position_m": [r1(bx), r1(by)], "yaw_deg": r1(rng.uniform(0, 360)),
                         "scale": r1(rng.uniform(0.7, 1.6)), "mesh_index": len(boulders)})

    mountains = []
    for k in range(C.MOUNTAIN_COUNT):
        ang = 2 * math.pi * (k + rng.uniform(-0.3, 0.3)) / C.MOUNTAIN_COUNT
        rad = rng.uniform(*C.MOUNTAIN_RING_RADIUS_M)
        mountains.append({"position_m": [r1(math.cos(ang) * rad), r1(math.sin(ang) * rad)],
                          "yaw_deg": r1(rng.uniform(0, 360)), "scale": r1(rng.uniform(*C.MOUNTAIN_SCALE_RANGE)),
                          "mesh_index": k})

    probes = [
        {"name": "lake_centre", "position_m": [r1(C.LAKE_CENTER_M[0]), r1(C.LAKE_CENTER_M[1])]},
        {"name": "cabin_pad", "position_m": [r1(cx), r1(cy)]},
        {"name": "player_spawn", "position_m": [r1(sx), r1(sy)]},
    ]
    for kx, ky, _r, _h in ROCK_KNOLLS:
        probes.append({"name": "rock_knoll", "position_m": [r1(kx), r1(ky)]})
    for p in probes:
        p["expected_height_m"] = r1(sample_height(height, p["position_m"][0], p["position_m"][1]))

    return {
        "format": 1,
        "units": "metres; origin = landscape centre; heights relative to the landscape actor Z",
        "landscape": {"resolution": N, "size_m": C.LANDSCAPE_SIZE_M, "scale_xy_cm": C.LANDSCAPE_SCALE_XY_CM,
                      "scale_z": C.LANDSCAPE_SCALE_Z},
        "water_level_m": C.WATER_LEVEL_M,
        "lake": {"center_m": list(C.LAKE_CENTER_M), "spline_points_m": lake_pts, "max_depth_m": C.LAKE_MAX_DEPTH_M},
        "road": {"half_width_m": C.ROAD_HALF_WIDTH_M, "length_m": r1(ROAD_LENGTH), "points_m": road_pts},
        "cabin": {"center_m": [r1(cx), r1(cy)], "height_m": r1(pad_h), "yaw_deg": r1(cabin_yaw),
                  "pad_half_m": C.CABIN_PAD_HALF_M},
        "player_start": {"position_m": [r1(sx), r1(sy), r1(spawn_h)], "yaw_deg": r1(spawn_yaw)},
        "fence": {"segment_length_m": seg_len, "segments": segs},
        "boulders": boulders,
        "mountains": mountains,
        "mountain_base_height_m": C.MOUNTAIN_BASE_HEIGHT_M,
        "boundary": {"half_extent_m": inner, "wall_height_m": 150.0, "wall_thickness_m": 2.0},
        "rock_knolls_m": [[kx, ky, kr] for kx, ky, kr, _ in ROCK_KNOLLS],
        "probes": probes,
    }


def build_backdrop(path, seed):
    """Coarse ring of mountains for Option B (a second landscape around the main one)."""
    size_m = (N - 1) * C.BACKDROP_SCALE_XY_CM / 100.0
    half = size_m / 2.0
    cell = C.BACKDROP_SCALE_XY_CM / 100.0
    zs = C.BACKDROP_SCALE_Z
    rows = []
    for j in range(N):
        vals = []
        for i in range(N):
            x, y = i * cell - half, j * cell - half
            cheb = max(abs(x), abs(y))
            r = math.hypot(x, y)
            if cheb < HALF - 6.0:
                h = -60.0  # hidden under the main landscape
            else:
                meadow = C.BASE_HEIGHT_M + 6.0 + 4.0 * fbm(x / 120.0, y / 120.0, 3, seed + 21)
                foot = smoothstep(HALF + 20.0, 900.0, r)
                hills = 90.0 * foot * (0.5 + 0.5 * fbm(x / 400.0, y / 400.0, 4, seed + 23))
                peaks = C.BACKDROP_PEAK_M * smoothstep(700.0, 2000.0, r) * ridged(x / 900.0, y / 900.0, 5, seed + 29)
                h = meadow + hills + peaks
                h = lerp(-60.0, h, smoothstep(HALF - 6.0, HALF + 2.0, cheb))
            vals.append(int(clamp(round(32768 + h * 128.0 * 100.0 / zs), 0, 65535)))
        rows.append(struct.pack(">%dH" % N, *vals))
    write_png(path, N, N, rows, 16, 0)


def write_png(path, width, height, rows, bit_depth, color_type):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, 0)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def write_preview(path, height, road_w, layout):
    """Shaded-relief map with the lake, road, cabin, spawn, fence, boulders and walls drawn on."""
    img = bytearray(N * N * 3)
    hmin, hmax = min(height), max(height)
    for j in range(N):
        for i in range(N):
            k = j * N + i
            h = height[k]
            hx = height[j * N + min(N - 1, i + 1)] - height[j * N + max(0, i - 1)]
            hy = height[min(N - 1, j + 1) * N + i] - height[max(0, j - 1) * N + i]
            slope = math.degrees(math.atan(math.hypot(hx, hy) / (2 * CELL_M)))
            shade = clamp(0.75 + (-hx - hy) * 0.18, 0.35, 1.25)
            t = (h - hmin) / max(1e-3, hmax - hmin)
            if h < C.WATER_LEVEL_M:
                col = (40, 90, 140)
            elif slope > 33.0:
                col = (128, 124, 118)
            else:
                col = (int(lerp(88, 150, t)), int(lerp(128, 140, t)), int(lerp(60, 90, t)))
            if road_w[k] > 0:
                a = road_w[k] / 255.0
                col = tuple(int(lerp(c, r, a)) for c, r in zip(col, (150, 115, 75)))
            img[k * 3:k * 3 + 3] = bytes(int(clamp(c * shade, 0, 255)) for c in col)

    def dot(x, y, rgb, rad=1):
        ci, cj = int(round((x + HALF) / CELL_M)), int(round((y + HALF) / CELL_M))
        for dj in range(-rad, rad + 1):
            for di in range(-rad, rad + 1):
                ii, jj = ci + di, cj + dj
                if 0 <= ii < N and 0 <= jj < N:
                    img[(jj * N + ii) * 3:(jj * N + ii) * 3 + 3] = bytes(rgb)

    inner = layout["boundary"]["half_extent_m"]
    s = -inner
    while s <= inner:
        for x, y in ((s, -inner), (s, inner), (-inner, s), (inner, s)):
            dot(x, y, (230, 200, 40), 0)
        s += 1.0
    for seg in layout["fence"]["segments"]:
        dot(seg["start_m"][0], seg["start_m"][1], (245, 245, 245), 0)
    for b in layout["boulders"]:
        dot(b["position_m"][0], b["position_m"][1], (60, 60, 60), 2)
    cx, cy = layout["cabin"]["center_m"]
    dot(cx, cy, (120, 40, 20), 4)
    sx, sy, _ = layout["player_start"]["position_m"]
    yaw = math.radians(layout["player_start"]["yaw_deg"])
    for k in range(0, 30):
        dot(sx + math.cos(yaw) * k, sy + math.sin(yaw) * k, (220, 30, 30), 0)
    dot(sx, sy, (220, 30, 30), 3)
    for x, y in layout["lake"]["spline_points_m"]:
        dot(x, y, (200, 230, 255), 1)

    rows = [bytes(img[j * N * 3:(j + 1) * N * 3]) for j in range(N)]
    write_png(path, N, N, rows, 8, 2)


def default_out_dir():
    if C.OUTPUT_DIR:
        return C.OUTPUT_DIR
    try:
        import unreal  # noqa: F401  (only present inside the editor)
        return os.path.join(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_saved_dir()), "OpenWorld")
    except ImportError:
        return os.path.normpath(os.path.join(_HERE, "..", "output"))


if __name__ == "__main__" or "unreal" in sys.modules:  # Unreal may not set __main__
    args = [a for a in sys.argv[1:] if a.strip()]
    build(args[0] if args else default_out_dir())
