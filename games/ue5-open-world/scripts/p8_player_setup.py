"""Phase 8 - player setup: Player Start, invisible boundary walls, Kill Z, sprint input.

Build-plan step: 8.2 (it also creates the input assets that step 8.3 wires up).

How to run (see build-plan step 1.5): Tools > Execute Python Script... and pick
    <Project>/OpenWorldTools/scripts/p8_player_setup.py
or type this in the Output Log command box (Cmd mode):
    py "C:/.../OpenWorldTools/scripts/p8_player_setup.py"
Stop Play first. L_OpenWorld must be open, with the landscape from Phase 2 and the
OW_Layout.json written by tools/generate_heightmap.py.

What it changes
  Level (one undo step, "OW: player setup"):
    * deletes EVERY Player Start in the level and lists each one in the Output Log;
    * spawns one PlayerStart "OW_PlayerStart" on the road at OW_Layout.json
      player_start. It faces the lake (yaw only, pitch 0, roll 0), and the bottom of
      the taller capsule (Player Start or pawn) sits PLAYER_START_CLEARANCE_CM above
      the traced road surface, about 101 cm above the road for its centre;
    * spawns 4 invisible walls "OW_Wall_+X/-X/+Y/-Y" from OW_Layout.json boundary:
      StaticMeshActors with /Engine/BasicShapes/Cube, collision preset InvisibleWall,
      Actor Hidden In Game, no shadow, Can Character Step Up On = No;
    * World Settings: Kill Z = landscape actor Z - KILL_Z_BELOW_LANDSCAPE_M. It also
      sets GameMode Override = BP_FirstPersonGameMode, but only when the override is
      empty and the asset is found.
    New actors are tagged OW_Managed plus OW_PlayerStart or OW_Boundary and are filed
    in the Outliner folders OpenWorld/Player and OpenWorld/Boundary.
  Assets (saved to disk; Ctrl+Z does not undo them):
    * /Game/OpenWorld/Blueprints/IA_Sprint (Input Action, Value Type Digital (bool));
    * a Left Shift -> IA_Sprint row in the template's Input Mapping Context IMC_Default.
      Close IMC_Default first if it is open in an editor tab.
  Saves the level at the end (SAVE_LEVEL).

Safe to re-run: it deletes its own tagged walls and every Player Start before spawning,
reuses IA_Sprint if it already exists, and adds no mapping when IMC_Default already maps
IA_Sprint.

Undo: press Ctrl+Z once for the level changes, then Ctrl+S. Or delete the actors in the
Outliner folders OpenWorld/Player and OpenWorld/Boundary. To undo the input assets,
delete IA_Sprint in the Content Browser and remove its row from IMC_Default > Mappings.

The Python calls were checked against the UE 5.6 API. If one fails on 5.7 or 5.8, the
script logs the manual step instead of stopping (build plan 8.1-8.3).
"""
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unreal
import ow_common as ow
importlib.reload(ow)
cfg = ow.cfg

# =============================================================================
# TUNABLES
# =============================================================================
# --- 8.2 Player Start ---------------------------------------------------------
PLAYER_START_CLEARANCE_CM = 5.0      # gap between the taller capsule's bottom and the road (cm)
PAWN_CAPSULE_HALF_HEIGHT_CM = 96.0   # BP_FirstPersonCharacter > CapsuleComponent > Capsule Half Height (cm), see 8.1
PLAYER_START_YAW_OFFSET_DEG = 0.0    # added to the layout yaw (the layout yaw faces the lake), degrees
TAG_PLAYER_START = "OW_PlayerStart"  # extra tag on the spawned Player Start

# --- 8.2 Invisible boundary walls (position and size come from OW_Layout.json "boundary") ---
WALL_COLLISION_PROFILE = "InvisibleWall"   # Collision Presets value; blocks everything except Visibility traces
WALL_FALLBACK_PROFILE = "BlockAll"         # used if the preset above does not exist
WALL_BOTTOM_M = 0.0                  # wall bottom, metres above the landscape actor Z (terrain minimum is about +4.5 m)
WALLS_VISIBLE_IN_EDITOR = False      # True = grey slabs visible in the editor viewport (never in game)

# --- 8.2 Kill Z ------------------------------------------------------------------
KILL_Z_BELOW_LANDSCAPE_M = 50.0      # Kill Z = landscape actor Z - this (metres)

