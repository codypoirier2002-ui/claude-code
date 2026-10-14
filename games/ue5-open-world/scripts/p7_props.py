"""Place the cabin, the roadside fence and boulders, and the distant mountain ring.

Build-plan step: 7.2 (run again after 7.3 and 7.5 as described there).

How to run (Play stopped, L_OpenWorld open):
  Tools > Execute Python Script... > <Project>/OpenWorldTools/scripts/p7_props.py
  or in the Output Log (Cmd mode):  py "C:/.../OpenWorldTools/scripts/p7_props.py"

What it creates / changes:
  * Cabin on the flattened pad, turned so its +X side faces the lake (layout yaw).
  * One fence piece per OW_Layout.json fence segment. Each piece spans start -> end,
    is stretched to the exact segment length and tilted so both ends (posts) sit on
    the ground. Works with any pivot: the mesh's bounding box is measured.
  * The roadside boulders (yaw and scale from the layout), slightly buried, and pushed
    off the road if a big mesh would overlap it.
  * Option A of the distant mountains: ASSETS["mountains"] meshes scaled up (layout
    scale), cycled by mesh_index, bases sunk to mountain_base_height_m, collision off.
  * Every prop is dropped onto the landscape with line traces that only hit the
    landscape (ow.ground_z), then sunk by the TUNABLES amounts.
  * Empty ASSETS slots use Engine basic shapes as placeholders; the log says which.
  * Reports where to import the Option B backdrop landscape (7.3) and checks it if
    one exists. It never changes the backdrop.
  Tags:  cabin / fence / boulders: OW_Managed, OW_Prop, OW_GroundCheck, OW_PCGExclude
         plus OW_Cabin / OW_Fence / OW_Boulder.  Mountains: OW_Managed, OW_Mountain.
  Outliner folders: OpenWorld/Props, OpenWorld/Props/Fence, OpenWorld/Props/Boulders,
         OpenWorld/Backdrop.
  Labels: OW_Cabin, OW_Fence_01.., OW_Boulder_01.., OW_Mountain_01..
  Saves the level at the end (SAVE_LEVEL).

Safe to re-run: each group set to "place" first deletes the actors this script placed
for it (tagged OW_Managed + the group tag), so manual moves of those actors are lost.
Set a group to "keep" to leave it alone. Actors without the OW_Managed tag are never
touched.

Undo: Ctrl+Z right after the run (one transaction), or delete the actors in the
Outliner folders above. API names checked against the UE 5.6 Python API.
"""
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unreal
import ow_common as ow
importlib.reload(ow)
cfg = ow.cfg

import math  # noqa: E402

# ===========================================================================
# TUNABLES (build-plan step in brackets)
# ===========================================================================
# What to do with each group [7.2]:
#   "place"  = delete the ones this script placed before, then place them again
#   "keep"   = leave them exactly as they are (keeps your manual tweaks, 7.5)
#   "remove" = delete them and place nothing
CABIN = "place"
FENCE = "place"
BOULDERS = "place"
MOUNTAINS = "place"          # "remove" if you use only the Option B backdrop landscape [7.3]

# Cabin [7.2]
CABIN_YAW_OFFSET_DEG = 0.0   # added to the layout yaw. 90 / 180 / -90 if the door is not on the mesh's +X side
CABIN_SCALE = 1.0            # uniform scale for a real cabin asset
CABIN_SINK_CM = 10.0         # cm below the lowest ground point under the cabin
PLACEHOLDER_CABIN_SIZE_M = (5.0, 7.0, 3.5)   # X (towards the lake) x Y x Z of the placeholder cube

# Fence [7.2]
FENCE_MESH_AXIS = "+X"       # axis the fence mesh runs along: "+X", "-X", "+Y" or "-Y"
FENCE_STRETCH_TO_FIT = True  # scale along that axis = segment length / FENCE_SEGMENT_LENGTH_M
FENCE_FOLLOW_SLOPE = True    # tilt each piece so both ends sit on the ground
FENCE_MAX_PITCH_DEG = 20.0   # steeper slopes are clamped (the low end is then buried a bit more)
FENCE_SINK_CM = 15.0         # cm the posts go into the ground
PLACEHOLDER_FENCE_SIZE_M = (0.10, 1.0)       # thickness, height of the placeholder panel

