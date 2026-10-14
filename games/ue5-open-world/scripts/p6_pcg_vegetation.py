"""p6_pcg_vegetation.py - Phase 6: build the PCG vegetation graphs and volumes, then generate.

Build-plan step: 6.3. Step 6.4 explains every node and value, 6.5 the generation, culling,
shadow and collision settings, and 6.6 re-running and tuning.

How to run (see 1.5):
  Close every PCG graph editor tab first, and open L_OpenWorld. Then use Tools > Execute Python
  Script... and pick OpenWorldTools/scripts/p6_pcg_vegetation.py, or type
      py "C:/<Project>/OpenWorldTools/scripts/p6_pcg_vegetation.py"
  in the Output Log command box (Cmd mode). It needs the PCG plugin (1.3), the landscape with its
  Road paint layer (Phases 2-3), the lake tagged OW_Water (Phase 5) and the ASSETS slots filled
  (1.7, 1.8).

What it creates / changes:
  * Two PCG Graph assets in /Game/OpenWorld/PCG (cfg.PCG_DIR):
      PCG_OW_Vegetation  trees, bushes, ground scatter, shore reeds/pebbles
      PCG_OW_Grass       grass and flowers
    Existing assets are reused: all their nodes are removed and rebuilt, so no overwrite dialog
    appears and the level keeps its references. A branch whose ASSETS slot is empty is skipped,
    with a warning.
  * Two PCG Volumes that cover the landscape, PCGV_OW_Vegetation and PCGV_OW_Grass. They get the
    tags OW_Managed + OW_PCG and go in Outliner folder OpenWorld/PCG. Settings: Generation
    Trigger = Generate On Demand, not partitioned, component Seed = PCG_SEED. The script then
    starts generation. Generation is asynchronous: plants appear over the next seconds to a
    minute. When the editor allows it, the script prints the instance count per layer against
    the budget once generation has finished.
  * Saved/OpenWorld/OW_PCG_Graphs.txt: every node, setting and wire the script built. Use it as
    the checklist for 6.4.
  * With LANDSCAPE_TAG set, it adds that tag to the main landscape.
  If the engine refuses a value, the script prints "do this by hand: ..." and carries on.
  It does not save the level: wait for generation, check the result, then File > Save All.

Safe to re-run: it first removes the volumes it placed before (tag OW_PCG) and rebuilds the graphs
in place. A re-run loses hand edits inside the two graphs unless BUILD_GRAPHS = False.

Undo: Ctrl+Z ("OW: PCG vegetation") removes the new volumes (old volumes that come back may need
Generate again). The graph assets stay; delete them in the Content Browser. Or delete the actors
tagged OW_PCG.

API notes: engine calls were checked against the UE 5.6 Python API. The PCG names come from the
UE 5.6.1 and 5.8.2 PCG source (research R6b). 5.7 is assumed to be the same. In UE 5.6 a PCG graph
editor that was open earlier in the session keeps showing the OLD graph after a re-run: restart the
editor to see the rebuilt graph. Generation always uses the real graph.
"""
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unreal
import ow_common as ow
importlib.reload(ow)
cfg = ow.cfg
import math  # noqa: E402

# ===========================================================================
# TUNABLES (units in brackets; build-plan step in front). The doc mirrors these in 6.4-6.6.
# ===========================================================================
# 6.3 Names and what to do
GRAPH_VEGETATION = "PCG_OW_Vegetation"   # in cfg.PCG_DIR: trees, bushes, ground scatter, shore
GRAPH_GRASS = "PCG_OW_Grass"             # in cfg.PCG_DIR: grass, flowers
VOLUME_VEGETATION = "PCGV_OW_Vegetation"
VOLUME_GRASS = "PCGV_OW_Grass"
TAG_PCG = "OW_PCG"                       # extra tag on both volumes (besides OW_Managed)
BUILD_GRAPHS = True                      # False = keep the graph assets as they are (your hand edits
                                         #   survive); only replace the volumes and generate
GENERATE = True                          # False = place the volumes but do not generate
REPORT_TIMEOUT_S = 300.0                 # [s] stop waiting for the instance-count report after this

# 6.4 Shared rules (both graphs)
PCG_SEED = cfg.SEED                      # component Seed of BOTH volumes. Keep them equal: the forest
                                         #   mask in both graphs must match (6.6)
NEAR_WATER_SOURCE = "spline"             # "spline" = distance to the OW_Water lake spline
                                         # "box"    = distance to the lake's bounding box from
                                         #            OW_Layout.json (fallback, 6.6)
LAKE_SPLINE_STEP_CM = 200.0              # [cm] Spline Sampler Distance Increment along the lake spline
EXCLUDE_MARGIN_CM = (150.0, 300.0)       # [cm] (sideways, up/down) margin around every OW_PCGExclude actor
ROAD_POINTS_DENSITY = 0.5                # [points/m2] road-point sampler for tree/bush clearance
ROAD_POINT_MIN_WEIGHT = 0.5              # Road layer weight that counts as road for the clearance boxes
ROAD_CLEAR_HALF_CM = 250.0               # [cm] half size of the clearance box around each road point
SMALL_PLANT_MAX_ROAD = 0.2               # grass, flowers, scatter, shore: removed where Road weight >= this
FOREST_NOISE = {"scale": 1.5,            # Spatial Noise Transform scale X/Y: lattice = 100 m / scale
                "contrast": 4.0,         # sharper forest edges with higher values
                "brightness": 0.0,       # +0.05 = more forest, -0.05 = less
                "seed": 1001}            # node Seed; the same in all four forest-mask nodes
LANDSCAPE_TAG = ""                       # "" = sample every landscape. "OW_PCGLandscape" = tag the main
                                         #   landscape and read only it (use with the 7.3 backdrop)

# 6.4 / 6.5 Layers. density = Surface Sampler Points Per Squared Meter [points/m2];
# extents_cm = Point Extents [cm] (max density = 10000 / (2 * extents)^2 per m2);
# near_water = (distance [m], keep fraction beyond it): keep 100 % at the lake, falling linearly
# to that fraction at the distance; cull/wpo distances in cm (0 = never).
# max_slope_deg: keep every layer at or below 33 deg, where the Phase 3 landscape material starts
# showing rock (RockSlopeStart_deg). If you change that parameter, change these with it.
TREES = {"density": 0.06, "extents_cm": 100.0, "max_slope_deg": 30.0, "above_water_cm": 100.0,
         "forest_roll": (0.15, 0.65),    # keep if Forest > random(min, max)
         "spacing_m": 4.0,               # Self Pruning: no two trunks closer than this
         "scale": (0.8, 1.25), "sink_cm": (10.0, 20.0), "upright": True, "seed": 11,
         "start_cull_cm": 0, "end_cull_cm": 0, "wpo_disable_cm": 6000,
         "shadow": True, "collision": True, "ray_tracing": True, "wpo": True}
BUSHES = {"density": 0.03, "extents_cm": 50.0, "max_slope_deg": 33.0, "above_water_cm": 30.0,
          "near_water": (40.0, 0.25),
          "scale": (0.7, 1.3), "sink_cm": (5.0, 10.0), "upright": True, "seed": 22,
          "start_cull_cm": 12000, "end_cull_cm": 15000, "wpo_disable_cm": 4000,
          "shadow": True, "collision": False, "ray_tracing": True, "wpo": True}
SCATTER = {"density": 0.15, "extents_cm": 10.0, "max_slope_deg": 33.0, "above_water_cm": 30.0,
           "forest_roll": (0.4, 0.7),    # forest floor only
           "scale": (0.6, 1.4), "sink_cm": (0.0, 3.0), "upright": False, "seed": 33,
           "start_cull_cm": 1500, "end_cull_cm": 2500, "wpo_disable_cm": 0,
           "shadow": False, "collision": False, "ray_tracing": False, "wpo": False}
SHORE = {"density": 1.5, "extents_cm": 10.0, "band_cm": (-40.0, 80.0),   # height band around the water surface
         "near_water": (6.0, 0.0),
         "scale": (0.7, 1.3), "sink_cm": (0.0, 5.0), "upright": True, "seed": 44,
         "start_cull_cm": 3500, "end_cull_cm": 5000, "wpo_disable_cm": 2500,
         "shadow": False, "collision": False, "ray_tracing": False, "wpo": True}
