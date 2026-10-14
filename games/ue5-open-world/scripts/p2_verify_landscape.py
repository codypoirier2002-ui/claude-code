"""p2_verify_landscape.py - check that the imported landscape matches OW_Layout.json.

Build plan: Phase 2, step 2.3. Run it again after 2.4, after any sculpting in
2.5, and after every re-import.

How to run (see 1.5):
    Tools -> Execute Python Script... and pick
        <Project>/OpenWorldTools/scripts/p2_verify_landscape.py
    or type this in the Output Log command box (Cmd mode):
        py "C:/.../OpenWorldTools/scripts/p2_verify_landscape.py"
    Results are printed in the Output Log (Window -> Output Log).

What it checks:
  * the level: no World Partition landscape proxies, no template "Floor" left;
  * the main landscape actor (found with ow.frame()): scale 100/100/100,
    rotation 0/0/0, 504 m x 504 m collision extent, 4 x 4 components of
    126 quads, centred on world X=0 / Y=0 with its Z location at 0;
  * OW_Layout.json: still matches the values in ow_config.py;
  * heights: traces the ground at every probe in OW_Layout.json ("probes":
    lake centre, cabin pad, player spawn, three rock knolls) and compares the
    result with the height the generator wrote (tolerance in TUNABLES);
  * if heights do not match: re-samples the probes under other hypotheses
    (Y mirrored, X mirrored, X/Y swapped, rotated, other Z scale or offset,
    shifted) and reports the one that fits with the exact fix;
  * 2.4 settings for information: Nanite, collision mip levels, material,
    edit layers (5.6).
It prints a PASS / WARN / FAIL / INFO table and one RESULT line.

Creates / changes: nothing. The script is READ-ONLY: it spawns no actors,
edits no properties and saves nothing, so it is safe to re-run any number of
times and there is nothing to undo.
"""
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unreal
import ow_common as ow
importlib.reload(ow)
cfg = ow.cfg

# ---------------------------------------------------------------------------
# TUNABLES (build-plan step 2.3)
# ---------------------------------------------------------------------------
HEIGHT_TOLERANCE_CM = 10.0      # a probe passes if traced and expected height differ by at most this (cm).
                                # Heightmap step is 0.78 cm at Scale Z 100; the rest is interpolation.
EXTENT_TOLERANCE_CM = 100.0     # landscape width may differ from 504 m by this much (cm; 1 quad = 100 cm)
CENTRE_TOLERANCE_CM = 50.0      # landscape centre further than this from world X=0/Y=0 gives a WARN (cm)
Z_LOCATION_TOLERANCE_CM = 1.0   # landscape actor Z further than this from 0 gives a WARN (cm)
SCALE_TOLERANCE = 0.01          # actor scale must be within this of ow_config's scale (unitless)
ROTATION_TOLERANCE_DEG = 0.01   # actor rotation must be within this of 0 (degrees)
FRAME_TOLERANCE_CM = 100.0      # bounds centre vs. ow_common's computed centre (cm)
EXPECTED_COMPONENTS = cfg.LANDSCAPE_COMPONENTS ** 2                                       # 16 (2.2)
EXPECTED_COMPONENT_QUADS = cfg.LANDSCAPE_SECTION_QUADS * cfg.LANDSCAPE_SECTIONS_PER_COMPONENT  # 126 (2.2)
LOCAL_EDIT_MAX_FAILS = 2        # if at most this many probes fail, blame local sculpting, not the import

# ---------------------------------------------------------------------------
# Report table
# ---------------------------------------------------------------------------
ROWS = []        # (status, check, detail, fix)


def row(status, check, detail, fix=""):
    ROWS.append((status, check, detail, fix))


def emit(status, text):
    """Print in the Output Log colour that matches the status."""
    if status == "FAIL":
        ow.error(text)
    elif status == "WARN":
        ow.warn(text)
    else:
        ow.log(text)


def cm(v):
    return "%.0f" % v


def engine_version():
    try:
        return str(unreal.SystemLibrary.get_engine_version())
    except Exception:  # noqa: BLE001 - information only
        return ""


ENGINE = engine_version()
ENGINE_SHORT = ENGINE.split("-")[0].split("+")[0]   # e.g. "5.6.1"


