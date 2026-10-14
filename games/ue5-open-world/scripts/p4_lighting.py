"""Phase 4 - Lighting & sky: configure the sun, sky, clouds, fog and one post process volume.

Build-plan step: 4.1 (the values are explained in steps 4.2-4.7).

How to run (see step 1.5):
  Tools > Execute Python Script... and pick OpenWorldTools/scripts/p4_lighting.py, or type
      py "C:/<Project>/OpenWorldTools/scripts/p4_lighting.py"
  in the Output Log command box (Cmd mode). Open L_OpenWorld first.

What it creates / changes:
  * Finds the DirectionalLight, SkyAtmosphere, SkyLight, ExponentialHeightFog and
    VolumetricCloud that File > New Level > Basic put in the level and configures them.
    It spawns only the ones that are missing, so nothing is duplicated. If a class
    appears more than once it configures one and warns about the others.
  * Renames them OW_Sun, OW_SkyAtmosphere, OW_SkyLight, OW_HeightFog, OW_VolumetricCloud,
    tags them OW_Lighting (only that tag, never OW_Managed, so no script deletes them),
    and moves them to the Outliner folder OpenWorld/Lighting.
  * Spawns one unbound Post Process Volume, OW_PostProcess (tags OW_Managed + OW_Lighting).
  * Creates /Game/OpenWorld/Materials/MI_OW_Clouds (a child of the engine cloud material,
    so the clouds look the same until you change it) and assigns it to the clouds.
  * Reads the sun direction from OW_Layout.json (player spawn yaw) and the fog height
    from the landscape (water level). Works without them, using fallbacks.
  * Does not save the level: check the result, then press Ctrl+S.

Safe to re-run: it deletes its own post process volume first, reuses the five actors
above and applies the TUNABLES again.

Undo: Ctrl+Z (one step, "OW: Lighting") restores the previous values and removes the
post process volume and any actor the script spawned. The MI_OW_Clouds asset stays;
delete it in the Content Browser if you want it gone.
"""
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unreal
import ow_common as ow
importlib.reload(ow)
cfg = ow.cfg
import math  # noqa: E402

# ===========================================================================
# TUNABLES (units in brackets; step of the build plan in front)
# ===========================================================================
# 4.2 Sun (Directional Light)
SUN_ELEVATION_DEG = 15.0           # [deg] above the horizon. Pitch = -elevation. Useful range 12-20.
SUN_AZIMUTH_OFFSET_DEG = -60.0     # [deg] sun direction relative to the spawn view; negative = left.
                                   #       -90 = pure side light, 0 = straight into the camera.
PLAYER_YAW_FALLBACK_DEG = -37.63   # [deg] used only if OW_Layout.json is missing (player_start.yaw_deg)
SUN_INTENSITY_LUX = 120000.0       # [lux] top-of-atmosphere sun; the atmosphere dims and warms it
SUN_SOURCE_ANGLE_DEG = 0.5357      # [deg] angular diameter of the real sun
SUN_USE_TEMPERATURE = False        # False = white (D65); the atmosphere supplies the warm colour
SUN_CAST_CLOUD_SHADOWS = True
SUN_CAST_SHADOWS_ON_CLOUDS = True
SUN_CAST_SHADOWS_ON_ATMOSPHERE = True

# 4.3 Sky Atmosphere
AERIAL_PERSPECTIVE_DISTANCE_SCALE = 5.0   # [x] 500 m of terrain hazes like 2.5 km. Range 3-8.
HEIGHT_FOG_CONTRIBUTION = 1.0             # [x]
MIE_SCATTERING_SCALE = None               # None = keep the default; 0.006 = hazier sky, bigger sun glow

# 4.4 Sky Light
SKY_LIGHT_INTENSITY = 1.0          # [x] "Intensity Scale"
SKY_LIGHT_REAL_TIME_CAPTURE = True
SKY_LIGHT_CLOUD_AO = True          # clouds darken the sky light