# --- 8.1 GameMode Override (World Settings) -------------------------------------
SET_GAME_MODE_OVERRIDE = True        # only fills an EMPTY override; never replaces your choice
GAME_MODE_PATH = ""                  # "" = search the project for GAME_MODE_NAME, or paste Copy Reference here
GAME_MODE_NAME = "BP_FirstPersonGameMode"

# --- 8.3 Sprint input ------------------------------------------------------------
CREATE_SPRINT_INPUT = True
SPRINT_ACTION_DIR = cfg.BLUEPRINTS_DIR    # /Game/OpenWorld/Blueprints
SPRINT_ACTION_NAME = "IA_Sprint"
SPRINT_KEY_NAME = "LeftShift"             # Unreal's key name for Left Shift
IMC_PATH = ""                             # "" = search the project for IMC_NAME, or paste Copy Reference here
IMC_NAME = "IMC_Default"

SAVE_LEVEL = True
# =============================================================================


# ---------------------------------------------------------------------------
# Small helpers (not in ow_common)
# ---------------------------------------------------------------------------
def clean_reference(text):
    """Accept '/Game/A/B', '/Game/A/B.B' or a full Copy Reference string; return '/Game/A/B'."""
    text = (text or "").strip()
    if "'" in text:
        parts = text.split("'")
        text = parts[1] if len(parts) > 1 else text
    return text.split(".")[0]


def find_assets_named(name, root="/Game"):
    """Package paths of every asset called `name` under `root`; plain template folders first."""
    try:
        paths = unreal.EditorAssetLibrary.list_assets(root, True, False)
    except Exception as exc:  # noqa: BLE001 - report and continue
        ow.warn("could not list assets under %s (%s)" % (root, exc))
        return []
    found = []
    for p in paths:
        pkg = str(p).split(".")[0]
        if pkg.rsplit("/", 1)[-1] == name and pkg not in found:
            found.append(pkg)
    found.sort(key=lambda p: ("/Variant_" in p, len(p)))
    return found


def resolve_asset(explicit_path, name, what):
    """Return the package path to use, or None. Logs what it picked."""
    if explicit_path:
        pkg = clean_reference(explicit_path)
        if unreal.EditorAssetLibrary.does_asset_exist(pkg):
            return pkg
        ow.warn("%s: '%s' (from TUNABLES) does not exist - searching for %s instead" % (what, pkg, name))
    hits = find_assets_named(name)
    if len(hits) > 1:
        ow.warn("found %d assets named %s: %s - using %s. Paste the right one into TUNABLES to choose."
                % (len(hits), name, ", ".join(hits), hits[0]))
    return hits[0] if hits else None


def project_mapping_contexts():
    """All Input Mapping Context assets under /Game (asset registry), as package paths."""
    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
        class_path = unreal.TopLevelAssetPath(package_name="/Script/EnhancedInput", asset_name="InputMappingContext")
        found = registry.get_assets_by_class(class_path, True) or []
        return sorted(str(d.package_name) for d in found if str(d.package_name).startswith("/Game/"))
    except Exception as exc:  # noqa: BLE001
        ow.warn("asset registry search for Input Mapping Contexts failed (%s)" % exc)
        return []


def capsule_size(actor, default_half, default_radius):
    """(half height, radius) of the actor's capsule in cm; defaults if it cannot be read."""
    half = radius = 0.0
    cap = actor.get_component_by_class(unreal.CapsuleComponent)
    if cap:
        half = float(cap.get_scaled_capsule_half_height())
        radius = float(cap.get_scaled_capsule_radius())
    if half < 1.0 or radius < 1.0:
        ow.warn("could not read the Player Start capsule - assuming %.0f x %.0f cm (radius x half height)"
                % (default_radius, default_half))
        half, radius = default_half, default_radius
    return half, radius


def set_property(obj, name, value, manual):
    try:
        obj.set_editor_property(name, value)
        return True
    except Exception as exc:  # noqa: BLE001
        ow.warn("could not set %s (%s) - do this by hand: %s" % (name, exc, manual))
        return False


