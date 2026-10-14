"""p1_check_project.py - check the project setup (build plan Phase 1, steps 1.5-1.9).

What it does
  Prints a PASS / FIX / WARN / INFO table in the Output Log:
    * engine and Python version;
    * plugins this plan needs (PCG, Water, Python, Editor Scripting Utilities, Fab);
    * rendering project settings, read from their console variables
      (Lumen GI + reflections, Virtual Shadow Maps, mesh distance fields, TSR,
      auto-exposure luminance range, Nanite, hardware ray tracing, Substrate);
    * the level: L_OpenWorld open, not World Partition, template Floor deleted,
      Editor Startup Map / Game Default Map;
    * every path in ow_config.ASSETS (exists, right asset type, pasted correctly);
    * the current editor scalability (step 1.9).
  Every FIX line names the exact menu path that fixes it.

What it changes
  Nothing in the project settings or the level. The only write: it creates the
  empty Content Browser folders from ow_config.py (/Game/OpenWorld/Maps,
  /Materials, /Landscape/Layers, /PCG, /Blueprints, /Water). Turn that off with
  CREATE_FOLDERS = False.

How to run (build plan step 1.5)
  Tools > Execute Python Script... and pick this file, or type in the Output Log
  (command box set to Cmd):
      py "C:/.../OpenWorldDemo/OpenWorldTools/scripts/p1_check_project.py"

Safe to re-run: yes, as often as you like (run it again after each fix, after
step 1.6 and after filling ow_config.ASSETS in step 1.7). It spawns no actors.

Undo: nothing to undo. To remove the folders it created, delete them in the
Content Browser (they are empty).

API names were checked against the UE 5.6 Python API.
"""
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unreal
import ow_common as ow
importlib.reload(ow)
cfg = ow.cfg

import re  # noqa: E402

# ===========================================================================
# TUNABLES
# ===========================================================================
CREATE_FOLDERS = True                 # 1.5: create the /Game/OpenWorld folder tree from ow_config.py
EXPECT_HARDWARE_RAY_TRACING = None    # 1.4: None = only report; True / False = FIX if Lumen differs
MIN_VERSION = (5, 6)                  # 1.1: oldest engine this plan supports
NEWEST_TESTED = (5, 8)                # 1.1: newer engines get a WARN (labels may have moved)
RECOMMENDED_COUNTS = {                # 1.7: how many meshes per ow_config.ASSETS slot
    "trees": (3, 6), "bushes": (2, 4), "grass": (2, 5), "flowers": (0, 4),
    "scatter": (2, 6), "shore_scatter": (1, 4), "boulders": (3, 6), "mountains": (3, 6),
}
# ===========================================================================

RENDERING = "Edit > Project Settings > Engine > Rendering"
PLUGINS = "Edit > Plugins"
MAPS_MODES = "Edit > Project Settings > Project > Maps & Modes"
PCG_SLOTS = ("trees", "bushes", "grass", "flowers", "scatter", "shore_scatter")
LEVELS = {0: "Low", 1: "Medium", 2: "High", 3: "Epic", 4: "Cinematic"}

ROWS = []          # (section, status, item, value, fix)


def row(section, status, item, value="", fix=""):
    ROWS.append((section, status, item, str(value), fix))


# ---------------------------------------------------------------------------
# Console variables (the ini keys of the rendering settings are cvar names)
# ---------------------------------------------------------------------------
def read_cvar(name):
    """Return (value as float or None, text, certain).

    certain=False means the string getter returned nothing and the number came
    from the int/float getter, which also returns 0 when the cvar does not exist.
    """
    sl = unreal.SystemLibrary
    text = ""
    try:
        text = (sl.get_console_variable_string_value(name) or "").strip()
    except Exception:
        text = ""
    if text:
        low = text.lower()
        if low in ("true", "false"):
            return (1.0 if low == "true" else 0.0), text, True
        try:
            return float(text), text, True
        except ValueError:
            return None, text, True
    try:
        f = float(sl.get_console_variable_float_value(name))
        i = int(sl.get_console_variable_int_value(name))
    except Exception:
        return None, "", False
    value = f if f != 0.0 else float(i)
    shown = str(i) if float(i) == value else ("%g" % value)
    return value, shown, False


