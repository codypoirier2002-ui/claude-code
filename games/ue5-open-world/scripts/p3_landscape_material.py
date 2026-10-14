"""p3_landscape_material.py - build the landscape material and assign it to the landscape.

Build plan: Phase 3, step 3.2. Fill in TEXTURES first (step 3.1). Run it again
after you change TEXTURES or any value below, after creating the Layer Infos
(3.4) and after importing the weightmaps (3.5): every run also checks them.

How to run (see 1.5):
    Tools -> Execute Python Script... and pick
        <Project>/OpenWorldTools/scripts/p3_landscape_material.py
    or type this in the Output Log command box (Cmd mode):
        py "C:/.../OpenWorldTools/scripts/p3_landscape_material.py"
    Close the M_OW_Landscape editor tab before running (an open tab can later
    overwrite what the script built). Results are printed in the Output Log.

What it creates / changes:
  * /Game/OpenWorld/Materials/M_OW_Landscape (Material). Its node graph is
    deleted and rebuilt on every run: 5 surfaces (Grass, Dirt, Rock, Road and a
    wet "Shore" made from the Dirt textures), an automatic slope / height /
    shoreline mix, and one Landscape Layer Blend per output (Base Color,
    Normal, Roughness, Ambient Occlusion) with the paint layers
    Auto / Grass / Dirt / Rock / Road (ow_config.LANDSCAPE_LAYERS).
    TUNABLES below become the parameter defaults.
  * /Game/OpenWorld/Materials/MI_OW_Landscape (Material Instance of the above).
    Created once. Values you change in it survive re-runs. The script only sets
    WaterLevelZ_cm (world Z of the lake surface, from the landscape actor).
  * The main Landscape actor: Landscape Material = MI_OW_Landscape.
  * 5.7/5.8 only, if FIX_LAYER_INFO_BLENDING: Layer Info assets whose Blend
    Method is "No Weight Blending" are switched to weight blending.
  * Saves both material assets, changed Layer Infos and (SAVE_LEVEL) the level.
It reports: engine version, Substrate on/off, the Layer Blend pin names, the
material statistics, which paint layers have a Layer Info and how they blend,
the imported Auto/Road weights, and every step it could not do (with the exact
manual fix).

Safe to re-run: it spawns no actors; it rebuilds the material graph from scratch
and reuses both assets, so nothing is duplicated.

Undo: Ctrl+Z reverts the landscape material assignment (undo step "OW: assign
landscape material") and a Layer Info change ("OW: layer info blending").
Material graph edits cannot be undone with Ctrl+Z: to remove everything, set
the landscape's Landscape Material back to None and delete M_OW_Landscape and
MI_OW_Landscape in the Content Browser.
"""
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unreal
import ow_common as ow
importlib.reload(ow)
cfg = ow.cfg

# ===========================================================================
# TUNABLES
# ===========================================================================
# --- Step 3.1: texture paths ----------------------------------------------
# Content Browser > right-click the texture > Copy Reference, paste between the
# quotes. The whole copied text (/Script/Engine.Texture2D'/Game/...') works too.
#   BaseColor = ..._B (Fab) or ..._D / _Albedo / _BC (older Megascans)
#   Normal    = ..._N
#   ORM       = the packed map: ..._ORM (Fab: R = AO, G = Roughness, B = Metallic)
#               or ..._ORDp / _AoRDp (older: B = Displacement). Only R and G are used.
# Leave a surface's BaseColor empty to use a flat colour (lets you test before
# downloading anything). Normal and ORM may be left empty on their own.
TEXTURES = {
    "Grass": {"BaseColor": "", "Normal": "", "ORM": ""},   # meadow grass surface
    "Dirt":  {"BaseColor": "", "Normal": "", "ORM": ""},   # forest floor / soil (also used for the wet shore)
    "Rock":  {"BaseColor": "", "Normal": "", "ORM": ""},   # rock / rocky ground (steep slopes)
    "Road":  {"BaseColor": "", "Normal": "", "ORM": ""},   # gravel / dirt track
}
ROAD_USES_DIRT_IF_EMPTY = True     # no Road textures: reuse the Dirt textures for Road (with Road tint)

# --- Step 3.6: tiling (metres per texture repeat; MI group "05 Tiling") ----
TILE_M = {"Grass": 2.0, "Dirt": 2.0, "Rock": 4.0, "Road": 2.0}   # Megascans ground scans are usually 2 m x 2 m
USE_FAR_TILING = True              # second, 4x bigger Base Color sample in the distance (hides repetition)
FAR_TILING_SCALE = 0.25            # far UV = near UV x this (0.25 = 4x bigger tiles)
FAR_FADE_START_M = 10.0            # camera distance where the far tiling starts to fade in (m)
FAR_FADE_LENGTH_M = 40.0           # fade length (m): fully far tiling at 10 + 40 = 50 m

# --- Step 3.6: slope thresholds (degrees from horizontal; MI group "02 Slope") ---
DIRT_SLOPE_START_DEG = 22.0        # grass starts turning to dirt
DIRT_SLOPE_FULL_DEG = 30.0         # all dirt
ROCK_SLOPE_START_DEG = 33.0        # dirt starts turning to rock (matches the 33 deg grey in OW_Preview.png)
ROCK_SLOPE_FULL_DEG = 42.0         # all rock