# ---------------------------------------------------------------------------
# 8.2 Player Start
# ---------------------------------------------------------------------------
def place_player_start(lay, fr):
    old = [a for a in ow.all_actors() if isinstance(a, unreal.PlayerStart)]
    for a in old:
        loc = a.get_actor_location()
        msg = "deleting Player Start '%s' at (%.0f, %.0f, %.0f) cm" % (a.get_actor_label(), loc.x, loc.y, loc.z)
        if ow.has_tag(a, TAG_PLAYER_START):
            ow.log(msg + " (from an earlier run)")
        else:
            ow.warn(msg + " - the level must have exactly one Player Start")
    if old:
        ow.actors_subsystem().destroy_actors(old)
        ow.refresh_trace_cache()

    x_m, y_m, h_m = [float(v) for v in lay["player_start"]["position_m"]]
    yaw = float(lay["player_start"]["yaw_deg"]) + PLAYER_START_YAW_OFFSET_DEG
    spot = fr.to_world(x_m, y_m, h_m)
    ground = ow.ground_z(spot.x, spot.y)
    if ground is None:
        ground = spot.z
        ow.warn("no landscape under the spawn point - using the layout height (%.0f cm). "
                "Run scripts/p2_verify_landscape.py to check the landscape placement." % ground)
    elif abs(ground - spot.z) > 100.0:
        ow.warn("road surface at the spawn point is %.0f cm from the layout height - was the landscape "
                "sculpted or moved? Using the traced surface." % (ground - spot.z))

    ps = ow.spawn(unreal.PlayerStart, unreal.Vector(spot.x, spot.y, ground + 200.0), ow.yaw_rotator(yaw),
                  label="OW_PlayerStart", folder=cfg.OUTLINER["player"], tags=(TAG_PLAYER_START,))
    ps_half, ps_radius = capsule_size(ps, 92.0, 40.0)
    half = max(ps_half, PAWN_CAPSULE_HALF_HEIGHT_CM)
    z = ground + half + PLAYER_START_CLEARANCE_CM
    ps.set_actor_location(unreal.Vector(spot.x, spot.y, z), False, True)
    ow.log("Player Start at (%.0f, %.0f, %.0f) cm = road + %.0f cm, yaw %.2f deg (pitch 0, roll 0); "
           "capsules: Player Start %.0f x %.0f, pawn half height %.0f cm"
           % (spot.x, spot.y, z, z - ground, yaw, ps_radius, ps_half, PAWN_CAPSULE_HALF_HEIGHT_CM))
    return ps


# ---------------------------------------------------------------------------
# 8.2 Invisible boundary walls
# ---------------------------------------------------------------------------
def build_walls(lay, fr):
    ow.remove_managed(cfg.TAG_BOUNDARY)
    cube = ow.load("/Engine/BasicShapes/Cube")
    if not cube:
        ow.error("/Engine/BasicShapes/Cube not found - place 4 Blocking Volumes by hand (build plan 8.2)")
        return []
    b = lay["boundary"]
    half_m = float(b["half_extent_m"])
    thick_cm = float(b["wall_thickness_m"]) * 100.0
    height_cm = float(b["wall_height_m"]) * 100.0
    span_x_cm = 2.0 * half_m * fr.cm_per_m_x    # layout metres -> world cm
    span_y_cm = 2.0 * half_m * fr.cm_per_m_y
    z_centre = fr.origin.z + WALL_BOTTOM_M * 100.0 + height_cm / 2.0
    # name, layout centre (m), size along X and Y (cm). Walls run one thickness past each corner.
    specs = [
        ("OW_Wall_+X", (half_m, 0.0), (thick_cm, span_y_cm + thick_cm)),
        ("OW_Wall_-X", (-half_m, 0.0), (thick_cm, span_y_cm + thick_cm)),
        ("OW_Wall_+Y", (0.0, half_m), (span_x_cm + thick_cm, thick_cm)),
        ("OW_Wall_-Y", (0.0, -half_m), (span_x_cm + thick_cm, thick_cm)),
    ]
    walls, unconfirmed = [], []
    for label, (x_m, y_m), (size_x, size_y) in specs:
        c = fr.to_world(x_m, y_m)
        actor = ow.spawn(unreal.StaticMeshActor, unreal.Vector(c.x, c.y, z_centre), None, label=label,
                         folder=cfg.OUTLINER["boundary"], tags=(cfg.TAG_BOUNDARY,),
                         scale=unreal.Vector(size_x / 100.0, size_y / 100.0, height_cm / 100.0))
        smc = actor.static_mesh_component
        smc.set_static_mesh(cube)               # returns False if the mesh was already set; not an error
        smc.set_collision_profile_name(WALL_COLLISION_PROFILE)
        got = str(smc.get_collision_profile_name())
        if got != WALL_COLLISION_PROFILE:
            if got:
                ow.warn("%s: collision preset '%s' not available (got '%s') - using %s"
                        % (label, WALL_COLLISION_PROFILE, got, WALL_FALLBACK_PROFILE))
                smc.set_collision_profile_name(WALL_FALLBACK_PROFILE)
            else:
                unconfirmed.append(label)
        smc.set_cast_shadow(False)
        set_property(smc, "affect_distance_field_lighting", False,
                     "select the wall > Details > Lighting > Affect Distance Field Lighting = off")
        set_property(smc, "can_character_step_up_on", unreal.CanBeCharacterBase.ECB_NO,
                     "select the wall > Details > Collision > Can Character Step Up On = No")
        if not WALLS_VISIBLE_IN_EDITOR:
            smc.set_visibility(False)           # collision still blocks; Show > Collision displays it
        actor.set_actor_hidden_in_game(True)
        walls.append(actor)
    if unconfirmed:
        ow.warn("could not read back the collision preset of %s - check one wall: Details > Collision > "
                "Collision Presets should read %s" % (", ".join(unconfirmed), WALL_COLLISION_PROFILE))
    ow.log("4 invisible walls at +/-%.0f m from the landscape centre, %.0f m high, %.1f m thick (preset %s)"
           % (half_m, height_cm / 100.0, thick_cm / 100.0, WALL_COLLISION_PROFILE))
    return walls