# 4.5 Volumetric Cloud
CLOUD_LAYER_BOTTOM_KM = 1.5        # [km] fair-weather cumulus bases
CLOUD_LAYER_HEIGHT_KM = 3.0        # [km] thickness of the cloud layer
CLOUD_TRACING_MAX_DISTANCE_KM = 50.0
CLOUD_VIEW_SAMPLE_COUNT_SCALE = 1.0        # first performance knob: 0.5
CLOUD_REFLECTION_SAMPLE_COUNT_SCALE = 0.5  # clouds in the sky-light capture; low quality is invisible there
CLOUD_CREATE_MATERIAL_INSTANCE = True      # False = leave the cloud material alone
CLOUD_MI_NAME = "MI_OW_Clouds"
CLOUD_PARENT_MATERIAL = "/Engine/EngineSky/VolumetricClouds/m_SimpleVolumetricCloud_Inst"
CLOUD_MI_SCALARS = {}              # {"<parameter name printed in the log>": value}; empty = unchanged look

# 4.6 Exponential Height Fog
FOG_HEIGHT_ABOVE_WATER_M = 0.0     # [m] fog actor Z = lake surface + this
FOG_DENSITY = 0.01
FOG_HEIGHT_FALLOFF = 0.1
FOG_MAX_OPACITY = 1.0
FOG_START_DISTANCE_CM = 0.0        # [cm]
VOLUMETRIC_FOG = True
VOLUMETRIC_FOG_SCATTERING_DISTRIBUTION = 0.4   # 0 = uniform, 0.9 = strongly toward the sun
VOLUMETRIC_FOG_EXTINCTION_SCALE = 1.0
VOLUMETRIC_FOG_VIEW_DISTANCE_CM = 6000.0       # [cm]

# 4.7 Post Process Volume
PPV_PRIORITY = 1.0                 # above any leftover unbound volume (those default to 0)
EXPOSURE_COMPENSATION = 1.0        # [EV]
EXPOSURE_MIN_EV100 = 11.0          # [EV100] forest shade
EXPOSURE_MAX_EV100 = 15.0          # [EV100] bright sky; set Min = Max (e.g. 13) for fixed exposure
EXPOSURE_SPEED_UP = 3.0            # [f-stops/s]
EXPOSURE_SPEED_DOWN = 1.0          # [f-stops/s]
LOCAL_EXPOSURE_HIGHLIGHT_CONTRAST = 0.8
LOCAL_EXPOSURE_SHADOW_CONTRAST = 0.9
COLOR_SATURATION = 1.05
COLOR_CONTRAST = 1.03
BLOOM_INTENSITY = 0.5
LENS_FLARE_INTENSITY = 0.0
VIGNETTE_INTENSITY = 0.25
CHROMATIC_ABERRATION_INTENSITY = 0.0
FILM_GRAIN_INTENSITY = 0.0
MOTION_BLUR_AMOUNT = 0.2
MOTION_BLUR_MAX_PERCENT = 2.0      # [% of screen width]
LUMEN_SCENE_VIEW_DISTANCE_CM = 40000.0   # [cm] performance: back to 20000 first
LUMEN_MAX_TRACE_DISTANCE_CM = 40000.0    # [cm]

# Placement of the actors whose position does not change the look (tidy cluster)
ACTOR_HEIGHT_ABOVE_GROUND_M = 8.0  # [m] above the terrain at the landscape centre
# ===========================================================================

LABELS = {
    "sun": "OW_Sun",
    "atmosphere": "OW_SkyAtmosphere",
    "skylight": "OW_SkyLight",
    "fog": "OW_HeightFog",
    "cloud": "OW_VolumetricCloud",
    "ppv": "OW_PostProcess",
}
FOLDER = cfg.OUTLINER["lighting"]
FAILED = []      # (what, manual fix) for anything the engine refused
SUMMARY = []     # rows for the summary table


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def setp(obj, prop, value, where):
    """set_editor_property with a clear manual fallback instead of a crash."""
    try:
        obj.set_editor_property(prop, value)
        return True
    except Exception as exc:  # renamed in a newer engine, read-only, ...
        FAILED.append((prop, where))
        ow.warn("could not set %s (%s) - do this by hand: %s" % (prop, exc, where))
        return False


def pp(settings, field, value, where):
    """Set one Post Process Settings field and tick its override checkbox."""
    try:
        settings.set_editor_property("override_" + field, True)
        settings.set_editor_property(field, value)
    except Exception as exc:
        FAILED.append((field, where))
        ow.warn("could not set post process %s (%s) - do this by hand: %s" % (field, exc, where))


def wrap_deg(a):
    return ((a + 180.0) % 360.0) - 180.0


def cvar_int(name):
    try:
        return unreal.SystemLibrary.get_console_variable_int_value(name)
    except Exception:
        return None


def touch(actor):
    """Record the actor and its root component for Ctrl+Z before changing them."""
    actor.modify()
    root = actor.root_component
    if root:
        root.modify()