# ---------------------------------------------------------------------------
# Fixes printed with the diagnosis (step numbers refer to the build plan)
# ---------------------------------------------------------------------------
FIX_FLIP_Y = ("Delete the Landscape actor and import again (2.2) with 'Flip Y Axis' set to the OPPOSITE of what "
              "you used (the plan uses OFF). Then run this script again.")
FIX_REGEN = ("The heightmap file itself is mirrored or rotated (the import panel can only flip Y). Regenerate it "
             "with tools/generate_heightmap.py (2.1) - do not open and re-save the PNG in an image editor - then "
             "delete the Landscape actor and import again (2.2) with Flip Y Axis OFF and Rotation 0, 0, 0.")
FIX_ROT = "First make sure Details > Transform > Rotation is 0, 0, 0 on the landscape. If it already is: " + FIX_REGEN
FIX_STALE = ("The landscape does not match this OW_Layout.json. Usual causes: (1) you changed ow_config.py and "
             "regenerated (2.1) but did not re-import (2.2) - delete the Landscape and import the new "
             "OW_Height_505.png; (2) you imported a different or older heightmap file; (3) OUTPUT_DIR in "
             "ow_config.py points at another folder than the file you imported; (4) you sculpted over the probe "
             "positions (2.5). Fix the cause, then run this script again.")


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
def check_layout(lay):
    """OW_Layout.json must have been written from the current ow_config.py values."""
    out_dir = ow.output_dir()
    png = os.path.join(out_dir, cfg.HEIGHTMAP_FILE)
    row("INFO", "Terrain files", out_dir + ("" if os.path.exists(png) else "  (no %s here!)" % cfg.HEIGHTMAP_FILE))

    def close(a, b, tol=0.011):
        return abs(float(a) - float(b)) <= tol

    stale = []
    land = lay.get("landscape", {})
    if int(land.get("resolution", -1)) != cfg.LANDSCAPE_RESOLUTION:
        stale.append("LANDSCAPE_RESOLUTION")
    if not close(land.get("scale_xy_cm", -1), cfg.LANDSCAPE_SCALE_XY_CM):
        stale.append("LANDSCAPE_SCALE_XY_CM")
    if not close(land.get("scale_z", -1), cfg.LANDSCAPE_SCALE_Z):
        stale.append("LANDSCAPE_SCALE_Z")
    if not close(lay.get("water_level_m", -999), cfg.WATER_LEVEL_M):
        stale.append("WATER_LEVEL_M")
    lake_c = lay.get("lake", {}).get("center_m", [None, None])
    if None in lake_c or not (close(lake_c[0], cfg.LAKE_CENTER_M[0]) and close(lake_c[1], cfg.LAKE_CENTER_M[1])):
        stale.append("LAKE_CENTER_M")
    if len(lay.get("lake", {}).get("spline_points_m", [])) != cfg.LAKE_SPLINE_POINTS:
        stale.append("LAKE_SPLINE_POINTS")
    cab = lay.get("cabin", {})
    cab_c = cab.get("center_m", [None, None])
    if None in cab_c or not (close(cab_c[0], cfg.CABIN_CENTER_M[0]) and close(cab_c[1], cfg.CABIN_CENTER_M[1])):
        stale.append("CABIN_CENTER_M")
    if not close(cab.get("pad_half_m", -1), cfg.CABIN_PAD_HALF_M):
        stale.append("CABIN_PAD_HALF_M")
    road = lay.get("road", {})
    if not close(road.get("half_width_m", -1), cfg.ROAD_HALF_WIDTH_M):
        stale.append("ROAD_HALF_WIDTH_M")
    pts = road.get("points_m", [])
    if not pts or not (close(pts[0][0], cfg.ROAD_CONTROL_POINTS_M[0][0])
                       and close(pts[0][1], cfg.ROAD_CONTROL_POINTS_M[0][1])):
        stale.append("ROAD_CONTROL_POINTS_M")
    if not close(lay.get("boundary", {}).get("half_extent_m", -1), cfg.HALF_SIZE_M - cfg.PLAYABLE_INSET_M):
        stale.append("PLAYABLE_INSET_M")
    if len(lay.get("mountains", [])) != cfg.MOUNTAIN_COUNT:
        stale.append("MOUNTAIN_COUNT")
    if len(lay.get("boulders", [])) > cfg.BOULDER_COUNT:
        stale.append("BOULDER_COUNT")
    if stale:
        row("WARN", "Layout vs config",
            "OW_Layout.json was generated with other values than ow_config.py has now: " + ", ".join(stale),
            "Regenerate the terrain files (2.1), delete the Landscape and import again (2.2), then run this again.")
    else:
        row("PASS", "Layout vs config", "OW_Layout.json matches ow_config.py (values not stored in the JSON, "
            "such as SEED or hill settings, cannot be checked)")
    if not lay.get("probes"):
        row("FAIL", "Layout probes", "OW_Layout.json has no 'probes' list",
            "Regenerate the terrain files with the current tools/generate_heightmap.py (2.1).")


