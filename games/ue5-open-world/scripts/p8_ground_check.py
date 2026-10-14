"""Phase 8 - ground check: finds props that float above or sink into the landscape.

Build-plan step: 8.6. Re-run it after any terrain edit, prop move, re-run of
p7_props.py, or PCG regeneration.

How to run (see build-plan step 1.5): Tools > Execute Python Script... and pick
    <Project>/OpenWorldTools/scripts/p8_ground_check.py
or type this in the Output Log command box (Cmd mode):
    py "C:/.../OpenWorldTools/scripts/p8_ground_check.py"
Stop Play first and open L_OpenWorld.

What it checks
  * Props: every actor tagged OW_GroundCheck (Phase 7 tags the cabin, fence and boulders)
    plus untagged StaticMeshActors in the OpenWorld/Props Outliner folders
    (INCLUDE_PROP_FOLDERS). It skips actors tagged OW_Boundary, OW_Mountain, OW_Water or
    OW_Lighting.
    For each prop it traces the landscape in 5 columns: the bounds centre and 4 corners
    pulled in by CORNER_INSET. Where the mesh has collision, it also traces the mesh
    underside in the same columns.
      gap  = largest air gap under the mesh (cm; > 0 means air)
      sink = lowest landscape height under the prop - bounds bottom (cm; > 0 means sunk)
    Status: FLOATING (gap > float_tol), BURIED (sink > bury_cm or sink/height > bury_frac),
    NO GROUND (no landscape under it), OK. The thresholds are per kind in KIND_RULES.
  * Player Start: capsule clearance above the ground, not inside a boundary wall or a
    prop's bounds, inside the walls, and exactly one in the level.
  * PCG (optional, CHECK_PCG_INSTANCES): samples the instances of the instanced static
    mesh components on the PCG Volume and lists the worst floating ones. Report only.
  Prints a table in the Output Log, selects the problem actors (press F in the viewport
  to frame them) and draws red debug boxes around them (DRAW_DEBUG_BOXES).

What it changes: nothing unless FIX = True. With FIX = True it moves FLOATING and
BURIED props up or down so their bottom sits the kind's fix sink below the lowest
ground sample. It also lifts or lowers a badly placed Player Start to the right
height. All moves are one undo step, "OW: ground check fix". It never saves: press
Ctrl+S if you keep the result.
Note: re-running p7_props.py puts props back at their scripted heights.

Safe to re-run: read-only by default; FIX only moves actors that fail.
Undo: Ctrl+Z once after a FIX run.

The Python calls were checked against the UE 5.6 API. The PCG classes are looked up
by name and skipped with a warning if the PCG plugin is off.
"""
import importlib, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unreal
import ow_common as ow
importlib.reload(ow)
cfg = ow.cfg

# =============================================================================
# TUNABLES (build-plan step 8.6)
# =============================================================================
FIX = False                       # True = move failing props and the Player Start (one Ctrl+Z undoes it)

# --- what to check ---
INCLUDE_PROP_FOLDERS = True       # also check untagged StaticMeshActors in OpenWorld/Props/...
SKIP_TAGS = (cfg.TAG_BOUNDARY, cfg.TAG_MOUNTAIN, cfg.TAG_WATER, cfg.TAG_LIGHTING)
CORNER_INSET = 0.5                # corner samples at +/- this fraction of the bounds half size (1.0 = exact corners)
USE_MESH_PROBES = True            # trace the mesh underside per column (needs collision on the mesh)

# --- thresholds per kind, all in cm (fractions are of the prop's bounds height) ---
#   float_tol     air gap under the mesh that counts as FLOATING
#   bury_cm       sink that counts as BURIED (None = not used)
#   bury_frac     sink / height that counts as BURIED
#   fix_sink_cm / fix_sink_frac   FIX puts the bottom this far below the lowest ground sample (larger of the two)
KIND_RULES = {
    "boulder": {"float_tol": 2.0, "bury_cm": None, "bury_frac": 0.50, "fix_sink_cm": 10.0, "fix_sink_frac": 0.15},
    "fence":   {"float_tol": 2.0, "bury_cm": 45.0, "bury_frac": 0.40, "fix_sink_cm": 20.0, "fix_sink_frac": 0.0},
    "cabin":   {"float_tol": 3.0, "bury_cm": 30.0, "bury_frac": 0.25, "fix_sink_cm": 10.0, "fix_sink_frac": 0.0},
    "tree":    {"float_tol": 2.0, "bury_cm": 60.0, "bury_frac": 0.15, "fix_sink_cm": 20.0, "fix_sink_frac": 0.0},
    "other":   {"float_tol": 3.0, "bury_cm": 60.0, "bury_frac": 0.30, "fix_sink_cm": 5.0, "fix_sink_frac": 0.0},
}

