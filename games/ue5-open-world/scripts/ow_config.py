"""Shared settings for every script in this folder.

Edit values here, not inside the individual scripts. This file never imports
`unreal`, so the heightmap generator can also use it from plain Python.

Coordinate convention used everywhere ("layout metres"):
  * Origin = centre of the landscape, in metres.
  * +X and +Y are Unreal's world X and Y (X = red arrow, Y = green arrow).
  * Heights are metres above the landscape actor's Z location.
The Unreal-side scripts convert layout metres to world centimetres by reading
the landscape actor's bounds, so it does not matter where you placed it.
"""

# ---------------------------------------------------------------------------
# Content Browser paths (created on demand by the scripts)
# ---------------------------------------------------------------------------
CONTENT_ROOT = "/Game/OpenWorld"
MAPS_DIR = CONTENT_ROOT + "/Maps"
MAP_NAME = "L_OpenWorld"
MATERIALS_DIR = CONTENT_ROOT + "/Materials"
LANDSCAPE_LAYERS_DIR = CONTENT_ROOT + "/Landscape/Layers"
PCG_DIR = CONTENT_ROOT + "/PCG"
BLUEPRINTS_DIR = CONTENT_ROOT + "/Blueprints"
WATER_DIR = CONTENT_ROOT + "/Water"

LANDSCAPE_MATERIAL_NAME = "M_OW_Landscape"
LANDSCAPE_MATERIAL_INSTANCE_NAME = "MI_OW_Landscape"

# Paint layers of the landscape material, in blend order. "Auto" is the
# slope/height auto-blend; the others are manual overrides you paint on top.
LANDSCAPE_LAYERS = ["Auto", "Grass", "Dirt", "Rock", "Road"]

# ---------------------------------------------------------------------------
# Actor tags and World Outliner folders (scripts find their actors by tag so
# re-running a script replaces its own actors instead of duplicating them)
# ---------------------------------------------------------------------------
TAG_MANAGED = "OW_Managed"            # every actor a script spawns
TAG_LIGHTING = "OW_Lighting"
TAG_WATER = "OW_Water"                # the lake; PCG reads its spline by this tag
TAG_PCG_EXCLUDE = "OW_PCGExclude"     # PCG removes vegetation inside these actors' bounds
TAG_PROP = "OW_Prop"
TAG_GROUND_CHECK = "OW_GroundCheck"   # ground_check.py inspects actors with this tag
TAG_BOUNDARY = "OW_Boundary"
TAG_MOUNTAIN = "OW_Mountain"

OUTLINER = {
    "lighting": "OpenWorld/Lighting",
    "water": "OpenWorld/Water",
    "pcg": "OpenWorld/PCG",
    "props": "OpenWorld/Props",
    "fence": "OpenWorld/Props/Fence",
    "boulders": "OpenWorld/Props/Boulders",
    "mountains": "OpenWorld/Backdrop",
    "boundary": "OpenWorld/Boundary",
    "player": "OpenWorld/Player",
}

# ---------------------------------------------------------------------------
# Landscape geometry. Enter exactly these numbers in
# Landscape Mode > Manage > New > Import from File.
#   Section Size 63x63 quads, Sections Per Component 2x2, 4x4 components
#   -> 505 x 505 vertices -> 504 m x 504 m at 100 cm per quad.
# ---------------------------------------------------------------------------
LANDSCAPE_RESOLUTION = 505            # vertices per side (heightmap pixels per side)
LANDSCAPE_SCALE_XY_CM = 100.0         # landscape actor scale X and Y
LANDSCAPE_SCALE_Z = 100.0             # landscape actor scale Z
LANDSCAPE_SECTION_QUADS = 63
LANDSCAPE_SECTIONS_PER_COMPONENT = 2  # means 2x2
LANDSCAPE_COMPONENTS = 4              # means 4x4
LANDSCAPE_SIZE_M = (LANDSCAPE_RESOLUTION - 1) * LANDSCAPE_SCALE_XY_CM / 100.0
HALF_SIZE_M = LANDSCAPE_SIZE_M / 2.0

# ---------------------------------------------------------------------------
# World layout (layout metres). The heightmap generator sculpts the terrain
# around these, and writes OW_Layout.json for the Unreal-side scripts.
# ---------------------------------------------------------------------------
SEED = 1337

BASE_HEIGHT_M = 22.0                  # average meadow height
HILL_AMPLITUDE_M = 12.0               # rolling hills, +/-
HILL_WAVELENGTH_M = 170.0             # size of the largest hills
GLOBAL_TILT_M = 9.0                   # terrain falls this much from the spawn side to the lake side

WATER_LEVEL_M = 10.0                  # lake surface height
LAKE_CENTER_M = (55.0, -35.0)
LAKE_RADII_M = (60.0, 40.0)           # ellipse semi-axes before shoreline noise
LAKE_ROTATION_DEG = 15.0
LAKE_MAX_DEPTH_M = 5.5
LAKE_SHORE_SLOPE = 0.04               # minimum rise per metre right at the water (4 %)
LAKE_SHORE_BLEND_M = 95.0             # the lake sits in a concave bowl this wide, so the water is visible from above
LAKE_SPLINE_POINTS = 24               # spline points written for the Water Body Lake
LAKE_SPLINE_OUTSET_M = 2.0            # spline sits this far outside the shoreline so water meets the bank