# Boulders [7.2]
BOULDER_SCALE_MULTIPLIER = 1.0   # multiplies the layout scale (0.7 - 1.6)
BOULDER_SINK_FRACTION = 0.15     # sink = this x boulder height ...
BOULDER_MIN_SINK_CM = 10.0       # ... but at least this many cm
BOULDER_ROAD_CLEARANCE_M = 0.3   # boulders closer than this to the road edge are pushed away
PLACEHOLDER_BOULDER_SIZE_M = (1.4, 1.1, 0.8)  # placeholder sphere size at layout scale 1

# Mountains, Option A [7.2]
MOUNTAIN_SCALE_MULTIPLIER = 1.0  # multiplies the layout scale (18 - 34)
MOUNTAIN_ALIGN = "bottom"        # "bottom": the mesh's lowest point goes to mountain_base_height_m; "pivot": its pivot does
MOUNTAIN_MIN_TOP_M = 180.0       # m above the landscape base. Lower tops are scaled up to reach it; 0 = off
MOUNTAIN_HEIGHT_VARIATION = 0.35 # scaled-up tops spread from MIN_TOP to MIN_TOP x (1 + this), bigger layout scale = taller
MOUNTAIN_CAST_SHADOW = True      # False = cheaper, but the mountains look flat
MOUNTAIN_COLLISION = False       # they stand outside the invisible walls
PLACEHOLDER_MOUNTAIN_WIDTH = 1.0 # placeholder cones: base width / height (wider ones poke through the rim corners)

SAVE_LEVEL = True                # save L_OpenWorld at the end
# ===========================================================================

PROP_TAGS = [cfg.TAG_PROP, cfg.TAG_GROUND_CHECK, cfg.TAG_PCG_EXCLUDE]
TAG_CABIN, TAG_FENCE, TAG_BOULDER = "OW_Cabin", "OW_Fence", "OW_Boulder"
MODES = ("place", "keep", "remove")
SUMMARY = []
WARN_COUNT = [0]


def warn(msg):
    WARN_COUNT[0] += 1
    ow.warn(msg)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def vec(x, y, z):
    return unreal.Vector(float(x), float(y), float(z))


def bounds(actor):
    """World AABB (origin, half extent). Colliding parts first, so editor-only
    Blueprint components (arrows, billboards) do not widen it."""
    origin, ext = actor.get_actor_bounds(True)
    if ext.x < 1.0 and ext.y < 1.0 and ext.z < 1.0:
        origin, ext = actor.get_actor_bounds(False)
    return origin, ext


def move_by(actor, dx=0.0, dy=0.0, dz=0.0):
    loc = actor.get_actor_location()
    actor.set_actor_location(vec(loc.x + dx, loc.y + dy, loc.z + dz), False, True)


def centre_xy_on(actor, x_cm, y_cm):
    """Shift the actor so its bounding-box centre (not its pivot) is at x, y."""
    origin, _ext = bounds(actor)
    move_by(actor, dx=x_cm - origin.x, dy=y_cm - origin.y)


def mesh_components(actor):
    comps = [c for c in actor.get_components_by_class(unreal.StaticMeshComponent)
             if c and not isinstance(c, unreal.InstancedStaticMeshComponent)]
    if not comps and isinstance(actor, unreal.StaticMeshActor):
        comps = [actor.static_mesh_component]
    return comps


def mesh_underside(comps, x, y, z_low, z_high):
    """Lowest mesh surface in the column (x, y), traced upward against the actor's own meshes."""
    best = None
    for c in comps:
        r = c.line_trace_component(vec(x, y, z_low), vec(x, y, z_high), True, False, False)
        if r:
            best = r[0].z if best is None else min(best, r[0].z)
    return best