def adopt(actor, key, location):
    """Rename, tag, re-folder and move an actor the script configures."""
    touch(actor)
    tags = [t for t in actor.tags if str(t) != cfg.TAG_MANAGED]     # lights carry only OW_Lighting
    if not ow.has_tag(actor, cfg.TAG_LIGHTING):
        tags.append(unreal.Name(cfg.TAG_LIGHTING))
    if len(tags) != len(list(actor.tags)) or not ow.has_tag(actor, cfg.TAG_LIGHTING):
        setp(actor, "tags", tags, "Details > Actor > Tags: keep OW_Lighting, remove OW_Managed")
    actor.set_actor_label(LABELS[key])
    actor.set_folder_path(FOLDER)
    if location is not None:
        actor.set_actor_location(location, False, False)


def find_or_spawn(cls, key, location, rotation=None):
    found = [a for a in ow.all_actors() if isinstance(a, cls)]
    if not found:
        actor = ow.spawn(cls, location, rotation, label=LABELS[key], folder=FOLDER, tags=(cfg.TAG_LIGHTING,))
        # ow.spawn always adds OW_Managed. The five lights carry only OW_Lighting, so no
        # remove_managed() call in any script can ever delete them (only the PPV is managed).
        actor.tags = [t for t in actor.tags if str(t) != cfg.TAG_MANAGED]
        return actor, "spawned"
    tagged = [a for a in found if ow.has_tag(a, cfg.TAG_LIGHTING)]
    actor = (tagged or found)[0]
    if len(found) > 1:
        others = ", ".join(a.get_actor_label() for a in found if a != actor)
        ow.warn("%d %s actors in the level; configuring '%s'. The others still affect the image "
                "(a second sun, double fog): delete them by hand (Outliner > select > Delete): %s"
                % (len(found), cls.__name__, actor.get_actor_label(), others))
    adopt(actor, key, location)
    return actor, "reused"


def component(actor, comp_cls, fallback_prop):
    comp = actor.get_component_by_class(comp_cls)
    if comp is None:
        comp = actor.get_editor_property(fallback_prop)
    comp.modify()
    return comp


# ---------------------------------------------------------------------------
# Where things go (landscape + layout; both optional)
# ---------------------------------------------------------------------------
def scene_frame():
    try:
        fr = ow.frame()
    except RuntimeError as exc:
        ow.warn("%s - lighting actors go to the world origin, fog at Z = %.0f m" % (exc, cfg.WATER_LEVEL_M))
        return None
    return fr


def layout_or_none():
    try:
        return ow.layout()
    except (RuntimeError, OSError, ValueError) as exc:
        ow.warn("%s - using PLAYER_YAW_FALLBACK_DEG = %.2f for the sun direction" % (exc, PLAYER_YAW_FALLBACK_DEG))
        return None


# ---------------------------------------------------------------------------
# Configure each actor
# ---------------------------------------------------------------------------
def configure_sun(sun, rot):
    sun.set_actor_rotation(rot, False)
    dl = component(sun, unreal.DirectionalLightComponent, "light_component")
    dl.set_mobility(unreal.ComponentMobility.MOVABLE)
    w = "select OW_Sun > Details > "
    setp(dl, "intensity", SUN_INTENSITY_LUX, w + "Light > Intensity = %.0f lux" % SUN_INTENSITY_LUX)
    setp(dl, "light_color", unreal.Color(r=255, g=255, b=255, a=255), w + "Light > Light Color = white")
    setp(dl, "light_source_angle", SUN_SOURCE_ANGLE_DEG, w + "Light > Source Angle = %.4f" % SUN_SOURCE_ANGLE_DEG)
    setp(dl, "use_temperature", SUN_USE_TEMPERATURE, w + "Light > Use Temperature = %s" % SUN_USE_TEMPERATURE)
    setp(dl, "cast_shadows", True, w + "Light > Cast Shadows = on")
    setp(dl, "atmosphere_sun_light", True, w + "Atmosphere and Cloud > Atmosphere Sun Light = on")
    setp(dl, "atmosphere_sun_light_index", 0, w + "Atmosphere and Cloud > Atmosphere Sun Light Index = 0")
    setp(dl, "cast_cloud_shadows", SUN_CAST_CLOUD_SHADOWS, w + "Atmosphere and Cloud > Cast Cloud Shadows")
    setp(dl, "cast_shadows_on_clouds", SUN_CAST_SHADOWS_ON_CLOUDS, w + "Atmosphere and Cloud > Cast Shadows on Clouds")
    setp(dl, "cast_shadows_on_atmosphere", SUN_CAST_SHADOWS_ON_ATMOSPHERE,
         w + "Atmosphere and Cloud > Cast Shadows on Atmosphere")
    return dl