# --- Step 3.6: heights above the lake surface (m; MI groups "03 Shore", "04 High rock") ---
SHORE_FULL_M = 0.40                # wet mud up to this height above the water
SHORE_END_M = 1.10                 # back to normal ground at this height
SHORE_JITTER_M = 0.30              # noise added to the shoreline edge (total range, m)
SHORE_DARKEN = 0.55                # shore Base Color = Dirt x this (wet look)
SHORE_ROUGHNESS_MUL = 0.60         # shore Roughness = Dirt x this (wet look)
HIGH_ROCK_START_M = 30.0           # rock starts mixing in this high above the water (rim crest, highest knoll)
HIGH_ROCK_FULL_M = 45.0            # full high-rock amount here
HIGH_ROCK_AMOUNT = 0.5             # 0..1, how much rock at full height

# --- Step 3.6: macro variation (MI group "06 Variation") -------------------
USE_MACRO_NOISE = True             # large soft light/dark blotches (Noise node, no texture needed)
MACRO_SIZE_M = 25.0                # blotch size (m). Script-only: re-run to change it
MACRO_CONTRAST = 0.24              # 0.24 = +/-12 % brightness
NOISE_LEVELS = 2                   # 1 = cheaper, 3 = more detail (each level costs shader instructions)

# --- Colours and surface looks (MI groups "10 Grass" ... "13 Road") --------
FLAT_COLOUR = {                    # linear RGB used when a surface has no textures
    "Grass": (0.11, 0.16, 0.05), "Dirt": (0.19, 0.14, 0.09),
    "Rock": (0.24, 0.23, 0.21), "Road": (0.23, 0.18, 0.12)}
FLAT_ROUGHNESS = {"Grass": 0.85, "Dirt": 0.90, "Rock": 0.75, "Road": 0.90}  # also used when ORM is empty
TEXTURE_TINT = {                   # multiplies textured Base Color (1 = unchanged)
    "Grass": (1.0, 1.0, 1.0), "Dirt": (1.0, 1.0, 1.0),
    "Rock": (1.0, 1.0, 1.0), "Road": (0.80, 0.78, 0.75)}   # road slightly darker / wetter
ROAD_ROUGHNESS_MUL = 0.85          # road roughness x this (compacted, slightly wet)
USE_AO = True                      # blend the ORM red channel into Ambient Occlusion (False saves one Layer Blend)

# --- Behaviour ------------------------------------------------------------
REBUILD_MATERIAL = True            # False = keep the existing graph; only (re)assign, update the MI and run checks
ASSIGN_TO_LANDSCAPE = True         # set Landscape Material = MI_OW_Landscape on the main landscape
RESET_INSTANCE_OVERRIDES = False   # True = clear every value changed by hand in MI_OW_Landscape (back to TUNABLES)
FIX_LAYER_INFO_BLENDING = True     # 5.7/5.8: switch Layer Infos set to "No Weight Blending" to weight blending
SAVE_LEVEL = True                  # save the level after assigning the material
MAX_PROBLEMS_SHOWN = 40            # how many failed steps to print in full at the end

# ===========================================================================
# Setup
# ===========================================================================
MEL = unreal.MaterialEditingLibrary
EAL = unreal.EditorAssetLibrary
SURFACES = ["Grass", "Dirt", "Rock", "Road"]
MAT_PATH = cfg.MATERIALS_DIR + "/" + cfg.LANDSCAPE_MATERIAL_NAME
MI_PATH = cfg.MATERIALS_DIR + "/" + cfg.LANDSCAPE_MATERIAL_INSTANCE_NAME
COL_W, ROW_H = 420, 170           # node grid spacing in the material editor
PROPS = ["BaseColor", "Normal", "Roughness", "AO"]
MP = {"BaseColor": "MP_BASE_COLOR", "Normal": "MP_NORMAL",
      "Roughness": "MP_ROUGHNESS", "AO": "MP_AMBIENT_OCCLUSION"}
ROOT_PIN_LABEL = {"BaseColor": "Base Color", "Normal": "Normal",
                  "Roughness": "Roughness", "AO": "Ambient Occlusion"}

# Input-pin names the script asks for, and other spellings an engine version may
# use for the same pin. In the 5.6.1 source, connect and get_material_expression_
# input_names both use the shortened names ("Coordinates" -> "UVs", "Input" -> "").
PIN_ALIASES = {
    "": ["Input"],
    "UVs": ["Coordinates", "UV"],
}

PROBLEMS = []                      # every step the script could not do, with the manual fix


def problem(text):
    PROBLEMS.append(text)
    ow.warn(text)


