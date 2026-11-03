"""Blender scenes for "The Man Who Doubted the Machine" (Stanislav Petrov, 1983).

Built by blender/build.py with a lib.Ctx. Every frame number comes from the timeline
(ctx.start / ctx.end / ctx.cue), so re-voicing the story re-times the animation.

Sets (each in its own collection, far apart, visible only in its shots):
  orbit   night Earth, a Molniya-style satellite, the "launch" flare  -> shots orbit, outro
  bunker  Serpukhov-15 style room: wall screen, desk, Petrov at the console -> bunker
  screen  close-up of the alert display: LAUNCH, missile markers       -> screen
  petrov  profile close-up, red siren light that dies at "None arrives" -> petrov
  glint   sunlight off high clouds into the satellite's sensor          -> glint

Loop: the outro reuses the orbit set and its camera ends exactly on the opening pose at
frame total_frames; Earth spin and the satellite orbit are periodic over the timeline.

Look tuning lives in the constants below. Step 4 (contact sheets) is where to change them.
"""
import math

import lib

R = math.radians

NAVY = (0.010, 0.016, 0.040)
TEAL = (0.10, 0.95, 0.80)
RED = (1.00, 0.05, 0.03)
AMBER = (1.00, 0.52, 0.16)
ICE = (0.70, 0.82, 1.00)
WARM_SUN = (1.00, 0.86, 0.66)

SCREEN_IDLE = 1.6      # emission of calm teal screen lines
SCREEN_ALARM = 7.0     # emission of red alarm elements
SIREN_W = 900.0        # red siren light power (W)
SIREN_PERIOD = 0.6     # seconds per siren cycle

ORBIT_X, BUNKER_X, SCREEN_X, PETROV_X, GLINT_X = 0, 1000, 2000, 3000, 4000

HOOK_CAM = ((0.0, -36.0, 3.0), (0.0, 0.0, 4.5))   # (location, target) at frame 0 == frame total
EARTH_R = 10.0
LAUNCH_LAT, LAUNCH_LON_FACING = R(47.0), R(-78.0)  # Montana-ish; angle (in XY) facing camera at the cue


def off(x, p):
    return (p[0] + x, p[1], p[2])


# ------------------------------------------------------------------ shared builders

def earth_material(name, ocean, land, lights_strength):
    m = lib.material(name, ocean, rough=0.6)
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    coord = nt.nodes.new("ShaderNodeTexCoord")
    big = nt.nodes.new("ShaderNodeTexNoise")
    big.inputs["Scale"].default_value = 1.6
    big.inputs["Detail"].default_value = 8.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    ramp.color_ramp.elements[0].color = (*ocean, 1)
    ramp.color_ramp.elements[1].position = 0.53
    ramp.color_ramp.elements[1].color = (*land, 1)
    nt.links.new(coord.outputs["Object"], big.inputs["Vector"])
    nt.links.new(big.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], lib._sock(bsdf, "Base Color"))
    if lights_strength > 0:
        # City lights: fine noise thresholded to specks, only on land.
        fine = nt.nodes.new("ShaderNodeTexNoise")
        fine.inputs["Scale"].default_value = 45.0
        specks = nt.nodes.new("ShaderNodeValToRGB")
        specks.color_ramp.elements[0].position = 0.70
        specks.color_ramp.elements[1].position = 0.74
        mask = nt.nodes.new("ShaderNodeMath")
        mask.operation = "GREATER_THAN"
        mask.inputs[1].default_value = 0.53
        mult = nt.nodes.new("ShaderNodeMath")
        mult.operation = "MULTIPLY"
        nt.links.new(coord.outputs["Object"], fine.inputs["Vector"])
        nt.links.new(fine.outputs["Fac"], specks.inputs["Fac"])
        nt.links.new(big.outputs["Fac"], mask.inputs[0])
        nt.links.new(specks.outputs["Color"], mult.inputs[0])
        nt.links.new(mask.outputs[0], mult.inputs[1])
        lib._sock(bsdf, "Emission Color", "Emission").default_value = (*AMBER, 1)
        nt.links.new(mult.outputs[0], lib._sock(bsdf, "Emission Strength"))
        strength = nt.nodes.new("ShaderNodeMath")
        strength.operation = "MULTIPLY"
        strength.inputs[1].default_value = lights_strength
        nt.links.new(mult.outputs[0], strength.inputs[0])
        nt.links.new(strength.outputs[0], lib._sock(bsdf, "Emission Strength"))
    return m