def check_level(main):
    actors = ow.all_actors()
    proxies = [a for a in actors if isinstance(a, unreal.LandscapeStreamingProxy)]
    if proxies:
        row("FAIL", "Level type",
            "%d LandscapeStreamingProxy actors: this is a World Partition level" % len(proxies),
            "The plan uses a non-World-Partition level: File > New Level > Basic, save it as %s/%s (1.6), "
            "and import the landscape there (2.2)." % (cfg.MAPS_DIR, cfg.MAP_NAME))
    else:
        row("PASS", "Level type", "no World Partition landscape proxies")

    lands = ow.landscapes()
    if len(lands) > 1:
        names = ["'%s' (%.0f m)" % (ls.get_actor_label(), (cfg.LANDSCAPE_RESOLUTION - 1) * ls.get_actor_scale3d().x
                                     / 100.0) for ls in lands]
        row("INFO", "Landscapes", "%d found: %s; checking '%s' (closest to %.0f m)"
            % (len(lands), ", ".join(names), main.get_actor_label(), cfg.LANDSCAPE_SIZE_M))
    else:
        row("PASS", "Landscapes", "one: '%s'" % main.get_actor_label())

    floors = [a for a in actors if isinstance(a, unreal.StaticMeshActor)
              and a.get_actor_label().strip().lower() == "floor"]
    if floors:
        row("WARN", "Template floor", "a StaticMeshActor labelled 'Floor' is still in the level",
            "Select 'Floor' in the Outliner and press Delete (1.6), then save (Ctrl+S).")