# ===========================================================================
# Graph builder: nodes, checked connections, parameters
# ===========================================================================
class Graph(object):
    def __init__(self, material):
        self.mat = material
        self.rows = {}
        self.nodes = 0
        self.links_ok = 0
        self.links_failed = 0
        self.prop_failed = 0

    # --- nodes ------------------------------------------------------------
    def node(self, cls, col, label, **props):
        row = self.rows.get(col, 0)
        self.rows[col] = row + 1
        expr = MEL.create_material_expression(self.mat, cls, -COL_W * col, row * ROW_H)
        if expr is None:
            raise RuntimeError("could not create a %s node in %s" % (cls.__name__, MAT_PATH))
        self.nodes += 1
        self.set(expr, "desc", label, label)
        for key, value in props.items():
            self.set(expr, key, value, label)
        return expr

    def set(self, expr, key, value, label):
        try:
            expr.set_editor_property(key, value)
        except Exception as exc:  # noqa: BLE001 - reported with the manual fix
            self.prop_failed += 1
            problem("could not set '%s' on node '%s' (%s). By hand: select that node in M_OW_Landscape and set "
                    "%s = %s in its Details panel." % (key, label, exc, key, value))

    @staticmethod
    def label(expr):
        try:
            text = expr.get_editor_property("desc")
            if text:
                return str(text)
        except Exception:  # noqa: BLE001
            pass
        return expr.get_name()

    # --- connections ------------------------------------------------------
    @staticmethod
    def input_names(expr):
        try:
            return [str(n) for n in MEL.get_material_expression_input_names(expr)]
        except Exception:  # noqa: BLE001 - names are only used to pick the spelling
            return []

    def connect(self, src, dst, pin, out=""):
        """Connect src's output `out` ("" = first/default output) to dst's input `pin`.

        The requested name is checked against the node's real input names
        (case-insensitive, plus known aliases). A False return counts as a failure.
        """
        names = self.input_names(dst)
        wanted = [pin] + PIN_ALIASES.get(pin, [])
        if pin.startswith("Layer "):
            wanted.append(pin[len("Layer "):])
        candidates = []
        for w in wanted:
            for n in names:
                if n.lower() == w.lower() and n not in candidates:
                    candidates.append(n)
        for w in wanted:
            if w not in candidates:
                candidates.append(w)
        error = ""
        for cand in candidates:
            try:
                if MEL.connect_material_expressions(src, out, dst, cand):
                    self.links_ok += 1
                    return True
            except Exception as exc:  # noqa: BLE001 - reported below
                error = " (%s)" % exc
        self.links_failed += 1
        problem("could not connect '%s' -> '%s' input '%s'%s. Inputs on that node: %s. By hand: open M_OW_Landscape, "
                "drag from the %s of the node labelled '%s' to the '%s' pin of the node labelled '%s'."
                % (self.label(src), self.label(dst), pin or "(first input)", error, names or "(not readable)",
                   ("'%s' output" % out) if out else "first (top) output pin", self.label(src),
                   pin or (names[0] if names else "first"), self.label(dst)))
        return False

    def to_root(self, src, prop):
        ok = False
        try:
            ok = MEL.connect_material_property(src, "", getattr(unreal.MaterialProperty, MP[prop]))
        except Exception as exc:  # noqa: BLE001
            ow.warn("connect_material_property(%s) raised %s" % (prop, exc))
        if ok:
            self.links_ok += 1
        else:
            self.links_failed += 1
            problem("could not connect '%s' to the material's '%s' pin. By hand: open M_OW_Landscape and drag the "
                    "output of the node labelled '%s' to the '%s' pin of the big result node on the right."
                    % (self.label(src), ROOT_PIN_LABEL[prop], self.label(src), ROOT_PIN_LABEL[prop]))
        return ok

    # --- helpers for common node shapes ----------------------------------
    def op(self, cls, col, label, a, b=None, **props):
        expr = self.node(cls, col, label, **props)
        self.connect(a, expr, "A")
        if b is not None:
            self.connect(b, expr, "B")
        return expr

    def mul(self, col, label, a, b=None, const_b=1.0):
        return self.op(unreal.MaterialExpressionMultiply, col, label, a, b, const_b=const_b)

    def one_in(self, cls, col, label, src, **props):
        expr = self.node(cls, col, label, **props)
        self.connect(src, expr, "")
        return expr

    def lerp(self, col, label, a, b, alpha):
        expr = self.node(unreal.MaterialExpressionLinearInterpolate, col, label)
        self.connect(a, expr, "A")
        self.connect(b, expr, "B")
        self.connect(alpha, expr, "Alpha")
        return expr

    def smoothstep(self, col, label, lo, hi, value, invert=False):
        expr = self.node(unreal.MaterialExpressionSmoothStep, col, label)
        self.connect(lo, expr, "Min")
        self.connect(hi, expr, "Max")
        self.connect(value, expr, "Value")
        if invert:
            return self.one_in(unreal.MaterialExpressionOneMinus, col, label + " (1-x)", expr)
        return expr

    def mask(self, col, label, src, channel):
        flags = {c: (c == channel) for c in "rgba"}
        return self.one_in(unreal.MaterialExpressionComponentMask, col, label, src, **flags)

    def scalar(self, name, value, group, col=9, lo=None, hi=None, prio=0):
        props = {"parameter_name": name, "default_value": float(value), "group": group, "sort_priority": prio}
        if lo is not None and hi is not None:
            props["slider_min"] = float(lo)
            props["slider_max"] = float(hi)
        return self.node(unreal.MaterialExpressionScalarParameter, col, name, **props)

    def vector(self, name, rgb, group, col=8, prio=0):
        return self.node(unreal.MaterialExpressionVectorParameter, col, name, parameter_name=name, group=group,
                         sort_priority=prio, default_value=unreal.LinearColor(rgb[0], rgb[1], rgb[2], 1.0))

    def metres_to_cm(self, param, col=8):
        return self.mul(col, self.label(param) + " x100", param, None, const_b=100.0)


# ===========================================================================
# Textures
# ===========================================================================
def clean_path(text):
    p = (text or "").strip().strip('"')
    if "'" in p:                       # /Script/Engine.Texture2D'/Game/...'
        parts = p.split("'")
        p = parts[1] if len(parts) > 1 else p
    return p.strip()


_TEXTURE_CACHE = {}


def load_texture(surface, slot):
    key = (surface, slot)
    if key not in _TEXTURE_CACHE:
        _TEXTURE_CACHE[key] = _load_texture(surface, slot)
    return _TEXTURE_CACHE[key]


