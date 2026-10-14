"""p1_configure_assets.py - batch-configure the meshes in ow_config.ASSETS (build plan step 1.8).

What it does, per ow_config.ASSETS slot (defaults in TUNABLES below):
  * Nanite: on for trees, bushes, boulders, mountains, cabin and fence. Grass,
    flowers, scatter and shore_scatter get Nanite only if every material on the
    mesh is opaque (masked Nanite foliage is expensive); otherwise they keep
    what the import gave them. Foliage slots also get Preserve Area (5.6) /
    Shape Preservation = Preserve Area (5.8) so crowns do not thin out.
  * Collision:
      trees      keep existing simple collision, else add a thin capsule on
                 the trunk (the crown stays walk-through)
      boulders,  "Use Complex Collision As Simple": the player stands on the
      cabin      real surface (fine for a few dozen placed actors)
      fence      keep existing simple collision, else add a box
      bushes, grass, flowers, scatter, shore_scatter
                 remove simple collision (walk through; PCG spawns thousands)
      mountains  unchanged (they stand outside the invisible walls)
  * Materials of PCG-scattered meshes get "Used with Instanced Static Meshes",
    and materials of Nanite meshes get "Used with Nanite" (Fab Megascans masters
    sometimes miss these; the editor then warns and cooked builds may render the
    default material).
  * Textures larger than TEXTURE_MAX_SIZE (2048 px) get Maximum Texture Size =
    2048 (8 GB GPUs; legacy tree packs ship 4K-8K atlases).
  * Reports each mesh's size, triangles, before -> after, and measures the fence
    mesh so you can set FENCE_SEGMENT_LENGTH_M in ow_config.py.
  Only assets under /Game are changed. Engine content (/Engine) is never touched.

How to run (build plan step 1.8; see 1.5 for running scripts)
  Fill ow_config.ASSETS first (step 1.7). Then Tools > Execute Python Script...
  and pick this file, or in the Output Log (Cmd):
      py "C:/.../OpenWorldDemo/OpenWorldTools/scripts/p1_configure_assets.py"
  Set DRY_RUN = True to only print what would change. Enabling Nanite on large
  scans rebuilds them: expect several minutes and a busy editor.

What it changes: the listed StaticMesh assets, their base materials and their
textures, and it saves them. It spawns no actors and does not touch the level.

Safe to re-run: yes. It only changes what is not already configured, so a
second run reports "no change" for finished meshes. Run it again after adding
assets to ow_config.ASSETS.

Undo: there is no Ctrl+Z (assets are saved, and an undo record of a Nanite
rebuild would hold a copy of every mesh in memory). The report and
Saved/OpenWorld/p1_configure_assets_log.txt list every before -> after value.
To revert one mesh, open it (double-click) and change it back:
  Details > Nanite Settings > Enable Nanite Support > Apply Changes;
  Collision menu > Remove Collision; Details > Collision > Collision Complexity.
For a material: Details > Usage > untick the flag. For a texture: Details >
Compression > Advanced > Maximum Texture Size = 0.

API names were checked against the UE 5.6 Python API. The 5.8 Nanite field
`shape_preservation` is used only when the engine has it (5.6 uses preserve_area).
"""
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unreal
import ow_common as ow
importlib.reload(ow)
cfg = ow.cfg

# ===========================================================================
# TUNABLES (build plan step 1.8)
# ===========================================================================
DRY_RUN = False                 # True = print the plan, change and save nothing
ONLY_SLOTS = []                 # e.g. ["boulders"] to process one slot; [] = every slot

# Nanite per slot: True = enable, False = disable, None = leave as imported,
# "auto" = enable only if every material on the mesh is opaque (else leave).
NANITE = {
    "trees": True, "bushes": True, "boulders": True, "mountains": True,
    "cabin": True, "fence": True,
    "grass": "auto", "flowers": "auto", "scatter": "auto", "shore_scatter": "auto",
}
# Slots that get Preserve Area / Shape Preservation when Nanite is on (foliage).
PRESERVE_AREA_SLOTS = ("trees", "bushes", "grass", "flowers", "shore_scatter")