def atmosphere_material(name, color, strength, blend=0.12):
    """Rim glow: emission weighted by grazing angle, transparent face-on."""
    m = lib.blended(lib.glow(name, color, strength))
    nt = m.node_tree
    em = nt.nodes["Emission"]
    out = nt.nodes["Material Output"]
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = blend
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lw.outputs["Facing"], mix.inputs[0])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])
    return m


def satellite(name, coll, parent=None, scale=1.0):
    body_m = lib.material(name + "_body", (0.55, 0.5, 0.4), rough=0.35, metal=0.9)
    panel_m = lib.material(name + "_panel", (0.04, 0.07, 0.2), rough=0.25, metal=0.4,
                           emit=(0.1, 0.2, 0.6), strength=0.4)
    root = lib.empty(name, coll=coll, parent=parent)
    lib.add("cube", name + "_bus", (0, 0, 0), scale=(0.35 * scale,) * 3, mat=body_m, coll=coll,
            parent=root)
    for side in (-1, 1):
        lib.add("cube", f"{name}_panel{side}", (side * 1.1 * scale, 0, 0),
                scale=(0.7 * scale, 0.02 * scale, 0.28 * scale), mat=panel_m, coll=coll, parent=root)
    beacon = lib.glow(name + "_beacon", (1, 0.25, 0.2), 0.0)
    lib.add("ico", name + "_light", (0, 0, 0.42 * scale), mat=beacon, coll=coll, parent=root,
            radius=0.08 * scale, subdivisions=2)
    return root, beacon


def officer(name, coll, base, mat, arms=True):
    """Seated silhouette in a peaked cap, facing +Y. arms=False for close-ups with no desk."""
    x, y, z = base
    parts = [
        ("cyl", "torso", (x, y, z + 1.05), (1.0, 0.72, 1.0), dict(radius=0.27, depth=0.72)),
        ("sphere", "shoulders", (x, y, z + 1.38), (1.25, 0.75, 0.45), dict(radius=0.27)),
        ("cyl", "neck", (x, y, z + 1.52), (1, 1, 1), dict(radius=0.07, depth=0.14)),
        ("sphere", "head", (x, y + 0.01, z + 1.66), (0.92, 1.0, 1.08), dict(radius=0.135)),
        ("cyl", "cap", (x, y, z + 1.80), (1, 1, 1), dict(radius=0.15, depth=0.08)),
        ("cyl", "cap_top", (x, y + 0.01, z + 1.85), (1.05, 1.05, 1), dict(radius=0.16, depth=0.03)),
        ("cyl", "brim", (x, y + 0.11, z + 1.765), (0.8, 1.0, 1), dict(radius=0.12, depth=0.015)),
        ("cone", "nose", (x, y + 0.14, z + 1.65), (0.7, 1, 1), dict(radius1=0.035, depth=0.07)),
        ("sphere", "chin", (x, y + 0.08, z + 1.57), (1.0, 0.8, 0.6), dict(radius=0.07)),
    ]
    for kind, part, loc, scl, kw in parts:
        rot = (R(-90), 0, 0) if part == "nose" else (0, 0, 0)     # cone tip toward +Y
        lib.add(kind, f"{name}_{part}", loc, rot=rot, scale=scl, mat=mat, smooth=True, coll=coll,
                **kw)
    for side in ((-1, 1) if arms else ()):  # forearms reaching to the console
        a = (x + side * 0.30, y + 0.05, z + 1.25)
        b = (x + side * 0.22, y + 0.62, z + 0.98)
        piv = lib.beam(f"{name}_arm{side}", a, b, mat, radius=0.06, coll=coll)
        lib.grow(piv, 0, 1.0, "CONSTANT")


def screen_grid(name, coll, loc, size, cuts, mat, thickness=0.012):
    g = lib.add("grid", name, loc, rot=(R(90), 0, 0), mat=mat, coll=coll,
                x_subdivisions=cuts[0], y_subdivisions=cuts[1], size=2.0)
    g.scale = (size[0] / 2, size[1] / 2, 1)
    mod = g.modifiers.new("wire", "WIREFRAME")
    mod.thickness = thickness
    return g