def _load_texture(surface, slot):
    path = clean_path(TEXTURES.get(surface, {}).get(slot, ""))
    if not path:
        return None
    tex = ow.load(path)
    if tex is None:
        problem("TEXTURES['%s']['%s']: '%s' not found. Copy the reference again (right-click the texture > Copy "
                "Reference) and run the script again. Using no texture for now." % (surface, slot, path))
        return None
    if not isinstance(tex, unreal.Texture2D):
        problem("TEXTURES['%s']['%s']: '%s' is a %s, not a texture. Paste the T_..._%s texture, not the material."
                % (surface, slot, path, tex.get_class().get_name(), {"BaseColor": "B", "Normal": "N"}.get(slot, "ORM")))
        return None
    try:
        srgb = bool(tex.get_editor_property("srgb"))
        if slot == "BaseColor" and not srgb:
            ow.warn("%s BaseColor texture has sRGB off - colours will look washed out. Open the texture and tick "
                    "sRGB." % surface)
        if slot in ("Normal", "ORM") and srgb:
            ow.warn("%s %s texture has sRGB on - roughness/AO/normals will be wrong. Open the texture and untick "
                    "sRGB." % (surface, slot))
    except Exception:  # noqa: BLE001 - information only
        pass
    return tex


def sampler_type_for(tex):
    """Sampler type must match the texture or the material does not compile."""
    T = unreal.MaterialSamplerType
    TC = unreal.TextureCompressionSettings
    vt = bool(tex.get_editor_property("virtual_texture_streaming"))
    cs = tex.get_editor_property("compression_settings")
    srgb = bool(tex.get_editor_property("srgb"))
    if cs == TC.TC_NORMALMAP:
        return T.SAMPLERTYPE_VIRTUAL_NORMAL if vt else T.SAMPLERTYPE_NORMAL
    if cs == TC.TC_MASKS:
        return T.SAMPLERTYPE_VIRTUAL_MASKS if vt else T.SAMPLERTYPE_MASKS
    if cs in (TC.TC_GRAYSCALE, TC.TC_DISPLACEMENTMAP):
        if srgb:
            return T.SAMPLERTYPE_VIRTUAL_GRAYSCALE if vt else T.SAMPLERTYPE_GRAYSCALE
        return T.SAMPLERTYPE_VIRTUAL_LINEAR_GRAYSCALE if vt else T.SAMPLERTYPE_LINEAR_GRAYSCALE
    if cs == TC.TC_ALPHA:
        return T.SAMPLERTYPE_VIRTUAL_ALPHA if vt else T.SAMPLERTYPE_ALPHA
    if srgb:
        return T.SAMPLERTYPE_VIRTUAL_COLOR if vt else T.SAMPLERTYPE_COLOR
    return T.SAMPLERTYPE_VIRTUAL_LINEAR_COLOR if vt else T.SAMPLERTYPE_LINEAR_COLOR


def texture_sample(g, name, tex, uv, group, col, label, prio=0):
    expr = g.node(unreal.MaterialExpressionTextureSampleParameter2D, col, label,
                  parameter_name=name, group=group, sort_priority=prio)
    g.set(expr, "texture", tex, label)
    g.set(expr, "sampler_type", sampler_type_for(tex), label)
    g.set(expr, "sampler_source", unreal.SamplerSourceMode.SSM_WRAP_WORLD_GROUP_SETTINGS, label)  # "Shared: Wrap"
    g.connect(uv, expr, "UVs")
    return expr