GRASS = {"density": 3.0, "extents_cm": 10.0, "max_slope_deg": 33.0, "above_water_cm": 30.0,
         "forest_keep": 0.3,             # fraction of grass kept deep inside the forest
         "near_water": (30.0, 0.6),
         "scale": (0.7, 1.3), "sink_cm": (0.0, 0.0), "upright": False, "seed": 55,
         "start_cull_cm": 3500, "end_cull_cm": 5000, "wpo_disable_cm": 2500,
         "shadow": False, "collision": False, "ray_tracing": False, "wpo": True}
FLOWERS = {"density": 0.25, "extents_cm": 10.0, "max_slope_deg": 30.0, "above_water_cm": 50.0,
           "meadow_max_forest": 0.4,     # only where Forest < this
           "patch": {"scale": 6.0, "contrast": 3.0, "threshold": 0.6, "seed": 2002},
           "scale": (0.8, 1.2), "sink_cm": (0.0, 0.0), "upright": False, "seed": 66,
           "start_cull_cm": 3000, "end_cull_cm": 4500, "wpo_disable_cm": 2500,
           "shadow": False, "collision": False, "ray_tracing": False, "wpo": True}

# 6.5 Volumes and budget
REGENERATE_IN_EDITOR = {"vegetation": True, "grass": False}   # grass off: no regeneration per brush stroke
BUDGET = {"trees": 5000, "bushes": 3000, "scatter": 25000, "shore": 5000,
          "grass": 500000, "flowers": 15000}                  # instances in the level (6.5)
# ===========================================================================

PCG_DIR = cfg.PCG_DIR
SPEC = []          # lines for OW_PCG_Graphs.txt
MANUAL = []        # "do this by hand" steps, repeated at the end
PIN_UI = {"InsideFilter": "Inside Filter", "OutsideFilter": "Outside Filter"}


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def manual_step(where, what):
    msg = "%s: %s" % (where, what)
    MANUAL.append(msg)
    ow.warn("do this by hand: " + msg)


def fmt(v):
    if isinstance(v, bool):
        return "on" if v else "off"
    if isinstance(v, float):
        return ("%.3f" % v).rstrip("0").rstrip(".")
    if isinstance(v, unreal.Vector):
        return "X %s, Y %s, Z %s" % (fmt(v.x), fmt(v.y), fmt(v.z))
    return str(v)


def vec(x, y, z):
    return unreal.Vector(float(x), float(y), float(z))


def enum(enum_name, value_name):
    """unreal.<enum_name>.<value_name>, or None if this engine does not have it."""
    try:
        return getattr(getattr(unreal, enum_name), value_name)
    except Exception:
        return None


def normalize_ref(text):
    """'/Script/Engine.StaticMesh'/Game/A/B.B'' or '/Game/A/B.B' -> '/Game/A/B' (same as p1)."""
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


def load_meshes(slot):
    """Static meshes from cfg.ASSETS[slot]; no placeholders (an empty slot skips the branch)."""
    entry = cfg.ASSETS.get(slot)
    paths = entry if isinstance(entry, list) else ([entry] if entry else [])
    meshes = []
    for p in paths:
        asset = ow.load(normalize_ref(p))
        if asset is None:
            ow.warn("ASSETS['%s']: '%s' not found - check the path (right-click > Copy Reference)" % (slot, p))
        elif not isinstance(asset, unreal.StaticMesh):
            ow.warn("ASSETS['%s']: '%s' is a %s, not a Static Mesh - the PCG Static Mesh Spawner needs "
                    "Static Meshes, skipped" % (slot, p, asset.get_class().get_name()))
        else:
            meshes.append(asset)
    return meshes


# ---------------------------------------------------------------------------
# Graph builder: every PCG call is guarded; failures become exact manual steps
# ---------------------------------------------------------------------------
def P(name, value, ui):
    """Plain property on the node settings. ui = what to set by hand, e.g. '`Lower Bound` = 0.866'."""
    return (lambda s: s.set_editor_property(name, value), ui)


def SEL(name, text, label):
    """Attribute selector ('Road', '$Position.Z', 'Forest') via the PCGBegin(...)PCGEnd text form."""
    def f(s):
        sel = s.get_editor_property(name)
        ok = sel.import_text("PCGBegin(%s)PCGEnd" % text)
        s.set_editor_property(name, sel)
        if ok is False:
            raise RuntimeError("import_text did not confirm the value")
    return (f, "`%s` = **%s**" % (label, text))


def STRUCT(name, fields, ui):
    """Read-modify-write of a struct property (Python returns a copy)."""
    def f(s):
        st = s.get_editor_property(name)
        for k, v in fields:
            st.set_editor_property(k, v)
        s.set_editor_property(name, st)
    return (f, ui)


def const_double(value):
    c = unreal.PCGMetadataTypesConstantStruct()
    c.set_editor_property("type", unreal.PCGMetadataTypes.DOUBLE)
    c.set_editor_property("double_value", float(value))
    return c


def CONST(value):
    """Constant threshold of Filter Attribute Elements (Use Constant Threshold on, type Double)."""
    return (lambda s: s.set_editor_property("attribute_types", const_double(value)),
            "constant `Type` = **Double**, value = **%s**" % fmt(float(value)))


def RANGE_BOUND(name, value, label):
    """Min/Max Threshold of Filter Attribute Elements by Range: constant Double, Inclusive on."""
    def f(s):
        st = s.get_editor_property(name)
        st.set_editor_property("use_constant_threshold", True)
        st.set_editor_property("inclusive", True)
        st.set_editor_property("attribute_types", const_double(value))
        s.set_editor_property(name, st)
    return (f, "`%s` > `Use Constant Threshold` = **on**, `Inclusive` = **on**, Double value = **%s**"
            % (label, fmt(float(value))))


def pin_labels(node, output):
    try:
        pins = node.get_editor_property("output_pins" if output else "input_pins") or []
        return [str(p.get_editor_property("properties").get_editor_property("label")) for p in pins]
    except Exception:
        return []


def find_pin(node, label, output):
    try:
        for p in node.get_editor_property("output_pins" if output else "input_pins") or []:
            if str(p.get_editor_property("properties").get_editor_property("label")) == label:
                return p
    except Exception:
        pass
    return None


def edge_count(pin):
    try:
        return len(pin.get_editor_property("edges") or [])
    except Exception:
        return None