def check_transform(fr):
    """Scale, rotation, extent, components, centre. Returns the collision bounds (origin, extent)."""
    act = fr.actor
    s = fr.scale
    want_xy, want_z = cfg.LANDSCAPE_SCALE_XY_CM, cfg.LANDSCAPE_SCALE_Z
    scale_txt = "%.2f, %.2f, %.2f" % (s.x, s.y, s.z)
    if (abs(s.x - want_xy) <= SCALE_TOLERANCE and abs(s.y - want_xy) <= SCALE_TOLERANCE
            and abs(s.z - want_z) <= SCALE_TOLERANCE):
        row("PASS", "Scale", scale_txt)
    else:
        row("FAIL", "Scale", "%s (want %.0f, %.0f, %.0f)" % (scale_txt, want_xy, want_xy, want_z),
            "Select the landscape > Details > Transform > Scale = %.0f, %.0f, %.0f (or delete it and import again "
            "with those values, 2.2). Then run this script again." % (want_xy, want_xy, want_z))

    r = act.get_actor_rotation()
    rot_txt = "roll %.2f, pitch %.2f, yaw %.2f" % (r.roll, r.pitch, r.yaw)
    if max(abs(r.roll), abs(r.pitch), abs(r.yaw)) <= ROTATION_TOLERANCE_DEG:
        row("PASS", "Rotation", rot_txt)
    else:
        row("FAIL", "Rotation", rot_txt,
            "Select the landscape > Details > Transform > Rotation = 0, 0, 0. Then run this script again.")

    origin, extent = act.get_actor_bounds(True)
    want_cm = cfg.LANDSCAPE_SIZE_M * 100.0
    wx, wy = 2.0 * extent.x, 2.0 * extent.y
    size_txt = "%.1f m x %.1f m" % (wx / 100.0, wy / 100.0)
    if wx < 1.0 or wy < 1.0:
        row("FAIL", "Extent", "the landscape has no collision bounds",
            "In a World Partition level the terrain lives in streaming proxies (use a Basic level, 1.6). Otherwise "
            "check Details > Collision on the landscape, or import it again (2.2).")
    elif abs(wx - want_cm) <= EXTENT_TOLERANCE_CM and abs(wy - want_cm) <= EXTENT_TOLERANCE_CM:
        row("PASS", "Extent", "%s (want %.0f m)" % (size_txt, cfg.LANDSCAPE_SIZE_M))
    else:
        quads_x = wx / max(abs(s.x), 1e-3)
        row("FAIL", "Extent", "%s, about %.0f quads per side (want %.0f m = %d quads)"
            % (size_txt, quads_x, cfg.LANDSCAPE_SIZE_M, cfg.LANDSCAPE_RESOLUTION - 1),
            "Delete the landscape and import again (2.2): Section Size 63x63 Quads, Sections Per Component "
            "2x2 Sections, Number of Components 4 x 4, Overall Resolution 505 x 505, Scale 100, 100, 100.")

    comps = list(act.get_components_by_class(unreal.LandscapeComponent))
    if not comps:
        row("INFO", "Components", "no LandscapeComponents on this actor (normal only in World Partition levels)")
    else:
        bases = sorted(set(int(c.section_base_x) for c in comps))
        steps = sorted(set(b - a for a, b in zip(bases, bases[1:])))
        quads = steps[0] if steps else None
        detail = "%d components, %s quads each" % (len(comps), quads if quads is not None else "?")
        if len(comps) == EXPECTED_COMPONENTS and (quads is None or quads == EXPECTED_COMPONENT_QUADS):
            row("PASS", "Components", detail)
        else:
            row("WARN", "Components", "%s (plan: %d components of %d quads)"
                % (detail, EXPECTED_COMPONENTS, EXPECTED_COMPONENT_QUADS),
                "Works, but differs from 2.2. To match the plan, import again with Section Size 63x63 Quads, "
                "Sections Per Component 2x2 Sections, Number of Components 4 x 4.")

    # ow_common assumes: actor location = corner of heightmap pixel (0, 0)
    fc = fr.center
    if wx >= 1.0:
        off = ((origin.x - fc.x) ** 2 + (origin.y - fc.y) ** 2) ** 0.5
        if off <= FRAME_TOLERANCE_CM:
            row("PASS", "Script frame", "bounds centre matches ow_common's landscape frame (%.0f cm apart)" % off)
        else:
            row("FAIL", "Script frame",
                "bounds centre (%s, %s) is %.0f m from where ow_common expects it (%s, %s)"
                % (cm(origin.x), cm(origin.y), off / 100.0, cm(fc.x), cm(fc.y)),
                "ow_common.LandscapeFrame assumes the actor location is the corner of heightmap pixel (0,0). "
                "Every later script would be off by this amount. Workaround: in ow_common.py, LandscapeFrame."
                "__init__, after 'self.origin = loc' add:  o, e = landscape.get_actor_bounds(True); "
                "self.origin = unreal.Vector(o.x - e.x, o.y - e.y, loc.z)")

    loc = act.get_actor_location()
    centre_off = ((origin.x ** 2 + origin.y ** 2) ** 0.5) if wx >= 1.0 else 0.0
    z_off = abs(loc.z)
    if centre_off <= CENTRE_TOLERANCE_CM and z_off <= Z_LOCATION_TOLERANCE_CM:
        row("PASS", "Placement", "centred on X=0, Y=0; actor at (%s, %s, %s) cm"
            % (cm(loc.x), cm(loc.y), cm(loc.z)))
    else:
        new_x = loc.x - (origin.x if wx >= 1.0 else 0.0)
        new_y = loc.y - (origin.y if wx >= 1.0 else 0.0)
        row("WARN", "Placement",
            "centre at (%s, %s) cm, actor Z %s cm; the plan centres it on 0, 0 with Z 0 (later scripts still work "
            "because they read the landscape's position)" % (cm(origin.x), cm(origin.y), cm(loc.z)),
            "To match the plan: select the landscape > Details > Transform > Location = %s, %s, 0 (cm)."
            % (cm(new_x), cm(new_y)))
    return origin, extent