# ===========================================================================
# Material graph
# ===========================================================================
def build_graph(g, mapping_scale, water_z_cm):
    C = unreal
    # --- shared inputs (column 10/9) ---------------------------------------
    coords = g.node(C.MaterialExpressionLandscapeLayerCoords, 10, "Landscape UV (1 unit = 1 m)",
                    mapping_type=C.TerrainCoordMappingType.TCMT_AUTO, mapping_scale=mapping_scale,
                    custom_uv_type=C.LandscapeCustomizedCoordType.LCCT_NONE)
    wp = g.node(C.MaterialExpressionWorldPosition, 10, "Absolute World Position (cm)",
                world_position_shader_offset=C.WorldPositionIncludedOffsets.WPT_DEFAULT)
    vnormal = g.node(C.MaterialExpressionVertexNormalWS, 10, "Vertex Normal WS (smooth terrain normal)")
    depth = g.node(C.MaterialExpressionPixelDepth, 10, "Pixel Depth (cm from camera)")

    p_water = g.scalar("WaterLevelZ_cm", water_z_cm, "01 Water level", prio=0)
    p_dirt_start = g.scalar("DirtSlopeStart_deg", DIRT_SLOPE_START_DEG, "02 Slope", lo=0, hi=90, prio=0)
    p_dirt_full = g.scalar("DirtSlopeFull_deg", DIRT_SLOPE_FULL_DEG, "02 Slope", lo=0, hi=90, prio=1)
    p_rock_start = g.scalar("RockSlopeStart_deg", ROCK_SLOPE_START_DEG, "02 Slope", lo=0, hi=90, prio=2)
    p_rock_full = g.scalar("RockSlopeFull_deg", ROCK_SLOPE_FULL_DEG, "02 Slope", lo=0, hi=90, prio=3)
    p_shore_full = g.scalar("ShoreFull_m", SHORE_FULL_M, "03 Shore", lo=-2, hi=5, prio=0)
    p_shore_end = g.scalar("ShoreEnd_m", SHORE_END_M, "03 Shore", lo=-2, hi=5, prio=1)
    p_shore_jit = g.scalar("ShoreJitter_m", SHORE_JITTER_M, "03 Shore", lo=0, hi=2, prio=2)
    p_shore_dark = g.scalar("ShoreDarken", SHORE_DARKEN, "03 Shore", lo=0, hi=1, prio=3)
    p_shore_rough = g.scalar("ShoreRoughnessMul", SHORE_ROUGHNESS_MUL, "03 Shore", lo=0, hi=1, prio=4)
    p_high_start = g.scalar("HighRockStart_m", HIGH_ROCK_START_M, "04 High rock", lo=0, hi=80, prio=0)
    p_high_full = g.scalar("HighRockFull_m", HIGH_ROCK_FULL_M, "04 High rock", lo=0, hi=80, prio=1)
    p_high_amt = g.scalar("HighRockAmount", HIGH_ROCK_AMOUNT, "04 High rock", lo=0, hi=1, prio=2)
    p_debug = g.scalar("DebugMasks", 0.0, "99 Debug", lo=0, hi=1, prio=0)

    # --- slope masks (column 8/7): normal.z = cos(slope) --------------------
    nz = g.mask(8, "normal.z = cos(slope)", vnormal, "b")

    def cos_deg(param):
        return g.one_in(C.MaterialExpressionCosine, 8, "cos(" + g.label(param) + ")", param, period=360.0)  # 360 = degrees

    dirt_a = g.smoothstep(7, "Dirt slope mask", cos_deg(p_dirt_full), cos_deg(p_dirt_start), nz, invert=True)
    rock_slope = g.smoothstep(7, "Rock slope mask", cos_deg(p_rock_full), cos_deg(p_rock_start), nz, invert=True)

    # --- height above the lake surface (m) ----------------------------------
    wz = g.mask(8, "world Z (cm)", wp, "b")
    above_cm = g.op(C.MaterialExpressionSubtract, 8, "height above water (cm)", wz, p_water)
    above_m = g.mul(7, "height above water (m)", above_cm, None, const_b=0.01)

    # --- macro noise (no texture asset needed) ------------------------------
    noise = None
    macro = None
    if USE_MACRO_NOISE:
        # Position pin left unconnected on purpose: the node then samples the absolute world position (cm).
        # Every property is set because the engine defaults differ (6 levels, turbulence, output -1..1).
        noise = g.node(C.MaterialExpressionNoise, 8, "Macro noise (0..1, ~%g m blotches)" % MACRO_SIZE_M,
                       noise_function=C.NoiseFunction.NOISEFUNCTION_VALUE_ALU,
                       scale=1.0 / (MACRO_SIZE_M * 100.0), levels=int(NOISE_LEVELS), level_scale=2.0,
                       output_min=0.0, output_max=1.0, turbulence=False, tiling=False, quality=1,
                       world_position_origin_type=C.PositionOrigin.ABSOLUTE)
        p_contrast = g.scalar("MacroContrast", MACRO_CONTRAST, "06 Variation", lo=0, hi=1, prio=0)
        centred = g.op(C.MaterialExpressionSubtract, 7, "noise - 0.5", noise, None, const_b=0.5)
        macro = g.op(C.MaterialExpressionAdd, 6, "macro brightness (1 +/- contrast/2)",
                     g.mul(7, "noise x contrast", centred, p_contrast), None, const_b=1.0)

    high = g.mul(6, "high-rock mask",
                 g.smoothstep(7, "high-altitude ramp", p_high_start, p_high_full, above_m), p_high_amt)
    rock_a = g.op(C.MaterialExpressionMax, 6, "Rock mask (slope or height)", rock_slope, high)
    shore_h = above_m
    if noise is not None:
        jitter = g.mul(7, "shore jitter (m)", centred, p_shore_jit)
        shore_h = g.op(C.MaterialExpressionAdd, 6, "jittered height above water", above_m, jitter)
    shore_a = g.smoothstep(6, "Shore mask", p_shore_full, p_shore_end, shore_h, invert=True)

    # --- distance fade for the far tiling ------------------------------------
    fade = None
    p_far = None
    if USE_FAR_TILING:
        p_fstart = g.scalar("FarFadeStart_m", FAR_FADE_START_M, "05 Tiling", lo=0, hi=200, prio=10)
        p_flen = g.scalar("FarFadeLength_m", FAR_FADE_LENGTH_M, "05 Tiling", lo=1, hi=400, prio=11)
        p_far = g.scalar("FarTilingScale", FAR_TILING_SCALE, "05 Tiling", lo=0.05, hi=1, prio=12)
        fade = g.one_in(C.MaterialExpressionSaturate, 7, "far-tiling fade (0 near, 1 far)",
                        g.op(C.MaterialExpressionDivide, 7, "(depth - start) / length",
                             g.op(C.MaterialExpressionSubtract, 8, "depth - start", depth, g.metres_to_cm(p_fstart)),
                             g.metres_to_cm(p_flen)))

    # --- surfaces -------------------------------------------------------------
    flat_normal = g.node(C.MaterialExpressionConstant3Vector, 5, "flat normal (0,0,1)",
                         constant=unreal.LinearColor(0.0, 0.0, 1.0, 0.0))
    one = g.node(C.MaterialExpressionConstant, 5, "AO = 1", r=1.0)
    surf = {}
    report = {}
    for i, s in enumerate(SURFACES):
        group = "%02d %s" % (10 + i, s)
        tex = {slot: load_texture(s, slot) for slot in ("BaseColor", "Normal", "ORM")}
        source = s
        if s == "Road" and tex["BaseColor"] is None and ROAD_USES_DIRT_IF_EMPTY and not any(tex.values()):
            tex = {slot: load_texture("Dirt", slot) for slot in ("BaseColor", "Normal", "ORM")}
            source = "Dirt"
        d = {"BaseColor": None, "Normal": None, "Roughness": None, "AO": None}
        if tex["BaseColor"] is not None:
            p_tile = g.scalar(s + "_TileM", TILE_M[s], "05 Tiling", lo=0.25, hi=20, prio=i)
            uv = g.op(C.MaterialExpressionDivide, 7, s + " UV (metres / tile)", coords, p_tile)
            near = texture_sample(g, s + "_BaseColor", tex["BaseColor"], uv, group, 6, s + " BaseColor (near)", 0)
            bc = near
            if USE_FAR_TILING:
                far_uv = g.mul(6, s + " UV far", uv, p_far)
                # same parameter name as the near sample = one texture slot in the MI
                far = texture_sample(g, s + "_BaseColor", tex["BaseColor"], far_uv, group, 6,
                                     s + " BaseColor (far)", 0)
                bc = g.lerp(5, s + " near/far", near, far, fade)
            tint = g.vector(s + "_Tint", TEXTURE_TINT[s], group, col=6, prio=1)
            bc = g.mul(5, s + " x tint", bc, tint)
            if tex["Normal"] is not None:
                d["Normal"] = texture_sample(g, s + "_Normal", tex["Normal"], uv, group, 6, s + " Normal", 2)
            if tex["ORM"] is not None:
                orm = texture_sample(g, s + "_ORM", tex["ORM"], uv, group, 6, s + " ORM (R=AO, G=Rough)", 3)
                d["Roughness"] = g.mask(5, s + " roughness (G)", orm, "g")
                d["AO"] = g.mask(5, s + " AO (R)", orm, "r")
            report[s] = "textures from %s (%s)" % (source, ", ".join(k for k, v in tex.items() if v is not None))
        else:
            bc = g.vector(s + "_Colour", FLAT_COLOUR[s], group, col=6, prio=0)
            report[s] = "flat colour (no textures set)"
        if macro is not None:
            bc = g.mul(4, s + " x macro", bc, macro)
        if d["Roughness"] is None:
            d["Roughness"] = g.scalar(s + "_Roughness", FLAT_ROUGHNESS[s], group, col=6, lo=0, hi=1, prio=4)
        if s == "Road":
            p_rr = g.scalar("Road_RoughnessMul", ROAD_ROUGHNESS_MUL, group, col=6, lo=0, hi=1, prio=5)
            d["Roughness"] = g.mul(4, "Road roughness x mul", d["Roughness"], p_rr)
        d["BaseColor"] = bc
        surf[s] = d

    shore = {"BaseColor": g.mul(4, "Shore base colour (Dirt x darken)", surf["Dirt"]["BaseColor"], p_shore_dark),
             "Roughness": g.mul(4, "Shore roughness (Dirt x mul)", surf["Dirt"]["Roughness"], p_shore_rough),
             "Normal": surf["Dirt"]["Normal"], "AO": surf["Dirt"]["AO"]}

    # Which outputs get a Layer Blend: skip Normal / AO when no texture provides them
    active = ["BaseColor", "Normal", "Roughness", "AO"]
    if all(surf[s]["Normal"] is None for s in SURFACES):
        active.remove("Normal")
    if not USE_AO or all(surf[s]["AO"] is None for s in SURFACES):
        active.remove("AO")
    fill = {"Normal": flat_normal, "AO": one}
    for s in SURFACES:
        for p in ("Normal", "AO"):
            if surf[s][p] is None:
                surf[s][p] = fill[p]
    for p in ("Normal", "AO"):
        if shore[p] is None:
            shore[p] = fill[p]

    # --- Auto = grass -> dirt (slope) -> rock (slope/height) -> shore (height) ---
    auto = {}
    for p in active:
        a = g.lerp(3, "Auto %s: grass/dirt" % p, surf["Grass"][p], surf["Dirt"][p], dirt_a)
        a = g.lerp(3, "Auto %s: +rock" % p, a, surf["Rock"][p], rock_a)
        a = g.lerp(2, "Auto %s: +shore" % p, a, shore[p], shore_a)
        auto[p] = a
    # Debug view for tuning (3.6): DebugMasks = 1 shows red = dirt slope, green = rock, blue = shore
    debug_rgb = g.op(C.MaterialExpressionAppendVector, 3, "mask colours RG",
                     dirt_a, rock_a)
    debug_rgb = g.op(C.MaterialExpressionAppendVector, 3, "mask colours RGB", debug_rgb, shore_a)
    auto["BaseColor"] = g.lerp(2, "Auto BaseColor: DebugMasks", auto["BaseColor"], debug_rgb, p_debug)

    # --- one Landscape Layer Blend per output ----------------------------------
    printed = False
    for p in active:
        blend = g.node(C.MaterialExpressionLandscapeLayerBlend, 1, "Layer Blend " + p)
        layers = []
        for name in cfg.LANDSCAPE_LAYERS:
            li = unreal.LayerBlendInput()
            li.set_editor_property("layer_name", name)
            li.set_editor_property("blend_type", C.LandscapeLayerBlendType.LB_WEIGHT_BLEND)
            li.set_editor_property("preview_weight", 1.0 if name == "Auto" else 0.0)
            layers.append(li)
        g.set(blend, "layers", layers, "Layer Blend " + p)   # set before connecting (re-setting drops links)
        if not printed:
            ow.log("Landscape Layer Blend input pins: %s" % (g.input_names(blend) or "(not readable)"))
            printed = True
        for name in cfg.LANDSCAPE_LAYERS:
            if name == "Auto":
                src = auto[p]
            elif name in surf:
                src = surf[name][p]
            else:
                problem("layer '%s' in ow_config.LANDSCAPE_LAYERS has no surface in this script; it stays black. "
                        "Use the names Auto, Grass, Dirt, Rock, Road." % name)
                continue
            g.connect(src, blend, "Layer " + name)
        g.to_root(blend, p)
    return active, report