# Collision per slot:
#   "trunk"   keep existing simple collision; if none, add a trunk capsule (below)
#   "complex" Collision Complexity = Use Complex Collision As Simple
#   "convex"  auto convex hulls (CONVEX_* below) if the mesh has none
#   "simple"  keep existing simple collision; if none, add a box
#   "none"    remove simple collision (and complex-as-simple)
#   "keep"    change nothing
COLLISION = {
    "trees": "trunk",
    "boulders": "complex", "cabin": "complex", "fence": "simple",
    "bushes": "none", "grass": "none", "flowers": "none", "scatter": "none", "shore_scatter": "none",
    "mountains": "keep",
}
TRUNK_RADIUS_PERCENT = 2.0       # trunk capsule radius, % of tree height
TRUNK_RADIUS_MIN_CM = 12.0       # cm
TRUNK_RADIUS_MAX_CM = 45.0       # cm
TRUNK_HEIGHT_PERCENT = 60.0      # capsule height from the tree base, % of tree height
TRUNK_MIN_TREE_HEIGHT_CM = 400.0 # smaller "trees" (saplings) get no capsule
CONVEX_HULL_COUNT = 8            # used by "convex"
CONVEX_MAX_HULL_VERTS = 24
CONVEX_HULL_PRECISION = 100000

TEXTURE_MAX_SIZE = 2048          # px; 0 = never touch textures
TEXTURE_MAX_SIZE_PER_SLOT = {}   # e.g. {"trees": 4096} if leaves look blurry
SET_MATERIAL_USAGE = True        # add Used with Instanced Static Meshes / Nanite to base materials
WRITE_LOG_FILE = True            # Saved/OpenWorld/p1_configure_assets_log.txt
# ===========================================================================

PCG_SLOTS = ("trees", "bushes", "grass", "flowers", "scatter", "shore_scatter")
COLLISION_RANK = {"none": 0, "keep": 1, "trunk": 2, "simple": 3, "convex": 4, "complex": 5}
SME = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
EAL = unreal.EditorAssetLibrary
CTF = unreal.CollisionTraceFlag
SHAPE_ENUM = getattr(unreal, "NaniteShapePreservation", None)   # 5.8 (5.7 not verified); None on 5.6
LINES = []


def out(msg, warn=False):
    LINES.append(("WARN " if warn else "") + msg)
    (ow.warn if warn else ow.log)(msg)


def normalize_ref(text):
    """'/Script/Engine.StaticMesh'/Game/A/B.B'' or '/Game/A/B.B' -> '/Game/A/B'."""
    s = (text or "").strip()
    if "'" in s:
        parts = s.split("'")
        if len(parts) >= 2:
            s = parts[1]
    s = s.strip().strip('"')
    head, _, last = s.rpartition("/")
    if head and "." in last:
        s = head + "/" + last.split(".")[0]
    return s


def in_game(obj_or_path):
    path = obj_or_path if isinstance(obj_or_path, str) else obj_or_path.get_path_name()
    return path.startswith("/Game/")


def ctf_name(value):
    for name in ("CTF_USE_DEFAULT", "CTF_USE_SIMPLE_AND_COMPLEX", "CTF_USE_SIMPLE_AS_COMPLEX",
                 "CTF_USE_COMPLEX_AS_SIMPLE"):
        if value == getattr(CTF, name):
            return name[4:].lower()
    return str(value)


# ---------------------------------------------------------------------------
# Collect the jobs (one per unique mesh, merged over slots)
# ---------------------------------------------------------------------------
class Job(object):
    def __init__(self, path, mesh):
        self.path = path
        self.mesh = mesh
        self.slots = []

    def merged(self, table, rank, default):
        values = [table.get(s, default) for s in self.slots]
        return max(values, key=rank) if values else default

    @property
    def nanite(self):
        return self.merged(NANITE, lambda v: {True: 3, "auto": 2, None: 1, False: 0}.get(v, 1), None)

    @property
    def preserve(self):
        return any(s in PRESERVE_AREA_SLOTS for s in self.slots)

    @property
    def collision(self):
        return self.merged(COLLISION, lambda v: COLLISION_RANK.get(v, 1), "keep")

    @property
    def texture_cap(self):
        caps = [TEXTURE_MAX_SIZE_PER_SLOT.get(s, TEXTURE_MAX_SIZE) for s in self.slots]
        return max(caps) if caps else TEXTURE_MAX_SIZE