# (cvar, wanted value or None for info, severity if different, label, fix)
CVAR_CHECKS = [
    ("r.DynamicGlobalIlluminationMethod", 1, "FIX", "Global illumination = Lumen",
     RENDERING + " > Global Illumination > Dynamic Global Illumination Method = Lumen"),
    ("r.ReflectionMethod", 1, "FIX", "Reflections = Lumen",
     RENDERING + " > Reflections > Reflection Method = Lumen"),
    ("r.Shadow.Virtual.Enable", 1, "FIX", "Shadows = Virtual Shadow Maps",
     RENDERING + " > Shadows > Shadow Map Method = Virtual Shadow Maps"),
    ("r.GenerateMeshDistanceFields", 1, "FIX", "Mesh distance fields on",
     RENDERING + " > Software Ray Tracing > Generate Mesh Distance Fields = on (restart)"),
    ("r.AntiAliasingMethod", 4, "FIX", "Anti-aliasing = TSR",
     RENDERING + " > Default Settings > Anti-Aliasing Method = Temporal Super-Resolution (TSR)"),
    ("r.DefaultFeature.AutoExposure", 1, "WARN", "Auto exposure on",
     RENDERING + " > Default Settings > Auto Exposure = on"),
    ("r.DefaultFeature.AutoExposure.ExtendDefaultLuminanceRange", 1, "FIX",
     "Extended luminance range (EV100)",
     RENDERING + " > Default Settings > Extend default luminance range in Auto Exposure settings = on"),
    ("r.Nanite.ProjectEnabled", 1, "FIX", "Nanite enabled for the project",
     RENDERING + " > Nanite > Nanite = on (restart)"),
    ("r.AllowStaticLighting", 0, "WARN", "Static lighting off (all lights Movable)",
     RENDERING + " > Global Illumination (or Lighting) > Allow Static Lighting = off (restart)"),
    ("r.SupportSkyAtmosphere", 1, "WARN", "Sky Atmosphere supported",
     RENDERING + " > search 'Support Sky Atmosphere' = on (restart)"),
    ("r.SupportSkyAtmosphereAffectsHeightFog", 1, "FIX", "Sky Atmosphere affects height fog (Phase 4 fog)",
     RENDERING + " > search 'Support Sky Atmosphere Affecting Height Fog' = on (restart)"),
    ("r.RayTracing", None, "INFO", "Support Hardware Ray Tracing (1 = on)",
     RENDERING + " > Hardware Ray Tracing > Support Hardware Ray Tracing (leave on; restart if changed)"),
    ("r.Lumen.HardwareRayTracing", None, "INFO", "Lumen uses hardware ray tracing (1 = on)",
     RENDERING + " > Lumen > Use Hardware Ray Tracing when available"),
    ("r.Lumen.TraceMeshSDFs", None, "INFO", "Software ray tracing mode (1 = Detail, 0 = Global)",
     RENDERING + " > Lumen > Software Ray Tracing Mode (only used without hardware ray tracing)"),
    ("r.Substrate", None, "INFO", "Substrate materials (5.6 default 0, 5.7+ default 1)",
     "leave it as the project was created; changing it recompiles every shader"),
]