# ===========================================================================
# Assets, landscape, checks
# ===========================================================================
def get_or_create(path, cls, factory):
    folder, name = path.rsplit("/", 1)
    if EAL.does_asset_exist(path):
        asset = EAL.load_asset(path)
        if asset is not None and isinstance(asset, cls):
            return asset, False
        raise RuntimeError("%s exists but is not a %s. Rename or delete it, then run again." % (path, cls.__name__))
    ow.ensure_directory(folder)
    asset = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, cls, factory)
    if asset is None:
        raise RuntimeError("could not create %s" % path)
    ow.log("created %s" % path)
    return asset, True


def substrate_state():
    try:
        on = bool(unreal.SystemLibrary.get_console_variable_bool_value("r.Substrate"))
    except Exception:  # noqa: BLE001
        return "unknown"
    return "ON" if on else "off"


BLEND_METHOD_LABEL = {"NONE": "No Weight Blending", "FINAL_WEIGHT_BLENDING": "Weight Blending (Legacy)",
                      "PREMULTIPLIED_ALPHA_BLENDING": "Advanced Weight Blending"}


def enum_name(value):
    text = str(value)
    if "." in text:
        text = text.split(".")[-1]
    return text.split(":")[0].strip("<> ")


def blend_label(name):
    return "%s (%s)" % (BLEND_METHOD_LABEL.get(name, name), name)