# --- Player Start ---
PAWN_CAPSULE_HALF_HEIGHT_CM = 96.0   # same value as in p8_player_setup.py (8.1)
PS_MIN_CLEARANCE_CM = 2.0            # Player Start capsule bottom must be at least this far above the ground
PS_MAX_CLEARANCE_CM = 50.0           # higher than this = the player visibly drops on spawn
PS_FIX_CLEARANCE_CM = 5.0            # FIX puts the taller capsule's bottom this far above the ground

# --- PCG instances (report only) ---
CHECK_PCG_INSTANCES = True
PCG_MAX_SAMPLES = 3000               # instances traced in total, spread over all PCG mesh components
PCG_FLOAT_TOL_CM = 5.0               # instance pivot this far above the ground = floating
PCG_BURY_TOL_CM = 100.0              # instance pivot this far below the ground = buried
PCG_REPORT_WORST = 10

# --- feedback in the viewport ---
SELECT_PROBLEMS = True
DRAW_DEBUG_BOXES = True
DEBUG_DRAW_SECONDS = 600.0           # boxes are also cleared at the start of the next run
# =============================================================================


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def actor_bounds(actor):
    """World AABB (centre, half size) of the colliding components; all components if none collide."""
    origin, ext = actor.get_actor_bounds(True)
    if ext.x + ext.y + ext.z < 1.0:
        origin, ext = actor.get_actor_bounds(False)
    return origin, ext


def boxes_overlap(c1, e1, c2, e2):
    return (abs(c1.x - c2.x) <= e1.x + e2.x and abs(c1.y - c2.y) <= e1.y + e2.y
            and abs(c1.z - c2.z) <= e1.z + e2.z)


def capsule_size(actor, default_half=92.0, default_radius=40.0):
    half = radius = 0.0
    cap = actor.get_component_by_class(unreal.CapsuleComponent)
    if cap:
        half = float(cap.get_scaled_capsule_half_height())
        radius = float(cap.get_scaled_capsule_radius())
    if half < 1.0 or radius < 1.0:
        half, radius = default_half, default_radius
    return half, radius


def world_to_layout(fr, loc):
    return ((loc.x - fr.origin.x) / fr.cm_per_m_x - fr.half_m, (loc.y - fr.origin.y) / fr.cm_per_m_y - fr.half_m)


def folder_of(actor):
    return str(actor.get_folder_path())


def in_folder(actor, folder):
    f = folder_of(actor)
    return f == folder or f.startswith(folder + "/")


def kind_of(actor):
    label = actor.get_actor_label().lower()
    if in_folder(actor, cfg.OUTLINER["fence"]) or "fence" in label:
        return "fence"
    if in_folder(actor, cfg.OUTLINER["boulders"]) or "boulder" in label or "rock" in label:
        return "boulder"
    if "cabin" in label or "house" in label:
        return "cabin"
    if "tree" in label:
        return "tree"
    return "other"


def move_z(actor, dz):
    actor.modify()
    root = actor.root_component
    if root:
        root.modify()
    loc = actor.get_actor_location()
    actor.set_actor_location(unreal.Vector(loc.x, loc.y, loc.z + dz), False, True)


def mesh_components(actor):
    comps = []
    for c in actor.get_components_by_class(unreal.StaticMeshComponent):
        if not isinstance(c, unreal.InstancedStaticMeshComponent):
            comps.append(c)
    return comps


def mesh_underside(comps, x, y, z_low, z_high):
    """Lowest mesh surface in the column (x, y), traced upward against each component only."""
    best = None
    for c in comps:
        r = c.line_trace_component(unreal.Vector(x, y, z_low), unreal.Vector(x, y, z_high), True, False, False)
        if r:
            z = r[0].z
            best = z if best is None else min(best, z)
    return best