def siren(ctx, name, coll, loc, target, start, end):
    lamp = lib.light(name, "POINT", loc, 0.0, RED, size=0.4, coll=coll)
    period = ctx.sec(SIREN_PERIOD)
    lib.key(lamp.data, "energy", 0, 0.0, "CONSTANT")
    lib.pulse(lamp.data, "energy", start, end, period, SIREN_W * 0.15, SIREN_W)
    return lamp


# ------------------------------------------------------------------ sets

def build_orbit(ctx):
    coll = ctx.set_collection("set_orbit", "orbit", "outro")
    X = ORBIT_X
    total = ctx.total

    earth = lib.add("sphere", "earth", (X, 0, 0), mat=earth_material(
        "earth", (0.004, 0.012, 0.035), (0.012, 0.016, 0.02), lights_strength=6.0),
        smooth=True, coll=coll, segments=128, ring_count=64, radius=EARTH_R)
    lib.add("sphere", "atmosphere", (X, 0, 0), mat=atmosphere_material("atmo", (0.25, 0.5, 1.0), 1.1, blend=0.1),
            smooth=True, coll=coll, segments=96, ring_count=48, radius=EARTH_R * 1.035)
    # Whole turns over the timeline, so frame 0 and frame total match. The phase puts the
    # launch site where the camera sees it when the narrator says "launched".
    cue = ctx.cue("launch_flare")
    phase = LAUNCH_LON_FACING - 2 * math.pi * cue / total
    lib.loop_spin(earth, total, turns=1, phase=0.0)

    site_xyz = (EARTH_R * math.cos(LAUNCH_LAT) * math.cos(phase),
                EARTH_R * math.cos(LAUNCH_LAT) * math.sin(phase),
                EARTH_R * math.sin(LAUNCH_LAT))
    site = lib.empty("launch_site", site_xyz, (0, math.pi / 2 - LAUNCH_LAT, phase), coll=coll,
                     parent=earth)
    flare_m = lib.glow("flare", RED, 0.0)
    lib.add("ico", "flare", (0, 0, 0.05), mat=flare_m, coll=coll, parent=site, radius=0.22,
            subdivisions=3)
    s = lib.emit_socket(flare_m)
    lib.key(s, "default_value", 0, 0.0, "CONSTANT")
    lib.key(s, "default_value", cue - 1, 0.0)
    lib.key(s, "default_value", cue + 3, 60.0)
    lib.pulse(s, "default_value", cue + 8, ctx.end("orbit"), ctx.sec(0.5), 14.0, 40.0)
    lib.key(s, "default_value", ctx.end("orbit") + 1, 0.0, "CONSTANT")   # gone before the outro

    trail_m = lib.glow("trail", (1.0, 0.35, 0.12), 8.0)
    trail = lib.beam("trail", (0, 0, 0), (0, 0, 7.0), trail_m, radius=0.05, coll=coll, parent=site)
    lib.grow(trail, 0, 0.0, "CONSTANT")
    lib.grow(trail, cue, 0.0)
    full = min(cue + ctx.sec(1.6), ctx.end("orbit"))
    lib.grow(trail, full, 1.0)
    if full < ctx.end("orbit"):
        lib.grow(trail, ctx.end("orbit"), 1.0)          # hold until the cut
    lib.grow(trail, ctx.end("orbit") + 1, 0.0, "CONSTANT")

    # Satellite on a tilted ellipse (Oko used highly elliptical Molniya orbits; this is a
    # readable stand-in). One whole orbit over the timeline keeps the loop seamless.
    plane = lib.empty("orbit_plane", (X, 0, 0), (R(-68), R(-18), R(10)), coll=coll)
    ring_m = lib.glow("orbit_line", TEAL, 0.9)
    ring = lib.add("torus", "orbit_line", (0, 0, 0), mat=ring_m, coll=coll, parent=plane,
                   major_radius=1.0, minor_radius=0.0025, major_segments=192, minor_segments=6)
    ring.scale = (15.0, 12.0, 15.0)
    sat, beacon = satellite("oko_sat", coll, parent=plane, scale=0.9)
    lib.orbit_keys(sat, total, 15.0, 12.0, theta0=R(290))
    lib.pulse(lib.emit_socket(beacon), "default_value", 0, total, ctx.sec(1.0), 0.0, 25.0)

    lib.light("orbit_sun", "SUN", (X + 30, -10, 30), 1.2, ICE, size=1.0, target=(X, 0, 0),
              coll=coll)
    lib.light("orbit_rim", "AREA", (X - 18, 25, 14), 1500.0, (0.5, 0.65, 1.0), size=12,
              target=(X, 0, 0), coll=coll)

    # Hook camera: frame 0 pose == outro's final pose (frame total).
    loc0, tgt0 = off(X, HOOK_CAM[0]), off(X, HOOK_CAM[1])
    cam, tgt = lib.camera("cam_orbit", loc0, tgt0, lens=35)
    lib.key(cam, "location", 0, loc0)
    lib.key(cam, "location", ctx.end("orbit"), off(X, (2.0, -29.0, 4.2)))
    lib.key(tgt, "location", 0, tgt0)
    lib.key(tgt, "location", ctx.end("orbit"), off(X, (1.2, 0.0, 5.5)))
    ctx.bind_camera("orbit", cam)

    cam2, tgt2 = lib.camera("cam_outro", off(X, (-6.0, -48.0, 12.0)), off(X, (0.0, 0.0, 6.0)),
                            lens=35)
    lib.key(cam2, "location", ctx.start("outro"), off(X, (-6.0, -48.0, 12.0)))
    lib.key(cam2, "location", total, loc0)
    lib.key(tgt2, "location", ctx.start("outro"), off(X, (0.0, 0.0, 6.0)))
    lib.key(tgt2, "location", total, tgt0)
    ctx.bind_camera("outro", cam2)