def configure_atmosphere(atmo, absolute):
    sa = component(atmo, unreal.SkyAtmosphereComponent, "sky_atmosphere_component")
    w = "select OW_SkyAtmosphere > Details > "
    mode = (unreal.SkyAtmosphereTransformMode.PLANET_TOP_AT_ABSOLUTE_WORLD_ORIGIN if absolute
            else unreal.SkyAtmosphereTransformMode.PLANET_TOP_AT_COMPONENT_TRANSFORM)
    setp(sa, "transform_mode", mode, w + "Planet > Transform Mode")
    setp(sa, "aerial_pespective_view_distance_scale", AERIAL_PERSPECTIVE_DISTANCE_SCALE,  # engine typo, no 'r'
         w + "Art Direction > Aerial Perspective View Distance Scale = %.1f" % AERIAL_PERSPECTIVE_DISTANCE_SCALE)
    setp(sa, "height_fog_contribution", HEIGHT_FOG_CONTRIBUTION,
         w + "Art Direction > Height Fog Contribution = %.1f" % HEIGHT_FOG_CONTRIBUTION)
    if MIE_SCATTERING_SCALE is not None:
        setp(sa, "mie_scattering_scale", MIE_SCATTERING_SCALE, w + "Atmosphere - Mie > Mie Scattering Scale")
    return sa


def configure_skylight(sky):
    sl = component(sky, unreal.SkyLightComponent, "light_component")
    sl.set_mobility(unreal.ComponentMobility.MOVABLE)   # Real Time Capture needs Movable
    w = "select OW_SkyLight > Details > Light > "
    setp(sl, "source_type", unreal.SkyLightSourceType.SLS_CAPTURED_SCENE, w + "Source Type = SLS Captured Scene")
    setp(sl, "real_time_capture", SKY_LIGHT_REAL_TIME_CAPTURE, w + "Real Time Capture = on")
    setp(sl, "intensity", SKY_LIGHT_INTENSITY, w + "Intensity Scale = %.1f" % SKY_LIGHT_INTENSITY)
    setp(sl, "lower_hemisphere_is_black", True, w + "Lower Hemisphere Is Solid Color = on")
    setp(sl, "lower_hemisphere_color", unreal.LinearColor(r=0.0, g=0.0, b=0.0, a=1.0), w + "Lower Hemisphere Color = black")
    setp(sl, "cast_shadows", True, w + "Cast Shadows = on")
    setp(sl, "cloud_ambient_occlusion", SKY_LIGHT_CLOUD_AO, "select OW_SkyLight > Details > Cloud Ambient Occlusion = on")
    if not SKY_LIGHT_REAL_TIME_CAPTURE:
        sl.recapture_sky()
    return sl


def cloud_material_instance():
    """Create (once) or load MI_OW_Clouds and print its parameter names."""
    path = cfg.MATERIALS_DIR + "/" + CLOUD_MI_NAME
    manual = ("Content Browser > Settings > Show Engine Content; right-click %s > Create Material Instance; "
              "save it as %s; select OW_VolumetricCloud > Details > Material = it" % (CLOUD_PARENT_MATERIAL, path))
    try:
        mi = ow.load(path)
        state = "reused"
        if mi is None:
            parent = ow.load(CLOUD_PARENT_MATERIAL)
            if parent is None:
                ow.warn("cloud material %s not found - clouds keep their material. Do this by hand: %s"
                        % (CLOUD_PARENT_MATERIAL, manual))
                return None, "skipped"
            ow.ensure_directory(cfg.MATERIALS_DIR)
            mi = unreal.AssetToolsHelpers.get_asset_tools().create_asset(
                CLOUD_MI_NAME, cfg.MATERIALS_DIR, unreal.MaterialInstanceConstant,
                unreal.MaterialInstanceConstantFactoryNew())
            unreal.MaterialEditingLibrary.set_material_instance_parent(mi, parent)
            state = "created"
        mel = unreal.MaterialEditingLibrary
        scalars = [str(n) for n in mel.get_scalar_parameter_names(mi)]
        vectors = [str(n) for n in mel.get_vector_parameter_names(mi)]
        ow.log("%s scalar parameters: %s" % (CLOUD_MI_NAME, ", ".join(scalars) or "(none)"))
        ow.log("%s vector parameters: %s" % (CLOUD_MI_NAME, ", ".join(vectors) or "(none)"))
        for name, value in CLOUD_MI_SCALARS.items():
            if name in scalars:
                mel.set_material_instance_scalar_parameter_value(mi, name, float(value))
            else:
                ow.warn("CLOUD_MI_SCALARS: '%s' is not a scalar parameter of %s (see the list above)" % (name, CLOUD_MI_NAME))
        mel.update_material_instance(mi)
        unreal.EditorAssetLibrary.save_asset(path, False)
        return mi, state
    except Exception as exc:
        FAILED.append((CLOUD_MI_NAME, manual))
        ow.warn("could not set up %s (%s) - do this by hand: %s" % (CLOUD_MI_NAME, exc, manual))
        return None, "failed"