# ---------------------------------------------------------------------------
# Props
# ---------------------------------------------------------------------------
def prop_candidates():
    out = []
    for a in ow.all_actors():
        if isinstance(a, (unreal.LandscapeProxy, unreal.PlayerStart)):
            continue
        if any(ow.has_tag(a, t) for t in SKIP_TAGS):
            continue
        if ow.has_tag(a, cfg.TAG_GROUND_CHECK):
            out.append(a)
        elif INCLUDE_PROP_FOLDERS and isinstance(a, unreal.StaticMeshActor) and in_folder(a, cfg.OUTLINER["props"]):
            out.append(a)
    return out


def analyse(actor):
    kind = kind_of(actor)
    rules = KIND_RULES.get(kind, KIND_RULES["other"])
    origin, ext = actor_bounds(actor)
    bottom = origin.z - ext.z
    height = max(2.0 * ext.z, 1.0)
    columns = [(origin.x, origin.y)] + [(origin.x + sx * ext.x * CORNER_INSET, origin.y + sy * ext.y * CORNER_INSET)
                                        for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1))]
    comps = mesh_components(actor) if USE_MESH_PROBES else []
    grounds, gaps = [], []
    for x, y in columns:
        g = ow.ground_z(x, y)
        if g is None:
            continue
        grounds.append(g)
        m = mesh_underside(comps, x, y, bottom - 100.0, origin.z + ext.z + 10.0) if comps else None
        if m is not None:
            gaps.append(m - g)
    r = {"actor": actor, "label": actor.get_actor_label(), "kind": kind, "height": height, "origin": origin,
         "ext": ext, "gap": None, "sink": None, "dz": 0.0, "probes": len(gaps)}
    if not grounds:
        r["status"] = "NO GROUND"
        return r
    g_min = min(grounds)
    gap = max(gaps) if gaps else bottom - g_min
    # sink is measured from the LOWEST ground sample: that is the shallowest burial, and it is the
    # same reference p7_props.py places props by and FIX moves them to (so a fixed prop reads OK).
    sink = g_min - bottom
    r["gap"], r["sink"] = gap, sink
    target = max(rules["fix_sink_cm"], rules["fix_sink_frac"] * height)
    if gap > rules["float_tol"]:
        r["status"] = "FLOATING"
        # same reference as BURIED and p7_props.py: bottom to (lowest ground - target); never move a
        # floating prop up (possible only if its bounds reach below its mesh underside)
        r["dz"] = min((g_min - target) - bottom, 0.0) or -(gap + target)
    elif (rules["bury_cm"] is not None and sink > rules["bury_cm"]) or sink / height > rules["bury_frac"]:
        r["status"] = "BURIED"
        r["dz"] = (g_min - target) - bottom
    else:
        r["status"] = "OK"
    return r


def fmt(v):
    return "     -" if v is None else "%+6.0f" % v


# ---------------------------------------------------------------------------
# Player Start
# ---------------------------------------------------------------------------
def check_player_starts(fr, walls, props):
    """Returns a list of dicts: actor, label, status, issues, dz."""
    starts = [a for a in ow.all_actors() if isinstance(a, unreal.PlayerStart)]
    results = []
    if not starts:
        ow.warn("PLAYER START: none in the level - the player spawns at 0,0,0. Run scripts/p8_player_setup.py (8.2).")
        return results
    if len(starts) > 1:
        ow.warn("PLAYER START: %d in the level - the game picks one of them. Keep one (re-run p8_player_setup.py)."
                % len(starts))
    half_ext_m = float(ow.layout()["boundary"]["half_extent_m"])
    for ps in starts:
        loc = ps.get_actor_location()
        half, radius = capsule_size(ps)
        issues, dz = [], 0.0
        ground = ow.ground_z(loc.x, loc.y)
        if ground is None:
            issues.append("no landscape below it")
        else:
            clear = loc.z - half - ground
            pawn_clear = loc.z - PAWN_CAPSULE_HALF_HEIGHT_CM - ground
            if clear < PS_MIN_CLEARANCE_CM:
                issues.append("capsule bottom only %.0f cm above the ground (BADsize, spawns in the ground)" % clear)
            if pawn_clear < 0.0:
                issues.append("pawn capsule (half height %.0f cm) would start %.0f cm inside the ground"
                              % (PAWN_CAPSULE_HALF_HEIGHT_CM, -pawn_clear))
            if clear > PS_MAX_CLEARANCE_CM:
                issues.append("capsule bottom %.0f cm above the ground - the player drops on spawn" % clear)
            if issues:
                dz = ground + max(half, PAWN_CAPSULE_HALF_HEIGHT_CM) + PS_FIX_CLEARANCE_CM - loc.z
        box_e = unreal.Vector(radius, radius, half)
        for w in walls:
            wo, we = actor_bounds(w)
            if boxes_overlap(loc, box_e, wo, we):
                issues.append("inside boundary wall %s" % w.get_actor_label())
        for p in props:
            po, pe = actor_bounds(p)
            if boxes_overlap(loc, box_e, po, pe):
                issues.append("overlaps the bounds of prop %s (check for the BADsize icon)" % p.get_actor_label())
        x_m, y_m = world_to_layout(fr, loc)
        if max(abs(x_m), abs(y_m)) > half_ext_m - radius / 100.0:
            issues.append("outside the boundary walls (layout %.1f, %.1f m; walls at +/-%.0f m)" % (x_m, y_m, half_ext_m))
        clearance = None if ground is None else loc.z - half - ground
        results.append({"actor": ps, "label": ps.get_actor_label(), "issues": issues, "dz": dz,
                        "status": "PROBLEM" if issues else "OK", "clearance": clearance})
    return results


