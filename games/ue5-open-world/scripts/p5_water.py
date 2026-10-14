"""Phase 5 - Water: build the lake (Water Body Lake) and fit the Water Zone around it.

Build-plan step: 5.2 (values explained in 5.3-5.6).

How to run (see step 1.5):
  Tools > Execute Python Script... and pick OpenWorldTools/scripts/p5_water.py, or type
      py "C:/<Project>/OpenWorldTools/scripts/p5_water.py"
  in the Output Log command box (Cmd mode). Open L_OpenWorld first. Needs the Water plugin
  (step 1.3), the landscape (Phase 2) and OW_Layout.json (step 2.1).

What it creates / changes:
  * Prints the water surface height (world Z) and the 24 shoreline points from OW_Layout.json
    in world and lake-relative centimetres, for the manual fallback in step 5.2.
  * Creates /Game/OpenWorld/Water/MI_OW_Lake, a child of the plugin's Water_Material_Lake (only
    if it does not exist yet, so your edits survive a re-run). Prints every parameter name and
    default value to the Output Log and to Saved/OpenWorld/OW_LakeMaterialParams.txt.
  * Spawns OW_Lake (a Water Body Lake; tags OW_Managed + OW_Water; Outliner folder
    OpenWorld/Water) at the lake centre with its actor Z = the water surface, and sets its spline
    to the shoreline points (closed loop, Curve points). Then: Channel Depth 600 cm, Affects
    Landscape OFF (the basin is already in the heightmap), Waves Source None (calm), the lake
    materials set explicitly, Generate Overlap Events ON (needed for the underwater look).
  * Reuses the Water Zone (the plugin spawns one with the first water body) or spawns one,
    renames it OW_WaterZone (tags OW_Managed + OW_WaterZone), fits it around the lake
    (ZONE_FIT), sets Render Target Resolution and the water mesh Tessellation Factor.
  * Prints the transform for the optional swim volume (step 5.6). It does not place it.
  * Does not save the level: check the result, then press Ctrl+S.
  The plugin also adds <Landscape>_WaterBrushManager and a "Water" edit layer when the lake is
  spawned. With Affects Landscape off they change nothing; the script leaves them alone.

Safe to re-run: it deletes the previous OW_Lake (and any OW_WaterMarker spheres) first, reuses
OW_WaterZone and MI_OW_Lake, and applies the TUNABLES again. Changes you made by hand in OW_Lake's
Details panel are lost on a re-run (OW_Lake is re-created): put them in the TUNABLES instead.

Undo: Ctrl+Z (one step, "OW: Water") removes OW_Lake and restores the zone. MI_OW_Lake stays;
delete it in the Content Browser if you want it gone. Or delete the actors tagged OW_Water.
"""
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unreal
import ow_common as ow
importlib.reload(ow)
cfg = ow.cfg
import math  # noqa: E402

# ===========================================================================
# TUNABLES (units in brackets; build-plan step in front)
# ===========================================================================
# 5.2 Lake actor
LAKE_LABEL = "OW_Lake"
COLLISION_DEPTH_M = 6.0            # [m] Channel Depth: depth of the lake's overlap box below the
                                   #     surface. Keep it > the lake's max depth (5.5 m).
SPAWN_POINT_MARKERS = False        # True = also put a 2 m sphere on every shoreline point (manual
                                   #     fallback). They are placed automatically if the spline step fails.
# 5.3 Waves
WAVES_ASSET = ""                   # "" = Waves Source None (calm, recommended). Or the path of a Water
                                   #     Waves asset you made in 5.3, e.g. "/Game/OpenWorld/Water/WW_OW_LakeSwell"