class Builder(object):
    def __init__(self, graph_name, graph):
        self.gname = graph_name
        self.graph = graph
        self.nodes = {}            # key -> dict(node, settings, title, palette) or None
        self.titles = {}           # key -> title (also for nodes that failed)
        self.count = 0
        self.ok = self.unverified = self.failed = 0
        SPEC.append("")
        SPEC.append("=" * 78)
        SPEC.append("GRAPH %s/%s" % (PCG_DIR, graph_name))
        SPEC.append("=" * 78)

    def manual(self, what):
        manual_step(self.gname, what)

    def add(self, key, cls_name, palette, title, pos, props=()):
        self.titles[key] = title
        SPEC.append("")
        SPEC.append("[%s] %s  (palette: %s)" % (key, title, palette))
        for _, ui in props:
            SPEC.append("    set " + ui)
        node = settings = None
        cls = getattr(unreal, cls_name, None)
        if cls is not None and self.graph is not None:
            try:
                result = self.graph.add_node_of_type(cls)
                node, settings = tuple(result) if isinstance(result, (tuple, list)) else (result, None)
                if node is not None and settings is None:
                    settings = node.get_settings()
            except Exception as exc:
                ow.warn("%s: add_node_of_type(%s) failed: %s" % (self.gname, cls_name, exc))
                node = settings = None
        if node is None or settings is None:
            self.nodes[key] = None
            self.manual("add a '%s' node titled '%s' and set: %s"
                        % (palette, title, "; ".join(ui for _, ui in props) or "(defaults)"))
            return None
        self.count += 1
        try:
            node.set_editor_property("node_title", unreal.Name(title))
        except Exception:
            pass   # cosmetic only
        try:
            node.set_node_position(int(pos[0]), int(pos[1]))
        except Exception:
            pass
        self.nodes[key] = {"node": node, "settings": settings, "title": title, "palette": palette}
        for f, ui in props:
            try:
                f(settings)
            except Exception as exc:
                self.manual("node '%s' (%s): set %s   [%s]" % (title, palette, ui, exc))
        return settings

    def wire(self, a, a_pin, b, b_pin):
        desc = "%s . %s  ->  %s . %s" % (self.titles.get(a, a), PIN_UI.get(a_pin, a_pin),
                                         self.titles.get(b, b), PIN_UI.get(b_pin, b_pin))
        SPEC.append("    wire " + desc)
        na, nb = self.nodes.get(a), self.nodes.get(b)
        if na is None or nb is None or self.graph is None:
            self.failed += 1
            self.manual("wire " + desc)
            return
        outs, ins = pin_labels(na["node"], True), pin_labels(nb["node"], False)
        if (outs and a_pin not in outs) or (ins and b_pin not in ins):
            self.failed += 1
            self.manual("wire %s   [pins found: '%s' outputs %s, '%s' inputs %s]"
                        % (desc, na["title"], outs, nb["title"], ins))
            return
        dst = find_pin(nb["node"], b_pin, False)
        before = edge_count(dst) if dst is not None else None
        try:
            self.graph.add_edge(na["node"], a_pin, nb["node"], b_pin)   # returns the To node even on failure
        except Exception as exc:
            self.failed += 1
            self.manual("wire %s   [%s]" % (desc, exc))
            return
        if dst is None or before is None:
            self.unverified += 1          # pin list not readable: cannot check (log has LogPCG errors if wrong)
            return
        after = edge_count(dst)
        if after is not None and after > before:
            self.ok += 1
        else:
            self.failed += 1
            self.manual("wire %s   [add_edge did not connect; see LogPCG in the Output Log]" % desc)

    # -- building blocks (each adds nodes and the wires between them) --------
    def landscape(self, pos):
        props = []
        if LANDSCAPE_TAG:
            props.append(STRUCT("actor_selector",
                                [("actor_selection", enum("PCGActorSelection", "BY_TAG")),
                                 ("actor_selection_tag", unreal.Name(LANDSCAPE_TAG))],
                                "`Actor Selection` = **By Tag**, `Actor Selection Tag` = **%s**" % LANDSCAPE_TAG))
        self.add("landscape", "PCGGetLandscapeSettings", "Get Landscape Data", "Landscape", pos, props)

    def actors_by_tag(self, key, tag, title, pos, single_point):
        cls, palette = (("PCGDataFromActorSettings", "Get Actor Data") if single_point
                        else ("PCGGetSplineSettings", "Get Spline Data"))
        props = [STRUCT("actor_selector",
                        [("actor_filter", enum("PCGActorFilter", "ALL_WORLD_ACTORS")),
                         ("actor_selection", enum("PCGActorSelection", "BY_TAG")),
                         ("actor_selection_tag", unreal.Name(tag)),
                         ("select_multiple", True)],
                        "`Actor Filter` = **All World Actors**, `Actor Selection` = **By Tag**, "
                        "`Actor Selection Tag` = **%s**, `Select Multiple` = **on**" % tag)]
        if single_point:
            props.append(P("mode", enum("PCGGetDataFromActorMode", "GET_SINGLE_POINT"),
                           "`Mode` = **Get Single Point**"))
        self.add(key, cls, palette, title, pos, props)

    def bounds(self, key, title, pos, mode_name, mode_ui, bmin, bmax, src, src_pin):
        self.add(key, "PCGBoundsModifierSettings", "Bounds Modifier", title, pos, [
            P("mode", enum("PCGBoundsModifierMode", mode_name), "`Mode` = **%s**" % mode_ui),
            P("bounds_min", bmin, "`Bounds Min` = **%s**" % fmt(bmin)),
            P("bounds_max", bmax, "`Bounds Max` = **%s**" % fmt(bmax))])
        self.wire(src, src_pin, key, "In")

    def sampler(self, key, title, pos, density, extents_cm, seed):
        ext = vec(extents_cm, extents_cm, extents_cm)
        self.add(key, "PCGSurfaceSamplerSettings", "Surface Sampler", title, pos, [
            P("points_per_squared_meter", float(density), "`Points Per Squared Meter` = **%s**" % fmt(float(density))),
            P("point_extents", ext, "`Point Extents` = **%s**" % fmt(ext)),
            P("seed", int(seed), "`Seed` = **%d**" % int(seed))])
        self.wire("landscape", "Out", key, "Surface")

    def slope(self, prefix, branch, x, y, max_deg, src, src_pin):
        lower = round(math.cos(math.radians(max_deg)), 3)
        self.add(prefix + "_n2d", "PCGNormalToDensitySettings", "Normal To Density",
                 "%s: Slope To Density" % branch, (x, y), [
                     P("normal", vec(0, 0, 1), "`Normal` = **X 0, Y 0, Z 1** (default)"),
                     P("density_mode", enum("PCGNormalToDensityMode", "SET"), "`Density Mode` = **Set** (default)")])
        self.add(prefix + "_slope", "PCGDensityFilterSettings", "Density Filter",
                 "%s: Max Slope %d deg" % (branch, int(round(max_deg))), (x + 320, y), [
                     P("lower_bound", float(lower), "`Lower Bound` = **%s** (cos %d deg)" % (fmt(float(lower)), int(round(max_deg)))),
                     P("upper_bound", 1.0, "`Upper Bound` = **1.0**")])
        self.wire(src, src_pin, prefix + "_n2d", "In")
        self.wire(prefix + "_n2d", "Out", prefix + "_slope", "In")
        return prefix + "_slope", "Out"

    def filter_const(self, key, title, pos, target, op_name, op_ui, value, src, src_pin):
        self.add(key, "PCGAttributeFilteringSettings", "Filter Attribute Elements", title, pos, [
            SEL("target_attribute", target, "Target Attribute"),
            P("operator", enum("PCGAttributeFilterOperator", op_name), "`Operator` = **%s**" % op_ui),
            P("use_constant_threshold", True, "`Use Constant Threshold` = **on**"),
            CONST(value)])
        self.wire(src, src_pin, key, "In")

    def filter_attr(self, key, title, pos, target, op_name, op_ui, threshold_attr, src, src_pin):
        self.add(key, "PCGAttributeFilteringSettings", "Filter Attribute Elements", title, pos, [
            SEL("target_attribute", target, "Target Attribute"),
            P("operator", enum("PCGAttributeFilterOperator", op_name), "`Operator` = **%s**" % op_ui),
            P("use_constant_threshold", False, "`Use Constant Threshold` = **off** (leave the Filter pin unconnected)"),
            SEL("threshold_attribute", threshold_attr, "Threshold Attribute")])
        self.wire(src, src_pin, key, "In")

    def difference(self, key, title, pos, src, src_pin, diffs):
        self.add(key, "PCGDifferenceSettings", "Difference", title, pos, [
            P("density_function", enum("PCGDifferenceDensityFunction", "BINARY"), "`Density Function` = **Binary**")])
        self.wire(src, src_pin, key, "Source")
        for d in diffs:
            if d in self.nodes:
                self.wire(d, "Out", key, "Differences")

    def spatial_noise(self, key, title, pos, target, scale, contrast, brightness, seed, src, src_pin):
        self.add(key, "PCGSpatialNoiseSettings", "Spatial Noise", title, pos, [
            (lambda s: None, "`Mode` = **Perlin2D** (default)"),
            P("transform", unreal.Transform(scale=vec(scale, scale, 1.0)),
              "`Transform` > `Scale` = **X %s, Y %s, Z 1**" % (fmt(float(scale)), fmt(float(scale)))),
            P("contrast", float(contrast), "`Contrast` = **%s**" % fmt(float(contrast))),
            P("brightness", float(brightness), "`Brightness` = **%s**" % fmt(float(brightness))),
            SEL("value_target", target, "Value Target"),
            P("seed", int(seed), "`Seed` = **%d**" % int(seed))])
        self.wire(src, src_pin, key, "In")

    def roll(self, key, title, pos, target, lo, hi, seed, src, src_pin):
        self.add(key, "PCGAttributeNoiseSettings", "Attribute Noise", title, pos, [
            SEL("output_target", target, "Output Target"),
            P("mode", enum("PCGAttributeNoiseMode", "SET"), "`Mode` = **Set** (default)"),
            P("noise_min", float(lo), "`Noise Min` = **%s**" % fmt(float(lo))),
            P("noise_max", float(hi), "`Noise Max` = **%s**" % fmt(float(hi))),
            P("seed", int(seed), "`Seed` = **%d**" % int(seed))])
        self.wire(src, src_pin, key, "In")

    def distance_to_lake(self, key, title, pos, max_cm, src, src_pin, lake_keys, target_shape):
        shape_name, shape_ui = target_shape
        self.add(key, "PCGDistanceSettings", "Distance", title, pos, [
            P("output_to_attribute", True, "`Output To Attribute` = **on**"),
            SEL("output_attribute", "WaterDist", "Output Attribute"),
            P("set_density", False, "`Set Density` = **off**"),
            P("maximum_distance", float(max_cm), "`Maximum Distance` = **%s** (cm)" % fmt(float(max_cm))),
            P("source_shape", enum("PCGDistanceShape", "CENTER"), "`Source Shape` = **Center**"),
            P("target_shape", enum("PCGDistanceShape", shape_name), "`Target Shape` = **%s**" % shape_ui)])
        self.wire(src, src_pin, key, "Source")
        for k in lake_keys:
            if k in self.nodes:
                self.wire(k, "Out", key, "Target")

    def transform(self, key, title, pos, layer, src, src_pin):
        s_lo, s_hi = layer["scale"]
        k_lo, k_hi = layer["sink_cm"]
        rot_max = unreal.Rotator(roll=0.0, pitch=0.0, yaw=360.0)
        self.add(key, "PCGTransformPointsSettings", "Transform Points", title, pos, [
            P("offset_min", vec(0, 0, -k_hi), "`Offset Min` = **X 0, Y 0, Z %s**" % fmt(float(-k_hi))),
            P("offset_max", vec(0, 0, -k_lo), "`Offset Max` = **X 0, Y 0, Z %s**" % fmt(float(-k_lo))),
            P("rotation_min", unreal.Rotator(roll=0.0, pitch=0.0, yaw=0.0), "`Rotation Min` = **X 0, Y 0, Z 0**"),
            P("rotation_max", rot_max, "`Rotation Max` = **X 0, Y 0, Z 360** (Z = yaw)"),
            P("absolute_rotation", bool(layer["upright"]),
              "`Absolute Rotation` = **%s**" % fmt(bool(layer["upright"]))),
            P("scale_min", vec(s_lo, s_lo, s_lo), "`Scale Min` = **%s**" % fmt(float(s_lo))),
            P("scale_max", vec(s_hi, s_hi, s_hi), "`Scale Max` = **%s**" % fmt(float(s_hi))),
            P("uniform_scale", True, "`Uniform Scale` = **on** (default)")])
        self.wire(src, src_pin, key, "In")

    def spawner(self, key, title, pos, meshes, layer, src, src_pin):
        if layer["end_cull_cm"] > 0 and layer["start_cull_cm"] >= layer["end_cull_cm"]:
            fixed = int(layer["end_cull_cm"] * 0.7)
            ow.warn("%s: start_cull_cm (%d) must be below end_cull_cm (%d) - using %d. Lower both together."
                    % (title, layer["start_cull_cm"], layer["end_cull_cm"], fixed))
            layer = dict(layer, start_cull_cm=fixed)
        is_trees = key == "t_spawn"
        ui = ("`Mesh Entries`: one entry per mesh (%s), each `Weight` = 1 and `Descriptor` > "
              "`Instance Start Cull Distance` = %d, `Instance End Cull Distance` = %d, "
              "`World Position Offset Disable Distance` = %d, `Evaluate World Position Offset` = %s, "
              "`Cast Shadow` = %s, `Visible In Ray Tracing` = %s, collision %s"
              % (", ".join(m.get_name() for m in meshes), layer["start_cull_cm"], layer["end_cull_cm"],
                 layer["wpo_disable_cm"], fmt(layer["wpo"]), fmt(layer["shadow"]), fmt(layer["ray_tracing"]),
                 "`Collision Presets` = BlockAll" if layer["collision"] else "none (default NoCollision)"))
        if is_trees:
            ui += ", `Shadow Cache Invalidation Behavior` = Rigid"

        def f(s):
            sel = s.get_editor_property("mesh_selector_parameters")
            if not isinstance(sel, unreal.PCGMeshSelectorWeighted):
                s.set_mesh_selector_type(unreal.PCGMeshSelectorWeighted)
                sel = s.get_editor_property("mesh_selector_parameters")
            entries = []
            for mesh in meshes:
                e = unreal.PCGMeshSelectorWeightedEntry()
                d = e.get_editor_property("descriptor")                 # struct copy
                d.set_editor_property("static_mesh", mesh)
                d.set_editor_property("instance_start_cull_distance", int(layer["start_cull_cm"]))
                d.set_editor_property("instance_end_cull_distance", int(layer["end_cull_cm"]))
                d.set_editor_property("world_position_offset_disable_distance", int(layer["wpo_disable_cm"]))
                d.set_editor_property("evaluate_world_position_offset", bool(layer["wpo"]))
                d.set_editor_property("cast_shadow", bool(layer["shadow"]))
                d.set_editor_property("visible_in_ray_tracing", bool(layer["ray_tracing"]))
                if is_trees:
                    d.set_editor_property("shadow_cache_invalidation_behavior",
                                          unreal.ShadowCacheInvalidationBehavior.RIGID)
                if layer["collision"]:
                    bi = d.get_editor_property("body_instance")         # nested struct copy
                    bi.set_editor_property("collision_profile_name", unreal.Name("BlockAll"))
                    bi.set_editor_property("collision_enabled", unreal.CollisionEnabled.QUERY_AND_PHYSICS)
                    d.set_editor_property("body_instance", bi)
                e.set_editor_property("descriptor", d)                  # write back
                e.set_editor_property("weight", 1)
                entries.append(e)
            sel.set_editor_property("mesh_entries", entries)
        self.add(key, "PCGStaticMeshSpawnerSettings", "Static Mesh Spawner", title, pos, [(f, ui)])
        self.wire(src, src_pin, key, "In")


