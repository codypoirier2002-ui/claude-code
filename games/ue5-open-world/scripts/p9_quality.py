"""Phase 9 - Quality presets: Performance / Balanced / Cinematic in one run.

Build-plan step: 9.3 (the presets are explained in 9.2 and 9.3; Part B step 9.6 uses
"cinematic" for screenshots).

How to run (see step 1.5):
  Tools > Execute Python Script... and pick OpenWorldTools/scripts/p9_quality.py, or type
      py "C:/<Project>/OpenWorldTools/scripts/p9_quality.py"
  in the Output Log command box (Cmd mode). Open L_OpenWorld first and run p4_lighting.py
  before this script (it needs the post process volume OW_PostProcess).
  Change PRESET in the TUNABLES block below to switch presets, then run it again.

What it creates / changes:
  * (a) Post process: edits the Lumen fields of OW_PostProcess (the unbound volume that
    p4_lighting.py spawned; found by its tag OW_Lighting and its label) and ticks their
    override checkboxes. These values are saved with the level when you press Ctrl+S.
  * (a) Clouds: sets View Sample Count Scale on OW_VolumetricCloud (the post process volume
    has no fog or cloud settings, so the cloud actor is the place for them).
  * (b) Console variables: sets scalability groups (sg.*) and a few r.* values with
    unreal.SystemLibrary.execute_console_command for THIS editor session only (they are
    gone after a restart and are not saved in the level).
  * (c) Prints the matching lines to paste into Config/DefaultEngine.ini and
    Config/DefaultGameUserSettings.ini (close the editor first), plus a console-command
    list. The script never writes any config file.
  * It never spawns or deletes actors. Phase 4 lights (tag OW_Lighting) are left alone.
  * Does not save the level: check the result, then press Ctrl+S.

Safe to re-run: every preset sets the same list of values, so running another preset
fully replaces the previous one. Re-running p4_lighting.py resets the post process volume
and the clouds to the "balanced" values; run this script again afterwards.

Undo: Ctrl+Z (one step, "OW: Quality preset") restores the post process and cloud values.
Console variables are not part of the undo history: run the script again with another
PRESET, or restart the editor.
"""
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unreal
import ow_common as ow
importlib.reload(ow)
cfg = ow.cfg

# ===========================================================================
# TUNABLES (units in brackets; step of the build plan in front)
# ===========================================================================
# 9.3 Which preset to apply: "performance", "balanced" or "cinematic"
PRESET = "balanced"

# 9.3 What to touch
APPLY_POST_PROCESS = True     # (a) Lumen fields on OW_PostProcess
APPLY_CLOUDS = True           # (a) View Sample Count Scale on OW_VolumetricCloud
APPLY_CONSOLE_VARIABLES = True  # (b) sg.* and r.* for this editor session
PRINT_CONFIG_LINES = True     # (c) ini blocks and console list in the Output Log

# 9.1 Output resolution you measure at [pixels, vertical]: 1080 or 1440. Picks the
# r.ScreenPercentage of the preset (TSR upscales the rest).
OUTPUT_HEIGHT = 1440

# 9.2 5.8 only: True = the performance preset uses Global Illumination scalability Medium
# (Lumen Lite, Beta, about 2x faster than High). On 5.6/5.7 Medium turns Lumen GI off, so
# the script ignores this flag there.
USE_LUMEN_LITE_ON_58 = False