# ---------------------------------------------------------------------------
# PCG instances
# ---------------------------------------------------------------------------
def pcg_mesh_components():
    classes = []
    for name in ("PCGVolume", "PCGPartitionActor"):
        cls = getattr(unreal, name, None)      # None when the PCG plugin is disabled
        if cls is not None:
            classes.append(cls)
    owners = [a for a in ow.all_actors()
              if (classes and isinstance(a, tuple(classes))) or in_folder(a, cfg.OUTLINER["pcg"])]
    comps = []
    for a in owners:
        for c in a.get_components_by_class(unreal.InstancedStaticMeshComponent):
            comps.append((a, c))
    return comps


def check_pcg_instances():
    try:
        comps = pcg_mesh_components()
    except Exception as exc:  # noqa: BLE001
        ow.warn("PCG: could not list PCG components (%s) - skipped. Check vegetation by eye instead." % exc)
        return None
    if not comps:
        ow.log("PCG: no instanced meshes found on a PCG Volume (not generated yet, or PCG is off) - skipped")
        return None
    counts = [int(c.get_instance_count()) for _, c in comps]
    total = sum(counts)
    if total == 0:
        ow.log("PCG: the PCG mesh components have no instances - press Generate on the PCG Volume first")
        return None
    sampled, floating, buried = 0, [], 0
    with unreal.ScopedSlowTask(len(comps), "OW ground check: PCG instances") as task:
        task.make_dialog(True)
        for (owner, comp), n in zip(comps, counts):
            if task.should_cancel():
                break
            task.enter_progress_frame(1.0)
            if n == 0:
                continue
            want = max(1, int(round(PCG_MAX_SAMPLES * float(n) / total)))
            step = max(1, n // want)
            mesh = comp.static_mesh
            mesh_name = mesh.get_name() if mesh else "?"
            for i in range(0, n, step):
                t = comp.get_instance_transform(i, True)
                if t is None:
                    continue
                p = t.translation
                g = ow.ground_z(p.x, p.y)
                if g is None:
                    continue
                sampled += 1
                d = p.z - g
                if d > PCG_FLOAT_TOL_CM:
                    floating.append((d, mesh_name, i, p))
                elif d < -PCG_BURY_TOL_CM:
                    buried += 1
    floating.sort(key=lambda e: -e[0])
    ow.log("PCG: sampled %d of %d instances in %d mesh components: %d floating > %.0f cm, %d buried > %.0f cm"
           % (sampled, total, len(comps), len(floating), PCG_FLOAT_TOL_CM, buried, PCG_BURY_TOL_CM))
    for d, mesh_name, i, p in floating[:PCG_REPORT_WORST]:
        ow.warn("PCG floating %+6.0f cm  %s instance %d at (%.0f, %.0f, %.0f) cm" % (d, mesh_name, i, p.x, p.y, p.z))
    return {"sampled": sampled, "total": total, "floating": len(floating), "buried": buried}


# ---------------------------------------------------------------------------
def main():
    world = ow.editor_world()
    fr = ow.frame()
    if DRAW_DEBUG_BOXES:
        unreal.SystemLibrary.flush_persistent_debug_lines(world)

    props = prop_candidates()
    results = []
    with unreal.ScopedSlowTask(max(1, len(props)), "OW ground check: props") as task:
        task.make_dialog(True)
        for a in props:
            if task.should_cancel():
                break
            task.enter_progress_frame(1.0, a.get_actor_label())
            results.append(analyse(a))

    ow.log("%-9s %-7s %6s %6s %6s %3s  %s" % ("STATUS", "KIND", "GAP", "SINK", "HEIGHT", "MP", "ACTOR  (cm; MP = mesh probes)"))
    order = {"NO GROUND": 0, "FLOATING": 1, "BURIED": 2, "OK": 3}
    for r in sorted(results, key=lambda r: (order[r["status"]], r["label"])):
        line = "%-9s %-7s %s %s %6.0f %3d  %s" % (r["status"], r["kind"], fmt(r["gap"]), fmt(r["sink"]),
                                                   r["height"], r["probes"], r["label"])
        if r["status"] == "OK":
            ow.log(line)
        else:
            ow.warn(line)

    walls = ow.managed(cfg.TAG_BOUNDARY)
    if not walls:
        ow.warn("no boundary walls (tag %s) - run scripts/p8_player_setup.py (8.2)" % cfg.TAG_BOUNDARY)
    starts = check_player_starts(fr, walls, props)
    for s in starts:
        if s["issues"]:
            for issue in s["issues"]:
                ow.warn("PLAYER START %s: %s" % (s["label"], issue))
        else:
            ow.log("PLAYER START %s: OK, capsule bottom %.0f cm above the ground" % (s["label"], s["clearance"]))

    pcg = check_pcg_instances() if CHECK_PCG_INSTANCES else None

    problems = [r for r in results if r["status"] != "OK"]
    fixable = [r for r in problems if r["status"] in ("FLOATING", "BURIED")]
    ps_fixable = [s for s in starts if abs(s["dz"]) > 0.5]
    if FIX and (fixable or ps_fixable):
        with unreal.ScopedEditorTransaction("OW: ground check fix"):
            for r in fixable:
                move_z(r["actor"], r["dz"])
                ow.log("FIX %s: moved %+.0f cm" % (r["label"], r["dz"]))
            for s in ps_fixable:
                move_z(s["actor"], s["dz"])
                ow.log("FIX Player Start %s: moved %+.0f cm" % (s["label"], s["dz"]))
        ow.log("FIX done - re-run this script to confirm, then Ctrl+S to keep (Ctrl+Z to undo)")
    elif (fixable or ps_fixable) and not FIX:
        ow.log("to repair FLOATING/BURIED props and the Player Start height automatically, "
               "set FIX = True in TUNABLES and re-run")

    flagged = [r["actor"] for r in problems] + [s["actor"] for s in starts if s["issues"]]
    if DRAW_DEBUG_BOXES:
        red = unreal.LinearColor(r=1.0, g=0.0, b=0.0, a=1.0)
        for r in problems:
            unreal.SystemLibrary.draw_debug_box(world, r["origin"], r["ext"], red,
                                                unreal.Rotator(roll=0.0, pitch=0.0, yaw=0.0),
                                                DEBUG_DRAW_SECONDS, 5.0)
    if SELECT_PROBLEMS and flagged:
        ow.actors_subsystem().set_selected_level_actors(flagged)

    counts = {k: sum(1 for r in results if r["status"] == k) for k in order}
    ps_ok = bool(starts) and all(not s["issues"] for s in starts)
    ow.log("ground check: %d props - %d OK, %d FLOATING, %d BURIED, %d NO GROUND; Player Start %s; PCG %s%s"
           % (len(results), counts["OK"], counts["FLOATING"], counts["BURIED"], counts["NO GROUND"],
              "OK" if ps_ok else "CHECK WARNINGS",
              "%d/%d sampled, %d floating" % (pcg["sampled"], pcg["total"], pcg["floating"]) if pcg else "skipped",
              " (FIX applied)" if FIX and (fixable or ps_fixable) else ""))


main()