# ---------------------------------------------------------------------------
# Graph assets
# ---------------------------------------------------------------------------
def reset_graph(name):
    """Reuse /Game/OpenWorld/PCG/<name> (remove every node) or create it. None on failure."""
    path = PCG_DIR + "/" + name
    try:
        if unreal.EditorAssetLibrary.does_asset_exist(path):
            graph = unreal.EditorAssetLibrary.load_asset(path)
            if not isinstance(graph, unreal.PCGGraph):
                ow.error("%s exists but is not a PCG Graph - rename or delete it, then re-run" % path)
                return None
            unreal.get_editor_subsystem(unreal.AssetEditorSubsystem).close_all_editors_for_asset(graph)
            if BUILD_GRAPHS:
                keep = (graph.get_input_node(), graph.get_output_node())
                removed = 0
                for n in list(graph.get_editor_property("nodes") or []):
                    if n not in keep:
                        graph.remove_node(n)          # not remove_nodes(): its list is an out-param in Python
                        removed += 1
                ow.log("%s: reused the asset, removed %d old nodes" % (name, removed))
            return graph
        ow.ensure_directory(PCG_DIR)
        graph = unreal.AssetToolsHelpers.get_asset_tools().create_asset(
            name, PCG_DIR, unreal.PCGGraph, unreal.PCGGraphFactory())
        if graph is None:
            raise RuntimeError("create_asset returned None")
        ow.log("%s: created %s" % (name, path))
        if not BUILD_GRAPHS:
            ow.warn("%s did not exist, so it is EMPTY: set BUILD_GRAPHS = True and re-run, or build it by "
                    "hand (6.4)" % name)
        return graph
    except Exception as exc:
        manual_step(name, "create it: Content Browser > %s > right-click > PCG > PCG Graph, name it %s "
                          "(empty graph)   [%s]" % (PCG_DIR, name, exc))
        return None


def finish_graph(name, graph):
    if graph is None:
        return
    try:
        change = enum("PCGChangeType", "EXTERNAL_MODIFICATION")     # 5.8: rebuilds an open graph view
        if change is not None:
            graph.force_notification_for_editor(change)
        else:
            graph.force_notification_for_editor()
    except Exception as exc:
        try:
            graph.force_notification_for_editor()
        except Exception:
            ow.warn("%s: force_notification_for_editor failed (%s) - harmless" % (name, exc))
    try:
        if not unreal.EditorAssetLibrary.save_loaded_asset(graph, False):
            ow.warn("%s: could not save - press Save in the Content Browser" % name)
    except Exception as exc:
        ow.warn("%s: save failed (%s) - save it in the Content Browser" % (name, exc))


# ---------------------------------------------------------------------------
# World facts: water surface, lake box, landscape box
# ---------------------------------------------------------------------------
def find_lake():
    lakes = [a for a in ow.all_actors() if ow.has_tag(a, cfg.TAG_WATER)]
    return lakes[0] if lakes else None