SCALABILITY = [
    ("sg.ResolutionQuality", "Resolution Scale (%)"),
    ("sg.ViewDistanceQuality", "View Distance"),
    ("sg.AntiAliasingQuality", "Anti-Aliasing"),
    ("sg.ShadowQuality", "Shadows"),
    ("sg.GlobalIlluminationQuality", "Global Illumination"),
    ("sg.ReflectionQuality", "Reflections"),
    ("sg.PostProcessQuality", "Post Processing"),
    ("sg.TextureQuality", "Textures"),
    ("sg.EffectsQuality", "Effects"),
    ("sg.FoliageQuality", "Foliage"),
    ("sg.ShadingQuality", "Shading"),
]


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------
def check_engine():
    sec = "Engine and plugins"
    raw = ""
    try:
        raw = unreal.SystemLibrary.get_engine_version()
    except Exception as exc:  # pragma: no cover - only if the API moved
        ow.warn("get_engine_version failed: %s" % exc)
    m = re.match(r"\s*(\d+)\.(\d+)", raw or "")
    ver = (int(m.group(1)), int(m.group(2))) if m else None
    if ver is None:
        row(sec, "WARN", "Engine version", raw or "unknown",
            "Help > About Unreal Editor shows the version; this plan needs 5.6, 5.7 or 5.8")
    elif ver < MIN_VERSION:
        row(sec, "FIX", "Engine version", raw,
            "install UE 5.6 or newer (step 1.1) and create the project again")
    elif ver > NEWEST_TESTED:
        row(sec, "WARN", "Engine version", raw,
            "newer than 5.8: menus and Python names may differ from the build plan")
    else:
        row(sec, "PASS", "Engine version", raw)

    py = "%d.%d.%d" % sys.version_info[:3]
    row(sec, "PASS" if sys.version_info >= (3, 9) else "WARN", "Python Editor Script Plugin", "Python " + py,
        "" if sys.version_info >= (3, 9) else "the scripts expect Python 3.9 or newer")

    has_pcg = hasattr(unreal, "PCGGraph") or hasattr(unreal, "PCGComponent")
    row(sec, "PASS" if has_pcg else "FIX", "PCG plugin", "loaded" if has_pcg else "not loaded",
        "" if has_pcg else PLUGINS + " > search 'Procedural Content Generation' > tick "
        "'Procedural Content Generation Framework (PCG)' > Restart Now")

    has_water = hasattr(unreal, "WaterBodyLake")
    row(sec, "PASS" if has_water else "FIX", "Water plugin", "loaded" if has_water else "not loaded",
        "" if has_water else PLUGINS + " > search 'Water' > tick 'Water' (Experimental, click Yes) > Restart Now")

    has_esu = hasattr(unreal, "EditorAssetLibrary")
    row(sec, "PASS" if has_esu else "FIX", "Editor Scripting Utilities", "loaded" if has_esu else "not loaded",
        "" if has_esu else PLUGINS + " > search 'Editor Scripting Utilities' > tick > Restart Now")

    has_fab = hasattr(unreal, "InterchangeMegascansPipeline")
    row(sec, "PASS" if has_fab else "WARN", "Fab plugin", "loaded" if has_fab else "not detected",
        "" if has_fab else PLUGINS + " > search 'Fab' > tick > Restart Now (needed for step 1.7)")

    interop = hasattr(unreal, "PCGGetWaterSplineSettings")
    row(sec, "INFO", "PCG Water Interop (not needed)", "loaded" if interop else "off",
        "this plan reads the lake spline with Get Spline Data; leave the interop plugin off")
    return ver