def collect_jobs():
    jobs = {}
    for slot, entry in cfg.ASSETS.items():
        if ONLY_SLOTS and slot not in ONLY_SLOTS:
            continue
        paths = entry if isinstance(entry, list) else ([entry] if entry else [])
        for raw in paths:
            path = normalize_ref(raw)
            if not path:
                continue
            if not in_game(path):
                out("%s: %s is not under /Game - left unchanged (Engine content is never modified)" % (slot, path))
                continue
            if not EAL.does_asset_exist(path):
                out("%s: %s not found - run p1_check_project.py and fix the path (Copy Reference)" % (slot, path), True)
                continue
            asset = EAL.load_asset(path)
            if isinstance(asset, unreal.StaticMesh):
                jobs.setdefault(path, Job(path, asset)).slots.append(slot)
            elif isinstance(asset, unreal.Blueprint):
                out("%s: %s is a Blueprint - open it and configure its meshes by hand (see step 1.8)" % (slot, path))
            else:
                out("%s: %s is a %s, not a Static Mesh - skipped" % (slot, path, type(asset).__name__), True)
    return list(jobs.values())


# ---------------------------------------------------------------------------
# Mesh facts
# ---------------------------------------------------------------------------
def mesh_bounds(mesh):
    """(origin, extent) in cm, or None."""
    try:
        b = mesh.get_bounds()
        origin = b.get_editor_property("origin")
        extent = b.get_editor_property("box_extent")
        return (origin.x, origin.y, origin.z), (extent.x, extent.y, extent.z)
    except Exception:
        return None


def size_text(bounds):
    if not bounds:
        return "size ?"
    e = bounds[1]
    return "%.2f x %.2f x %.2f m" % (2 * e[0] / 100.0, 2 * e[1] / 100.0, 2 * e[2] / 100.0)


def materials_of(mesh):
    result = []
    try:
        for sm in mesh.get_editor_property("static_materials") or []:
            mi = sm.get_editor_property("material_interface")
            if mi:
                result.append(mi)
    except Exception as exc:
        out("  could not read the material slots: %s" % exc, True)
    return result


def is_opaque(mi):
    try:
        if isinstance(mi, unreal.MaterialInstance):
            ov = mi.get_editor_property("base_property_overrides")
            if ov.get_editor_property("override_blend_mode"):
                return ov.get_editor_property("blend_mode") == unreal.BlendMode.BLEND_OPAQUE
        base = mi.get_base_material()
        return base is not None and base.get_editor_property("blend_mode") == unreal.BlendMode.BLEND_OPAQUE
    except Exception:
        return False


def textures_of(mi):
    found = []
    m, depth = mi, 0
    while isinstance(m, unreal.MaterialInstance) and depth < 8:
        for tpv in m.get_editor_property("texture_parameter_values") or []:
            tex = tpv.get_editor_property("parameter_value")
            if tex:
                found.append(tex)
        m, depth = m.get_editor_property("parent"), depth + 1
    if isinstance(m, unreal.Material):   # the base material's own (non-parameter) textures too
        found.extend(unreal.MaterialEditingLibrary.get_used_textures(m) or [])
    return found


# ---------------------------------------------------------------------------
# Nanite
# ---------------------------------------------------------------------------
def preserve_is_set(ns):
    try:
        if SHAPE_ENUM is not None:
            # any value except None (Preserve Area or Voxelize) counts as set
            return "NONE" not in str(ns.get_editor_property("shape_preservation")).upper()
        return bool(ns.get_editor_property("preserve_area"))
    except Exception:
        return False


def set_preserve(ns):
    try:
        if SHAPE_ENUM is not None:
            ns.set_editor_property("shape_preservation", SHAPE_ENUM.PRESERVE_AREA)
        else:
            ns.set_editor_property("preserve_area", True)
        return True
    except Exception as exc:
        out("  Preserve Area not set (%s) - do this by hand: Static Mesh Editor > Details > Nanite Settings > "
            "Preserve Area (5.6) or Shape Preservation = Preserve Area (5.8) > Apply Changes" % exc, True)
        return False