def build_bunker(ctx):
    coll = ctx.set_collection("set_bunker", "bunker")
    X = BUNKER_X
    s0, s1 = ctx.start("bunker"), ctx.end("bunker")

    concrete = lib.material("concrete", (0.05, 0.055, 0.06), rough=0.85)
    lib.add("plane", "floor", (X, 2, 0), scale=(8, 8, 1), mat=concrete, coll=coll)
    lib.add("plane", "ceiling", (X, 2, 4.6), rot=(R(180), 0, 0), scale=(8, 8, 1), mat=concrete,
            coll=coll)
    lib.add("plane", "back_wall", (X, 6.1, 2.3), rot=(R(90), 0, 0), scale=(8, 2.4, 1), mat=concrete,
            coll=coll)
    for side in (-1, 1):
        lib.add("plane", f"side_wall{side}", (X + side * 5, 2, 2.3), rot=(R(90), 0, R(90)),
                scale=(8, 2.4, 1), mat=concrete, coll=coll)

    panel = lib.material("screen_panel", (0.0, 0.0, 0.0), rough=0.3, emit=(0.0, 0.12, 0.1),
                         strength=1.0)
    lib.add("plane", "wall_screen", (X, 6.0, 2.45), rot=(R(90), 0, 0), scale=(3.6, 1.7, 1),
            mat=panel, coll=coll)
    grid_m = lib.glow("bunker_grid", TEAL, SCREEN_IDLE)
    screen_grid("bunker_grid", coll, (X, 5.97, 2.45), (7.0, 3.3), (28, 13), grid_m)

    # Date stamp, on at the cue "September".
    date_m = lib.glow("date_text", TEAL, 0.0)
    lib.text("date", "26.09.1983", (X - 2.2, 5.95, 3.75), size=0.36, mat=date_m, align="LEFT",
             coll=coll)
    d = lib.emit_socket(date_m)
    lib.key(d, "default_value", 0, 0.0, "CONSTANT")
    lib.key(d, "default_value", ctx.cue("date_on"), 0.0, "CONSTANT")
    lib.pulse(d, "default_value", ctx.cue("date_on") + 1, ctx.cue("date_on") + ctx.sec(0.6),
              ctx.sec(0.2), 0.0, 6.0)
    lib.key(d, "default_value", ctx.cue("date_on") + ctx.sec(0.6), 6.0)

    # Airliner icon crossing the map; hit at the cue "shot".
    hit = ctx.cue("airliner_hit")
    plane_m = lib.glow("airliner", (0.85, 0.95, 1.0), 0.0)
    ac = lib.empty("airliner", (X - 2.8, 5.93, 2.0), coll=coll)
    lib.add("cube", "ac_body", (0, 0, 0), scale=(0.22, 0.01, 0.035), mat=plane_m, coll=coll, parent=ac)
    lib.add("cube", "ac_wing", (0.02, 0, 0), scale=(0.05, 0.01, 0.18), mat=plane_m, coll=coll,
            parent=ac)
    lib.add("cube", "ac_tail", (-0.19, 0, 0.05), scale=(0.03, 0.01, 0.07), mat=plane_m, coll=coll,
            parent=ac)
    appear = max(hit - ctx.sec(2.2), s0)
    lib.key(ac, "location", appear, (X - 2.8, 5.93, 2.0), "LINEAR")
    lib.key(ac, "location", hit, (X + 0.3, 5.93, 2.55), "LINEAR")
    ps, pc = lib.emit_socket(plane_m), lib.emit_color_socket(plane_m)
    lib.key(ps, "default_value", 0, 0.0, "CONSTANT")
    lib.key(ps, "default_value", appear, 4.0, "CONSTANT")
    lib.key(pc, "default_value", hit - 1, (0.85, 0.95, 1.0, 1), "CONSTANT")
    lib.key(pc, "default_value", hit, (*RED, 1), "CONSTANT")
    lib.key(ps, "default_value", hit, 14.0)
    lib.key(ps, "default_value", hit + ctx.sec(0.8), 0.0)
    lib.show_during([ac] + list(ac.children), [(appear, hit + ctx.sec(0.8))])
    ring_m = lib.glow("hit_ring", RED, 0.0)
    ring = lib.add("torus", "hit_ring", (X + 0.3, 5.92, 2.55), rot=(R(90), 0, 0), mat=ring_m,
                   coll=coll, major_radius=0.2, minor_radius=0.012)
    lib.key(ring, "scale", hit, (0.2, 0.2, 0.2))
    lib.key(ring, "scale", hit + ctx.sec(0.7), (2.5, 2.5, 2.5))
    lib.show_during([ring], [(hit, hit + ctx.sec(0.7))])
    rs = lib.emit_socket(ring_m)
    lib.key(rs, "default_value", 0, 0.0, "CONSTANT")
    lib.key(rs, "default_value", hit, 10.0)
    lib.key(rs, "default_value", hit + ctx.sec(0.7), 0.0)

    # Desk, console, chair, officer.
    desk_m = lib.material("desk", (0.08, 0.09, 0.085), rough=0.5, metal=0.3)
    lib.add("cube", "desk", (X, 3.3, 0.85), scale=(1.8, 0.5, 0.06), mat=desk_m, coll=coll)
    lib.add("cube", "desk_body", (X, 3.4, 0.42), scale=(1.8, 0.4, 0.42), mat=desk_m, coll=coll)
    lib.add("cube", "console", (X, 3.55, 1.1), rot=(R(-25), 0, 0), scale=(1.5, 0.05, 0.28),
            mat=desk_m, coll=coll)
    colors = [TEAL, AMBER, (0.3, 1.0, 0.3)]
    for i in range(14):
        for j in range(2):
            m = lib.glow(f"btn_{i}_{j}", colors[(i * 3 + j) % 3], 2.0 + ((i * 7 + j * 3) % 5))
            lib.add("cube", f"btn_{i}_{j}", (X - 1.25 + i * 0.19, 3.48 + j * 0.09, 1.07 + j * 0.05),
                    rot=(R(-25), 0, 0), scale=(0.04, 0.012, 0.03), mat=m, coll=coll)
    chair_m = lib.material("chair", (0.03, 0.03, 0.035), rough=0.7)
    lib.add("cube", "chair_seat", (X, 2.45, 0.5), scale=(0.32, 0.3, 0.05), mat=chair_m, coll=coll)
    lib.add("cube", "chair_back", (X, 2.12, 0.95), scale=(0.3, 0.04, 0.42), mat=chair_m, coll=coll)
    silhouette = lib.material("silhouette", (0.012, 0.013, 0.016), rough=0.8)
    officer("petrov_wide", coll, (X, 2.45, 0.0), silhouette)

    lib.light("screen_spill", "AREA", (X, 5.6, 2.4), 260.0, TEAL, size=6.5, target=(X, 2, 1.4),
              coll=coll)
    lib.light("desk_lamp", "SPOT", (X + 0.9, 3.0, 3.6), 220.0, AMBER, size=0.2,
              target=(X + 0.3, 3.3, 0.9), coll=coll, spot_deg=45)
    lib.light("back_fill", "AREA", (X - 3, -2, 3.5), 60.0, (0.4, 0.5, 0.8), size=4,
              target=(X, 2.5, 1.5), coll=coll)

    cam, tgt = lib.camera("cam_bunker", (X + 1.7, -1.6, 2.0), (X, 6.0, 2.3), lens=26,
                          dof_fstop=4.0)
    lib.key(cam, "location", s0, (X + 1.7, -1.6, 2.0))
    lib.key(cam, "location", s1, (X + 1.0, 0.6, 1.85))
    lib.key(tgt, "location", s0, (X, 6.0, 2.3))
    lib.key(tgt, "location", s1, (X + 0.2, 6.0, 2.4))
    ctx.bind_camera("bunker", cam)