# ---------------------------------------------------------------------------
# 8.2 Kill Z and 8.1 GameMode Override (World Settings)
# ---------------------------------------------------------------------------
def set_kill_z(ws, fr):
    kill_z = fr.origin.z - KILL_Z_BELOW_LANDSCAPE_M * 100.0
    if set_property(ws, "kill_z", kill_z, "Window > World Settings > World > Kill Z = %.0f" % kill_z):
        ow.log("World Settings > Kill Z = %.0f cm (%.0f m below the landscape actor)" % (kill_z, KILL_Z_BELOW_LANDSCAPE_M))
    return kill_z


def set_game_mode(ws):
    manual = "Window > World Settings > Game Mode > GameMode Override = %s (build plan 8.1)" % GAME_MODE_NAME
    if not SET_GAME_MODE_OVERRIDE:
        return "skipped"
    try:
        current = ws.get_editor_property("default_game_mode")
    except Exception as exc:  # noqa: BLE001
        ow.warn("could not read the GameMode Override (%s) - check by hand: %s" % (exc, manual))
        return None
    if current:
        ow.log("GameMode Override is already %s - left unchanged" % current.get_name())
        return current.get_name()
    path = resolve_asset(GAME_MODE_PATH, GAME_MODE_NAME, "GameMode")
    if not path:
        ow.warn("%s not found in the project - add the First Person template (build plan 8.1), then: %s"
                % (GAME_MODE_NAME, manual))
        return None
    gm_class = unreal.EditorAssetLibrary.load_blueprint_class(path)
    if not gm_class:
        ow.warn("could not load %s as a Blueprint class - do this by hand: %s" % (path, manual))
        return None
    if set_property(ws, "default_game_mode", gm_class, manual):
        ow.log("World Settings > GameMode Override = %s" % path)
        return path
    return None


# ---------------------------------------------------------------------------
# 8.3 Sprint input: IA_Sprint + Left Shift in the template's mapping context
# ---------------------------------------------------------------------------
def create_sprint_action():
    path = SPRINT_ACTION_DIR + "/" + SPRINT_ACTION_NAME
    manual = ("Content Browser > %s > right-click > Input > Input Action, name it %s, open it and set "
              "Value Type = Digital (bool)" % (SPRINT_ACTION_DIR, SPRINT_ACTION_NAME))
    try:
        ow.ensure_directory(SPRINT_ACTION_DIR)
        if unreal.EditorAssetLibrary.does_asset_exist(path):
            ia = unreal.EditorAssetLibrary.load_asset(path)
            ow.log("reusing %s" % path)
        else:
            ia = unreal.AssetToolsHelpers.get_asset_tools().create_asset(
                SPRINT_ACTION_NAME, SPRINT_ACTION_DIR, unreal.InputAction, unreal.InputAction_Factory())
            ow.log("created %s" % path)
        if not ia:
            raise RuntimeError("create_asset returned nothing")
        ia.set_editor_property("value_type", unreal.InputActionValueType.BOOLEAN)
        unreal.EditorAssetLibrary.save_loaded_asset(ia, False)
        return ia
    except Exception as exc:  # noqa: BLE001
        ow.warn("could not create %s (%s) - do this by hand: %s" % (path, exc, manual))
        return None


