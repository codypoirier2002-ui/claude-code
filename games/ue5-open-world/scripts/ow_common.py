"""Helpers shared by the Unreal-side scripts. Imported, never run on its own.

Every script in this folder starts with:

    import importlib, os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import ow_common as ow
    importlib.reload(ow)   # the editor caches modules between runs

and then uses ow.cfg (the ow_config module), ow.layout(), ow.frame(), ow.spawn(),
ow.ground_hit() and friends. API names were checked against the UE 5.6 Python API.
"""
import importlib
import json
import math
import os
import sys

import unreal

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import ow_config as cfg  # noqa: E402

# The editor keeps imported modules cached between script runs; reload so
# edits to ow_config.py take effect without restarting Unreal.
cfg = importlib.reload(cfg)


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
def log(msg):
    unreal.log("[OW] " + str(msg))


def warn(msg):
    unreal.log_warning("[OW] " + str(msg))


def error(msg):
    unreal.log_error("[OW] " + str(msg))


# ---------------------------------------------------------------------------
# Subsystems and world
# ---------------------------------------------------------------------------
def actors_subsystem():
    return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)


def level_subsystem():
    return unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)


def editor_world():
    return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()


def all_actors():
    return list(actors_subsystem().get_all_level_actors())


def save_level():
    if level_subsystem().save_current_level():
        log("level saved")
    else:
        warn("could not save the level automatically - press Ctrl+S")


# ---------------------------------------------------------------------------
# Layout written by tools/generate_heightmap.py
# ---------------------------------------------------------------------------
def output_dir():
    if cfg.OUTPUT_DIR:
        return cfg.OUTPUT_DIR
    saved = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_saved_dir())
    return os.path.join(saved, "OpenWorld")


_layout_cache = {}


def layout():
    path = os.path.join(output_dir(), cfg.LAYOUT_FILE)
    if path not in _layout_cache:
        if not os.path.exists(path):
            raise RuntimeError(
                "OW_Layout.json not found at %s. Run tools/generate_heightmap.py first "
                "(or set OUTPUT_DIR in ow_config.py to the folder it wrote to)." % path)
        with open(path, "r") as fh:
            _layout_cache[path] = json.load(fh)
    return _layout_cache[path]


# ---------------------------------------------------------------------------
# Landscape frame: converts layout metres to world centimetres
# ---------------------------------------------------------------------------
class LandscapeFrame(object):
    """Maps layout metres (origin = landscape centre) to world space.

    The landscape actor's location is the corner of heightmap pixel (0, 0); one
    pixel step is actor_scale.x centimetres along +X (columns) and actor_scale.y
    along +Y (rows). Heights: world Z = actor Z + metres * 100 * scale_z / LANDSCAPE_SCALE_Z.
    """

    def __init__(self, landscape):
        self.actor = landscape
        loc = landscape.get_actor_location()
        scale = landscape.get_actor_scale3d()
        self.origin = loc
        self.scale = scale
        self.half_m = cfg.HALF_SIZE_M
        rot = landscape.get_actor_rotation()
        if abs(rot.yaw) > 0.01 or abs(rot.pitch) > 0.01 or abs(rot.roll) > 0.01:
            warn("the landscape is rotated (%s); keep Rotation at 0,0,0 or positions will be off" % rot)

    @property
    def cm_per_m_x(self):
        # actor scale is cm per heightmap quad; one quad is LANDSCAPE_SCALE_XY_CM / 100 layout metres
        return self.scale.x * 100.0 / cfg.LANDSCAPE_SCALE_XY_CM

    @property
    def cm_per_m_y(self):
        return self.scale.y * 100.0 / cfg.LANDSCAPE_SCALE_XY_CM

    def to_world(self, x_m, y_m, h_m=None):
        x = self.origin.x + (x_m + self.half_m) * self.cm_per_m_x
        y = self.origin.y + (y_m + self.half_m) * self.cm_per_m_y
        z = self.origin.z if h_m is None else self.height_to_world_z(h_m)
        return unreal.Vector(x, y, z)

    def height_to_world_z(self, h_m):
        return self.origin.z + h_m * 100.0 * self.scale.z / cfg.LANDSCAPE_SCALE_Z

    def world_z_to_height(self, z_cm):
        return (z_cm - self.origin.z) * cfg.LANDSCAPE_SCALE_Z / (100.0 * self.scale.z)

    @property
    def center(self):
        return self.to_world(0.0, 0.0)


def landscapes():
    return [a for a in all_actors() if isinstance(a, unreal.Landscape)]


def find_landscape():
    """The main landscape: the Landscape actor whose size is closest to 504 m."""
    found = landscapes()
    if not found:
        raise RuntimeError("No Landscape in the level. Create it first (Phase 2 of the build plan).")
    if len(found) == 1:
        return found[0]
    target_cm = cfg.LANDSCAPE_SIZE_M * 100.0

    def size_error(ls):
        return abs((cfg.LANDSCAPE_RESOLUTION - 1) * ls.get_actor_scale3d().x - target_cm)

    return sorted(found, key=size_error)[0]


_frame = None


def frame():
    global _frame
    if _frame is None or not _frame.actor or not unreal.SystemLibrary.is_valid(_frame.actor):
        _frame = LandscapeFrame(find_landscape())
    return _frame