def build_screen(ctx):
    coll = ctx.set_collection("set_screen", "screen")
    X = SCREEN_X
    s0, s1 = ctx.start("screen"), ctx.end("screen")
    on, m1, m5 = ctx.cue("alarm_on"), ctx.cue("missile_1"), ctx.cue("missile_5")

    back = lib.material("alert_back", (0, 0, 0), rough=0.4, emit=(0.0, 0.07, 0.06), strength=1.0)
    lib.add("plane", "alert_back", (X, 0.05, 0), rot=(R(90), 0, 0), scale=(4.0, 6.5, 1), mat=back,
            coll=coll)
    grid_m = lib.glow("alert_grid", TEAL, SCREEN_IDLE)
    screen_grid("alert_grid", coll, (X, 0.0, 0), (7.6, 12.6), (12, 20), grid_m, thickness=0.02)
    gc = lib.emit_color_socket(grid_m)
    lib.key(gc, "default_value", on - 1, (*TEAL, 1), "CONSTANT")
    lib.key(gc, "default_value", on, (*RED, 1), "CONSTANT")

    label_m = lib.glow("label", TEAL, 2.5)
    lib.text("label_ussr", "USSR", (X, -0.02, 4.6), size=0.55, mat=label_m, coll=coll)
    lib.text("label_usa", "USA", (X, -0.02, -4.6), size=0.55, mat=label_m, coll=coll)

    launch_m = lib.glow("launch_text", RED, 0.0)
    lib.text("launch", "LAUNCH", (X, -0.04, 2.6), size=1.05, mat=launch_m, coll=coll, extrude=0.02)
    ls = lib.emit_socket(launch_m)
    lib.key(ls, "default_value", 0, 0.0, "CONSTANT")
    lib.pulse(ls, "default_value", on, s1 + 1, ctx.sec(SIREN_PERIOD), 2.0, SCREEN_ALARM)

    # Count: "1" from missile_1, "5" from missile_5.
    for n, a, b in (("1", m1, m5 - 1), ("5", m5, s1)):
        cm = lib.glow(f"count_{n}", RED, SCREEN_ALARM)
        t = lib.text(f"count_{n}", n, (X + 1.75, -0.04, 0.9), size=1.6, mat=cm, coll=coll)
        lib.show_during([t], [(a, b)])

    # Missile markers rising from the USA edge, five in all, one then four.
    for i in range(5):
        appear = m1 if i == 0 else m5 + (i - 1) * 4
        mm = lib.glow(f"missile_{i}", RED, SCREEN_ALARM * 1.5)
        x0 = -1.6 + i * 0.8
        dot = lib.add("ico", f"missile_{i}", (X + x0, -0.05, -3.8), mat=mm, coll=coll,
                      radius=0.13, subdivisions=2)
        lib.show_during([dot], [(appear, s1)])
        lib.key(dot, "location", appear, (X + x0, -0.05, -3.8), "LINEAR")
        lib.key(dot, "location", s1, (X + x0 * 0.6 + 0.4, -0.05, -3.8 + 0.9 + (s1 - appear) / 60),
                "LINEAR")

    siren(ctx, "siren_screen", coll, (X + 3, -4, 3), (X, 0, 0), on, s1 + 1)

    cam, tgt = lib.camera("cam_screen", (X, -10.6, 0.0), (X, 0, 0), lens=35)
    lib.key(cam, "location", s0, (X, -10.6, 0.0))
    lib.key(cam, "location", on, (X, -10.2, 0.0))
    for k in range(1, 9):  # a short jolt when the alarm hits
        f = on + k * 2
        amp = 0.08 * (1 - k / 9)
        lib.key(cam, "location", f, (X + amp * (-1) ** k, -10.2, amp * 0.6 * (-1) ** (k + 1)))
    lib.key(cam, "location", s1, (X, -9.2, 0.15))
    ctx.bind_camera("screen", cam)