def drop_to_ground(actor, sink_for_height, frac=0.4):
    """Lower/raise the actor so that, in 5 columns over its footprint, its underside is at
    least sink cm below the ground: nothing floats on slopes. Uses the real mesh underside
    (per-component trace, like p8_ground_check.py) where it can, else the bounding-box bottom."""
    origin, ext = bounds(actor)
    bottom = origin.z - ext.z
    cols = [(origin.x, origin.y)]
    cols += [(origin.x + sx * frac * ext.x, origin.y + sy * frac * ext.y) for sx in (-1, 1) for sy in (-1, 1)]
    comps = mesh_components(actor)
    gaps, grounds = [], []
    for x, y in cols:
        g = ow.ground_z(x, y)
        if g is None:
            continue
        grounds.append(g)
        m = mesh_underside(comps, x, y, bottom - 100.0, origin.z + ext.z + 10.0) if comps else None
        if m is not None:
            gaps.append(g - m)
    if not grounds:
        return None
    height = 2.0 * ext.z
    sink = sink_for_height(height)
    if len(gaps) >= 3:
        dz = min(gaps) - sink
    else:
        dz = (min(grounds) - sink) - bottom
    move_by(actor, dz=dz)
    return {"ground_min": min(grounds), "ground_max": max(grounds), "sink": sink, "height": height}


def describe(asset):
    if asset is None:
        return "nothing"
    kind = "placeholder" if ow.is_placeholder(asset) else type(asset).__name__
    return "%s %s" % (kind, asset.get_path_name().split(".")[0])


def load_assets(slot):
    assets = [a for a in ow.load_slot(slot) if a is not None]
    for a in assets:
        if not ow.is_placeholder(a) and not isinstance(a, (unreal.StaticMesh, unreal.Blueprint)):
            warn("ASSETS['%s']: %s is a %s - only Static Meshes and Blueprints are supported; "
                 "it will be tried, and replaced by a placeholder if it cannot be spawned"
                 % (slot, a.get_path_name(), type(a).__name__))
    names = ", ".join(describe(a) for a in assets) or "nothing"
    ow.log("ASSETS['%s']: %s" % (slot, names))
    return assets


_placeholder_cache = {}


def placeholder(slot):
    if slot not in _placeholder_cache:
        _placeholder_cache[slot] = unreal.EditorAssetLibrary.load_asset(cfg.FALLBACK_MESHES[slot])
    return _placeholder_cache[slot]


def spawn_or_placeholder(slot, asset, location, rotation, label, folder, tags, scale_fn):
    """Spawn asset; if that fails, spawn the slot's Engine placeholder instead.
    scale_fn(is_placeholder) returns the scale Vector to use."""
    for candidate in (asset, placeholder(slot)):
        if candidate is None:
            continue
        ph = ow.is_placeholder(candidate)
        try:
            actor = ow.spawn(candidate, location, rotation, label=label, folder=folder, tags=tags,
                             scale=scale_fn(ph))
            return actor, ph
        except Exception as exc:  # noqa: BLE001 - keep going with a placeholder
            warn("%s: could not spawn %s (%s) - using the placeholder" % (label, describe(candidate), exc))
    return None, True


def remove_group(tag, name):
    victims = ow.managed(tag)
    if victims:
        ow.actors_subsystem().destroy_actors(victims)
        ow.refresh_trace_cache()
    ow.log("%s: removed %d old actors" % (name, len(victims)))


def set_shadow_and_collision(actor, cast_shadow, collision):
    comps = [c for c in actor.get_components_by_class(unreal.PrimitiveComponent) if c]
    if not comps and isinstance(actor, unreal.StaticMeshActor):
        comps = [actor.static_mesh_component]
    for c in comps:
        c.set_editor_property("cast_shadow", bool(cast_shadow))
        if not collision:
            c.set_collision_profile_name("NoCollision")


# ---------------------------------------------------------------------------
# Rotation maths for the fence (UE Rotator convention: X forward, Y right, Z up,
# pitch = nose up). Pure Python, no engine calls.
# ---------------------------------------------------------------------------
def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _neg(a):
    return (-a[0], -a[1], -a[2])


def basis_for_axis(axis, yaw_deg, pitch_deg):
    """World directions of the mesh's local X, Y, Z so that `axis` points along the
    segment (yaw, tilted by pitch) and the mesh's up stays as vertical as possible."""
    p, y = math.radians(pitch_deg), math.radians(yaw_deg)
    d = (math.cos(p) * math.cos(y), math.cos(p) * math.sin(y), math.sin(p))   # along the segment
    s = (-math.sin(y), math.cos(y), 0.0)                                       # horizontal, to the right
    u = (-math.sin(p) * math.cos(y), -math.sin(p) * math.sin(y), math.cos(p))  # d x s
    return {"+X": (d, s, u), "-X": (_neg(d), _neg(s), u),
            "+Y": (_neg(s), d, u), "-Y": (s, _neg(d), u)}[axis]