def check_settings(act):
    """Step 2.4 values, for information. Each read is guarded: names can change after 5.6."""
    def read(name):
        try:
            return act.get_editor_property(name), None
        except Exception as exc:  # noqa: BLE001
            return None, exc

    nanite, err = read("enable_nanite")
    if err is not None:
        row("INFO", "Nanite", "could not read enable_nanite (%s)" % err)
    elif not nanite:
        row("PASS", "Nanite", "off (plan default, 2.4)")
    elif ENGINE_SHORT.startswith("5.8.0"):
        row("WARN", "Nanite", "on, engine %s: painted layers are reported broken with Nanite on 5.8.0" % ENGINE_SHORT,
            "Details > Nanite > untick Enable Nanite (2.4), or update to the newest 5.8.x hotfix.")
    else:
        row("INFO", "Nanite", "on: rebuild it after every sculpt/paint session (Details > Nanite > Rebuild Data)")

    for name, label in (("collision_mip_level", "Collision Mip Level"),
                        ("simple_collision_mip_level", "Simple Collision Mip Level")):
        val, err = read(name)
        if err is not None:
            row("INFO", label, "could not read %s (%s)" % (name, err))
        elif int(val) == 0:
            row("PASS", label, "0 (full resolution)")
        else:
            row("WARN", label, "%s (plan: 0)" % val,
                "Details > Collision > %s = 0 (2.4). Higher values make ground traces and footing coarser." % label)

    mat, err = read("landscape_material")
    if err is not None:
        row("INFO", "Material", "could not read landscape_material (%s)" % err)
    elif mat is None:
        row("INFO", "Material", "none yet: Phase 3 creates and assigns %s" % cfg.LANDSCAPE_MATERIAL_INSTANCE_NAME)
    else:
        row("INFO", "Material", mat.get_name())

    layers, err = read("can_have_layers_content")
    if err is not None:
        row("INFO", "Edit layers", "flag not readable in this version (5.7+: edit layers are always on)")
    elif layers:
        row("PASS", "Edit layers", "on")
    elif ENGINE_SHORT.startswith("5.6"):
        row("WARN", "Edit layers", "off",
            "5.6: delete the landscape and import again with 'Enable Edit Layers' ticked (2.2). Do not toggle it "
            "from Python.")
    else:
        row("INFO", "Edit layers", "flag reads False (engine '%s'); in 5.7+ edit layers are always on" % ENGINE_SHORT)


# ---------------------------------------------------------------------------
# Probe heights and diagnosis
# ---------------------------------------------------------------------------
def probe_list(lay):
    out = []
    for p in lay.get("probes", []):
        pos = p.get("position_m", [0.0, 0.0])
        out.append({"name": p.get("name", "probe"), "x": float(pos[0]), "y": float(pos[1]),
                    "h": float(p.get("expected_height_m", 0.0))})
    return out


def sample(fr, probes, transform):
    """Traced landscape Z (cm) at transform(x, y) for every probe; None where nothing was hit."""
    zs = []
    for p in probes:
        x, y = transform(p["x"], p["y"])
        w = fr.to_world(x, y)
        zs.append(ow.ground_z(w.x, w.y))
    return zs


def fit_line(xs, ys):
    """Least squares ys = a + b * xs. Returns (a, b, max residual) or None."""
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx < 1.0:
        return None
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    a = my - b * mx
    return a, b, max(abs(y - (a + b * x)) for x, y in zip(xs, ys))


def check_probes(fr, probes):
    """Returns (number failed, traced Z list)."""
    traced = sample(fr, probes, lambda x, y: (x, y))
    ow.log("")
    ow.log("Probe heights (tolerance %.0f cm; Z in world cm):" % HEIGHT_TOLERANCE_CM)
    ow.log("%-6s %-14s %8s %8s %12s %12s %9s" % ("RESULT", "PROBE", "X m", "Y m", "expected Z", "traced Z", "diff"))
    failed = 0
    for p, z in zip(probes, traced):
        want = fr.height_to_world_z(p["h"])
        if z is None:
            failed += 1
            emit("FAIL", "%-6s %-14s %8.1f %8.1f %12s %12s %9s"
                 % ("FAIL", p["name"], p["x"], p["y"], cm(want), "no hit", "-"))
            continue
        diff = z - want
        status = "PASS" if abs(diff) <= HEIGHT_TOLERANCE_CM else "FAIL"
        failed += status == "FAIL"
        emit(status, "%-6s %-14s %8.1f %8.1f %12s %12s %+9.1f"
             % (status, p["name"], p["x"], p["y"], cm(want), cm(z), diff))
    return failed, traced


