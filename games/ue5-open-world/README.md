# UE5 open-world demo: build plan and editor scripts

A step-by-step plan, plus the Python editor scripts it uses, for building a small, realistic open world in Unreal Engine 5.6, 5.7 or 5.8. You end with a 500 × 500 m valley you can walk around: rolling hills, a calm lake, a dirt road, a cabin, a fence line, boulders, a PCG-placed forest and meadow, distant mountains, and a late-afternoon sun lit with Lumen, Nanite and virtual shadow maps.

**Start here: [BUILD_PLAN.md](BUILD_PLAN.md).**

![Generated layout](docs/layout_preview.png)

## What's in the folder

| Path | What it is | Used in |
|---|---|---|
| `BUILD_PLAN.md` | the plan: nine phases, numbered steps, ⚡ performance flags, final checklist | everything |
| `tools/generate_heightmap.py` | writes the heightmap, Auto/Road weightmaps, backdrop mountains, a preview map and `OW_Layout.json`. Plain Python, no packages | 2.1 |
| `scripts/ow_config.py` | every shared setting: content paths, layer names, tags, layout, asset slots | all scripts |
| `scripts/ow_common.py` | helpers imported by the scripts (landscape frame, ground traces, tagged spawning) | all scripts |
| `scripts/p1_check_project.py` | reports plugins, rendering settings and asset slots; creates the content folders | 1.5 |
| `scripts/p1_configure_assets.py` | batch Nanite, collision and material flags for downloaded assets | 1.8 |
| `scripts/p2_verify_landscape.py` | checks the imported landscape's position, orientation and height scale | 2.3 |
| `scripts/p3_landscape_material.py` | builds `M_OW_Landscape` (slope/height auto-blend + paint layers) and its instance | 3.2 |
| `scripts/p4_lighting.py` | sun, sky atmosphere, sky light, clouds, height fog, post process | 4.1 |
| `scripts/p5_water.py` | Water Body Lake on the generated basin, calm settings, water zone | 5.2 |
| `scripts/p6_pcg_vegetation.py` | builds the PCG graphs and volumes for trees, bushes, grass, flowers, scatter, reeds | 6.3 |
| `scripts/p7_props.py` | cabin, fence, boulders, distant mountain ring | 7.2 |
| `scripts/p8_player_setup.py` | Player Start, invisible walls, Kill Z, sprint input action | 8.2 |
| `scripts/p8_ground_check.py` | finds floating or buried props and vegetation, optional fix | 8.6 |
| `scripts/p9_quality.py` | Performance / Balanced / Cinematic presets | 9.3 |

## How the scripts were checked

They have not been run inside a real Unreal Editor. They were checked in three ways:

1. Every `unreal.*` name was checked against the UE 5.6 Python API.
2. Every PCG and Water name was checked against the UE 5.6.1 plugin source.
3. Each script was run end to end against a simulated editor: a landscape built from the generated heightmap, actor spawning, ground traces, and PCG pin labels taken from engine source.

Where a script cannot do something, it prints the exact manual step instead of failing. Anything that could not be confirmed for every engine version is flagged ❓ in the plan.