WAVE_ATTENUATION_DEPTH_CM = 300.0  # [cm] "Wave Attenuation Water Depth"; used only with WAVES_ASSET
# 5.4 Lake material
LAKE_MI_NAME = "MI_OW_Lake"
LAKE_PARENT_MATERIAL = "/Water/Materials/WaterSurface/Water_Material_Lake"
LAKE_MI_MULTIPLY = {}              # {"<name from the log>": factor or (r, g, b)} x the PARENT's default,
                                   #     e.g. {"Absorption": (2.0, 1.5, 1.2), "Scattering": 0.4}. Re-runs do not compound.
LAKE_MI_SCALARS = {}               # {"<scalar name>": value}  absolute values (applied after MULTIPLY)
LAKE_MI_VECTORS = {}               # {"<vector name>": (r, g, b, a)}
# 5.5 Water Zone
ZONE_LABEL = "OW_WaterZone"
ZONE_FIT = "lake"                  # "lake" = square around the lake (sharper shoreline); "landscape" = whole landscape
ZONE_MARGIN_M = 10.0               # [m] border beyond the lake's dilated outline ("lake" mode)
ZONE_ROUND_M = 10.0                # [m] the zone size is rounded up to a multiple of this
ZONE_RESOLUTION = 1024             # [texels] Render Target Resolution (X = Y). "landscape" mode: use 2048
WATER_MESH_TESSELLATION = 4        # Water Mesh > Tessellation Factor (plugin default 6; 4 is plenty without waves)
# 5.6 Optional swim volume (only printed - place it by hand)
SWIM_VOLUME_MARGIN_M = 2.0         # [m] beyond the outermost shoreline point
SWIM_VOLUME_BELOW_BED_M = 2.5      # [m] below the deepest point of the lakebed
# ===========================================================================

# Plugin assets (verified paths in the UE 5.6.1 Water plugin; never edit them in place)
LAKE_LOD_MATERIAL = "/Water/Materials/WaterSurface/LODs/Water_Material_Lake_LOD"
WATER_INFO_MATERIAL = "/Water/Materials/WaterInfo/DrawWaterInfo"
UNDERWATER_PP_MATERIAL = "/Water/Materials/PostProcessing/M_UnderWater_PostProcess_Volume"
HLOD_MATERIAL = "/Water/Materials/HLOD/HLODWater"

TAG_WATER_ZONE = getattr(cfg, "TAG_WATER_ZONE", "OW_WaterZone")
TAG_WATER_MARKER = getattr(cfg, "TAG_WATER_MARKER", "OW_WaterMarker")
FOLDER = cfg.OUTLINER["water"]
PARAMS_FILE = "OW_LakeMaterialParams.txt"
FAILED = []      # (what, manual fix)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def manual(what, how, exc=None):
    FAILED.append((what, how))
    ow.warn("%s did not work%s - do this by hand: %s" % (what, " (%s)" % exc if exc else "", how))


def setp(obj, prop, value, how):
    """set_editor_property with a precise manual fallback instead of a crash."""
    try:
        obj.set_editor_property(prop, value)
        return True
    except Exception as exc:
        manual("setting '%s'" % prop, how, exc)
        return False


def fmt(value):
    if isinstance(value, float):
        return "%.4f" % value
    if isinstance(value, unreal.LinearColor):
        return "(R=%.4f, G=%.4f, B=%.4f, A=%.4f)" % (value.r, value.g, value.b, value.a)
    if isinstance(value, unreal.Object):
        return value.get_path_name()
    return str(value)


def type_name(actor):
    return type(actor).__name__


# ---------------------------------------------------------------------------
# Geometry from OW_Layout.json
# ---------------------------------------------------------------------------
def lake_geometry(fr, lay):
    water_m = float(lay["water_level_m"])
    water_z = fr.height_to_world_z(water_m)
    cx_m, cy_m = lay["lake"]["center_m"]
    centre = fr.to_world(cx_m, cy_m, water_m)
    pts_m = [tuple(p) for p in lay["lake"]["spline_points_m"]]
    world = [fr.to_world(x, y, water_m) for x, y in pts_m]
    local = [unreal.Vector(p.x - centre.x, p.y - centre.y, 0.0) for p in world]
    return water_m, water_z, centre, pts_m, world, local