def check_layer_infos(land):
    """Report which paint layers have a Layer Info and whether it is weight-blended (3.4)."""
    found = {}
    try:
        for key, settings in dict(land.get_editor_property("target_layers")).items():
            found[str(key)] = settings
    except Exception as exc:  # noqa: BLE001 - information only
        ow.warn("could not read the landscape's target layers (%s); check Layer Infos by eye in Paint mode" % exc)
        return
    enum = getattr(unreal, "LandscapeTargetLayerBlendMethod", None)   # 5.7+ only
    missing = []
    for name in cfg.LANDSCAPE_LAYERS:
        info = None
        if name in found:
            try:
                info = found[name].get_editor_property("layer_info_obj")
            except Exception:  # noqa: BLE001
                info = None
        if info is None:
            missing.append(name)
            continue
        where = info.get_path_name()
        place = "" if where.startswith(cfg.LANDSCAPE_LAYERS_DIR) else "  (not in %s - fine, but untidy)" % \
            cfg.LANDSCAPE_LAYERS_DIR
        method = None
        try:
            method = info.get_editor_property("blend_method")          # 5.7 / 5.8
        except Exception:  # noqa: BLE001
            method = None
        if method is not None:
            label = enum_name(method)
            if label == "NONE" and FIX_LAYER_INFO_BLENDING and enum is not None and \
                    hasattr(enum, "FINAL_WEIGHT_BLENDING"):
                with unreal.ScopedEditorTransaction("OW: layer info blending"):
                    info.set_editor_property("blend_method", enum.FINAL_WEIGHT_BLENDING)
                EAL.save_loaded_asset(info, False)
                label = enum_name(info.get_editor_property("blend_method"))
                ow.log("Layer Info %-6s: Blend Method was No Weight Blending -> now %s (saved)%s"
                       % (name, blend_label(label), place))
            elif label == "NONE":
                problem("Layer Info %s: Blend Method = No Weight Blending. Double-click %s and set Blend Method = "
                        "Weight Blending (Legacy), then save (3.4)." % (name, where))
            else:
                ow.log("Layer Info %-6s: OK, Blend Method = %s%s" % (name, blend_label(label), place))
            continue
        try:
            nwb = bool(info.get_editor_property("no_weight_blend"))     # 5.6
        except Exception:  # noqa: BLE001
            ow.log("Layer Info %-6s: present (%s); blending could not be read" % (name, where))
            continue
        if nwb:
            problem("Layer Info %s is Non Weight-Blended (%s). Delete it, then click '+' next to %s again and pick "
                    "'Weight-Blended Layer (normal)' (3.4). Manual paint would otherwise mix 50/50 with Auto."
                    % (name, where, name))
        else:
            ow.log("Layer Info %-6s: OK, weight-blended%s" % (name, place))
    if missing:
        ow.warn("no Layer Info yet for: %s. Next: step 3.4 (Landscape Mode > Paint > '+' next to each layer)."
                % ", ".join(missing))
    else:
        ow.log("all %d paint layers have a Layer Info" % len(cfg.LANDSCAPE_LAYERS))