def configure_cloud(cloud):
    vc = component(cloud, unreal.VolumetricCloudComponent, "volumetric_cloud_component")
    w = "select OW_VolumetricCloud > Details > "
    setp(vc, "layer_bottom_altitude", CLOUD_LAYER_BOTTOM_KM, w + "Layer > Layer Bottom Altitude = %.1f" % CLOUD_LAYER_BOTTOM_KM)
    setp(vc, "layer_height", CLOUD_LAYER_HEIGHT_KM, w + "Layer > Layer Height = %.1f" % CLOUD_LAYER_HEIGHT_KM)
    setp(vc, "tracing_max_distance", CLOUD_TRACING_MAX_DISTANCE_KM, w + "Cloud Tracing > Tracing Max Distance")
    setp(vc, "view_sample_count_scale", CLOUD_VIEW_SAMPLE_COUNT_SCALE, w + "View Sample Count Scale")
    setp(vc, "reflection_view_sample_count_scale_value", CLOUD_REFLECTION_SAMPLE_COUNT_SCALE,
         w + "Reflection View Sample Count Scale = %.2f" % CLOUD_REFLECTION_SAMPLE_COUNT_SCALE)
    mi_state = "unchanged"
    if CLOUD_CREATE_MATERIAL_INSTANCE:
        mi, mi_state = cloud_material_instance()
        if mi is not None:
            setp(vc, "material", mi, w + "Cloud Material > Material = %s" % CLOUD_MI_NAME)
    return vc, mi_state


def configure_fog(fog):
    hf = component(fog, unreal.ExponentialHeightFogComponent, "component")
    w = "select OW_HeightFog > Details > "
    black = unreal.LinearColor(r=0.0, g=0.0, b=0.0, a=1.0)
    setp(hf, "fog_density", FOG_DENSITY, w + "Fog Density = %.3f" % FOG_DENSITY)
    setp(hf, "fog_height_falloff", FOG_HEIGHT_FALLOFF, w + "Fog Height Falloff = %.2f" % FOG_HEIGHT_FALLOFF)
    second = hf.get_editor_property("second_fog_data")
    setp(second, "fog_density", 0.0, w + "Second Fog Data > Fog Density = 0")
    setp(hf, "second_fog_data", second, w + "Second Fog Data > Fog Density = 0")
    setp(hf, "fog_inscattering_luminance", black, w + "Fog Inscattering Color = black")
    setp(hf, "directional_inscattering_luminance", black, w + "Directional Inscattering Color = black")
    setp(hf, "fog_max_opacity", FOG_MAX_OPACITY, w + "Fog Max Opacity = %.2f" % FOG_MAX_OPACITY)
    setp(hf, "start_distance", FOG_START_DISTANCE_CM, w + "Start Distance = %.0f" % FOG_START_DISTANCE_CM)
    setp(hf, "enable_volumetric_fog", VOLUMETRIC_FOG, w + "Volumetric Fog > Volumetric Fog = on")
    setp(hf, "volumetric_fog_scattering_distribution", VOLUMETRIC_FOG_SCATTERING_DISTRIBUTION,
         w + "Volumetric Fog > Scattering Distribution = %.2f" % VOLUMETRIC_FOG_SCATTERING_DISTRIBUTION)
    setp(hf, "volumetric_fog_extinction_scale", VOLUMETRIC_FOG_EXTINCTION_SCALE,
         w + "Volumetric Fog > Extinction Scale = %.1f" % VOLUMETRIC_FOG_EXTINCTION_SCALE)
    setp(hf, "volumetric_fog_distance", VOLUMETRIC_FOG_VIEW_DISTANCE_CM,
         w + "Volumetric Fog > View Distance = %.0f" % VOLUMETRIC_FOG_VIEW_DISTANCE_CM)
    return hf