def log_points(water_m, water_z, fr, centre, pts_m, world, local):
    ow.log("WATER SURFACE: world Z = %.1f cm (water level %.2f m above the landscape actor Z %.1f cm). "
           "Manual fallback: OW_Lake / Water Body Lake > Location Z = %.1f" % (water_z, water_m, fr.origin.z, water_z))
    ow.log("LAKE CENTRE: Location X = %.1f, Y = %.1f, Z = %.1f (cm)" % (centre.x, centre.y, centre.z))
    ow.log("SHORELINE POINTS (%d; Details > Selected Points > Location: 'Relative' = local columns, 'World' = world):"
           % len(world))
    ow.log("   #   layout X m  layout Y m |  world X cm  world Y cm |  local X cm  local Y cm")
    for i, ((xm, ym), w, l) in enumerate(zip(pts_m, world, local)):
        ow.log("  %2d  %10.2f %10.2f | %11.1f %11.1f | %11.1f %11.1f" % (i, xm, ym, w.x, w.y, l.x, l.y))


def zone_fit(fr, world, shape_dilation_cm):
    """Centre (x, y) and square size (cm) of the Water Zone."""
    round_cm = max(100.0, ZONE_ROUND_M * 100.0)
    if ZONE_FIT == "landscape":
        c = fr.center
        size = (cfg.LANDSCAPE_RESOLUTION - 1) * fr.scale.x
        return c.x, c.y, math.ceil(size / round_cm) * round_cm
    xs = [p.x for p in world]
    ys = [p.y for p in world]
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    size = span + 2.0 * (shape_dilation_cm / 2.0 + ZONE_MARGIN_M * 100.0)
    return (min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0, math.ceil(size / round_cm) * round_cm


def swim_volume(centre, world, water_z, max_depth_m):
    """Oriented box (yaw = LAKE_ROTATION_DEG) around the shoreline points, top at the water surface."""
    yaw = math.radians(cfg.LAKE_ROTATION_DEG)
    c, s = math.cos(yaw), math.sin(yaw)
    lx = [(p.x - centre.x) * c + (p.y - centre.y) * s for p in world]
    ly = [-(p.x - centre.x) * s + (p.y - centre.y) * c for p in world]
    m = SWIM_VOLUME_MARGIN_M * 100.0
    x0, x1, y0, y1 = min(lx) - m, max(lx) + m, min(ly) - m, max(ly) + m
    mx, my = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    height = (max_depth_m + SWIM_VOLUME_BELOW_BED_M) * 100.0
    return (centre.x + mx * c - my * s, centre.y + mx * s + my * c, water_z - height / 2.0,
            x1 - x0, y1 - y0, height)


# ---------------------------------------------------------------------------
# MI_OW_Lake
# ---------------------------------------------------------------------------
def parameter_rows(mi):
    mel = unreal.MaterialEditingLibrary
    groups = (("scalar", mel.get_scalar_parameter_names, mel.get_material_instance_scalar_parameter_value),
              ("vector", mel.get_vector_parameter_names, mel.get_material_instance_vector_parameter_value),
              ("switch", mel.get_static_switch_parameter_names, mel.get_material_instance_static_switch_parameter_value),
              ("texture", mel.get_texture_parameter_names, mel.get_material_instance_texture_parameter_value))
    rows = []
    for kind, names_fn, value_fn in groups:
        for name in names_fn(mi):
            try:
                value = fmt(value_fn(mi, name))
            except Exception as exc:
                value = "? (%s)" % exc
            rows.append((kind, str(name), value))
    return rows


def parent_value(parent, kind, name):
    mel = unreal.MaterialEditingLibrary
    if isinstance(parent, unreal.MaterialInstanceConstant):
        fn = mel.get_material_instance_scalar_parameter_value if kind == "scalar" \
            else mel.get_material_instance_vector_parameter_value
        return fn(parent, name)
    base = parent if isinstance(parent, unreal.Material) else parent.get_base_material()
    fn = mel.get_material_default_scalar_parameter_value if kind == "scalar" \
        else mel.get_material_default_vector_parameter_value
    return fn(base, name)


def apply_material_overrides(mi, parent, scalars, vectors):
    mel = unreal.MaterialEditingLibrary
    for name, factor in LAKE_MI_MULTIPLY.items():
        if name in scalars:
            value = parent_value(parent, "scalar", name) * float(factor)
            mel.set_material_instance_scalar_parameter_value(mi, name, value)
            ow.log("  %s = %.4f (parent x %s)" % (name, value, factor))
        elif name in vectors:
            base = parent_value(parent, "vector", name)
            f = (float(factor),) * 3 if isinstance(factor, (int, float)) else tuple(float(v) for v in factor)
            col = unreal.LinearColor(r=base.r * f[0], g=base.g * f[1], b=base.b * f[2], a=base.a)
            mel.set_material_instance_vector_parameter_value(mi, name, col)
            ow.log("  %s = %s (parent x %s)" % (name, fmt(col), factor))
        else:
            ow.warn("LAKE_MI_MULTIPLY: '%s' is not a scalar or vector parameter of %s (see the list above)"
                    % (name, LAKE_MI_NAME))
    for name, value in LAKE_MI_SCALARS.items():
        if name in scalars:
            mel.set_material_instance_scalar_parameter_value(mi, name, float(value))
            ow.log("  %s = %.4f" % (name, float(value)))
        else:
            ow.warn("LAKE_MI_SCALARS: '%s' is not a scalar parameter of %s (see the list above)" % (name, LAKE_MI_NAME))
    for name, rgba in LAKE_MI_VECTORS.items():
        if name in vectors:
            r, g, b = (float(v) for v in rgba[:3])
            a = float(rgba[3]) if len(rgba) > 3 else 1.0
            mel.set_material_instance_vector_parameter_value(mi, name, unreal.LinearColor(r=r, g=g, b=b, a=a))
            ow.log("  %s = (%.4f, %.4f, %.4f, %.4f)" % (name, r, g, b, a))
        else:
            ow.warn("LAKE_MI_VECTORS: '%s' is not a vector parameter of %s (see the list above)" % (name, LAKE_MI_NAME))


def lake_material():
    """Create (once) or reuse MI_OW_Lake, dump its parameters, apply the TUNABLE overrides."""
    path = cfg.WATER_DIR + "/" + LAKE_MI_NAME
    how = ("Content Browser > Settings > tick Show Plugin Content; open Plugins > Water Content > Materials > "
           "WaterSurface, right-click Water_Material_Lake > Create Material Instance, save it as %s; then select "
           "OW_Lake > Details > Rendering > Water Material = %s" % (path, LAKE_MI_NAME))
    parent = ow.load(LAKE_PARENT_MATERIAL)
    if parent is None:
        manual("loading %s" % LAKE_PARENT_MATERIAL, how)
        return None, "failed"
    try:
        mel = unreal.MaterialEditingLibrary
        mi = ow.load(path)
        state = "reused"
        if mi is None:
            ow.ensure_directory(cfg.WATER_DIR)
            mi = unreal.AssetToolsHelpers.get_asset_tools().create_asset(
                LAKE_MI_NAME, cfg.WATER_DIR, unreal.MaterialInstanceConstant,
                unreal.MaterialInstanceConstantFactoryNew())
            mel.set_material_instance_parent(mi, parent)
            state = "created"
        else:
            cur = mi.get_editor_property("parent")
            if cur is None or cur.get_path_name().split(".")[0] != LAKE_PARENT_MATERIAL:
                ow.warn("%s exists but its parent is %s, not %s. Kept as it is; delete it and re-run to rebuild it."
                        % (LAKE_MI_NAME, cur.get_path_name() if cur else "None", LAKE_PARENT_MATERIAL))
        rows = parameter_rows(mi)
        lines = ["%-8s %-45s %s" % row for row in rows]
        ow.log("%s parameters (%d) - names and values for step 5.4:" % (LAKE_MI_NAME, len(rows)))
        for line in lines:
            ow.log("  " + line)
        try:
            out = ow.output_dir()
            os.makedirs(out, exist_ok=True)
            with open(os.path.join(out, PARAMS_FILE), "w") as fh:
                fh.write("Parameters of %s (parent %s)\n" % (path, LAKE_PARENT_MATERIAL))
                fh.write("\n".join(lines) + "\n")
            ow.log("parameter list also written to %s" % os.path.join(out, PARAMS_FILE))
        except OSError as exc:
            ow.warn("could not write %s (%s); copy the list from the Output Log instead" % (PARAMS_FILE, exc))
        scalars = [r[1] for r in rows if r[0] == "scalar"]
        vectors = [r[1] for r in rows if r[0] == "vector"]
        if LAKE_MI_MULTIPLY or LAKE_MI_SCALARS or LAKE_MI_VECTORS:
            ow.log("applying LAKE_MI_* overrides:")
            apply_material_overrides(mi, parent, scalars, vectors)
        mel.update_material_instance(mi)
        unreal.EditorAssetLibrary.save_asset(path, False)
        return mi, state
    except Exception as exc:
        manual("setting up %s" % LAKE_MI_NAME, how, exc)
        return None, "failed"


# ---------------------------------------------------------------------------
# Lake actor
# ---------------------------------------------------------------------------
def configure_lake(lake, mi):
    """Plugin properties, each with its own manual fallback. Returns the water body component."""
    d = "select %s > Details > " % LAKE_LABEL
    try:
        comp = lake.get_water_body_component()
        comp.modify()
    except Exception as exc:
        manual("reading the lake's water body component", d + "set every value of step 5.2 by hand", exc)
        return None
    # Channel Depth first: it is greyed out in the UI once Affects Landscape is off.
    try:
        cs = comp.get_editor_property("curve_settings")
        cs.set_editor_property("channel_depth", COLLISION_DEPTH_M * 100.0)
        comp.set_editor_property("curve_settings", cs)
    except Exception as exc:
        manual("setting Channel Depth", d + "Terrain > Curve Settings > Channel Depth = %.0f" % (COLLISION_DEPTH_M * 100.0), exc)
    setp(comp, "affects_landscape", False, d + "Terrain > Affects Landscape = off")

    loaded = {p: ow.load(p) for p in (LAKE_PARENT_MATERIAL, LAKE_LOD_MATERIAL, WATER_INFO_MATERIAL,
                                      UNDERWATER_PP_MATERIAL, HLOD_MATERIAL)}
    surface = mi or loaded[LAKE_PARENT_MATERIAL]
    for label, setter, asset, path in (
            ("Rendering > Water Material", "set_water_material", surface,
             LAKE_MI_NAME if mi else LAKE_PARENT_MATERIAL),
            ("Rendering > Water Static Mesh Material", "set_water_static_mesh_material",
             loaded[LAKE_LOD_MATERIAL], LAKE_LOD_MATERIAL),
            ("Rendering > Water Info Material", "set_water_info_material",
             loaded[WATER_INFO_MATERIAL], WATER_INFO_MATERIAL),
            ("Rendering > Underwater Post Process Material", "set_underwater_post_process_material",
             loaded[UNDERWATER_PP_MATERIAL], UNDERWATER_PP_MATERIAL)):
        if asset is None:
            manual("loading %s" % path, d + "%s = %s (Show Plugin Content in the picker)" % (label, path))
            continue
        try:
            getattr(comp, setter)(asset)
        except Exception as exc:
            manual("setting %s" % label, d + "%s = %s" % (label, path), exc)
    if loaded[HLOD_MATERIAL] is not None:
        setp(comp, "water_hlod_material", loaded[HLOD_MATERIAL], d + "HLOD > Water HLOD Material = HLODWater")

    # Underwater post process needs overlap events (Collision category)
    setp(comp, "generate_overlap_events", True, d + "Collision > Generate Overlap Events = on")

    # Waves
    if WAVES_ASSET:
        how = (d + "Wave > Waves Source = Water Waves Asset Reference, then its Water Waves Asset = %s; "
               "Wave > Wave Attenuation Water Depth = %.0f" % (WAVES_ASSET, WAVE_ATTENUATION_DEPTH_CM))
        asset = ow.load(WAVES_ASSET)
        if asset is None:
            manual("loading WAVES_ASSET '%s'" % WAVES_ASSET, how)
        else:
            try:
                ref = unreal.new_object(unreal.WaterWavesAssetReference, lake)
                ref.set_editor_property("water_waves_asset", asset)
                lake.set_water_waves(ref)
                comp.set_editor_property("target_wave_mask_depth", WAVE_ATTENUATION_DEPTH_CM)
            except Exception as exc:
                manual("assigning the waves asset", how, exc)
    else:
        try:
            lake.set_water_waves(None)
        except Exception as exc:
            manual("removing the waves", d + "Wave > Waves Source = None (clear the field)", exc)
    return comp


def set_shoreline(lake, local):
    """Replace the default 3-point spline with the layout shoreline. Returns the point count read back."""
    spline = lake.get_water_spline()
    spline.modify()
    spline.set_spline_points(local, unreal.SplineCoordinateSpace.LOCAL, False)
    for i in range(len(local)):
        spline.set_spline_point_type(i, unreal.SplinePointType.CURVE, False)
    spline.set_closed_loop(True, False)
    spline.update_spline()
    spline.k2_synchronize_and_broadcast_data_change()   # rebuilds the water body, its mesh and the zone
    return spline, spline.get_number_of_spline_points()


def spawn_markers(world):
    mesh = ow.load("/Engine/BasicShapes/Sphere")
    if mesh is None:
        ow.warn("could not load /Engine/BasicShapes/Sphere - no markers; use the point table above")
        return 0
    for i, p in enumerate(world):
        m = ow.spawn(mesh, p, label="OW_LakePoint_%02d" % i, folder=FOLDER + "/Markers",
                     tags=(TAG_WATER_MARKER,), scale=2.0)
        m.set_actor_enable_collision(False)
    ow.log("placed %d marker spheres (OW_LakePoint_00..%02d, folder %s/Markers). Drag the spline points onto them, "
           "then delete the folder's actors." % (len(world), len(world) - 1, FOLDER))
    return len(world)


# ---------------------------------------------------------------------------
# Water Zone
# ---------------------------------------------------------------------------
def find_or_spawn_zone(loc):
    zones = [a for a in ow.all_actors() if isinstance(a, unreal.WaterZone)]
    if not zones:
        zone = ow.spawn(unreal.WaterZone, loc, label=ZONE_LABEL, folder=FOLDER, tags=(TAG_WATER_ZONE,))
        return zone, "spawned"
    tagged = [z for z in zones if ow.has_tag(z, TAG_WATER_ZONE)]
    zone = (tagged or zones)[0]
    if len(zones) > 1:
        ow.warn("%d Water Zones in the level; configuring '%s'. Overlapping zones fight over the lake (higher "
                "Overlap Priority wins): delete the others by hand: %s"
                % (len(zones), zone.get_actor_label(),
                   ", ".join(z.get_actor_label() for z in zones if z != zone)))
    zone.modify()
    extra = [unreal.Name(t) for t in (cfg.TAG_MANAGED, TAG_WATER_ZONE) if not ow.has_tag(zone, t)]
    if extra:
        setp(zone, "tags", list(zone.tags) + extra, "select the Water Zone > Details > Actor > Tags: add %s" % TAG_WATER_ZONE)
    zone.set_actor_label(ZONE_LABEL)
    zone.set_folder_path(FOLDER)
    return zone, "reused"


def configure_zone(zone, cx, cy, z, size_cm):
    d = "select %s > Details > " % ZONE_LABEL
    zone.set_actor_location(unreal.Vector(cx, cy, z), False, False)
    setp(zone, "zone_extent", unreal.Vector2D(x=size_cm, y=size_cm),
         d + "Water > Zone Extent X = %.0f, Y = %.0f" % (size_cm, size_cm))
    setp(zone, "render_target_resolution", unreal.IntPoint(x=ZONE_RESOLUTION, y=ZONE_RESOLUTION),
         d + "Water > Render Target Resolution X = %d, Y = %d" % (ZONE_RESOLUTION, ZONE_RESOLUTION))
    setp(zone, "auto_include_landscapes_as_terrain", True, d + "Terrain > Auto Include Landscapes As Terrain = on")
    how = d + "select the WaterMesh component > Rendering > Tessellation Factor = %d" % WATER_MESH_TESSELLATION
    try:
        mesh = zone.get_editor_property("water_mesh")
        mesh.modify()
        mesh.set_editor_property("tessellation_factor", WATER_MESH_TESSELLATION)
    except Exception as exc:
        manual("setting the water mesh Tessellation Factor", how, exc)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def run():
    ow.log("engine %s, Python %s" % (unreal.SystemLibrary.get_engine_version(), sys.version.split()[0]))
    try:
        fr = ow.frame()
        lay = ow.layout()
    except (RuntimeError, OSError, ValueError, KeyError) as exc:
        ow.error("%s - p5_water stopped, nothing changed." % exc)
        return
    water_m, water_z, centre, pts_m, world, local = lake_geometry(fr, lay)
    log_points(water_m, water_z, fr, centre, pts_m, world, local)
    max_depth_m = float(lay["lake"].get("max_depth_m", cfg.LAKE_MAX_DEPTH_M))
    if COLLISION_DEPTH_M * 100.0 < max_depth_m * 100.0 + 20.0:
        ow.warn("COLLISION_DEPTH_M (%.1f m) is not deeper than the lake (%.1f m): the underwater look will stop "
                "near the lakebed. Raise it to %.1f." % (COLLISION_DEPTH_M, max_depth_m, max_depth_m + 0.5))

    if not hasattr(unreal, "WaterBodyLake") or not hasattr(unreal, "WaterZone"):
        ow.error("The Water plugin is not enabled: Edit > Plugins, search 'Water', tick Water, Restart Now "
                 "(step 1.3), then run this script again. Nothing was changed.")
        return

    mi, mi_state = lake_material()      # assets are not part of Ctrl+Z, so outside the transaction
    zx, zy, zone_size = zone_fit(fr, world, 4096.0)
    zone_state, points, markers, lake = "failed", 0, 0, None

    with unreal.ScopedEditorTransaction("OW: Water"):
        ow.remove_managed(cfg.TAG_WATER)
        ow.remove_managed(TAG_WATER_MARKER)
        for a in ow.all_actors():
            if isinstance(a, unreal.WaterBodyLake):
                ow.warn("another Water Body Lake '%s' is in the level (not made by this script). If you placed it by "
                        "hand for the fallback, delete it now: two lakes at the same height overlap." % a.get_actor_label())

        try:
            lake = ow.spawn(unreal.WaterBodyLake, centre, ow.yaw_rotator(0.0), label=LAKE_LABEL, folder=FOLDER,
                            tags=(cfg.TAG_WATER,))
            lake.set_actor_scale3d(unreal.Vector(1.0, 1.0, 1.0))
        except Exception as exc:
            manual("spawning the Water Body Lake",
                   "Window > Place Actors, search 'Water Body Lake', drag it into the viewport, then follow the "
                   "manual fallback in step 5.2", exc)

        if lake is not None:
            comp = configure_lake(lake, mi)

            zone, zone_state = None, "failed"
            try:
                zone, zone_state = find_or_spawn_zone(unreal.Vector(zx, zy, water_z))
                configure_zone(zone, zx, zy, water_z, zone_size)
            except Exception as exc:
                manual("setting up the Water Zone", "Window > Place Actors, search 'Water Zone' (only if the level has "
                       "none), then set the values of step 5.5", exc)

            try:
                spline, points = set_shoreline(lake, local)
                if points != len(local):
                    ow.warn("the lake spline reports %d points, expected %d - check OW_Lake in the viewport"
                            % (points, len(local)))
                try:
                    z0 = spline.get_location_at_spline_point(0, unreal.SplineCoordinateSpace.WORLD).z
                    if abs(z0 - water_z) > 1.0:
                        ow.warn("spline point 0 is at Z %.1f, the water surface at %.1f - set OW_Lake Location Z = %.1f"
                                % (z0, water_z, water_z))
                except Exception:
                    pass
            except Exception as exc:
                manual("setting the lake spline", "follow the manual fallback in step 5.2 (markers placed below)", exc)
                markers = spawn_markers(world)

            if comp is not None:
                try:
                    ow.log("check: Affects Landscape = %s, Generate Overlap Events = %s"
                           % (comp.get_editor_property("affects_landscape"),
                              comp.get_editor_property("generate_overlap_events")))
                except Exception:
                    pass
        if SPAWN_POINT_MARKERS and not markers:
            markers = spawn_markers(world)

    for a in ow.all_actors():
        if "WaterBrushManager" in type_name(a):
            ow.log("'%s' was added by the Water plugin. With Affects Landscape off it changes nothing - leave it "
                   "(step 5.1)." % a.get_actor_label())
    try:
        unreal.SystemLibrary.execute_console_command(ow.editor_world(), "r.Water.WaterInfo.ForceUpdateWaterInfoNextFrames 3")
    except Exception as exc:
        ow.warn("could not refresh the water info texture (%s); select %s > Details > Debug > Force Update Water "
                "Info Texture" % (exc, ZONE_LABEL))

    sx, sy, sz, bx, by, bz = swim_volume(centre, world, water_z, max_depth_m)
    ow.log("OPTIONAL SWIM VOLUME (step 5.6): Physics Volume Location X = %.0f, Y = %.0f, Z = %.0f; Rotation Z = %.1f; "
           "Brush Settings X = %.0f, Y = %.0f, Z = %.0f (cm); Water Volume = on"
           % (sx, sy, sz, cfg.LAKE_ROTATION_DEG, bx, by, bz))
    ow.log("Water summary (Outliner folder %s):" % FOLDER)
    ow.log("  %-14s %s" % (LAKE_LABEL, "%d spline points, surface Z %.1f cm, Affects Landscape off, Channel Depth %.0f cm, "
                           "waves %s" % (points, water_z, COLLISION_DEPTH_M * 100.0, WAVES_ASSET or "none")
                           if lake is not None else "NOT CREATED - see warnings"))
    ow.log("  %-14s %s, %.0f x %.0f m, %d x %d texels (%.1f cm per texel), Tessellation Factor %d, mode '%s'"
           % (ZONE_LABEL, zone_state, zone_size / 100.0, zone_size / 100.0, ZONE_RESOLUTION, ZONE_RESOLUTION,
              zone_size / ZONE_RESOLUTION, WATER_MESH_TESSELLATION, ZONE_FIT))
    ow.log("  %-14s %s" % (LAKE_MI_NAME, mi_state))
    if markers:
        ow.log("  %-14s %d marker spheres (delete them when the spline is placed)" % ("markers", markers))
    if FAILED:
        ow.warn("%d step(s) need doing by hand - see the 'do this by hand' warnings above" % len(FAILED))
    ow.log("p5_water done. Check the lake in the viewport, then press Ctrl+S.")


run()