def diagnose(fr, probes, traced, bounds_origin):
    """Find which transform of the layout explains the traced heights.

    Returns True when the only differences are local edits that nothing later depends on.
    """
    base_z = fr.origin.z
    want = [fr.height_to_world_z(p["h"]) for p in probes]

    # 1) Most probes fine -> local sculpting, not a wrong import
    ok = [z is not None and abs(z - w) <= HEIGHT_TOLERANCE_CM for z, w in zip(traced, want)]
    bad = [p["name"] for p, good in zip(probes, ok) if not good]
    if len(probes) - len(bad) >= 3 and len(bad) <= LOCAL_EDIT_MAX_FAILS:
        important = [n for n in bad if n != "rock_knoll"]
        fix = ("Only %s differ(s): most likely you sculpted there (2.5). " % ", ".join(bad))
        if important:
            fix += ("Later phases place the water, cabin and player from these heights: remove that sculpting "
                    "(hide or delete your sculpt edit layer) or regenerate and re-import (2.1-2.2).")
        else:
            fix += "Nothing later depends on the rock knoll heights, so you can ignore this."
        row("WARN", "Diagnosis", "the import is fine; heights changed locally", fix)
        return not important

    # 2) Test the 8 mirror/rotation hypotheses (+ a shift if the bounds disagree with the frame)
    hyps = [
        ("as planned", lambda x, y: (x, y), None),
        ("mirrored in Y (Flip Y Axis)", lambda x, y: (x, -y), FIX_FLIP_Y),
        ("mirrored in X", lambda x, y: (-x, y), FIX_REGEN),
        ("rotated 180 degrees", lambda x, y: (-x, -y), FIX_ROT),
        ("X and Y swapped", lambda x, y: (y, x), FIX_REGEN),
        ("X and Y swapped and mirrored", lambda x, y: (-y, -x), FIX_REGEN),
        ("rotated 90 deg clockwise", lambda x, y: (-y, x), FIX_ROT),
        ("rotated 90 deg counter-clockwise", lambda x, y: (y, -x), FIX_ROT),
    ]
    fc = fr.center
    dx_m, dy_m = (bounds_origin.x - fc.x) / 100.0, (bounds_origin.y - fc.y) / 100.0
    if abs(dx_m) > 1.0 or abs(dy_m) > 1.0:
        hyps.append(("shifted by %.0f m, %.0f m" % (dx_m, dy_m),
                     lambda x, y: (x + dx_m, y + dy_m),
                     "See the 'Script frame' row: ow_common computes positions from the wrong corner."))

    ow.log("")
    ow.log("Diagnosis - re-sampling the probes under other hypotheses:")
    ow.log("%-50s %5s %12s %10s %13s" % ("HYPOTHESIS", "hits", "max err cm", "Z factor", "fit err cm"))
    results = []
    for name, tf, fix in hyps:
        zs = traced if name == "as planned" else sample(fr, probes, tf)
        hits = [(z, w) for z, w in zip(zs, want) if z is not None]
        if len(hits) < len(probes):
            ow.log("%-50s %2d/%-2d %12s %10s %13s" % (name, len(hits), len(probes), "-", "-", "-"))
            continue
        direct = max(abs(z - w) for z, w in hits)
        fit = fit_line([w - base_z for _z, w in hits], [z - base_z for z, _w in hits])
        if fit:
            a, b, res = fit
            ow.log("%-50s %2d/%-2d %12.1f %10.3f %13.1f" % (name, len(hits), len(probes), direct, b, res))
        else:
            a, b, res = 0.0, 1.0, direct
            ow.log("%-50s %2d/%-2d %12.1f %10s %13s" % (name, len(hits), len(probes), direct, "-", "-"))
        results.append((name, fix, direct, a, b, res))

    exact = sorted((r for r in results if r[2] <= HEIGHT_TOLERANCE_CM), key=lambda r: r[2])
    if exact:
        name, fix, direct = exact[0][:3]
        if name == "as planned":
            row("PASS", "Diagnosis", "heights match as planned")
        else:
            row("FAIL", "Diagnosis", "the terrain is %s (max error %.1f cm under that hypothesis)" % (name, direct),
                fix)
        return False

    scaled = sorted((r for r in results if r[4] > 0.2 and r[5] <= HEIGHT_TOLERANCE_CM * max(1.0, abs(r[4]))),
                    key=lambda r: r[5])
    if scaled:
        name, fix, _direct, a, b, res = scaled[0]
        parts = []
        fixes = []
        if name != "as planned":
            parts.append("the terrain is %s" % name)
            fixes.append(fix)
        if abs(b - 1.0) > 0.02:
            parts.append("heights are %.3f x what OW_Layout.json expects" % b)
            fixes.append("Heights: the heightmap was generated for a different LANDSCAPE_SCALE_Z than ow_config.py "
                         "has now, or the PNG was edited. Regenerate (2.1), delete the Landscape and import again "
                         "(2.2) with Scale Z = %.0f." % cfg.LANDSCAPE_SCALE_Z)
        if abs(a) > HEIGHT_TOLERANCE_CM:
            parts.append("heights are offset by %+.0f cm" % a)
            fixes.append("Offset: the file's zero level is not 32768 (8-bit, edited or wrong file). Import the "
                         "16-bit OW_Height_505.png written by 2.1.")
        row("FAIL", "Diagnosis", "; ".join(parts) + " (fit error %.1f cm)" % res, " ".join(fixes))
        return False

    row("FAIL", "Diagnosis", "no hypothesis fits the traced heights", FIX_STALE)
    return False


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def report():
    ow.log("")
    ow.log("%-6s %-26s %s" % ("STATUS", "CHECK", "DETAIL"))
    for status, check, detail, fix in ROWS:
        emit(status, "%-6s %-26s %s" % (status, check, detail))
        if fix and status in ("FAIL", "WARN"):
            emit(status, "%-6s %-26s FIX: %s" % ("", "", fix))
    fails = sum(1 for r in ROWS if r[0] == "FAIL")
    warns = sum(1 for r in ROWS if r[0] == "WARN")
    ow.log("")
    if fails:
        ow.error("RESULT: FAIL (%d failed, %d warnings) - apply the FIX lines in order, then run "
                 "p2_verify_landscape.py again." % (fails, warns))
    else:
        ow.log("RESULT: PASS (%d warnings) - the landscape matches OW_Layout.json. Continue with 2.4." % warns)
    return fails == 0