def check_rendering(ver):
    sec = "Rendering project settings"
    uncertain = 0
    for name, want, severity, label, fix in CVAR_CHECKS:
        value, text, certain = read_cvar(name)
        shown = "%s = %s" % (name, text if text else "?")
        if want is None:
            row(sec, "INFO", label, shown, fix)
            continue
        if value is None:
            row(sec, "WARN", label, name + " not found", "check by hand: " + fix)
            continue
        if int(round(value)) == want:
            row(sec, "PASS", label, shown)
        elif not certain and value == 0.0:
            uncertain += 1
            row(sec, "WARN", label, shown + " (or not found)", "check by hand: " + fix)
        else:
            row(sec, severity, label, shown, fix)

    hw, _, _ = read_cvar("r.Lumen.HardwareRayTracing")
    if EXPECT_HARDWARE_RAY_TRACING is not None and hw is not None:
        if bool(round(hw)) != bool(EXPECT_HARDWARE_RAY_TRACING):
            row(sec, "FIX", "Hardware ray tracing choice (TUNABLES)", "r.Lumen.HardwareRayTracing = %g" % hw,
                RENDERING + " > Lumen > Use Hardware Ray Tracing when available = %s"
                % ("on" if EXPECT_HARDWARE_RAY_TRACING else "off"))
    if ver is not None:
        sub, _, _ = read_cvar("r.Substrate")
        default_on = ver >= (5, 7)
        if sub is not None and bool(round(sub)) != default_on:
            row(sec, "INFO", "Substrate differs from the new-project default", "r.Substrate = %g" % sub,
                "fine if you chose it on purpose; materials in Phase 3 work either way")
    if uncertain and uncertain == len([c for c in CVAR_CHECKS if c[1] not in (None, 0)]):
        row(sec, "WARN", "Console variable reader", "every value came back 0",
            "your engine may not return cvar text; check the settings by hand in " + RENDERING)


def soft_path_text(struct_value):
    try:
        return (struct_value.export_text() or "").strip().strip('"').strip("'")
    except Exception:
        return ""


def check_level():
    sec = "Level (step 1.6)"
    want_pkg = cfg.MAPS_DIR + "/" + cfg.MAP_NAME
    world = ow.editor_world()
    pkg = world.get_path_name().split(".")[0] if world else ""
    if pkg != want_pkg:
        exists = unreal.EditorAssetLibrary.does_asset_exist(want_pkg)
        row(sec, "INFO", "Open level", pkg or "none",
            ("open %s (double-click it in the Content Browser) and run this again" % want_pkg) if exists
            else "do step 1.6 (File > New Level > Basic, delete Floor, Save Current Level As %s), then run again"
            % want_pkg)
    else:
        row(sec, "PASS", "Open level", pkg)
        wp = None
        try:
            wp = world.get_world_settings().get_editor_property("world_partition")
        except Exception as exc:
            ow.warn("could not read World Settings > World Partition: %s" % exc)
        if wp is None:
            row(sec, "PASS", "World Partition", "off")
        else:
            row(sec, "FIX", "World Partition", "on",
                "create the level again with File > New Level > Basic (not Open World / Empty Open World)")
        floors = [a for a in ow.all_actors() if isinstance(a, unreal.StaticMeshActor)
                  and a.get_actor_label().lower().startswith("floor")]
        if floors:
            row(sec, "FIX", "Template Floor deleted", "%d actor(s) named Floor" % len(floors),
                "Outliner > select Floor > Delete > Ctrl+S (the landscape replaces it)")
        else:
            row(sec, "PASS", "Template Floor deleted", "no Floor actor")
        counts = []
        for cls_name in ("DirectionalLight", "SkyAtmosphere", "SkyLight", "ExponentialHeightFog",
                         "VolumetricCloud", "PlayerStart"):
            cls = getattr(unreal, cls_name)
            counts.append("%s %d" % (cls_name, len([a for a in ow.all_actors() if isinstance(a, cls)])))
        row(sec, "INFO", "Template actors kept", ", ".join(counts),
            "Phase 4 reuses the sky and light actors; Phase 8 replaces the Player Start")

    try:
        gms = unreal.GameMapsSettings.get_game_maps_settings()
        startup = soft_path_text(gms.get_editor_property("editor_startup_map"))
        default = soft_path_text(gms.get_editor_property("game_default_map"))
        mode = soft_path_text(gms.get_editor_property("global_default_game_mode"))
    except Exception as exc:
        ow.warn("could not read Maps & Modes: %s" % exc)
        startup = default = mode = None
    for label, value, field in (("Editor Startup Map", startup, "Editor Startup Map"),
                                ("Game Default Map", default, "Game Default Map")):
        if value is None:
            row(sec, "WARN", label, "unreadable", "check by hand: " + MAPS_MODES + " > Default Maps > " + field)
        elif value.split(".")[0] == want_pkg:
            row(sec, "PASS", label, value)
        else:
            row(sec, "FIX", label, value or "empty",
                MAPS_MODES + " > Default Maps > %s = %s" % (field, cfg.MAP_NAME))
    if mode is not None:
        row(sec, "INFO", "Default GameMode", mode or "empty",
            "the First Person template sets BP_FirstPersonGameMode; Phase 8 checks it")


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