def rotator_from_basis(bx, by, bz):
    pitch = math.degrees(math.atan2(bx[2], math.hypot(bx[0], bx[1])))
    yaw = math.degrees(math.atan2(bx[1], bx[0]))
    sy = (-math.sin(math.radians(yaw)), math.cos(math.radians(yaw)), 0.0)
    roll = math.degrees(math.atan2(_dot(bz, sy), _dot(by, sy)))
    return unreal.Rotator(roll=roll, pitch=pitch, yaw=yaw)


def rotate(basis, v):
    bx, by, bz = basis
    return tuple(v[0] * bx[i] + v[1] * by[i] + v[2] * bz[i] for i in range(3))


# ---------------------------------------------------------------------------
# Cabin
# ---------------------------------------------------------------------------
def place_cabin(L, F):
    c = L["cabin"]
    assets = load_assets("cabin")
    asset = assets[0] if assets else None
    x_m, y_m = c["center_m"]
    yaw = c["yaw_deg"] + CABIN_YAW_OFFSET_DEG
    target = F.to_world(x_m, y_m, c["height_m"])

    def scale_fn(ph):
        if ph:
            return vec(*PLACEHOLDER_CABIN_SIZE_M)  # Engine cube = 1 m
        return vec(CABIN_SCALE, CABIN_SCALE, CABIN_SCALE)

    actor, ph = spawn_or_placeholder("cabin", asset, target, ow.yaw_rotator(yaw), "OW_Cabin",
                                     cfg.OUTLINER["props"], PROP_TAGS + [TAG_CABIN], scale_fn)
    if not actor:
        warn("cabin: nothing could be spawned")
        return
    centre_xy_on(actor, target.x, target.y)
    res = drop_to_ground(actor, lambda h: CABIN_SINK_CM)
    if res is None:
        warn("cabin: no landscape under (%.0f, %.0f) m - check the landscape (2.3)" % (x_m, y_m))
    else:
        expected = F.height_to_world_z(c["height_m"])
        if abs(res["ground_min"] - expected) > 50.0:
            warn("cabin: ground is %.1f m away from the layout pad height - was the terrain sculpted "
                 "or re-imported from different files? Re-run p2_verify_landscape.py (2.3)"
                 % ((res["ground_min"] - expected) / 100.0))
    origin, ext = bounds(actor)
    pad = c["pad_half_m"] * 100.0
    if ext.x > pad or ext.y > pad:
        warn("cabin: footprint %.1f x %.1f m is larger than the flattened %.0f x %.0f m pad - lower CABIN_SCALE"
             % (2 * ext.x / 100.0, 2 * ext.y / 100.0, 2 * pad / 100.0, 2 * pad / 100.0))
    SUMMARY.append("cabin 1 (%s, yaw %.1f)" % ("placeholder" if ph else "asset", yaw))


# ---------------------------------------------------------------------------
# Fence
# ---------------------------------------------------------------------------
def local_box(actor):
    """Local bounds of an actor spawned with rotation 0 and scale 1: (min, max) tuples in cm."""
    loc = actor.get_actor_location()
    origin, ext = bounds(actor)
    lo = (origin.x - ext.x - loc.x, origin.y - ext.y - loc.y, origin.z - ext.z - loc.z)
    hi = (origin.x + ext.x - loc.x, origin.y + ext.y - loc.y, origin.z + ext.z - loc.z)
    return lo, hi