# Dirt road: Catmull-Rom curve through these points (layout metres).
ROAD_CONTROL_POINTS_M = [
    (-262.0, 192.0),   # starts just past the landscape edge so it runs off over the rim
    (-212.0, 160.0),
    (-160.0, 118.0),
    (-110.0, 80.0),
    (-62.0, 54.0),
    (-15.0, 42.0),
    (30.0, 42.0),      # passes south of the lake
    (70.0, 38.0),
    (90.0, 32.0),      # ends in the cabin clearing on the south-east shore
]
ROAD_HALF_WIDTH_M = 2.1               # 4.2 m wide track
ROAD_SHOULDER_M = 5.0                 # terrain blends back to natural over this distance
ROAD_MAX_GRADE = 0.10                 # 10 % max slope along the road
ROAD_SINK_M = 0.12                    # road surface sits slightly below its shoulders

CABIN_CENTER_M = (100.0, 24.0)
CABIN_PAD_HALF_M = 10.0               # flattened clearing, half size
CABIN_YAW_DEG = None                  # None = face the lake

PLAYER_SPAWN_ROAD_FRACTION = 0.62     # 0 = road start, 1 = road end

# Raised rim along the landscape border so the edge is never visible.
EDGE_BERM_HEIGHT_M = 30.0
EDGE_BERM_WIDTH_M = 75.0
PLAYABLE_INSET_M = 45.0               # invisible walls this far inside the edge

# Fence and roadside boulders (placed by place_props.py along the road).
FENCE_ROAD_RANGE = (0.55, 0.94)       # fraction of the road that gets a fence
FENCE_SIDE = 1                        # +1 = the +Y side when the road runs along +X (away from the lake), -1 = other side
FENCE_OFFSET_M = 1.6                  # from road edge
BOULDER_COUNT = 16
BOULDER_OFFSET_RANGE_M = (1.5, 6.0)   # from road edge

# Distant mountain ring (place_props.py, Option A: scaled rock meshes).
MOUNTAIN_RING_RADIUS_M = (420.0, 650.0)
MOUNTAIN_COUNT = 22
MOUNTAIN_SCALE_RANGE = (18.0, 34.0)
MOUNTAIN_BASE_HEIGHT_M = -25.0        # sink the mountain meshes so their bases are hidden

# ---------------------------------------------------------------------------
# Files written by tools/generate_heightmap.py. Leave OUTPUT_DIR empty to use
# <ProjectFolder>/Saved/OpenWorld when run inside Unreal, or ../output next to
# this folder when run from a normal Python install.
# ---------------------------------------------------------------------------
OUTPUT_DIR = ""
HEIGHTMAP_FILE = "OW_Height_505.png"
HEIGHTMAP_RAW_FILE = "OW_Height_505.r16"
WEIGHT_FILES = {"Auto": "OW_Weight_Auto_505.png", "Road": "OW_Weight_Road_505.png"}
BACKDROP_HEIGHTMAP_FILE = "OW_Backdrop_Height_505.png"
PREVIEW_FILE = "OW_Preview.png"
LAYOUT_FILE = "OW_Layout.json"

# Backdrop landscape (Option B for the distant mountains): a second, coarse
# landscape around the main one. 505 x 505 at 1000 cm per quad = 5.04 km.
BACKDROP_SCALE_XY_CM = 1000.0
BACKDROP_SCALE_Z = 300.0
BACKDROP_PEAK_M = 520.0

# ---------------------------------------------------------------------------
# Asset paths. Fill these in after you add assets from Fab (right-click the
# asset in the Content Browser > Copy Reference, then paste the part in quotes,
# e.g. "/Game/Fab/Megascans/3D/Rock_abc123/High/SM_Rock_abc123").
# Scripts skip empty entries and fall back to Engine basic shapes so you can
# test the layout before downloading anything.
# ---------------------------------------------------------------------------
ASSETS = {
    "trees": [],          # 3-6 tree meshes (Nanite foliage-ready Megascans trees work best)
    "bushes": [],         # 2-4 shrubs for forest edges and lake shore
    "grass": [],          # 2-5 grass clump meshes
    "flowers": [],        # optional wildflowers mixed into the grass
    "scatter": [],        # small rocks, pebbles, twigs, pine cones, debris
    "shore_scatter": [],  # reeds / pebbles for the lake edge
    "boulders": [],       # 3-6 medium/large rocks for the roadside
    "cabin": "",          # one cabin mesh or Blueprint
    "fence": "",          # one fence segment mesh, modelled along +X
    "mountains": [],      # 3-6 large cliff/rock meshes scaled up as distant mountains
}

FALLBACK_MESHES = {
    "trees": "/Engine/BasicShapes/Cone",
    "bushes": "/Engine/BasicShapes/Sphere",
    "boulders": "/Engine/BasicShapes/Sphere",
    "cabin": "/Engine/BasicShapes/Cube",
    "fence": "/Engine/BasicShapes/Cube",
    "mountains": "/Engine/BasicShapes/Cone",
}

FENCE_SEGMENT_LENGTH_M = 2.5          # length of one fence mesh along its +X axis