# 9.2 / 9.3 The presets. Every preset must list the same keys (so switching is complete).
# Post process values: Lumen distances in cm; qualities are multipliers (1 = default).
PRESETS = {
    "performance": {
        "screen_percentage": {1080: 77, 1440: 67},     # [%] r.ScreenPercentage
        "sg": {                                          # scalability groups, 0 Low .. 3 Epic, 4 Cinematic
            "sg.ViewDistanceQuality": 2,
            "sg.AntiAliasingQuality": 2,                 # TSR history 100 % instead of 200 %
            "sg.ShadowQuality": 2,                       # keep >= 2: Medium (1) turns volumetric fog off
            "sg.GlobalIlluminationQuality": 2,           # 1 = Lumen Lite on 5.8 (see USE_LUMEN_LITE_ON_58)
            "sg.ReflectionQuality": 2,
            "sg.PostProcessQuality": 2,
            "sg.TextureQuality": 2,
            "sg.EffectsQuality": 2,
            "sg.FoliageQuality": 2,
            "sg.ShadingQuality": 2,
        },
        "cvars": {                                       # set after the groups, so they win
            "r.VolumetricFog.GridPixelSize": 16,         # [px] Epic uses 8
            "r.VolumetricFog.GridSizeZ": 64,             # [slices] Epic uses 128
            "r.Water.SingleLayer.Reflection.DownsampleFactor": 2,
            "r.Nanite.MaxPixelsPerEdge": 2.0,            # coarser Nanite triangles (default believed 1)
        },
        "ppv": {
            "lumen_scene_view_distance": 20000.0,        # [cm] engine default (believed)
            "lumen_max_trace_distance": 20000.0,         # [cm]
            "lumen_scene_lighting_quality": 1.0,
            "lumen_scene_detail": 1.0,
            "lumen_final_gather_quality": 1.0,
            "lumen_reflection_quality": 1.0,
            "lumen_max_roughness_to_trace_reflections": 0.3,
        },
        "hit_lighting_reflections": False,               # HWRT hit lighting for reflections (lake)
        "cloud_view_sample_count_scale": 0.5,
    },
    "balanced": {   # = the Phase 4 values, at High scalability
        "screen_percentage": {1080: 100, 1440: 77},
        "sg": {
            "sg.ViewDistanceQuality": 3,
            "sg.AntiAliasingQuality": 2,
            "sg.ShadowQuality": 2,
            "sg.GlobalIlluminationQuality": 2,
            "sg.ReflectionQuality": 2,
            "sg.PostProcessQuality": 3,
            "sg.TextureQuality": 3,
            "sg.EffectsQuality": 3,
            "sg.FoliageQuality": 3,
            "sg.ShadingQuality": 3,
        },
        "cvars": {
            "r.VolumetricFog.GridPixelSize": 16,
            "r.VolumetricFog.GridSizeZ": 128,
            "r.Water.SingleLayer.Reflection.DownsampleFactor": 1,
            "r.Nanite.MaxPixelsPerEdge": 1.0,
        },
        "ppv": {
            "lumen_scene_view_distance": 40000.0,
            "lumen_max_trace_distance": 40000.0,
            "lumen_scene_lighting_quality": 1.0,
            "lumen_scene_detail": 1.0,
            "lumen_final_gather_quality": 1.0,
            "lumen_reflection_quality": 1.0,
            "lumen_max_roughness_to_trace_reflections": 0.4,
        },
        "hit_lighting_reflections": False,
        "cloud_view_sample_count_scale": 1.0,
    },
    "cinematic": {  # screenshots and video; expect 30-45 fps on an 8 GB RTX 3060/3070
        "screen_percentage": {1080: 100, 1440: 100},
        "sg": {
            "sg.ViewDistanceQuality": 3,
            "sg.AntiAliasingQuality": 3,
            "sg.ShadowQuality": 3,
            "sg.GlobalIlluminationQuality": 3,
            "sg.ReflectionQuality": 3,
            "sg.PostProcessQuality": 3,
            "sg.TextureQuality": 3,
            "sg.EffectsQuality": 3,
            "sg.FoliageQuality": 3,
            "sg.ShadingQuality": 3,
        },
        "cvars": {
            "r.VolumetricFog.GridPixelSize": 8,
            "r.VolumetricFog.GridSizeZ": 128,
            "r.Water.SingleLayer.Reflection.DownsampleFactor": 1,
            "r.Nanite.MaxPixelsPerEdge": 1.0,
        },
        "ppv": {
            "lumen_scene_view_distance": 60000.0,
            "lumen_max_trace_distance": 40000.0,
            "lumen_scene_lighting_quality": 2.0,
            "lumen_scene_detail": 2.0,
            "lumen_final_gather_quality": 2.0,           # 4 for a single still (step 9.6)
            "lumen_reflection_quality": 2.0,
            "lumen_max_roughness_to_trace_reflections": 0.4,
        },
        "hit_lighting_reflections": True,                # only applied when HWRT is active
        "cloud_view_sample_count_scale": 2.0,
    },
}
# ===========================================================================