def find_mapping_context():
    path = resolve_asset(IMC_PATH, IMC_NAME, "Input Mapping Context")
    if path:
        return path
    candidates = [p for p in project_mapping_contexts() if "/Variant_" not in p]
    if len(candidates) == 1:
        ow.warn("%s not found - using the only Input Mapping Context in the project: %s" % (IMC_NAME, candidates[0]))
        return candidates[0]
    if candidates:
        ow.warn("%s not found; Input Mapping Contexts in the project: %s. Paste the one your character "
                "uses into IMC_PATH and re-run." % (IMC_NAME, ", ".join(candidates)))
    return None


def map_sprint_key(ia):
    manual = ("open the template's %s (Content Browser search: %s), click + next to Mappings, pick %s, "
              "click the keyboard icon, press Left Shift, then Save" % (IMC_NAME, IMC_NAME, SPRINT_ACTION_NAME))
    imc_path = find_mapping_context()
    if not imc_path:
        ow.warn("no Input Mapping Context found - map the key by hand: " + manual)
        return None
    try:
        imc = unreal.EditorAssetLibrary.load_asset(imc_path)
        ia_path = ia.get_path_name()
        mappings = list(imc.get_editor_property("mappings"))
        mine, others = [], []
        for m in mappings:
            action = m.get_editor_property("action")
            key_name = str(m.get_editor_property("key").get_editor_property("key_name"))
            if action and action.get_path_name() == ia_path:
                mine.append(key_name)
            elif key_name == SPRINT_KEY_NAME:
                others.append(action.get_name() if action else "an empty row")
        if others:
            ow.warn("%s already uses %s for %s - remove that row or pick another key"
                    % (imc_path, SPRINT_KEY_NAME, ", ".join(others)))
        if mine:
            ow.log("%s already maps %s to %s - left unchanged" % (imc_path, SPRINT_ACTION_NAME, ", ".join(mine)))
            return imc_path
        key = unreal.Key()
        key.set_editor_property("key_name", SPRINT_KEY_NAME)
        imc.modify()
        imc.map_key(ia, key)
        unreal.EditorAssetLibrary.save_loaded_asset(imc, False)
        ow.log("mapped %s -> %s in %s" % (SPRINT_KEY_NAME, SPRINT_ACTION_NAME, imc_path))
        return imc_path
    except Exception as exc:  # noqa: BLE001
        ow.warn("could not edit %s (%s) - map the key by hand: %s" % (imc_path, exc, manual))
        return None


def setup_sprint_input():
    if not CREATE_SPRINT_INPUT:
        return None, None
    ia = create_sprint_action()
    if not ia:
        return None, None
    return ia, map_sprint_key(ia)


# ---------------------------------------------------------------------------
def main():
    ow.log("p8_player_setup on engine %s" % unreal.SystemLibrary.get_engine_version())
    lay = ow.layout()
    fr = ow.frame()
    ws = ow.editor_world().get_world_settings()
    with unreal.ScopedEditorTransaction("OW: player setup"):
        place_player_start(lay, fr)
        walls = build_walls(lay, fr)
        kill_z = set_kill_z(ws, fr)
        game_mode = set_game_mode(ws)
    ia, imc_path = setup_sprint_input()
    if SAVE_LEVEL:
        ow.save_level()
    ow.log("p8_player_setup done: 1 Player Start, %d walls, Kill Z %.0f cm, GameMode %s, %s %s, Left Shift mapping %s"
           % (len(walls), kill_z, game_mode or "NOT SET (see warnings)",
              SPRINT_ACTION_NAME, "ready" if ia else "MISSING (see warnings)",
              "in " + imc_path if imc_path else "MISSING (see warnings)"))


main()