def water_z_cm(frame, lake):
    layout_z = None
    try:
        layout_z = frame.height_to_world_z(float(ow.layout().get("water_level_m", cfg.WATER_LEVEL_M)))
    except Exception as exc:
        ow.warn("OW_Layout.json not readable (%s) - using ow_config.WATER_LEVEL_M" % exc)
        layout_z = frame.height_to_world_z(cfg.WATER_LEVEL_M)
    if lake is None:
        return layout_z, "OW_Layout.json water level (no actor tagged %s)" % cfg.TAG_WATER
    z = lake.get_actor_location().z
    if abs(z - layout_z) > 5.0:
        ow.warn("the lake actor's Z (%.0f cm) differs from the layout water level (%.0f cm) by %.0f cm - "
                "using the lake actor" % (z, layout_z, z - layout_z))
    return z, "Z of lake actor '%s'" % lake.get_actor_label()


def lake_box(frame, water_z):
    """Smallest rotated rectangle around the layout's lake spline points -> (location, yaw, half X, half Y)."""
    pts = [tuple(p[:2]) for p in ow.layout()["lake"]["spline_points_m"]]
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    best = None
    for deg in range(0, 180):
        a = math.radians(deg)
        ca, sa = math.cos(a), math.sin(a)
        us = [(x - cx) * ca + (y - cy) * sa for x, y in pts]
        vs = [-(x - cx) * sa + (y - cy) * ca for x, y in pts]
        area = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or area < best[0]:
            best = (area, deg, us, vs)
    _, deg, us, vs = best
    a = math.radians(deg)
    mu, mv = (max(us) + min(us)) / 2.0, (max(vs) + min(vs)) / 2.0
    bx, by = cx + mu * math.cos(a) - mv * math.sin(a), cy + mu * math.sin(a) + mv * math.cos(a)
    loc = frame.to_world(bx, by)
    loc = unreal.Vector(round(loc.x), round(loc.y), round(water_z))
    k = frame.cm_per_m_x       # cm per layout metre
    return loc, float(deg), float(round((max(us) - min(us)) / 2.0 * k)), float(round((max(vs) - min(vs)) / 2.0 * k))


def lake_nodes(b, ctx, x, y):
    """Distance targets: lake spline points (spline mode) + one Create Points point."""
    keys = []
    if ctx["water_mode"] == "spline":
        b.actors_by_tag("lake_spline", cfg.TAG_WATER, "Lake Spline (%s)" % cfg.TAG_WATER, (x, y), single_point=False)
        b.add("lake_points", "PCGSplineSamplerSettings", "Spline Sampler", "Lake Shore Points", (x + 320, y), [
            STRUCT("sampler_params",
                   [("dimension", enum("PCGSplineSamplingDimension", "ON_SPLINE")),
                    ("mode", enum("PCGSplineSamplingMode", "DISTANCE")),
                    ("distance_increment", float(LAKE_SPLINE_STEP_CM)),
                    ("unbounded", True)],
                   "`Dimension` = **On Spline**, `Mode` = **Distance**, `Distance Increment` = **%s** (cm), "
                   "`Unbounded` = **on**" % fmt(float(LAKE_SPLINE_STEP_CM)))])
        b.wire("lake_spline", "Out", "lake_points", "Spline")
        keys.append("lake_points")
    p = ctx["safety_point"]

    def f(s):
        pt = unreal.PCGPoint()
        pt.set_editor_property("transform", unreal.Transform(location=p["loc"], rotation=ow.yaw_rotator(p["yaw"]),
                                                             scale=vec(1, 1, 1)))
        pt.set_editor_property("bounds_min", vec(-p["hx"], -p["hy"], -p["hz"]))
        pt.set_editor_property("bounds_max", vec(p["hx"], p["hy"], p["hz"]))
        pt.set_editor_property("density", 1.0)
        pt.set_editor_property("steepness", 1.0)
        s.set_editor_property("points_to_create", [pt])
    ui = ("`Points To Create` > + one point: `Transform` > `Location` = **%s**, `Rotation` = **X 0, Y 0, Z %s**; "
          "`Bounds Min` = **%s**, `Bounds Max` = **%s**; `Coordinate Space` = **World**"
          % (fmt(p["loc"]), fmt(p["yaw"]), fmt(vec(-p["hx"], -p["hy"], -p["hz"])), fmt(vec(p["hx"], p["hy"], p["hz"]))))
    b.add("lake_safety", "PCGCreatePointsSettings", "Create Points", p["title"], (x + 320, y + 200), [
        (f, ui),
        P("coordinate_space", enum("PCGCoordinateSpace", "WORLD"), "`Coordinate Space` = **World** (default)"),
        P("cull_points_outside_volume", False, "`Cull Points Outside Volume` = **off** (default)")])
    keys.append("lake_safety")
    return keys


def near_water_roll_max(layer):
    max_m, floor = layer["near_water"]
    return max_m * 100.0 / (1.0 - floor) if floor < 1.0 else 1.0e9


