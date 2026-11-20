# Animated true-story pipeline. Every step reads build/$(STORY)/timeline.json.
#   make STORY=petrov-1983 voice      (then scenes, test, final, post, qc)
STORY ?= petrov-1983
PY ?= python3
P = $(PY) pipeline

.PHONY: check voice scenes test final post qc all smoke clean

check:            ## 1. validate story.json (sources, cues, pacing)
	$(P)/check_story.py $(STORY)

voice: check      ## 2. narration + timeline.json
	$(P)/voice.py $(STORY)

scenes:           ## 3. scenes.py -> scene.blend (blender -b)
	$(P)/scenes.py $(STORY)

test: scenes      ## 4. stamped test frames -> contact sheet (read it, fix the worst thing, repeat)
	$(P)/render.py $(STORY) test

final:            ## 5. full EEVEE render, resumable (re-run after a crash or Ctrl-C)
	$(P)/render.py $(STORY) final

post:             ## 6. captions + mix + mux
	$(P)/captions.py $(STORY)
	$(P)/mix.py $(STORY)

qc:               ## 6. loudness, length and loop-seam checks on final.mp4
	$(P)/qc.py $(STORY)

all: voice scenes final post qc

smoke:            ## end-to-end test without Blender or paid TTS
	$(PY) tests/smoke.py

clean:
	rm -rf build/$(STORY)