def place_fence(L, F):
    segs = L["fence"]["segments"]
    assets = load_assets("fence")
    asset = assets[0] if assets else None
    if FENCE_MESH_AXIS not in ("+X", "-X", "+Y", "-Y"):
        warn("FENCE_MESH_AXIS must be '+X', '-X', '+Y' or '-Y' - using '+X'")
    axis = FENCE_MESH_AXIS if FENCE_MESH_AXIS in ("+X", "-X", "+Y", "-Y") else "+X"
    along_i = 0 if axis.endswith("X") else 1   # index of the axis the fence runs along
    other_i = 1 - along_i
    nominal_real = cfg.FENCE_SEGMENT_LENGTH_M * 100.0
    boxes = {}
    placed, ph_used, length_warned = 0, False, False
    with unreal.ScopedSlowTask(len(segs), "Placing fence") as task:
        task.make_dialog(False)
        for k, s in enumerate(segs):
            task.enter_progress_frame(1.0)
            a = F.to_world(s["start_m"][0], s["start_m"][1])
            b = F.to_world(s["end_m"][0], s["end_m"][1])
            za, zb = ow.ground_z(a.x, a.y), ow.ground_z(b.x, b.y)
            if za is None or zb is None:
                warn("fence segment %d: no landscape under it - skipped" % (k + 1))
                continue
            label = "OW_Fence_%02d" % (k + 1)
            actor, ph = spawn_or_placeholder("fence", asset, vec(a.x, a.y, za), ow.yaw_rotator(0.0), label,
                                             cfg.OUTLINER["fence"], PROP_TAGS + [TAG_FENCE],
                                             lambda _ph: vec(1.0, 1.0, 1.0))
            if not actor:
                continue
            ph_used = ph_used or ph
            key = "placeholder" if ph else "asset"
            if key not in boxes:
                boxes[key] = local_box(actor)  # measured once, at rotation 0 / scale 1
            lo, hi = boxes[key]
            mesh_len = max(hi[along_i] - lo[along_i], 1.0)
            if not ph and not length_warned and abs(mesh_len - nominal_real) > 0.2 * nominal_real:
                warn("fence: the mesh is %.2f m long along %s but FENCE_SEGMENT_LENGTH_M = %.2f m. Set "
                     "FENCE_SEGMENT_LENGTH_M to the post-to-post length, or FENCE_MESH_AXIS to the axis it runs along"
                     % (mesh_len / 100.0, axis[1], cfg.FENCE_SEGMENT_LENGTH_M))
                length_warned = True

            # slope and anchor height (start post)
            l2 = math.hypot(b.x - a.x, b.y - a.y)
            yaw = math.degrees(math.atan2(b.y - a.y, b.x - a.x))  # same as the layout yaw_deg
            if FENCE_FOLLOW_SLOPE:
                pitch = math.degrees(math.atan2(zb - za, l2))
                pitch = max(-FENCE_MAX_PITCH_DEG, min(FENCE_MAX_PITCH_DEG, pitch))
                z_anchor = min(za, zb - l2 * math.tan(math.radians(pitch))) - FENCE_SINK_CM
            else:
                pitch = 0.0
                z_anchor = min(za, zb) - FENCE_SINK_CM
            l3 = l2 / math.cos(math.radians(pitch))

            # scale: along the fence, then thickness / height for the placeholder
            scale = [1.0, 1.0, 1.0]
            if ph:
                scale[along_i] = l3 / mesh_len
                scale[other_i] = PLACEHOLDER_FENCE_SIZE_M[0] / (max(hi[other_i] - lo[other_i], 1.0) / 100.0)
                scale[2] = PLACEHOLDER_FENCE_SIZE_M[1] / (max(hi[2] - lo[2], 1.0) / 100.0)
            elif FENCE_STRETCH_TO_FIT:
                scale[along_i] = l3 / nominal_real

            # local point that must land on the start post: start end of the axis,
            # centre across, bottom
            anchor = [0.0, 0.0, lo[2]]
            anchor[along_i] = lo[along_i] if axis.startswith("+") else hi[along_i]
            anchor[other_i] = 0.5 * (lo[other_i] + hi[other_i])
            basis = basis_for_axis(axis, yaw, pitch)
            off = rotate(basis, (anchor[0] * scale[0], anchor[1] * scale[1], anchor[2] * scale[2]))
            actor.set_actor_scale3d(vec(*scale))
            actor.set_actor_rotation(rotator_from_basis(*basis), False)
            actor.set_actor_location(vec(a.x - off[0], a.y - off[1], z_anchor - off[2]), False, True)
            placed += 1
    SUMMARY.append("fence %d/%d (%s)" % (placed, len(segs), "placeholder" if ph_used else "asset"))


# ---------------------------------------------------------------------------
# Boulders
# ---------------------------------------------------------------------------
def road_world(L, F):
    return [F.to_world(p[0], p[1]) for p in L["road"]["points_m"]]