def configure_ppv(ppv):
    w = "select OW_PostProcess > Details > "
    setp(ppv, "unbound", True, w + "Post Process Volume Settings > Infinite Extent (Unbound) = on")
    setp(ppv, "priority", PPV_PRIORITY, w + "Post Process Volume Settings > Priority = %.0f" % PPV_PRIORITY)
    setp(ppv, "blend_weight", 1.0, w + "Post Process Volume Settings > Blend Weight = 1")
    setp(ppv, "enabled", True, w + "Post Process Volume Settings > Enabled = on")
    s = ppv.get_editor_property("settings")
    e = w + "Lens > Exposure > "
    pp(s, "auto_exposure_method", unreal.AutoExposureMethod.AEM_HISTOGRAM, e + "Metering Mode = Auto Exposure Histogram")
    pp(s, "auto_exposure_bias", EXPOSURE_COMPENSATION, e + "Exposure Compensation = %.1f" % EXPOSURE_COMPENSATION)
    pp(s, "auto_exposure_min_brightness", EXPOSURE_MIN_EV100, e + "Min EV100 = %.1f" % EXPOSURE_MIN_EV100)
    pp(s, "auto_exposure_max_brightness", EXPOSURE_MAX_EV100, e + "Max EV100 = %.1f" % EXPOSURE_MAX_EV100)
    pp(s, "auto_exposure_speed_up", EXPOSURE_SPEED_UP, e + "Speed Up = %.1f" % EXPOSURE_SPEED_UP)
    pp(s, "auto_exposure_speed_down", EXPOSURE_SPEED_DOWN, e + "Speed Down = %.1f" % EXPOSURE_SPEED_DOWN)
    l = w + "Lens > Local Exposure > "
    pp(s, "local_exposure_method", unreal.LocalExposureMethod.BILATERAL, l + "Method = Bilateral")
    pp(s, "local_exposure_highlight_contrast_scale", LOCAL_EXPOSURE_HIGHLIGHT_CONTRAST,
       l + "Highlight Contrast = %.2f" % LOCAL_EXPOSURE_HIGHLIGHT_CONTRAST)
    pp(s, "local_exposure_shadow_contrast_scale", LOCAL_EXPOSURE_SHADOW_CONTRAST,
       l + "Shadow Contrast = %.2f" % LOCAL_EXPOSURE_SHADOW_CONTRAST)
    g = w + "Color Grading > Global > "
    pp(s, "color_saturation", unreal.Vector4(x=COLOR_SATURATION, y=COLOR_SATURATION, z=COLOR_SATURATION, w=1.0),
       g + "Saturation = %.2f" % COLOR_SATURATION)
    pp(s, "color_contrast", unreal.Vector4(x=COLOR_CONTRAST, y=COLOR_CONTRAST, z=COLOR_CONTRAST, w=1.0),
       g + "Contrast = %.2f" % COLOR_CONTRAST)
    pp(s, "bloom_method", unreal.BloomMethod.BM_SOG, w + "Lens > Bloom > Method = Standard")
    pp(s, "bloom_intensity", BLOOM_INTENSITY, w + "Lens > Bloom > Intensity = %.2f" % BLOOM_INTENSITY)
    pp(s, "lens_flare_intensity", LENS_FLARE_INTENSITY, w + "Lens > Lens Flares > Intensity = %.1f" % LENS_FLARE_INTENSITY)
    pp(s, "vignette_intensity", VIGNETTE_INTENSITY, w + "Lens > Image Effects > Vignette Intensity = %.2f" % VIGNETTE_INTENSITY)
    pp(s, "scene_fringe_intensity", CHROMATIC_ABERRATION_INTENSITY,
       w + "Lens > Chromatic Aberration > Intensity = %.1f" % CHROMATIC_ABERRATION_INTENSITY)
    pp(s, "film_grain_intensity", FILM_GRAIN_INTENSITY, w + "Film Grain > Film Grain Intensity = %.2f" % FILM_GRAIN_INTENSITY)
    pp(s, "motion_blur_amount", MOTION_BLUR_AMOUNT, w + "Motion Blur > Amount = %.2f" % MOTION_BLUR_AMOUNT)
    pp(s, "motion_blur_max", MOTION_BLUR_MAX_PERCENT, w + "Motion Blur > Max = %.1f" % MOTION_BLUR_MAX_PERCENT)
    pp(s, "lumen_scene_view_distance", LUMEN_SCENE_VIEW_DISTANCE_CM,
       w + "Global Illumination > Lumen Scene View Distance = %.0f" % LUMEN_SCENE_VIEW_DISTANCE_CM)
    pp(s, "lumen_max_trace_distance", LUMEN_MAX_TRACE_DISTANCE_CM,
       w + "Global Illumination > Max Trace Distance = %.0f" % LUMEN_MAX_TRACE_DISTANCE_CM)
    setp(ppv, "settings", s, w + "(all post process values above)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def check_project_settings():
    ow.log("engine %s, Python %s" % (unreal.SystemLibrary.get_engine_version(), sys.version.split()[0]))
    if cvar_int("r.DefaultFeature.AutoExposure.ExtendDefaultLuminanceRange") != 1:
        ow.warn("'Extend default luminance range in Auto Exposure settings' reads OFF (or could not be read). "
                "The exposure values (EV100) are only right with it ON: Edit > Project Settings > Engine > "
                "Rendering > Default Settings > tick it (see step 4.1).")
    if cvar_int("r.SupportSkyAtmosphereAffectsHeightFog") != 1:
        ow.warn("'Support Sky Atmosphere Affecting Height Fog' reads OFF (or could not be read). With it off the "
                "black fog colours set here make the fog dark: Edit > Project Settings > Engine > Rendering > "
                "tick it (restart), or set OW_HeightFog > Fog Inscattering Color to a light blue.")


def run():
    check_project_settings()
    fr = scene_frame()
    lay = layout_or_none()

    player_yaw = float(lay["player_start"]["yaw_deg"]) if lay else PLAYER_YAW_FALLBACK_DEG
    sun_azimuth = wrap_deg(player_yaw + SUN_AZIMUTH_OFFSET_DEG)
    sun_rot = ow.yaw_rotator(wrap_deg(sun_azimuth + 180.0), pitch_deg=-SUN_ELEVATION_DEG)

    water_m = float(lay["water_level_m"]) if lay else cfg.WATER_LEVEL_M
    if fr:
        centre = fr.center
        ground = ow.ground_z(centre.x, centre.y, default=fr.height_to_world_z(cfg.BASE_HEIGHT_M))
        land_z = fr.origin.z
        fog_z = fr.height_to_world_z(water_m + FOG_HEIGHT_ABOVE_WATER_M)
        if lay:
            px, py, ph = lay["player_start"]["position_m"]
            ppv_loc = fr.to_world(px, py, ph + 3.0)
        else:
            ppv_loc = unreal.Vector(centre.x, centre.y, ground + 500.0)
    else:
        centre, ground, land_z = unreal.Vector(0.0, 0.0, 0.0), 0.0, 0.0
        fog_z = (water_m + FOG_HEIGHT_ABOVE_WATER_M) * 100.0
        ppv_loc = unreal.Vector(0.0, 0.0, 500.0)
    absolute = land_z >= -1.0     # terrain at or above world Z = 0 -> planet ground at world origin
    up = ACTOR_HEIGHT_ABOVE_GROUND_M * 100.0

    def spot(dx_m, dz_cm=0.0):
        return unreal.Vector(centre.x + dx_m * 100.0, centre.y, ground + up + dz_cm)

    with unreal.ScopedEditorTransaction("OW: Lighting"):
        # the post process volume is the one actor this script always replaces
        old = [a for a in ow.managed(cfg.TAG_LIGHTING) if isinstance(a, unreal.PostProcessVolume)]
        if old:
            ow.actors_subsystem().destroy_actors(old)
            ow.refresh_trace_cache()
            ow.log("removed %d old OW post process volume(s)" % len(old))
        others = [a for a in ow.all_actors() if isinstance(a, unreal.PostProcessVolume)]
        for a in others:
            ow.warn("another Post Process Volume '%s' is in the level; it blends with OW_PostProcess. "
                    "Delete it unless you need it." % a.get_actor_label())

        sun, sun_state = find_or_spawn(unreal.DirectionalLight, "sun", spot(0.0), sun_rot)
        dl = configure_sun(sun, sun_rot)
        SUMMARY.append((LABELS["sun"], sun_state, "Rotation X(roll) 0 / Y(pitch) %.1f / Z(yaw) %.1f, %.0f lux, Movable"
                        % (sun_rot.pitch, sun_rot.yaw, SUN_INTENSITY_LUX)))

        atmo_loc = spot(4.0) if absolute else unreal.Vector(centre.x, centre.y, land_z)
        atmo, atmo_state = find_or_spawn(unreal.SkyAtmosphere, "atmosphere", atmo_loc)
        sa = configure_atmosphere(atmo, absolute)
        SUMMARY.append((LABELS["atmosphere"], atmo_state, "%s, aerial perspective x%.1f"
                        % ("Planet Top at Absolute World Origin" if absolute else "Planet Top at Component Transform",
                           AERIAL_PERSPECTIVE_DISTANCE_SCALE)))

        sky, sky_state = find_or_spawn(unreal.SkyLight, "skylight", spot(8.0))
        configure_skylight(sky)
        SUMMARY.append((LABELS["skylight"], sky_state, "Real Time Capture %s, Intensity Scale %.1f, Movable"
                        % ("on" if SKY_LIGHT_REAL_TIME_CAPTURE else "off", SKY_LIGHT_INTENSITY)))

        cloud, cloud_state = find_or_spawn(unreal.VolumetricCloud, "cloud", spot(12.0))
        vc, mi_state = configure_cloud(cloud)
        SUMMARY.append((LABELS["cloud"], cloud_state, "layer %.1f km + %.1f km, material %s (%s)"
                        % (CLOUD_LAYER_BOTTOM_KM, CLOUD_LAYER_HEIGHT_KM, CLOUD_MI_NAME, mi_state)))

        fog_loc = unreal.Vector(centre.x, centre.y, fog_z)
        fog, fog_state = find_or_spawn(unreal.ExponentialHeightFog, "fog", fog_loc)
        configure_fog(fog)
        SUMMARY.append((LABELS["fog"], fog_state, "density %.3f, falloff %.2f, Z %.0f cm (water level), volumetric %s"
                        % (FOG_DENSITY, FOG_HEIGHT_FALLOFF, fog_z, "on" if VOLUMETRIC_FOG else "off")))

        ppv = ow.spawn(unreal.PostProcessVolume, ppv_loc, label=LABELS["ppv"], folder=FOLDER,
                       tags=(cfg.TAG_LIGHTING,))
        configure_ppv(ppv)
        SUMMARY.append((LABELS["ppv"], "spawned", "unbound, EV100 %.0f-%.0f, compensation %.1f, priority %.0f"
                        % (EXPOSURE_MIN_EV100, EXPOSURE_MAX_EV100, EXPOSURE_COMPENSATION, PPV_PRIORITY)))

    # How much sun reaches the ground through this atmosphere (information only)
    try:
        t = sa.get_atmosphere_transmitance_on_ground_at_planet_top(dl)
        lum = 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b
        facing = SUN_INTENSITY_LUX * lum
        flat = facing * math.sin(math.radians(SUN_ELEVATION_DEG))
        ow.log("sun through the atmosphere: transmittance RGB (%.2f, %.2f, %.2f) -> about %.0f lux facing the sun, "
               "%.0f lux direct on flat ground (expect roughly 0.6 / 73000 / 19000 at 15 deg)"
               % (t.r, t.g, t.b, facing, flat))
    except Exception as exc:
        ow.log("could not read the atmosphere transmittance (%s); skip this check" % exc)

    ow.log("sun azimuth %.1f deg (player view %.1f deg, offset %.0f deg), elevation %.1f deg"
           % (sun_azimuth, player_yaw, SUN_AZIMUTH_OFFSET_DEG, SUN_ELEVATION_DEG))
    ow.log("Lighting summary (Outliner folder %s):" % FOLDER)
    ow.log("  %-20s %-8s %s" % ("actor", "action", "key values"))
    for label, state, info in SUMMARY:
        ow.log("  %-20s %-8s %s" % (label, state, info))
    if FAILED:
        ow.warn("%d setting(s) could not be applied - see the 'do this by hand' warnings above" % len(FAILED))
    ow.log("p4_lighting done: %d actors configured, %d spawned. Check the view, then press Ctrl+S."
           % (len(SUMMARY), sum(1 for r in SUMMARY if r[1] == "spawned")))


run()