# ---------------------------------------------------------------------------
# The two graphs
# ---------------------------------------------------------------------------
def build_vegetation(b, ctx):
    m, wz = ctx["meshes"], ctx["water_z"]
    shape = ctx["target_shape"]
    X0, Y0 = -1600, -900
    b.landscape((X0, 0))
    b.actors_by_tag("props", cfg.TAG_PCG_EXCLUDE, "Props To Avoid (%s)" % cfg.TAG_PCG_EXCLUDE, (X0, Y0), True)
    mx, mz = EXCLUDE_MARGIN_CM
    b.bounds("props_margin", "Props + Margin", (X0 + 320, Y0), "TRANSLATE", "Translate",
             vec(-mx, -mx, -mz), vec(mx, mx, mz), "props", "Out")
    need_road = bool(m["trees"] or m["bushes"])
    if need_road:
        b.sampler("road_pts", "Road Points", (X0, Y0 - 300), ROAD_POINTS_DENSITY, 50.0, 7)
        b.filter_const("road_only", "Road Points: Road >= %s" % fmt(ROAD_POINT_MIN_WEIGHT), (X0 + 320, Y0 - 300),
                       "Road", "GREATER_OR_EQUAL", ">=", ROAD_POINT_MIN_WEIGHT, "road_pts", "Out")
        h = ROAD_CLEAR_HALF_CM
        b.bounds("road_boxes", "Road Clearance Boxes", (X0 + 640, Y0 - 300), "SET", "Set",
                 vec(-h, -h, -500), vec(h, h, 500), "road_only", "InsideFilter")
    lake_keys = lake_nodes(b, ctx, X0, Y0 - 700) if (m["bushes"] or m["shore_scatter"]) else []

    row = 0
    if m["trees"]:
        L, y = TREES, row * 320
        x = 0
        b.sampler("t_sample", "Trees: Sample", (x, y), L["density"], L["extents_cm"], L["seed"])
        k, p = b.slope("t", "Trees", x + 320, y, L["max_slope_deg"], "t_sample", "Out")
        b.filter_const("t_water", "Trees: Above Water", (x + 960, y), "$Position.Z", "GREATER", ">",
                       wz + L["above_water_cm"], k, p)
        b.difference("t_diff", "Trees: Remove Props And Road", (x + 1280, y), "t_water", "InsideFilter",
                     ["props_margin", "road_boxes"])
        b.spatial_noise("t_forest", "Trees: Forest Mask", (x + 1600, y), "Forest", FOREST_NOISE["scale"],
                        FOREST_NOISE["contrast"], FOREST_NOISE["brightness"], FOREST_NOISE["seed"], "t_diff", "Out")
        b.roll("t_roll", "Trees: Roll", (x + 1920, y), "TreeRoll", L["forest_roll"][0], L["forest_roll"][1],
               L["seed"] + 100, "t_forest", "Out")
        b.filter_attr("t_keep", "Trees: Keep In Forest", (x + 2240, y), "Forest", "GREATER", ">", "TreeRoll",
                      "t_roll", "Out")
        half = L["spacing_m"] * 50.0
        b.bounds("t_boxes", "Trees: Spacing Boxes", (x + 2560, y), "SET", "Set", vec(-half, -half, -100),
                 vec(half, half, 100), "t_keep", "InsideFilter")
        b.add("t_prune", "PCGSelfPruningSettings", "Self Pruning", "Trees: Spacing", (x + 2880, y), [
            STRUCT("parameters", [("pruning_type", enum("PCGSelfPruningType", "LARGE_TO_SMALL")),
                                  ("randomized_pruning", True)],
                   "`Pruning Type` = **Large To Small**, `Randomized Pruning` = **on** (defaults)")])
        b.wire("t_boxes", "Out", "t_prune", "In")
        b.transform("t_xform", "Trees: Random Transform", (x + 3200, y), L, "t_prune", "Out")
        b.spawner("t_spawn", "Trees: Spawn", (x + 3520, y), m["trees"], L, "t_xform", "Out")
        row += 1
    if m["bushes"]:
        L, y = BUSHES, row * 320
        x = 0
        b.sampler("b_sample", "Bushes: Sample", (x, y), L["density"], L["extents_cm"], L["seed"])
        k, p = b.slope("b", "Bushes", x + 320, y, L["max_slope_deg"], "b_sample", "Out")
        b.filter_const("b_water", "Bushes: Above Water", (x + 960, y), "$Position.Z", "GREATER", ">",
                       wz + L["above_water_cm"], k, p)
        b.difference("b_diff", "Bushes: Remove Props And Road", (x + 1280, y), "b_water", "InsideFilter",
                     ["props_margin", "road_boxes"])
        b.distance_to_lake("b_dist", "Bushes: Distance To Lake", (x + 1600, y), L["near_water"][0] * 100.0,
                           "b_diff", "Out", lake_keys, shape)
        b.roll("b_roll", "Bushes: Roll", (x + 1920, y), "BushRoll", 0.0, near_water_roll_max(L), L["seed"] + 100,
               "b_dist", "Out")
        b.filter_attr("b_keep", "Bushes: Keep Near Water", (x + 2240, y), "WaterDist", "LESSER", "<", "BushRoll",
                      "b_roll", "Out")
        b.transform("b_xform", "Bushes: Random Transform", (x + 2560, y), L, "b_keep", "InsideFilter")
        b.spawner("b_spawn", "Bushes: Spawn", (x + 2880, y), m["bushes"], L, "b_xform", "Out")
        row += 1
    if m["scatter"]:
        L, y = SCATTER, row * 320
        x = 0
        b.sampler("g_sample", "Scatter: Sample", (x, y), L["density"], L["extents_cm"], L["seed"])
        k, p = b.slope("g", "Scatter", x + 320, y, L["max_slope_deg"], "g_sample", "Out")
        b.filter_const("g_water", "Scatter: Above Water", (x + 960, y), "$Position.Z", "GREATER", ">",
                       wz + L["above_water_cm"], k, p)
        b.filter_const("g_road", "Scatter: On Road", (x + 1280, y), "Road", "GREATER_OR_EQUAL", ">=",
                       SMALL_PLANT_MAX_ROAD, "g_water", "InsideFilter")
        b.difference("g_diff", "Scatter: Remove Props", (x + 1600, y), "g_road", "OutsideFilter", ["props_margin"])
        b.spatial_noise("g_forest", "Scatter: Forest Mask", (x + 1920, y), "Forest", FOREST_NOISE["scale"],
                        FOREST_NOISE["contrast"], FOREST_NOISE["brightness"], FOREST_NOISE["seed"], "g_diff", "Out")
        b.roll("g_roll", "Scatter: Roll", (x + 2240, y), "ScatterRoll", L["forest_roll"][0], L["forest_roll"][1],
               L["seed"] + 100, "g_forest", "Out")
        b.filter_attr("g_keep", "Scatter: Keep In Forest", (x + 2560, y), "Forest", "GREATER", ">", "ScatterRoll",
                      "g_roll", "Out")
        b.transform("g_xform", "Scatter: Random Transform", (x + 2880, y), L, "g_keep", "InsideFilter")
        b.spawner("g_spawn", "Scatter: Spawn", (x + 3200, y), m["scatter"], L, "g_xform", "Out")
        row += 1
    if m["shore_scatter"]:
        L, y = SHORE, row * 320
        x = 0
        lo, hi = L["band_cm"]
        b.sampler("r_sample", "Shore: Sample", (x, y), L["density"], L["extents_cm"], L["seed"])
        b.add("r_band", "PCGAttributeFilteringRangeSettings", "Filter Attribute Elements by Range",
              "Shore: Water Band", (x + 320, y), [
                  SEL("target_attribute", "$Position.Z", "Target Attribute"),
                  RANGE_BOUND("min_threshold", wz + lo, "Min Threshold"),
                  RANGE_BOUND("max_threshold", wz + hi, "Max Threshold")])
        b.wire("r_sample", "Out", "r_band", "In")
        b.filter_const("r_road", "Shore: On Road", (x + 640, y), "Road", "GREATER_OR_EQUAL", ">=",
                       SMALL_PLANT_MAX_ROAD, "r_band", "InsideFilter")
        b.difference("r_diff", "Shore: Remove Props", (x + 960, y), "r_road", "OutsideFilter", ["props_margin"])
        b.distance_to_lake("r_dist", "Shore: Distance To Lake", (x + 1280, y), L["near_water"][0] * 100.0,
                           "r_diff", "Out", lake_keys, shape)
        b.roll("r_roll", "Shore: Roll", (x + 1600, y), "ShoreRoll", 0.0, near_water_roll_max(L), L["seed"] + 100,
               "r_dist", "Out")
        b.filter_attr("r_keep", "Shore: Keep Near Water", (x + 1920, y), "WaterDist", "LESSER", "<", "ShoreRoll",
                      "r_roll", "Out")
        b.transform("r_xform", "Shore: Random Transform", (x + 2240, y), L, "r_keep", "InsideFilter")
        b.spawner("r_spawn", "Shore: Spawn", (x + 2560, y), m["shore_scatter"], L, "r_xform", "Out")
        row += 1


def build_grass(b, ctx):
    m, wz = ctx["meshes"], ctx["water_z"]
    X0, Y0 = -1600, -900
    b.landscape((X0, 0))
    b.actors_by_tag("props", cfg.TAG_PCG_EXCLUDE, "Props To Avoid (%s)" % cfg.TAG_PCG_EXCLUDE, (X0, Y0), True)
    mx, mz = EXCLUDE_MARGIN_CM
    b.bounds("props_margin", "Props + Margin", (X0 + 320, Y0), "TRANSLATE", "Translate",
             vec(-mx, -mx, -mz), vec(mx, mx, mz), "props", "Out")
    lake_keys = lake_nodes(b, ctx, X0, Y0 - 500) if m["grass"] else []
    row = 0
    if m["grass"]:
        L, y = GRASS, row * 320
        x = 0
        b.sampler("gr_sample", "Grass: Sample", (x, y), L["density"], L["extents_cm"], L["seed"])
        k, p = b.slope("gr", "Grass", x + 320, y, L["max_slope_deg"], "gr_sample", "Out")
        b.filter_const("gr_water", "Grass: Above Water", (x + 960, y), "$Position.Z", "GREATER", ">",
                       wz + L["above_water_cm"], k, p)
        b.filter_const("gr_road", "Grass: On Road", (x + 1280, y), "Road", "GREATER_OR_EQUAL", ">=",
                       SMALL_PLANT_MAX_ROAD, "gr_water", "InsideFilter")
        b.difference("gr_diff", "Grass: Remove Props", (x + 1600, y), "gr_road", "OutsideFilter", ["props_margin"])
        b.spatial_noise("gr_forest", "Grass: Forest Mask", (x + 1920, y), "Forest", FOREST_NOISE["scale"],
                        FOREST_NOISE["contrast"], FOREST_NOISE["brightness"], FOREST_NOISE["seed"], "gr_diff", "Out")
        b.roll("gr_froll", "Grass: Forest Roll", (x + 2240, y), "GrassRoll", 0.0, 1.0 / (1.0 - L["forest_keep"]),
               L["seed"] + 100, "gr_forest", "Out")
        b.filter_attr("gr_fkeep", "Grass: Thin In Forest", (x + 2560, y), "Forest", "LESSER", "<", "GrassRoll",
                      "gr_froll", "Out")
        b.distance_to_lake("gr_dist", "Grass: Distance To Lake", (x + 2880, y), L["near_water"][0] * 100.0,
                           "gr_fkeep", "InsideFilter", lake_keys, ctx["target_shape"])
        b.roll("gr_wroll", "Grass: Water Roll", (x + 3200, y), "WaterRoll", 0.0, near_water_roll_max(L),
               L["seed"] + 200, "gr_dist", "Out")
        b.filter_attr("gr_wkeep", "Grass: Keep Near Water", (x + 3520, y), "WaterDist", "LESSER", "<", "WaterRoll",
                      "gr_wroll", "Out")
        b.transform("gr_xform", "Grass: Random Transform", (x + 3840, y), L, "gr_wkeep", "InsideFilter")
        b.spawner("gr_spawn", "Grass: Spawn", (x + 4160, y), m["grass"], L, "gr_xform", "Out")
        row += 1
    if m["flowers"]:
        L, y = FLOWERS, row * 320
        x = 0
        pt = L["patch"]
        b.sampler("f_sample", "Flowers: Sample", (x, y), L["density"], L["extents_cm"], L["seed"])
        k, p = b.slope("f", "Flowers", x + 320, y, L["max_slope_deg"], "f_sample", "Out")
        b.filter_const("f_water", "Flowers: Above Water", (x + 960, y), "$Position.Z", "GREATER", ">",
                       wz + L["above_water_cm"], k, p)
        b.filter_const("f_road", "Flowers: On Road", (x + 1280, y), "Road", "GREATER_OR_EQUAL", ">=",
                       SMALL_PLANT_MAX_ROAD, "f_water", "InsideFilter")
        b.difference("f_diff", "Flowers: Remove Props", (x + 1600, y), "f_road", "OutsideFilter", ["props_margin"])
        b.spatial_noise("f_forest", "Flowers: Forest Mask", (x + 1920, y), "Forest", FOREST_NOISE["scale"],
                        FOREST_NOISE["contrast"], FOREST_NOISE["brightness"], FOREST_NOISE["seed"], "f_diff", "Out")
        b.filter_const("f_meadow", "Flowers: Meadow Only", (x + 2240, y), "Forest", "LESSER", "<",
                       L["meadow_max_forest"], "f_forest", "Out")
        b.spatial_noise("f_patch", "Flowers: Patches", (x + 2560, y), "Patch", pt["scale"], pt["contrast"], 0.0,
                        pt["seed"], "f_meadow", "InsideFilter")
        b.filter_const("f_inpatch", "Flowers: In Patch", (x + 2880, y), "Patch", "GREATER", ">", pt["threshold"],
                       "f_patch", "Out")
        b.transform("f_xform", "Flowers: Random Transform", (x + 3200, y), L, "f_inpatch", "InsideFilter")
        b.spawner("f_spawn", "Flowers: Spawn", (x + 3520, y), m["flowers"], L, "f_xform", "Out")
        row += 1