def check_weights(land, fr):
    """After 3.5: Auto should be 1 at the lake centre and Road 1 in the middle of the road."""
    try:
        lay = ow.layout()
        comps = list(land.get_components_by_class(unreal.LandscapeComponent))
    except Exception as exc:  # noqa: BLE001 - information only
        ow.log("weight check skipped (%s)" % exc)
        return
    if not comps:
        ow.log("weight check skipped (no landscape components found)")
        return
    road = lay.get("road", {}).get("points_m", [])
    samples = [("Auto", lay.get("lake", {}).get("center_m", [55.0, -35.0]), "lake centre")]
    if road:
        samples.append(("Road", road[len(road) // 2][:2], "middle of the road"))
    for layer, pos, where in samples:
        loc = fr.to_world(pos[0], pos[1], 0.0)
        best = 0.0
        for comp in comps:
            try:
                best = max(best, float(comp.editor_get_paint_layer_weight_by_name_at_location(loc, layer)))
            except Exception:  # noqa: BLE001
                pass
        if best >= 0.8:
            ow.log("weight %-4s at %s = %.2f  OK" % (layer, where, best))
        else:
            ow.warn("weight %-4s at %s = %.2f (expected about 1.0). If you have not done step 3.5 yet this is "
                    "normal; otherwise re-import OW_Weight_%s_505.png into the %s layer." % (layer, where, best,
                                                                                         layer, layer))


def main():
    ow.log("=" * 70)
    ow.log("p3_landscape_material: engine %s, Substrate %s" % (unreal.SystemLibrary.get_engine_version(),
                                                             substrate_state()))
    if substrate_state() == "ON":
        ow.log("Substrate is on (5.7/5.8 default). The material uses the classic Base Color/Normal/Roughness/AO "
               "pins, which the engine converts. If the landscape renders black or flat grey, see step 3.2.")

    # --- landscape and water datum -----------------------------------------
    fr = None
    land = None
    try:
        fr = ow.frame()
        land = fr.actor
    except RuntimeError as exc:
        ow.warn("%s The material is still built; run the script again after Phase 2 to assign it." % exc)
    water_m = float(cfg.WATER_LEVEL_M)
    try:
        water_m = float(ow.layout().get("water_level_m", water_m))
    except Exception as exc:  # noqa: BLE001
        ow.warn("OW_Layout.json not read (%s); using WATER_LEVEL_M = %.2f m from ow_config.py" % (exc, water_m))
    if fr is not None:
        water_z_cm = fr.height_to_world_z(water_m)
        scale_xy = float(fr.scale.x) or cfg.LANDSCAPE_SCALE_XY_CM
    else:
        water_z_cm = water_m * 100.0
        scale_xy = cfg.LANDSCAPE_SCALE_XY_CM
    mapping_scale = 100.0 / scale_xy      # landscape UV = quads / Mapping Scale -> 1 UV unit = 1 m
    ow.log("lake surface: %.2f m above the landscape = world Z %.1f cm (WaterLevelZ_cm)" % (water_m, water_z_cm))

    # --- material ------------------------------------------------------------
    mat, mat_new = get_or_create(MAT_PATH, unreal.Material, unreal.MaterialFactoryNew())
    g = Graph(mat)
    if REBUILD_MATERIAL or mat_new:
        MEL.delete_all_material_expressions(mat)
        try:
            mat.set_editor_property("use_material_attributes", False)
        except Exception as exc:  # noqa: BLE001
            ow.warn("could not untick Use Material Attributes (%s); untick it in M_OW_Landscape's Details" % exc)
        active, report = build_graph(g, mapping_scale, water_z_cm)
        for s in SURFACES:
            ow.log("surface %-5s: %s" % (s, report[s]))
        ow.log("built %d nodes; %d connections OK, %d failed; Layer Blends for: %s"
               % (g.nodes, g.links_ok, g.links_failed, ", ".join(active)))
        MEL.recompile_material(mat)
        EAL.save_asset(MAT_PATH, False)
        try:
            st = MEL.get_statistics(mat)
            ow.log("material stats (editor preview, all layers): %d pixel-shader instructions, %d texture samples, "
                   "%d samplers, %d virtual-texture samples" % (st.num_pixel_shader_instructions,
                                                               st.num_pixel_texture_samples, st.num_samplers,
                                                               st.num_virtual_texture_samples))
        except Exception as exc:  # noqa: BLE001 - information only
            ow.log("statistics not available (%s); open M_OW_Landscape > Stats" % exc)
    else:
        ow.log("REBUILD_MATERIAL = False: kept the existing graph of %s" % MAT_PATH)

    # --- material instance -----------------------------------------------------
    mi, _ = get_or_create(MI_PATH, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
    if mi.get_editor_property("parent") != mat:
        MEL.set_material_instance_parent(mi, mat)
    if RESET_INSTANCE_OVERRIDES:
        MEL.clear_all_material_instance_parameters(mi)
        ow.log("cleared all overrides in %s (back to the TUNABLES values)" % MI_PATH)
    if not MEL.set_material_instance_scalar_parameter_value(mi, "WaterLevelZ_cm", water_z_cm):
        problem("could not set WaterLevelZ_cm on %s. By hand: open it, tick WaterLevelZ_cm (group '01 Water level') "
                "and type %.1f." % (MI_PATH, water_z_cm))
    MEL.update_material_instance(mi)
    EAL.save_asset(MI_PATH, False)

    # --- landscape -----------------------------------------------------------------
    if land is not None and ASSIGN_TO_LANDSCAPE:
        try:
            if land.get_editor_property("landscape_material") != mi:
                with unreal.ScopedEditorTransaction("OW: assign landscape material"):
                    land.set_editor_property("landscape_material", mi)
                ow.log("assigned %s to %s (the landscape recompiles its shaders now; wait for 'Compiling "
                       "Shaders' to finish)" % (MI_PATH, land.get_actor_label()))
            else:
                ow.log("%s already uses %s" % (land.get_actor_label(), MI_PATH))
        except Exception as exc:  # noqa: BLE001
            problem("could not assign the material (%s). By hand: select the Landscape, Details > Landscape > "
                    "Landscape Material = MI_OW_Landscape." % exc)
        check_layer_infos(land)
        check_weights(land, fr)
        if SAVE_LEVEL:
            ow.save_level()

    # --- summary ---------------------------------------------------------------------
    if PROBLEMS:
        ow.error("%d step(s) need doing by hand:" % len(PROBLEMS))
        for text in PROBLEMS[:MAX_PROBLEMS_SHOWN]:
            ow.error("  - " + text)
        if len(PROBLEMS) > MAX_PROBLEMS_SHOWN:
            ow.error("  ... and %d more (see the warnings above)" % (len(PROBLEMS) - MAX_PROBLEMS_SHOWN))
    ow.log("RESULT: %s and %s ready%s; %d problem(s)." % (cfg.LANDSCAPE_MATERIAL_NAME,
                                                         cfg.LANDSCAPE_MATERIAL_INSTANCE_NAME,
                                                         ", assigned to the landscape" if land is not None and
                                                         ASSIGN_TO_LANDSCAPE else "", len(PROBLEMS)))


main()