def configure_nanite(job, notes):
    mesh = job.mesh
    ns = SME.get_nanite_settings(mesh)
    before = bool(ns.get_editor_property("enabled"))
    before_preserve = preserve_is_set(ns)
    want = job.nanite
    if want == "auto":
        if all(is_opaque(m) for m in materials_of(mesh)) and materials_of(mesh):
            want = True
        else:
            want = None
            notes.append("Nanite left as imported (masked or translucent material)")
    target = before if want is None else bool(want)
    add_preserve = target and job.preserve and not before_preserve
    after_text = "on" if target else "off"
    if target and (before_preserve or add_preserve):
        after_text += "+preserve"
    before_text = ("on" if before else "off") + ("+preserve" if before and before_preserve else "")
    if target == before and not add_preserve:
        return before_text, before_text, False, target
    if not DRY_RUN:
        ns.set_editor_property("enabled", target)
        if add_preserve and not set_preserve(ns):
            if target == before:
                # nothing else to change: skip the (slow) Nanite rebuild so re-runs stay "no change"
                return before_text, before_text, False, target
            after_text = after_text.replace("+preserve", "")
        SME.set_nanite_settings(mesh, ns, apply_changes=True)
    return before_text, after_text, True, target


# ---------------------------------------------------------------------------
# Collision
# ---------------------------------------------------------------------------
def set_complexity(mesh, flag):
    body = mesh.get_editor_property("body_setup")
    if body is None:
        out("  no Body Setup - do this by hand: Details > Collision > Collision Complexity", True)
        return False
    body.modify()
    body.set_editor_property("collision_trace_flag", flag)
    return True


def add_trunk_capsule(mesh, bounds):
    """Add an auto capsule, then shrink it onto the trunk (pivot = trunk base)."""
    _, e = bounds
    origin = bounds[0]
    height = 2.0 * e[2]
    bottom = origin[2] - e[2]
    radius = min(max(height * TRUNK_RADIUS_PERCENT / 100.0, TRUNK_RADIUS_MIN_CM), TRUNK_RADIUS_MAX_CM)
    total = max(height * TRUNK_HEIGHT_PERCENT / 100.0, 2.0 * radius)
    manual = ("do this by hand: open the mesh > Collision > Add Capsule Simplified Collision, then scale "
              "the capsule down to the trunk (radius about %.0f cm, %.1f m tall)" % (radius, total / 100.0))
    try:
        SME.add_simple_collisions(mesh, unreal.ScriptCollisionShapeType.CAPSULE)
        body = mesh.get_editor_property("body_setup")
        geom = body.get_editor_property("agg_geom")
        capsules = list(geom.get_editor_property("sphyl_elems"))
        if not capsules:
            raise RuntimeError("no capsule was added")
        cap = capsules[-1]
        cap.set_editor_property("center", unreal.Vector(0.0, 0.0, bottom + total / 2.0))
        cap.set_editor_property("rotation", unreal.Rotator(roll=0.0, pitch=0.0, yaw=0.0))
        cap.set_editor_property("radius", radius)
        cap.set_editor_property("length", max(total - 2.0 * radius, 0.0))
        capsules[-1] = cap
        geom.set_editor_property("sphyl_elems", capsules)
        body.modify()
        body.set_editor_property("agg_geom", geom)
        check = list(body.get_editor_property("agg_geom").get_editor_property("sphyl_elems"))
        if not check or abs(float(check[-1].get_editor_property("radius")) - radius) > 0.5:
            raise RuntimeError("the capsule size did not stick")
        return "trunk capsule r=%.0f cm h=%.1f m" % (radius, total / 100.0)
    except Exception as exc:
        # never leave the auto capsule: it wraps the whole crown and blocks the player metres away
        try:
            SME.remove_collisions(mesh)
        except Exception:
            pass
        out("  trunk capsule failed (%s) - %s" % (exc, manual), True)
        return None