# ---------------------------------------------------------------------------
# Volumes, generation and the instance report
# ---------------------------------------------------------------------------
def remove_old_volumes():
    old = ow.managed(TAG_PCG)
    for a in old:
        try:
            comp = a.get_editor_property("pcg_component")
            if comp:
                comp.cleanup_local(True)
        except Exception:
            pass
    ow.remove_managed(TAG_PCG)
    others = []
    vol_cls = getattr(unreal, "PCGVolume", None)
    if vol_cls is not None:
        others = [a.get_actor_label() for a in ow.all_actors() if isinstance(a, vol_cls)]
    if others:
        ow.warn("other PCG Volumes in the level: %s. If one of them uses %s or %s, delete it, or that "
                "vegetation is spawned twice." % (", ".join(others), GRAPH_VEGETATION, GRAPH_GRASS))


def place_volume(label, graph, key, frame):
    """Spawn a PCG Volume over the landscape, set its component, assign the graph. -> (actor, comp)."""
    origin, extent = frame.actor.get_actor_bounds(True)
    half = vec(extent.x + 100.0, extent.y + 100.0, extent.z + 2000.0)
    center = vec(origin.x, origin.y, origin.z)
    manual_place = ("place it by hand: Place Actors > Volumes > PCG Volume, name it %s, Location = %s, "
                    "Rotation 0, Scale = %s (a new PCG Volume brush is 200 cm), tags %s + %s, then in its "
                    "PCG component set Graph = %s, Seed = %d, Generation Trigger = Generate On Demand, "
                    "Is Partitioned = off, Regenerate PCG Volume In Editor = %s, and click Generate"
                    % (label, fmt(center), fmt(vec(half.x / 100.0, half.y / 100.0, half.z / 100.0)),
                       cfg.TAG_MANAGED, TAG_PCG, graph.get_name() if graph else key, PCG_SEED,
                       fmt(REGENERATE_IN_EDITOR[key])))
    try:
        vol = ow.spawn(unreal.PCGVolume, center, label=label, folder=cfg.OUTLINER["pcg"],
                       tags=[TAG_PCG, "OW_PCG_" + key.capitalize()])
        vol.set_actor_scale3d(vec(1, 1, 1))
        _, base = vol.get_actor_bounds(False)
        if base.x < 1.0 or base.y < 1.0 or base.z < 1.0:
            raise RuntimeError("the spawned PCG Volume has no brush (bounds %s)" % fmt(base))
        vol.set_actor_scale3d(vec(half.x / base.x, half.y / base.y, half.z / base.z))
        vol.set_actor_location(center, False, False)
    except Exception as exc:
        manual_step(label, "%s   [%s]" % (manual_place, exc))
        return None, None
    comp = None
    try:
        comp = vol.get_editor_property("pcg_component")
    except Exception:
        try:
            comp = vol.get_component_by_class(unreal.PCGComponent)
        except Exception:
            comp = None
    if comp is None:
        manual_step(label, "select it > Details > PCG component: set Graph = %s and the values in 6.5" % key)
        return vol, None
    for prop, value, ui in (
            ("seed", int(PCG_SEED), "`Seed` = **%d**" % PCG_SEED),
            ("generation_trigger", enum("PCGComponentGenerationTrigger", "GENERATE_ON_DEMAND"),
             "`Generation Trigger` = **Generate On Demand**"),
            ("is_component_partitioned", False, "`Is Partitioned` = **off**"),
            ("regenerate_in_editor", bool(REGENERATE_IN_EDITOR[key]),
             "`Regenerate PCG Volume In Editor` = **%s**" % fmt(REGENERATE_IN_EDITOR[key]))):
        try:
            if value is None:
                raise RuntimeError("enum not found")
            comp.set_editor_property(prop, value)
        except Exception as exc:
            manual_step(label, "PCG component: set %s   [%s]" % (ui, exc))
    if graph is not None:
        try:
            comp.set_graph(graph)
        except Exception as exc:
            manual_step(label, "PCG component: set `Graph` = %s   [%s]" % (graph.get_name(), exc))
    ow.log("%s: centre %s, size %.0f x %.0f x %.0f m" % (label, fmt(center), half.x / 50.0, half.y / 50.0,
                                                          half.z / 50.0))
    return vol, comp