PPV_LABEL = "OW_PostProcess"
CLOUD_LABEL = "OW_VolumetricCloud"
FAILED = []    # (what, manual fix)
REPORT = []    # (what, value, status)

PPV_UI = {  # Details labels for the manual fallback (Global Illumination / Reflections > Lumen)
    "lumen_scene_view_distance": "Global Illumination > Lumen Scene View Distance",
    "lumen_max_trace_distance": "Global Illumination > Max Trace Distance",
    "lumen_scene_lighting_quality": "Global Illumination > Lumen Scene Lighting Quality",
    "lumen_scene_detail": "Global Illumination > Lumen Scene Detail",
    "lumen_final_gather_quality": "Global Illumination > Final Gather Quality",
    "lumen_reflection_quality": "Reflections > Quality",
    "lumen_max_roughness_to_trace_reflections": "Reflections > Max Roughness to Trace",
    "lumen_ray_lighting_mode": "Reflections > Ray Lighting Mode",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def engine_minor():
    """5.6 -> 6, 5.8 -> 8; None if the version string is unexpected."""
    ver = unreal.SystemLibrary.get_engine_version()
    try:
        major, minor = ver.split(".")[:2]
        return int(minor) if major == "5" else None
    except (ValueError, IndexError):
        return None


def cvar_text(name):
    """Current value of a console variable as text ('' if it cannot be read)."""
    try:
        raw = unreal.SystemLibrary.get_console_variable_string_value(name)
    except Exception:
        raw = ""
    if raw:
        return raw.strip()
    try:
        return "%g" % unreal.SystemLibrary.get_console_variable_float_value(name)
    except Exception:
        return ""


def same_value(a, b):
    try:
        return abs(float(a) - float(b)) < 1e-3
    except (TypeError, ValueError):
        return str(a).strip().lower() == str(b).strip().lower()


def fmt(v):
    return ("%g" % v) if isinstance(v, (int, float)) else str(v)


def find_tagged(cls, label):
    """The actor of this class tagged OW_Lighting, preferring the given label (as p4_lighting.py names it)."""
    found = [a for a in ow.all_actors() if isinstance(a, cls)]
    tagged = [a for a in found if ow.has_tag(a, cfg.TAG_LIGHTING)]
    named = [a for a in (tagged or found) if a.get_actor_label() == label]
    pick = (named or tagged)
    if len(pick) > 1:
        ow.warn("%d %s actors tagged OW_Lighting; using '%s'. Re-run p4_lighting.py to clean up."
                % (len(pick), cls.__name__, pick[0].get_actor_label()))
    return pick[0] if pick else None


def hwrt_active():
    """True when Lumen uses hardware ray tracing (both project settings on)."""
    try:
        sl = unreal.SystemLibrary
        return (sl.get_console_variable_int_value("r.RayTracing") == 1
                and sl.get_console_variable_int_value("r.Lumen.HardwareRayTracing") == 1)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# (a) Post process volume and clouds
# ---------------------------------------------------------------------------
def apply_post_process(ppv, values, hit_lighting):
    s = ppv.get_editor_property("settings")
    for field, value in values.items():
        where = "select %s > Details > tick and set %s = %s" % (PPV_LABEL, PPV_UI[field], fmt(value))
        try:
            s.set_editor_property("override_" + field, True)
            s.set_editor_property(field, value)
            REPORT.append((PPV_LABEL + " " + PPV_UI[field], fmt(value), "set"))
        except Exception as exc:
            FAILED.append((field, where))
            ow.warn("could not set post process %s (%s) - do this by hand: %s" % (field, exc, where))
    mode_enum = unreal.LumenRayLightingModeOverride
    mode = mode_enum.HIT_LIGHTING_FOR_REFLECTIONS if (hit_lighting and hwrt_active()) else mode_enum.DEFAULT
    if hit_lighting and mode == mode_enum.DEFAULT:
        ow.log("hardware ray tracing is not active (r.RayTracing / r.Lumen.HardwareRayTracing), "
               "so Ray Lighting Mode stays Default")
    try:
        s.set_editor_property("override_lumen_ray_lighting_mode", True)
        s.set_editor_property("lumen_ray_lighting_mode", mode)
        label = "Hit Lighting for Reflections" if mode == mode_enum.HIT_LIGHTING_FOR_REFLECTIONS else "Default"
        REPORT.append((PPV_LABEL + " " + PPV_UI["lumen_ray_lighting_mode"], label, "set"))
    except Exception as exc:
        FAILED.append(("lumen_ray_lighting_mode", PPV_UI["lumen_ray_lighting_mode"]))
        ow.warn("could not set Ray Lighting Mode (%s) - do this by hand: select %s > Details > %s"
                % (exc, PPV_LABEL, PPV_UI["lumen_ray_lighting_mode"]))
    try:
        ppv.set_editor_property("settings", s)
    except Exception as exc:
        FAILED.append(("settings", "all post process values above"))
        ow.warn("could not write the post process settings back (%s) - set the values above by hand" % exc)


def apply_clouds(cloud, scale):
    where = ("select %s > Details > Cloud Tracing > View Sample Count Scale = %s" % (CLOUD_LABEL, fmt(scale)))
    try:
        comp = cloud.get_component_by_class(unreal.VolumetricCloudComponent)
        if comp is None:
            comp = cloud.get_editor_property("volumetric_cloud_component")
        comp.modify()
        comp.set_editor_property("view_sample_count_scale", scale)
        REPORT.append((CLOUD_LABEL + " View Sample Count Scale", fmt(scale), "set"))
    except Exception as exc:
        FAILED.append(("view_sample_count_scale", where))
        ow.warn("could not set the cloud sample count (%s) - do this by hand: %s" % (exc, where))


# ---------------------------------------------------------------------------
# (b) Console variables
# ---------------------------------------------------------------------------
def console_list(preset, minor):
    """Ordered (name, value) list: groups first, then the cvars that refine them."""
    out = []
    for name, value in preset["sg"].items():
        if name == "sg.GlobalIlluminationQuality" and PRESET == "performance" and USE_LUMEN_LITE_ON_58:
            if minor is not None and minor >= 8:
                value = 1
            else:
                ow.warn("USE_LUMEN_LITE_ON_58 ignored: this is not 5.8 (Medium GI would turn Lumen GI off)")
        out.append((name, value))
    out.append(("r.ScreenPercentage", screen_percentage(preset)))
    out.extend(preset["cvars"].items())
    return out


def screen_percentage(preset):
    table = preset["screen_percentage"]
    if OUTPUT_HEIGHT in table:
        return table[OUTPUT_HEIGHT]
    ow.warn("OUTPUT_HEIGHT = %s is not 1080 or 1440; using the 1440 value" % OUTPUT_HEIGHT)
    return table[1440]


def apply_console(pairs, world):
    for name, value in pairs:
        before = cvar_text(name)
        cmd = "%s %s" % (name, fmt(value))
        try:
            unreal.SystemLibrary.execute_console_command(world, cmd)
        except Exception as exc:
            FAILED.append((name, "type '%s' in the console" % cmd))
            ow.warn("could not run '%s' (%s) - type it in the console (` key)" % (cmd, exc))
            continue
        after = cvar_text(name)
        if after and not same_value(after, value):
            status = "CHECK (reads %s)" % after
            ow.warn("%s reads %s after '%s': the name may differ in this engine version, or another "
                    "setting overrides it. Type '%s ?' in the console to check." % (name, after, cmd, name))
        else:
            status = "was %s" % (before or "?")
        REPORT.append((name, fmt(value), status))


# ---------------------------------------------------------------------------
# (c) Lines for config files
# ---------------------------------------------------------------------------
def print_config(pairs, preset):
    sg = [(n, v) for n, v in pairs if n.startswith("sg.")]
    rv = [(n, v) for n, v in pairs if not n.startswith("sg.")]
    ow.log("---- (c) To keep preset '%s' outside this editor session (close the editor first) ----" % PRESET)
    ow.log("Config/DefaultGameUserSettings.ini (scalability for Standalone and packaged builds; "
           "a player's own settings in Saved/ override it):")
    ow.log("[ScalabilityGroups]")
    for n, v in sg:
        ow.log("%s=%s" % (n, fmt(v)))
    ow.log("Config/DefaultEngine.ini (these win over the scalability groups; delete them to give the "
           "scalability menu control back):")
    ow.log("[SystemSettings]")
    for n, v in rv:
        ow.log("%s=%s" % (n, fmt(v)))
    ow.log("Console commands (paste one per line into the console, or into a Level Blueprint "
           "'Execute Console Command' node on BeginPlay):")
    for n, v in pairs:
        ow.log("%s %s" % (n, fmt(v)))
    ow.log("Post process and cloud values are stored in L_OpenWorld itself once you press Ctrl+S:")
    for field, value in preset["ppv"].items():
        ow.log("  %s: %s = %s" % (PPV_LABEL, PPV_UI[field], fmt(value)))
    ow.log("  %s: View Sample Count Scale = %s" % (CLOUD_LABEL, fmt(preset["cloud_view_sample_count_scale"])))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def run():
    name = str(PRESET).strip().lower()
    if name not in PRESETS:
        ow.error("PRESET = '%s' is not one of %s - edit the TUNABLES block" % (PRESET, ", ".join(PRESETS)))
        return
    preset = PRESETS[name]
    minor = engine_minor()
    ow.log("engine %s, Python %s, preset '%s', output %dp"
           % (unreal.SystemLibrary.get_engine_version(), sys.version.split()[0], name, OUTPUT_HEIGHT))
    world = ow.editor_world()
    pairs = console_list(preset, minor)

    ppv = find_tagged(unreal.PostProcessVolume, PPV_LABEL) if APPLY_POST_PROCESS else None
    cloud = find_tagged(unreal.VolumetricCloud, CLOUD_LABEL) if APPLY_CLOUDS else None
    if APPLY_POST_PROCESS and ppv is None:
        ow.warn("no Post Process Volume tagged OW_Lighting - run p4_lighting.py first (step 4.1). "
                "Post process values skipped; they are printed below for manual entry.")
    if APPLY_CLOUDS and cloud is None:
        ow.warn("no Volumetric Cloud tagged OW_Lighting - run p4_lighting.py first. Cloud value skipped.")

    if ppv is not None or cloud is not None:
        with unreal.ScopedEditorTransaction("OW: Quality preset"):
            if ppv is not None:
                ppv.modify()
                apply_post_process(ppv, preset["ppv"], preset["hit_lighting_reflections"])
            if cloud is not None:
                apply_clouds(cloud, preset["cloud_view_sample_count_scale"])

    if APPLY_CONSOLE_VARIABLES:
        apply_console(pairs, world)

    ow.log("Quality preset '%s':" % name)
    ow.log("  %-62s %-22s %s" % ("setting", "value", "status"))
    for what, value, status in REPORT:
        ow.log("  %-62s %-22s %s" % (what, value, status))
    if PRINT_CONFIG_LINES:
        print_config(pairs, preset)
    if FAILED:
        ow.warn("%d setting(s) could not be applied - see the 'do this by hand' warnings above" % len(FAILED))
    ow.log("p9_quality done: preset '%s', %d post process/cloud values, %d console variables. "
           "Console values last until the editor closes; press Ctrl+S to keep the volume values."
           % (name, sum(1 for r in REPORT if not r[0].startswith(("sg.", "r."))),
              sum(1 for r in REPORT if r[0].startswith(("sg.", "r.")))))


run()