def nearest_on_road(road, x, y):
    """(distance cm, unit vector from the road to the point)."""
    best = (1e18, 0.0, 0.0)
    for p, q in zip(road, road[1:]):
        dx, dy = q.x - p.x, q.y - p.y
        ll = dx * dx + dy * dy
        t = 0.0 if ll == 0 else max(0.0, min(1.0, ((x - p.x) * dx + (y - p.y) * dy) / ll))
        cx, cy = p.x + t * dx, p.y + t * dy
        d = math.hypot(x - cx, y - cy)
        if d < best[0]:
            best = (d, (x - cx) / d if d else 0.0, (y - cy) / d if d else 1.0)
    return best


def place_boulders(L, F):
    items = L["boulders"]
    assets = load_assets("boulders")
    road = road_world(L, F)
    road_half = L["road"]["half_width_m"] * 100.0
    placed, pushed, ph_count = 0, 0, 0
    for k, b in enumerate(items):
        asset = assets[b["mesh_index"] % len(assets)] if assets else None
        s = b["scale"] * BOULDER_SCALE_MULTIPLIER
        target = F.to_world(b["position_m"][0], b["position_m"][1])
        z0 = ow.ground_z(target.x, target.y)
        if z0 is None:
            warn("boulder %d: no landscape under (%.1f, %.1f) m - skipped" % (k + 1, b["position_m"][0], b["position_m"][1]))
            continue

        def scale_fn(ph, s=s):
            if ph:
                return vec(*(v * s for v in PLACEHOLDER_BOULDER_SIZE_M))  # Engine sphere = 1 m
            return vec(s, s, s)

        actor, ph = spawn_or_placeholder("boulders", asset, vec(target.x, target.y, z0), ow.yaw_rotator(b["yaw_deg"]),
                                         "OW_Boulder_%02d" % (k + 1), cfg.OUTLINER["boulders"],
                                         PROP_TAGS + [TAG_BOULDER], scale_fn)
        if not actor:
            continue
        ph_count += 1 if ph else 0
        centre_xy_on(actor, target.x, target.y)
        # keep big meshes off the road
        origin, ext = bounds(actor)
        radius = 0.85 * max(ext.x, ext.y)
        dist, nx, ny = nearest_on_road(road, origin.x, origin.y)
        deficit = road_half + BOULDER_ROAD_CLEARANCE_M * 100.0 + radius - dist
        if deficit > 0.0:
            move_by(actor, dx=nx * deficit, dy=ny * deficit)
            pushed += 1
        res = drop_to_ground(actor, lambda h: max(BOULDER_MIN_SINK_CM, BOULDER_SINK_FRACTION * h))
        if res is None:
            warn("boulder %d: lost the landscape after moving it off the road - check it by hand" % (k + 1))
        placed += 1
    note = "%d placeholder" % ph_count if ph_count else "%d mesh(es)" % len(assets)
    SUMMARY.append("boulders %d/%d (%s, %d pushed off the road)" % (placed, len(items), note, pushed))


# ---------------------------------------------------------------------------
# Mountains (Option A)
# ---------------------------------------------------------------------------
def poke_through(F, origin, ext):
    """Rough test whether a mountain shows above the main landscape: models the mesh as
    a cone over its bounding box and compares its height at the nearest landscape edge
    point (the rim crest, the worst case) with the traced ground there."""
    c, half = F.center, cfg.HALF_SIZE_M * 100.0 - 200.0
    px = max(c.x - half, min(c.x + half, origin.x))
    py = max(c.y - half, min(c.y + half, origin.y))
    r, big_r = math.hypot(px - origin.x, py - origin.y), max(ext.x, ext.y)
    if r >= big_r:
        return None
    est = (origin.z - ext.z) + 2.0 * ext.z * (1.0 - r / big_r)
    g = ow.ground_z(px, py)
    if g is None or est <= g:
        return None
    lx, ly = (px - c.x) / 100.0, (py - c.y) / 100.0
    return (lx, ly, F.world_z_to_height(est), F.world_z_to_height(g))