def asset_class_name(path):
    try:
        data = unreal.EditorAssetLibrary.find_asset_data(path)
        return str(data.get_editor_property("asset_class_path").get_editor_property("asset_name"))
    except Exception:
        return ""


def check_assets():
    sec = "ow_config.ASSETS (step 1.7)"
    seen = {}
    for slot, entry in cfg.ASSETS.items():
        paths = entry if isinstance(entry, list) else ([entry] if entry else [])
        if not paths:
            if slot in cfg.FALLBACK_MESHES:
                row(sec, "INFO", slot, "empty", "placeholder %s is used until you add a mesh"
                    % cfg.FALLBACK_MESHES[slot])
            else:
                row(sec, "INFO", slot, "empty", "Phase 6 skips this vegetation layer until you add meshes")
            continue
        good = 0
        for raw in paths:
            path = normalize_ref(raw)
            short = path.rsplit("/", 1)[-1] or raw
            if "'" in raw or raw.strip().startswith("/Script/"):
                row(sec, "FIX", "%s: %s" % (slot, short), "pasted with the class prefix",
                    'in ow_config.py keep only the part in quotes: "%s"' % path)
                continue
            if not path.startswith("/"):
                row(sec, "FIX", "%s: %s" % (slot, raw), "not a Content Browser path",
                    "right-click the asset > Copy Reference and paste the /Game/... part")
                continue
            if not unreal.EditorAssetLibrary.does_asset_exist(path):
                row(sec, "FIX", "%s: %s" % (slot, short), "not found",
                    "right-click the asset in the Content Browser > Copy Reference, paste again")
                continue
            cls = asset_class_name(path)
            allowed = ("StaticMesh", "Blueprint") if slot == "cabin" else ("StaticMesh",)
            if cls and cls not in allowed:
                hint = ("Megaplants are skeletal meshes: export a Static Mesh or pick another plant"
                        if cls == "SkeletalMesh" else "pick the Static Mesh asset (filter: Static Mesh)")
                sev = "WARN" if (slot == "fence" and cls == "Blueprint") else "FIX"
                row(sec, sev, "%s: %s" % (slot, short), cls, hint)
                continue
            if path.startswith("/Engine/") and not path.startswith("/Engine/BasicShapes/"):
                row(sec, "WARN", "%s: %s" % (slot, short), "Engine content",
                    "works, but p1_configure_assets.py will not change Engine assets")
            elif path.startswith("/Engine/BasicShapes/"):
                row(sec, "INFO", "%s: %s" % (slot, short), "Engine placeholder")
            else:
                row(sec, "PASS", "%s: %s" % (slot, short), cls or "found")
            seen.setdefault(path, []).append(slot)
            good += 1
        lo_hi = RECOMMENDED_COUNTS.get(slot)
        if lo_hi and good and not (lo_hi[0] <= good <= lo_hi[1]):
            row(sec, "INFO", "%s count" % slot, "%d mesh(es)" % good, "the plan suggests %d-%d" % lo_hi)
    for path, slots in seen.items():
        if len(slots) > 1:
            row(sec, "INFO", path.rsplit("/", 1)[-1], "in slots " + ", ".join(slots),
                "fine; p1_configure_assets.py uses the strongest collision of those slots")