def main():
    ow.log("=" * 72)
    ow.log("p2_verify_landscape (build plan 2.3) - engine '%s', Python %s"
           % (ENGINE or "unknown", sys.version.split()[0]))
    ow.log("=" * 72)
    try:
        lay = ow.layout()
    except RuntimeError as exc:
        row("FAIL", "OW_Layout.json", str(exc), "Run tools/generate_heightmap.py (2.1).")
        return report()
    check_layout(lay)

    try:
        fr = ow.frame()
    except RuntimeError as exc:
        row("FAIL", "Landscape", str(exc), "Create the landscape with Landscape Mode > Manage > New > Import from "
            "File (2.2), save the level, then run this script again.")
        return report()

    act = fr.actor
    loc = act.get_actor_location()
    ow.log("Landscape '%s' at (%s, %s, %s) cm" % (act.get_actor_label(), cm(loc.x), cm(loc.y), cm(loc.z)))
    check_level(act)
    bounds_origin, _extent = check_transform(fr)
    check_settings(act)

    probes = probe_list(lay)
    if probes:
        failed, traced = check_probes(fr, probes)
        if not failed:
            row("PASS", "Probe heights", "all %d probes within %.0f cm" % (len(probes), HEIGHT_TOLERANCE_CM))
        else:
            minor = diagnose(fr, probes, traced, bounds_origin)
            row("WARN" if minor else "FAIL", "Probe heights", "%d of %d probes off by more than %.0f cm or not hit"
                % (failed, len(probes), HEIGHT_TOLERANCE_CM))
    return report()


main()
