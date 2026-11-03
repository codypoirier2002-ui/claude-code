# Iterations

One entry per contact sheet: what was wrong, what changed.

## Sheet 001 (2026-11-03 19:11)

- sheet: `build/petrov-1983/contact/sheet_001.png` (28 frames, 6x5)
- frames: 0, 3, 56, 71, 110, 117, 163, 291, 413, 465, 472, 498, 518, 548, 572, 671, 678, 790, 878, 901, 908, 950, 1015, 1122, 1129, 1176, 1223, 1226
- engine: Cycles 16 spp at 40% (no GPU for EEVEE in the build container)
- worst thing now: **broken** - cue-gated elements on screen before their cues (0472: "5",
  missile dots and LAUNCH before the alarm). Root cause: Blender ignores the interpolation
  preference for Python-inserted keys, so CONSTANT keys were BEZIER; and set visibility
  overrode per-object visibility. Also broken: glint planet blown white (atmosphere at a
  grazing angle everywhere), airliner icon and hit ring left as black shapes after fading,
  orbit Earth washed into a glowing snowball.

## Sheet 002 (2026-11-03 19:17)

- sheet: `build/petrov-1983/contact/sheet_002.png` (28 frames, 6x5)
- frames: 0, 3, 56, 71, 110, 117, 163, 291, 413, 465, 472, 498, 518, 548, 572, 671, 678, 790, 878, 901, 908, 950, 1015, 1122, 1129, 1176, 1223, 1226
- changed since last sheet: lib.key writes interpolation onto each key; show_during() ranges
  intersect set visibility; airliner/ring/"1998" hidden outside their moments; atmospheres
  thinned (orbit 3.0 -> 1.1, glint 4.0 -> 0.5); tests/blender_check.py guards all of it.
- verified: alarm sequence now plays in order (dark -> LAUNCH -> "1" + one dot -> "5" +
  four staggered dots); glint planet readable; no leftovers after the airliner hit.
- worst thing now: **off-story / unreadable** - Petrov close-up (0678-0901) is cropped
  through the cap and the figure reads as a chess pawn with no face; it doesn't say "a man
  deciding". Next: pull the camera back with headroom, give the head a nose so the profile
  reads.

## Sheet 003 (2026-11-03 19:18)

- sheet: `build/petrov-1983/contact/sheet_003.png` (5 frames, 5x1)
- frames: 678, 752, 827, 878, 901
- changed since last sheet: camera pulled back to head-and-shoulders (55 mm at 1.5 m -> 50 mm at
  2.5 m), nose and chin added so the profile faces the screen light.
- verified: profile reads; red siren -> fade -> teal on "None arrives" lands on its word.
- worst thing now: **unreadable** - forearms reach for a desk that is not in this set and float
  across the lower frame as two big tubes; cap top overhangs the back of the head.

## Sheet 004 (2026-11-03 19:19)

- sheet: `build/petrov-1983/contact/sheet_004.png` (4 frames, 4x1)
- frames: 678, 790, 878, 901
- changed since last sheet: no forearms in the close-up (no desk in that set); cap top centred.
- verified: clean silhouette in profile; the decision beat reads in colour alone.
- worst thing now: **hook** (0000-0113, the first 2 s) - night Earth reads as orange camouflage:
  the city-light mask covers nearly all land. Want sparse lights on a dark planet.

## Sheet 005 (2026-11-03 19:20)

- sheet: `build/petrov-1983/contact/sheet_005.png` (5 frames, 5x1)
- frames: 3, 71, 110, 1129, 1223
- changed since last sheet: city-light threshold 0.62-0.70 -> 0.70-0.74, strength 4 -> 6, land
  darker.
- verified: dark planet with scattered lights; the launch flare and trail are the brightest
  thing in the hook; outro lands back on the opening composition (1223 vs 0003).
- worst thing now: nothing broken or off-story left on the per-shot sheets. Next: one full pass
  for the record.

## Sheet 006 (2026-11-03 19:23)

- sheet: `build/petrov-1983/contact/sheet_006.png` (22 frames, 6x4)
- frames: 0, 3, 71, 110, 117, 163, 413, 465, 472, 498, 518, 548, 671, 678, 878, 901, 908, 950, 1122, 1129, 1223, 1226
- full pass, 2 frames per shot plus cues and the loop seam.
- verified: every shot reads; cues land on their words; 0000/0003 match 1223/1226.
- worst thing now: **unreadable at phone size** - at 0671 the screen camera has pushed in and
  the "5" count is cut by the right edge. Count moved inboard (x 2.3 -> 1.75).

## Sheet 007 (2026-11-03 19:24)

- sheet: `build/petrov-1983/contact/sheet_007.png` (5 frames, 5x1)
- frames: 472, 498, 518, 548, 671
- changed since last sheet: count moved inboard.
- verified: "5" fully in frame at 0671.
- worst thing now: nothing broken, off-story or unreadable on the sheets. Remaining items are
  polish: the "USSR" label sits under the stamp at the top edge of the screen shot, and the
  officer is deliberately toy-like. Next real check: an EEVEE test pass on a machine with a
  GPU, since these sheets were rendered with Cycles.