def check_project_files():
    sec = "Project files (step 1.5)"
    here = os.path.normcase(os.path.normpath(os.path.dirname(os.path.abspath(__file__))))
    try:
        proj = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
        proj = os.path.normcase(os.path.normpath(proj))
    except Exception:
        proj = ""
    if proj and here.startswith(proj):
        row(sec, "PASS", "Script folder inside the project", here)
    else:
        row(sec, "INFO", "Script folder", here,
            "works from anywhere; step 1.5 suggests <Project>/OpenWorldTools so it travels with the project")

    folders = [cfg.CONTENT_ROOT, cfg.MAPS_DIR, cfg.MATERIALS_DIR, cfg.LANDSCAPE_LAYERS_DIR,
               cfg.PCG_DIR, cfg.BLUEPRINTS_DIR, cfg.WATER_DIR]
    made, missing = [], []
    for path in folders:
        if unreal.EditorAssetLibrary.does_directory_exist(path):
            continue
        if CREATE_FOLDERS:
            ow.ensure_directory(path)
            made.append(path)
        else:
            missing.append(path)
    if missing:
        row(sec, "INFO", "Content folders", "%d missing" % len(missing), "set CREATE_FOLDERS = True and run again")
    else:
        row(sec, "PASS", "Content folders", ("created " + ", ".join(made)) if made else "all exist")

    layout_path = os.path.join(ow.output_dir(), cfg.LAYOUT_FILE)
    if os.path.exists(layout_path):
        row(sec, "PASS", "Terrain files (OW_Layout.json)", layout_path)
    else:
        row(sec, "INFO", "Terrain files (OW_Layout.json)", "not generated yet", "Phase 2.1 creates them")


def check_scalability(ver):
    sec = "Editor scalability (step 1.9)"
    for name, label in SCALABILITY:
        value, text, _ = read_cvar(name)
        if value is None:
            row(sec, "INFO", label, name + " = ?")
            continue
        if name == "sg.ResolutionQuality":
            row(sec, "INFO", label, "%g %%" % value, "keep 100 while you work")
            continue
        level = int(round(value))
        row(sec, "INFO", label, "%s (%d)" % (LEVELS.get(level, "?"), level))
    gi, _, _ = read_cvar("sg.GlobalIlluminationQuality")
    if gi is not None and ver is not None:
        gi = int(round(gi))
        if gi == 0 or (gi == 1 and ver < (5, 8)):
            row(sec, "WARN", "Lumen GI active", "no (Global Illumination = %s)" % LEVELS.get(gi, gi),
                "viewport Performance and Scalability menu > Global Illumination = High or Epic; "
                "lighting looks wrong without Lumen GI")
        elif gi == 1:
            row(sec, "INFO", "Lumen GI active", "Lumen Lite (5.8 Medium)", "use High or Epic to judge lighting")


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
def report():
    order = []
    for sec, *_ in ROWS:
        if sec not in order:
            order.append(sec)
    width = max([len(r[2]) for r in ROWS] + [10])
    for sec in order:
        ow.log("---- %s ----" % sec)
        for s, status, item, value, fix in ROWS:
            if s != sec:
                continue
            line = "%-4s  %-*s  %s" % (status, width, item, value)
            if fix and status in ("FIX", "WARN"):
                line += "\n        -> " + fix
            elif fix and status == "INFO":
                line += "   (" + fix + ")"
            (ow.warn if status in ("FIX", "WARN") else ow.log)(line)
    totals = {k: len([r for r in ROWS if r[1] == k]) for k in ("PASS", "FIX", "WARN", "INFO")}
    ow.log("Summary: %(PASS)d PASS, %(FIX)d FIX, %(WARN)d WARN, %(INFO)d INFO" % totals)
    if totals["FIX"]:
        ow.warn("Fix every FIX line (restart if it says so), then run p1_check_project.py again.")
    else:
        ow.log("No FIX lines. Continue with the build plan.")


def main():
    ow.log("==== Phase 1 project check ====")
    ver = check_engine()
    check_rendering(ver)
    check_project_files()
    check_level()
    check_assets()
    check_scalability(ver)
    report()


main()