def build_petrov(ctx):
    coll = ctx.set_collection("set_petrov", "petrov")
    X = PETROV_X
    s0, s1 = ctx.start("petrov"), ctx.end("petrov")
    off_f = ctx.cue("alarm_off")

    silhouette = lib.material("silhouette_close", (0.02, 0.02, 0.024), rough=0.6)
    officer("petrov_close", coll, (X, 0, 0), silhouette, arms=False)
    wall = lib.material("far_wall", (0.02, 0.022, 0.025), rough=0.9)
    lib.add("plane", "far_wall", (X + 3.5, 2, 1.5), rot=(R(90), 0, R(90)), scale=(6, 3, 1), mat=wall,
            coll=coll)
    for i in range(18):  # out-of-focus console lights behind him
        m = lib.glow(f"bokeh_{i}", [TEAL, AMBER, TEAL][i % 3], 3.0 + (i % 4))
        lib.add("ico", f"bokeh_{i}", (X + 3.3, -1.5 + (i % 6) * 0.7, 0.9 + (i // 6) * 0.45), mat=m,
                coll=coll, radius=0.035, subdivisions=1)

    red = siren(ctx, "siren_petrov", coll, (X - 0.3, 1.6, 1.7), (X, 0, 1.6), s0, off_f)
    lib.key(red.data, "energy", s0, SIREN_W, "BEZIER")
    lib.key(red.data, "energy", off_f + ctx.sec(1.0), 0.0)
    calm = lib.light("calm_screen", "AREA", (X - 0.2, 1.4, 1.7), 0.0, TEAL, size=1.2,
                     target=(X, 0, 1.65), coll=coll)
    lib.key(calm.data, "energy", 0, 0.0, "CONSTANT")
    lib.key(calm.data, "energy", off_f, 0.0)
    lib.key(calm.data, "energy", off_f + ctx.sec(1.2), 90.0)
    lib.light("rim", "AREA", (X + 1.2, -1.4, 2.4), 40.0, (0.5, 0.6, 1.0), size=1.0,
              target=(X, 0, 1.65), coll=coll)

    # Three-quarter profile from his left, face toward the (red) screen light.
    # Head-and-shoulders with headroom; a slow push-in over the decision.
    cam, tgt = lib.camera("cam_petrov", (X - 2.4, 1.0, 1.72), (X, 0.12, 1.52), lens=50,
                          dof_fstop=2.0)
    lib.key(cam, "location", s0, (X - 2.4, 1.0, 1.72))
    lib.key(cam, "location", s1, (X - 1.9, 0.8, 1.70))
    ctx.bind_camera("petrov", cam)


def build_glint(ctx):
    coll = ctx.set_collection("set_glint", "glint")
    X = GLINT_X
    s0, s1 = ctx.start("glint"), ctx.end("glint")
    g = ctx.cue("glint")

    planet_m = earth_material("earth_day", (0.02, 0.06, 0.16), (0.12, 0.13, 0.10), 0.0)
    lib.add("sphere", "planet", (X, 0, -62), mat=planet_m, smooth=True, coll=coll,
            segments=192, ring_count=96, radius=60.0)
    lib.add("sphere", "planet_atmo", (X, 0, -62), mat=atmosphere_material("atmo_day", ICE, 0.5, blend=0.04),
            smooth=True, coll=coll, segments=128, ring_count=64, radius=61.2)

    cloud_m = lib.material("cloud", (0.9, 0.93, 1.0), rough=0.95)
    spots = [(0, 10, -1.3), (1.2, 11, -1.4), (-1.1, 9.4, -1.35), (0.6, 8.6, -1.25),
             (-0.4, 11.8, -1.5), (2.2, 9.8, -1.45), (-2.0, 10.6, -1.5)]
    for i, (cx, cy, cz) in enumerate(spots):
        lib.add("ico", f"cloud_{i}", (X + cx, cy, cz), scale=(1.4 + 0.2 * (i % 3), 1.0, 0.18),
                mat=cloud_m, smooth=True, coll=coll, radius=0.9, subdivisions=3)

    sun_dir = (-0.55, 0.8, 0.22)
    lib.light("sun", "SUN", (X, 0, 10), 4.0, WARM_SUN, size=0.6,
              target=(X - sun_dir[0], -sun_dir[1], -sun_dir[2] + 10), coll=coll)
    lib.add("sphere", "sun_disc", (X - 55, 80, 22), mat=lib.glow("sun_disc", WARM_SUN, 60.0),
            coll=coll, radius=3.0)

    glint_pt = (X + 0.2, 9.9, -1.05)
    sat_pt = (X + 3.4, 15.0, 7.5)
    sat, beacon = satellite("oko_glint", coll, scale=0.55)
    sat.location = sat_pt
    sat.rotation_euler = (R(20), R(-10), R(35))
    lib.key(lib.emit_socket(beacon), "default_value", 0, 20.0, "CONSTANT")

    spark_m = lib.glow("glint_spark", (1.0, 0.95, 0.85), 0.0)
    lib.add("ico", "glint_spark", glint_pt, mat=spark_m, coll=coll, radius=0.12, subdivisions=3)
    sp = lib.emit_socket(spark_m)
    lib.key(sp, "default_value", 0, 0.0, "CONSTANT")
    lib.key(sp, "default_value", g - 2, 0.0)
    lib.key(sp, "default_value", g + 4, 300.0)
    lib.key(sp, "default_value", g + ctx.sec(1.2), 80.0)

    beam_m = lib.glow("glint_beam", WARM_SUN, 6.0)
    sun_start = tuple(glint_pt[i] + 14 * sun_dir[i] for i in range(3))
    incoming = lib.beam("sun_ray", sun_start, glint_pt, beam_m, radius=0.025, coll=coll)
    bounce = lib.beam("glint_ray", glint_pt, sat_pt, lib.glow("glint_ray", (1.0, 0.4, 0.3), 9.0),
                      radius=0.03, coll=coll)
    lib.grow(incoming, 0, 0.0, "CONSTANT")
    lib.grow(incoming, g - ctx.sec(0.5), 0.0)
    lib.grow(incoming, g, 1.0)
    lib.grow(bounce, 0, 0.0, "CONSTANT")
    lib.grow(bounce, g, 0.0)
    lib.grow(bounce, g + ctx.sec(0.7), 1.0)

    # "fifteen years later": the year, faint, over the sky.
    after = ctx.beat("aftermath")["start_frame"]
    year_m = lib.glow("year", ICE, 0.0)
    year = lib.text("year", "1998", (X, 4.0, 6.2), size=1.3, mat=year_m, coll=coll, rot=(R(100), 0, 0))
    lib.show_during([year], [(after, s1)])
    ys = lib.emit_socket(year_m)
    lib.key(ys, "default_value", 0, 0.0, "CONSTANT")
    lib.key(ys, "default_value", after, 0.0)
    lib.key(ys, "default_value", after + ctx.sec(0.8), 5.0)

    cam, tgt = lib.camera("cam_glint", (X - 1.0, -12.0, 2.2), (X + 0.6, 10.0, 1.2), lens=30)
    lib.key(cam, "location", s0, (X - 1.0, -12.0, 2.2))
    lib.key(cam, "location", after, (X - 0.4, -6.0, 1.4))
    lib.key(cam, "location", s1, (X - 1.6, -16.0, 3.5))
    lib.key(tgt, "location", s0, (X + 0.6, 10.0, 1.2))
    lib.key(tgt, "location", after, (X + 1.2, 10.0, 1.8))
    lib.key(tgt, "location", s1, (X + 0.8, 10.0, 3.2))
    ctx.bind_camera("glint", cam)


def build(ctx):
    build_orbit(ctx)
    build_bunker(ctx)
    build_screen(ctx)
    build_petrov(ctx)
    build_glint(ctx)