def place_mountains(L, F):
    items = L["mountains"]
    assets = load_assets("mountains")
    base_m = L["mountain_base_height_m"]
    base_z = F.height_to_world_z(base_m)
    lo_s, hi_s = cfg.MOUNTAIN_SCALE_RANGE
    placed, raised, ph_count, tops = 0, 0, 0, []
    with unreal.ScopedSlowTask(len(items), "Placing mountains") as task:
        task.make_dialog(False)
        for k, m in enumerate(items):
            task.enter_progress_frame(1.0)
            asset = assets[m["mesh_index"] % len(assets)] if assets else None
            s = m["scale"] * MOUNTAIN_SCALE_MULTIPLIER
            target = F.to_world(m["position_m"][0], m["position_m"][1])

            def scale_fn(ph, s=s):
                if ph:
                    return vec(s * PLACEHOLDER_MOUNTAIN_WIDTH, s * PLACEHOLDER_MOUNTAIN_WIDTH, s)
                return vec(s, s, s)

            actor, ph = spawn_or_placeholder("mountains", asset, vec(target.x, target.y, base_z),
                                             ow.yaw_rotator(m["yaw_deg"]), "OW_Mountain_%02d" % (k + 1),
                                             cfg.OUTLINER["mountains"], [cfg.TAG_MOUNTAIN], scale_fn)
            if not actor:
                continue
            ph_count += 1 if ph else 0

            def settle():
                centre_xy_on(actor, target.x, target.y)
                if MOUNTAIN_ALIGN == "bottom":
                    o, e = bounds(actor)
                    move_by(actor, dz=base_z - (o.z - e.z))
                o, e = bounds(actor)
                return o, e

            origin, ext = settle()
            top_m = F.world_z_to_height(origin.z + ext.z)
            if MOUNTAIN_MIN_TOP_M > 0.0:
                t = max(0.0, min(1.0, (m["scale"] - lo_s) / max(hi_s - lo_s, 1e-6)))
                want_m = MOUNTAIN_MIN_TOP_M * (1.0 + MOUNTAIN_HEIGHT_VARIATION * t)
                if top_m < want_m:
                    if MOUNTAIN_ALIGN == "bottom":
                        ref_m = F.world_z_to_height(origin.z - ext.z)
                    else:
                        ref_m = F.world_z_to_height(actor.get_actor_location().z)
                    k_up = (want_m - ref_m) / max(top_m - ref_m, 0.01)
                    sc = actor.get_actor_scale3d()
                    actor.set_actor_scale3d(vec(sc.x * k_up, sc.y * k_up, sc.z * k_up))
                    origin, ext = settle()
                    top_m = F.world_z_to_height(origin.z + ext.z)
                    raised += 1
            set_shadow_and_collision(actor, MOUNTAIN_CAST_SHADOW, MOUNTAIN_COLLISION)
            tops.append(top_m)
            hit = poke_through(F, origin, ext)
            if hit:
                warn("OW_Mountain_%02d may poke through the terrain near (%.0f, %.0f) m: its slope is estimated "
                     "at %.0f m there, the ground is at %.0f m. Fly there and look; if it shows, lower "
                     "MOUNTAIN_SCALE_MULTIPLIER%s" % (k + 1, hit[0], hit[1], hit[2], hit[3],
                                                     " or PLACEHOLDER_MOUNTAIN_WIDTH" if ph else ""))
            if top_m > 900.0:
                warn("OW_Mountain_%02d is %.0f m tall - lower MOUNTAIN_SCALE_MULTIPLIER" % (k + 1, top_m - base_m))
            placed += 1
    if tops:
        SUMMARY.append("mountains %d/%d (%s, tops %.0f-%.0f m above the landscape base, %d scaled up to reach "
                       "MOUNTAIN_MIN_TOP_M)" % (placed, len(items),
                                                "%d placeholder" % ph_count if ph_count else "%d mesh(es)" % len(assets),
                                                min(tops), max(tops), raised))
    else:
        SUMMARY.append("mountains 0/%d" % len(items))