def configure_collision(job, bounds, notes):
    mesh = job.mesh
    policy = job.collision
    simple = SME.get_simple_collision_count(mesh)
    convex = SME.get_convex_collision_count(mesh)
    ctf = SME.get_collision_complexity(mesh)
    is_cas = ctf == CTF.CTF_USE_COMPLEX_AS_SIMPLE
    before = "%d simple, %d convex, %s" % (simple, convex, ctf_name(ctf))
    actions = []

    if policy == "keep":
        return before, "unchanged", False
    if policy in ("none", "trunk", "convex", "simple") and is_cas:
        actions.append(("complexity project default", lambda: set_complexity(mesh, CTF.CTF_USE_DEFAULT)))
    if policy == "none" and simple > 0:
        actions.append(("removed simple collision", lambda: SME.remove_collisions(mesh)))
    elif policy == "trunk":
        if simple > 0:
            notes.append("kept its %d simple collision shape(s)" % simple)
        elif not bounds:
            out("  %s: size unknown, no trunk capsule added - add one by hand (Collision menu)" % job.path, True)
        elif 2.0 * bounds[1][2] < TRUNK_MIN_TREE_HEIGHT_CM:
            notes.append("shorter than %.1f m: no trunk capsule" % (TRUNK_MIN_TREE_HEIGHT_CM / 100.0))
        else:
            actions.append(("trunk capsule", lambda: add_trunk_capsule(mesh, bounds)))
    elif policy == "simple" and simple == 0:
        actions.append(("added box", lambda: SME.add_simple_collisions(mesh, unreal.ScriptCollisionShapeType.BOX)))
    elif policy == "convex" and convex == 0:
        actions.append(("added %d convex hulls" % CONVEX_HULL_COUNT,
                        lambda: SME.set_convex_decomposition_collisions(
                            mesh, CONVEX_HULL_COUNT, CONVEX_MAX_HULL_VERTS, CONVEX_HULL_PRECISION)))
    elif policy == "complex" and not is_cas:
        actions.append(("complex as simple", lambda: set_complexity(mesh, CTF.CTF_USE_COMPLEX_AS_SIMPLE)))

    if not actions:
        return before, "no change", False
    done = []
    for label, fn in actions:
        if DRY_RUN:
            done.append(label)
            continue
        result = fn()
        if result is False or result is None:
            continue
        done.append(result if isinstance(result, str) else label)
    return before, ", ".join(done) if done else "failed (see warning)", bool(done) and not DRY_RUN or DRY_RUN


# ---------------------------------------------------------------------------
# Materials and textures (shared between meshes, handled once)
# ---------------------------------------------------------------------------
def configure_materials(material_needs, changed_assets):
    for path, (base, flags) in sorted(material_needs.items()):
        missing = []
        for prop in sorted(flags):
            try:
                if not base.get_editor_property(prop):
                    missing.append(prop)
            except Exception as exc:
                out("material %s: cannot read %s (%s)" % (path, prop, exc), True)
        if not missing:
            continue
        if not DRY_RUN:
            for prop in missing:
                base.set_editor_property(prop, True)
            changed_assets[path] = base
        out("material %s: set %s%s" % (path.rsplit("/", 1)[-1], ", ".join(missing),
                                      " (dry run)" if DRY_RUN else " (shaders recompile in the background)"))


def configure_textures(texture_caps, changed_assets):
    count = 0
    for path, (tex, cap) in sorted(texture_caps.items()):
        if cap <= 0 or not isinstance(tex, unreal.Texture2D):
            continue
        try:
            size = max(int(tex.blueprint_get_size_x()), int(tex.blueprint_get_size_y()))
            current = int(tex.get_editor_property("max_texture_size"))
        except Exception as exc:
            out("texture %s: cannot read its size (%s)" % (path, exc), True)
            continue
        if size <= cap or (0 < current <= cap):
            continue
        if not DRY_RUN:
            tex.set_editor_property("max_texture_size", cap)
            changed_assets[path] = tex
        count += 1
        out("texture %s: %d px -> Maximum Texture Size %d%s" % (path.rsplit("/", 1)[-1], size, cap,
                                                               " (dry run)" if DRY_RUN else ""))
    return count


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def fence_report(job, bounds):
    if "fence" not in job.slots or not bounds:
        return
    ex, ey = bounds[1][0], bounds[1][1]
    length_m = 2.0 * ex / 100.0
    if ey > ex * 1.2:
        out("fence: the mesh is longer along Y (%.2f m) than X (%.2f m). Phase 7 expects it along +X: pick another "
            "mesh, or rotate it 90 degrees in the Static Mesh Editor (Details > Import Settings > Import Rotation, "
            "then Reimport)" % (2.0 * ey / 100.0, length_m), True)
    elif abs(length_m - cfg.FENCE_SEGMENT_LENGTH_M) > 0.05:
        out("fence: mesh is %.2f m long along X but FENCE_SEGMENT_LENGTH_M = %.2f. Set FENCE_SEGMENT_LENGTH_M = %.2f "
            "in ow_config.py (use the post-to-post distance if the mesh has a post at both ends)"
            % (length_m, cfg.FENCE_SEGMENT_LENGTH_M, length_m), True)
    else:
        out("fence: mesh length %.2f m matches FENCE_SEGMENT_LENGTH_M" % length_m)