# ---------------------------------------------------------------------------
# Ground traces (work in the editor world, no Play needed)
# ---------------------------------------------------------------------------
_HIT_FIELDS = ("blocking_hit", "initial_overlap", "time", "distance", "location", "impact_point",
               "normal", "impact_normal", "phys_mat", "hit_actor", "hit_component", "hit_bone_name",
               "bone_name", "hit_item", "element_index", "face_index", "trace_start", "trace_end")


def hit_info(hit):
    """HitResult fields are only readable through to_tuple() in Python."""
    return dict(zip(_HIT_FIELDS, hit.to_tuple()))


_ignore_cache = []


def refresh_trace_cache():
    """Call after spawning or deleting actors so traces ignore the new ones."""
    del _ignore_cache[:]


def _non_landscape_actors():
    if not _ignore_cache:
        _ignore_cache.extend(a for a in all_actors() if not isinstance(a, unreal.LandscapeProxy))
    return _ignore_cache


def ground_hit(x_cm, y_cm, ignore=None, top_cm=200000.0, bottom_cm=-200000.0, landscape_only=True):
    """Trace straight down at (x, y) in the editor world (no Play needed).

    Returns a dict with impact_point, impact_normal, hit_actor (see hit_info), or None.
    landscape_only=True ignores every non-landscape actor (props, trees, water) so the
    result is the terrain surface itself.
    """
    skip = list(ignore or [])
    if landscape_only:
        skip += _non_landscape_actors()
    hit = unreal.SystemLibrary.line_trace_single(
        editor_world(), unreal.Vector(x_cm, y_cm, top_cm), unreal.Vector(x_cm, y_cm, bottom_cm),
        unreal.TraceTypeQuery.TRACE_TYPE_QUERY1, True, skip, unreal.DrawDebugTrace.NONE, True)
    if not hit:
        return None
    info = hit_info(hit)
    if landscape_only and not isinstance(info.get("hit_actor"), unreal.LandscapeProxy):
        return None
    return info


def ground_z(x_cm, y_cm, ignore=None, default=None):
    info = ground_hit(x_cm, y_cm, ignore)
    return info["impact_point"].z if info else default


# ---------------------------------------------------------------------------
# Assets
# ---------------------------------------------------------------------------
def ensure_directory(path):
    if not unreal.EditorAssetLibrary.does_directory_exist(path):
        unreal.EditorAssetLibrary.make_directory(path)


def load(path):
    if path and unreal.EditorAssetLibrary.does_asset_exist(path):
        return unreal.EditorAssetLibrary.load_asset(path)
    return None


def load_slot(slot):
    """Load the assets configured in ow_config.ASSETS[slot]; fall back to an Engine shape."""
    entry = cfg.ASSETS.get(slot)
    paths = entry if isinstance(entry, list) else ([entry] if entry else [])
    loaded = []
    for p in paths:
        asset = load(p)
        if asset:
            loaded.append(asset)
        else:
            warn("ASSETS['%s']: '%s' not found - check the path (right-click > Copy Reference)" % (slot, p))
    if not loaded and slot in cfg.FALLBACK_MESHES:
        warn("ASSETS['%s'] is empty - using placeholder %s" % (slot, cfg.FALLBACK_MESHES[slot]))
        loaded.append(unreal.EditorAssetLibrary.load_asset(cfg.FALLBACK_MESHES[slot]))
    return loaded


def is_placeholder(asset):
    return asset is not None and asset.get_path_name().startswith("/Engine/BasicShapes/")


# ---------------------------------------------------------------------------
# Managed actors (tagged so a re-run replaces them instead of duplicating)
# ---------------------------------------------------------------------------
def has_tag(actor, tag):
    return unreal.Name(tag) in list(actor.tags)


def managed(tag):
    return [a for a in all_actors() if has_tag(a, cfg.TAG_MANAGED) and has_tag(a, tag)]


def remove_managed(tag):
    victims = managed(tag)
    if victims:
        actors_subsystem().destroy_actors(victims)
        refresh_trace_cache()
        log("removed %d old '%s' actors" % (len(victims), tag))


def spawn(what, location, rotation=None, label=None, folder=None, tags=(), scale=None):
    """Spawn a class (unreal.DirectionalLight) or an asset (StaticMesh / Blueprint) and tag it."""
    sub = actors_subsystem()
    rot = rotation or unreal.Rotator(roll=0.0, pitch=0.0, yaw=0.0)
    if isinstance(what, type) or isinstance(what, unreal.Class):
        actor = sub.spawn_actor_from_class(what, location, rot)
    else:
        actor = sub.spawn_actor_from_object(what, location, rot)
    if not actor:
        raise RuntimeError("could not spawn %s" % what)
    actor.tags = list(actor.tags) + [unreal.Name(cfg.TAG_MANAGED)] + [unreal.Name(t) for t in tags]
    refresh_trace_cache()
    if label:
        actor.set_actor_label(label)
    if folder:
        actor.set_folder_path(folder)
    if scale is not None:
        actor.set_actor_scale3d(scale if isinstance(scale, unreal.Vector) else unreal.Vector(scale, scale, scale))
    return actor


def yaw_rotator(yaw_deg, pitch_deg=0.0, roll_deg=0.0):
    # unreal.Rotator's positional order is (roll, pitch, yaw) - always use keywords
    return unreal.Rotator(roll=roll_deg, pitch=pitch_deg, yaw=yaw_deg)


def bounds_bottom(actor):
    origin, extent = actor.get_actor_bounds(False)
    return origin.z - extent.z


def distance_2d(a, b):
    return math.hypot(a.x - b.x, a.y - b.y)