class InstanceReport(object):
    """Waits (editor ticks) until both volumes finished generating, then logs instances per layer."""

    def __init__(self, volumes, mesh_layer):
        self.volumes = volumes          # [(label, actor, comp)]
        self.mesh_layer = mesh_layer    # mesh path -> layer key
        self.t = 0.0
        self.next_check = 3.0
        self.handle = None
        self.last = None
        self.stable = 0

    def counts(self):
        per_layer, total = {}, 0
        for label, actor, comp in self.volumes:
            for c in actor.get_components_by_class(unreal.InstancedStaticMeshComponent) or []:
                n = c.get_instance_count()
                mesh = c.static_mesh
                layer = self.mesh_layer.get(mesh.get_path_name() if mesh else "", "other")
                per_layer[layer] = per_layer.get(layer, 0) + n
                total += n
        return per_layer, total

    def tick(self, dt):
        try:
            self.t += dt
            if self.t < self.next_check:
                return
            self.next_check = self.t + 2.0
            busy = False
            for label, actor, comp in self.volumes:
                if comp is not None and comp.get_editor_property("generation_in_progress"):
                    busy = True
            per_layer, total = self.counts()
            self.stable = self.stable + 1 if (not busy and total == self.last and total > 0) else 0
            self.last = total
            if self.stable >= 2 or self.t > REPORT_TIMEOUT_S:
                self.stop()
                self.log(per_layer, total)
        except Exception as exc:
            self.stop()
            ow.warn("instance report stopped (%s) - count instances with p8_ground_check.py (8.6)" % exc)

    def log(self, per_layer, total):
        if total == 0:
            ow.warn("PCG: no instances after %.0f s. Check the Output Log for LogPCG errors, then select a "
                    "volume and click Generate (6.6)." % self.t)
            return
        ow.log("PCG generated %d instances in total:" % total)
        for layer in ("trees", "bushes", "scatter", "shore_scatter", "grass", "flowers", "other"):
            if layer in per_layer:
                budget = BUDGET.get("shore" if layer == "shore_scatter" else layer)
                flag = "" if not budget or per_layer[layer] <= budget else "  OVER BUDGET - see 6.5 'Lower first'"
                ow.log("  %-14s %8d%s%s" % (layer, per_layer[layer],
                                           ("   (budget %d)" % budget) if budget else "", flag))
        ow.log("PCG: check the result, then File > Save All (6.3)")

    def start(self):
        old = getattr(ow, "_p6_report_handle", None)
        if old is not None:
            try:
                unreal.unregister_slate_post_tick_callback(old)
            except Exception:
                pass
        self.handle = unreal.register_slate_post_tick_callback(self.tick)
        ow._p6_report_handle = self.handle    # runtime only: lets a re-run cancel the previous report

    def stop(self):
        if self.handle is not None:
            try:
                unreal.unregister_slate_post_tick_callback(self.handle)
            except Exception:
                pass
            if getattr(ow, "_p6_report_handle", None) is self.handle:
                ow._p6_report_handle = None
            self.handle = None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ow.log("p6_pcg_vegetation: engine %s" % unreal.SystemLibrary.get_engine_version())
    if not hasattr(unreal, "PCGGraph") or not hasattr(unreal, "PCGVolume"):
        ow.error("the PCG plugin is not loaded: Edit > Plugins > search 'PCG' > tick 'Procedural Content "
                 "Generation Framework (PCG)' > Restart Now (step 1.3). Nothing was changed.")
        return
    try:
        frame = ow.frame()
    except RuntimeError as exc:
        ow.error("%s - open L_OpenWorld and finish Phase 2 first. Nothing was changed." % exc)
        return
    lake = find_lake()
    water_z, water_src = water_z_cm(frame, lake)
    mode = NEAR_WATER_SOURCE
    if mode not in ("spline", "box"):
        ow.warn("NEAR_WATER_SOURCE must be 'spline' or 'box' - using 'spline'")
        mode = "spline"
    if mode == "spline" and lake is None:
        ow.warn("no actor tagged %s (Phase 5) - using the lake-box fallback for this run. Run p5_water.py, "
                "then re-run this script." % cfg.TAG_WATER)
        mode = "box"
    try:
        box_loc, box_yaw, box_hx, box_hy = lake_box(frame, water_z)
    except Exception as exc:
        ow.warn("could not compute the lake box from OW_Layout.json (%s)" % exc)
        box_loc, box_yaw, box_hx, box_hy = frame.to_world(*cfg.LAKE_CENTER_M), 0.0, 6500.0, 4500.0
        box_loc = unreal.Vector(box_loc.x, box_loc.y, water_z)
    if mode == "box":
        safety = {"title": "Lake Box (fallback)", "loc": box_loc, "yaw": box_yaw, "hx": box_hx, "hy": box_hy,
                  "hz": 1000.0}
        target_shape = ("BOX_BOUNDS", "Box Bounds")
    else:
        c = frame.center
        safety = {"title": "Distance Safety Point", "loc": vec(c.x, c.y, water_z - 1000000.0), "yaw": 0.0,
                  "hx": 1.0, "hy": 1.0, "hz": 1.0}
        target_shape = ("CENTER", "Center")

    meshes = {}
    for slot in ("trees", "bushes", "scatter", "shore_scatter", "grass", "flowers"):
        meshes[slot] = load_meshes(slot)
        if not meshes[slot]:
            ow.warn("ASSETS['%s'] is empty or not found - its branch is skipped. Fill the slot (1.7), run 1.8, "
                    "then re-run this script." % slot)
    ctx = {"meshes": meshes, "water_z": water_z, "water_mode": mode, "safety_point": safety,
           "target_shape": target_shape}

    ow.log("water surface Z = %.0f cm (%s); near-water source = %s" % (water_z, water_src, mode))
    ow.log("height thresholds (world Z, cm): trees > %.0f, bushes/grass/scatter > %.0f, flowers > %.0f, "
           "shore band %.0f .. %.0f" % (water_z + TREES["above_water_cm"], water_z + GRASS["above_water_cm"],
                                        water_z + FLOWERS["above_water_cm"], water_z + SHORE["band_cm"][0],
                                        water_z + SHORE["band_cm"][1]))
    ow.log("lake box (fallback, 6.6): centre %s, yaw %.0f deg, half size %.0f x %.0f cm"
           % (fmt(box_loc), box_yaw, box_hx, box_hy))

    # --- graphs ---------------------------------------------------------------
    built = []
    for name, key, fn, slots in ((GRAPH_VEGETATION, "vegetation", build_vegetation,
                                  ("trees", "bushes", "scatter", "shore_scatter")),
                                 (GRAPH_GRASS, "grass", build_grass, ("grass", "flowers"))):
        if not any(meshes[s] for s in slots):
            ow.warn("%s: every slot (%s) is empty - graph and volume skipped" % (name, ", ".join(slots)))
            continue
        graph = reset_graph(name)
        b = Builder(name, graph)
        if BUILD_GRAPHS:
            fn(b, ctx)
            finish_graph(name, graph)
            ow.log("%s: %d nodes, wires %d OK, %d not checkable, %d FAILED"
                   % (name, b.count, b.ok, b.unverified, b.failed))
        else:
            ow.log("%s: BUILD_GRAPHS = False - graph left as it is" % name)
        built.append((name, key, graph))

    # --- volumes ----------------------------------------------------------------
    volumes = []
    with unreal.ScopedEditorTransaction("OW: PCG vegetation"):
        if LANDSCAPE_TAG and not ow.has_tag(frame.actor, LANDSCAPE_TAG):
            try:
                frame.actor.tags = list(frame.actor.tags) + [unreal.Name(LANDSCAPE_TAG)]
                ow.log("tagged the main landscape '%s' with %s" % (frame.actor.get_actor_label(), LANDSCAPE_TAG))
            except Exception as exc:
                manual_step("Landscape", "select it > Details > Tags > + > %s   [%s]" % (LANDSCAPE_TAG, exc))
        remove_old_volumes()
        for name, key, graph in built:
            label = VOLUME_VEGETATION if key == "vegetation" else VOLUME_GRASS
            vol, comp = place_volume(label, graph, key, frame)
            if vol is not None:
                volumes.append((label, vol, comp))

    # --- generate ---------------------------------------------------------------
    started = 0
    if GENERATE:
        for label, vol, comp in volumes:
            if comp is None:
                continue
            try:
                comp.generate_local(True)          # asynchronous: results appear over the next editor ticks
                started += 1
            except Exception as exc:
                manual_step(label, "select it > Details > PCG component > click Generate   [%s]" % exc)

    # --- spec file and report -----------------------------------------------------
    try:
        if not BUILD_GRAPHS:
            raise RuntimeError("BUILD_GRAPHS = False, the previous file is kept")
        out_dir = ow.output_dir()
        os.makedirs(out_dir, exist_ok=True)
        spec_path = os.path.join(out_dir, "OW_PCG_Graphs.txt")
        with open(spec_path, "w") as fh:
            fh.write("Phase 6 PCG graphs built by p6_pcg_vegetation.py (water Z %.0f cm, near-water source %s)\n"
                     % (water_z, mode))
            fh.write("\n".join(SPEC) + "\n")
            if MANUAL:
                fh.write("\nSTEPS TO DO BY HAND\n" + "\n".join("  %d. %s" % (i + 1, s) for i, s in enumerate(MANUAL)) + "\n")
        ow.log("wrote %s" % spec_path)
    except Exception as exc:
        ow.log("OW_PCG_Graphs.txt not written (%s)" % exc)

    if started:
        mesh_layer = {}
        for slot, lst in meshes.items():
            for mesh in lst:
                mesh_layer.setdefault(mesh.get_path_name(), slot)
        if hasattr(unreal, "register_slate_post_tick_callback"):
            try:
                InstanceReport(volumes, mesh_layer).start()
                ow.log("generation started on %d volume(s); the instance counts follow when it finishes" % started)
            except Exception as exc:
                ow.warn("could not schedule the instance report (%s) - count with p8_ground_check.py (8.6)" % exc)
        else:
            ow.log("generation started on %d volume(s)" % started)

    if MANUAL:
        ow.warn("%d step(s) need doing by hand (also listed in OW_PCG_Graphs.txt):" % len(MANUAL))
        for i, s in enumerate(MANUAL):
            ow.warn("  %d. %s" % (i + 1, s))
    ow.log("p6_pcg_vegetation done: %d graph(s), %d volume(s), generation started on %d; %d manual step(s). %s"
           % (len(built), len(volumes), started, len(MANUAL),
              "Wait for the plants, check them, then File > Save All." if started else
              "Select each volume and Ctrl-click Generate, then File > Save All."))


main()