def main():
    ow.log("==== Phase 1.8: configure meshes from ow_config.ASSETS%s ====" % (" (DRY RUN)" if DRY_RUN else ""))
    jobs = collect_jobs()
    if not jobs:
        ow.warn("No Static Mesh under /Game in ow_config.ASSETS. Fill it first (step 1.7), then run this again.")
        return
    changed_assets = {}
    material_needs = {}      # base material path -> (material, set of usage props)
    texture_caps = {}        # texture path -> (texture, cap)
    rows = []
    with unreal.ScopedSlowTask(len(jobs), "OW: configuring meshes (Nanite builds can take minutes)") as task:
        task.make_dialog(True)
        for job in jobs:
            if task.should_cancel():
                ow.warn("cancelled - meshes done so far are saved; run again to finish")
                break
            task.enter_progress_frame(1, "OW: " + job.path.rsplit("/", 1)[-1])
            notes = []
            bounds = mesh_bounds(job.mesh)
            try:
                tris = job.mesh.get_num_triangles(0)
            except Exception:
                tris = 0
            n_before, n_after, n_changed, nanite_on = configure_nanite(job, notes)
            c_before, c_after, c_changed = configure_collision(job, bounds, notes)
            if (n_changed or c_changed) and not DRY_RUN:
                changed_assets[job.path] = job.mesh
            mats = materials_of(job.mesh)
            for mi in mats:
                base = mi.get_base_material()
                if SET_MATERIAL_USAGE and base and in_game(base):
                    flags = material_needs.setdefault(base.get_path_name(), (base, set()))[1]
                    if any(s in PCG_SLOTS for s in job.slots):
                        flags.add("used_with_instanced_static_meshes")
                    if nanite_on:
                        flags.add("used_with_nanite")
                for tex in textures_of(mi):
                    if in_game(tex):
                        key = tex.get_path_name()
                        old = texture_caps.get(key, (tex, 0))[1]
                        texture_caps[key] = (tex, max(old, job.texture_cap))
            if not nanite_on and any(s in PCG_SLOTS for s in job.slots):
                try:
                    lods = SME.get_lod_count(job.mesh)
                except Exception:
                    lods = 0
                if lods == 1:
                    notes.append("WARNING: 1 LOD and no Nanite - add LODs (Details > LOD Settings > Number of "
                                 "LODs = 4 > Apply Changes) or set NANITE['%s'] = True" % job.slots[0])
            fence_report(job, bounds)
            rows.append((job, bounds, tris, n_before, n_after, c_before, c_after, notes))

    configure_materials(material_needs, changed_assets)
    n_tex = configure_textures(texture_caps, changed_assets) if TEXTURE_MAX_SIZE > 0 else 0

    saved = 0
    if not DRY_RUN:
        for path, asset in sorted(changed_assets.items()):
            if in_game(path) and EAL.save_loaded_asset(asset, only_if_is_dirty=False):
                saved += 1
            elif in_game(path):
                ow.warn("could not save %s - use File > Save All" % path)

    out("---- mesh report (slot | mesh | size W x D x H | LOD0 triangles | Nanite | collision) ----")
    for job, bounds, tris, n_before, n_after, c_before, c_after, notes in rows:
        out("%s | %s | %s | %s tris | Nanite %s -> %s | collision %s -> %s%s" % (
            "+".join(job.slots), job.path.rsplit("/", 1)[-1], size_text(bounds), tris, n_before, n_after,
            c_before, c_after, ("\n      " + "; ".join(notes)) if notes else ""),
            any(n.startswith("WARNING") for n in notes))
    out("Done: %d meshes checked, %d textures capped, %d assets saved%s." % (
        len(rows), n_tex, saved, " (DRY RUN: nothing changed)" if DRY_RUN else ""))

    if WRITE_LOG_FILE:
        try:
            folder = ow.output_dir()
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, "p1_configure_assets_log.txt")
            with open(path, "a", encoding="utf-8") as fh:
                fh.write("\n".join(LINES) + "\n\n")
            ow.log("log appended to " + path)
        except Exception as exc:
            ow.warn("could not write the log file: %s" % exc)


main()