# ---------------------------------------------------------------------------
# Option B backdrop landscape (7.3): report where to import it, check it if present
# ---------------------------------------------------------------------------
def check_backdrop(F):
    c = F.center
    ow.log("Option B (7.3): import OW_Backdrop_Height_505.png with Location X=%.0f Y=%.0f Z=%.0f (cm), "
           "Scale %.0f / %.0f / %.0f" % (c.x, c.y, F.origin.z, cfg.BACKDROP_SCALE_XY_CM, cfg.BACKDROP_SCALE_XY_CM,
                                         cfg.BACKDROP_SCALE_Z))
    main_path = F.actor.get_path_name()
    for ls in ow.landscapes():
        if ls.get_path_name() == main_path:
            continue
        label = ls.get_actor_label()
        loc, sc = ls.get_actor_location(), ls.get_actor_scale3d()
        half_x = (cfg.LANDSCAPE_RESOLUTION - 1) * sc.x / 2.0
        half_y = (cfg.LANDSCAPE_RESOLUTION - 1) * sc.y / 2.0
        want = (c.x - half_x, c.y - half_y, F.origin.z)
        problems = []
        if abs(sc.x - cfg.BACKDROP_SCALE_XY_CM) > 1 or abs(sc.y - cfg.BACKDROP_SCALE_XY_CM) > 1 \
                or abs(sc.z - cfg.BACKDROP_SCALE_Z) > 1:
            problems.append("Scale is %.0f / %.0f / %.0f, expected %.0f / %.0f / %.0f (re-import it)"
                            % (sc.x, sc.y, sc.z, cfg.BACKDROP_SCALE_XY_CM, cfg.BACKDROP_SCALE_XY_CM, cfg.BACKDROP_SCALE_Z))
        if abs(loc.x - want[0]) > 100 or abs(loc.y - want[1]) > 100 or abs(loc.z - want[2]) > 1:
            problems.append("Details > Transform > Location should be %.0f, %.0f, %.0f (it is %.0f, %.0f, %.0f)"
                            % (want[0], want[1], want[2], loc.x, loc.y, loc.z))
        if ow.has_tag(ls, cfg.TAG_PCG_EXCLUDE):
            problems.append("remove the %s tag, or PCG clears all vegetation" % cfg.TAG_PCG_EXCLUDE)
        try:
            if ls.get_editor_property("enable_nanite"):
                problems.append("Enable Nanite is on - see the 5.8.0 caveat in 7.3")
        except Exception:  # noqa: BLE001 - report only
            pass
        if problems:
            for p in problems:
                warn("backdrop '%s': %s" % (label, p))
        else:
            ow.log("backdrop '%s': position and scale OK" % label)


# ---------------------------------------------------------------------------
def main():
    for name, mode in (("CABIN", CABIN), ("FENCE", FENCE), ("BOULDERS", BOULDERS), ("MOUNTAINS", MOUNTAINS)):
        if mode not in MODES:
            ow.error("%s = '%s' - use one of %s" % (name, mode, MODES))
            return
    if MOUNTAIN_ALIGN not in ("bottom", "pivot"):
        ow.error("MOUNTAIN_ALIGN = '%s' - use 'bottom' or 'pivot'" % MOUNTAIN_ALIGN)
        return
    try:
        F = ow.frame()
        L = ow.layout()
    except RuntimeError as exc:
        ow.error(str(exc))
        return
    missing = [k for k in ("cabin", "fence", "boulders", "mountains", "mountain_base_height_m", "road", "boundary")
               if k not in L]
    if missing:
        ow.error("OW_Layout.json has no %s - re-run tools/generate_heightmap.py (2.1)" % ", ".join(missing))
        return

    groups = [("cabin", CABIN, TAG_CABIN, place_cabin), ("fence", FENCE, TAG_FENCE, place_fence),
              ("boulders", BOULDERS, TAG_BOULDER, place_boulders), ("mountains", MOUNTAINS, cfg.TAG_MOUNTAIN,
                                                                     place_mountains)]
    with unreal.ScopedEditorTransaction("OW: Place props (p7)"):
        for name, mode, tag, fn in groups:
            if mode == "keep":
                SUMMARY.append("%s kept" % name)
                continue
            remove_group(tag, name)
            if mode == "remove":
                SUMMARY.append("%s removed" % name)
                continue
            fn(L, F)
        ow.refresh_trace_cache()
    check_backdrop(F)
    ow.log("p7_props done: " + "; ".join(SUMMARY) + ("; %d warning(s) above" % WARN_COUNT[0] if WARN_COUNT[0] else ""))
    ow.log("next: regenerate the PCG vegetation so it clears the new props (7.4)")
    if SAVE_LEVEL:
        ow.save_level()


main()
