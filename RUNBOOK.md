# TikTok science pipeline: state branch

This branch holds the pipeline's durable state. It is never merged into `main`.

- `topic-log.md`: one line per finished video (date | topic | claim | file). Never make a topic that is already here.
- `topic-queue.json`: scored ideas from the trend scout. `status` is `queued` or `made`.
- `research/<date>-trends.md`: one report per research run.
- `videos/<slug>/script.json`: the script of each finished video (media is not stored; the MP4 is sent to the owner).

## One scheduled run = one video

1. **Skill**: in the `claude-code` checkout, use `.claude/skills/tiktok-science-video/` (if it is missing on `main`, `git fetch origin claude/tiktok-science-video-skill && git checkout claude/tiktok-science-video-skill`). Read `SKILL.md`, especially "Production cycle".
2. **State**: `git fetch origin tiktok-science-state && git worktree add /tmp/tiktok-state origin/tiktok-science-state && cd /tmp/tiktok-state && git checkout -B tiktok-science-state`. Export `TIKTOK_SCIENCE_DIR=/tmp/tiktok-state`.
3. **Research** only if `topic-queue.json` has fewer than 3 `queued` entries added in the last 7 days, or the newest `research/` report is older than 24 hours. At most one research run per day; keep vidIQ under about 20 credits.
4. **Make** the highest-scoring `queued` topic not in `topic-log.md`: verify every fact by opening its source, write `videos/<slug>/script.json`, gather NASA assets with `scripts/find-asset.js`, narrate with ElevenLabs (voice id in `SKILL.md`, one generation per beat) or local Piper if ElevenLabs is unavailable, render with `scripts/build.js`, run `scripts/check.js` on the script and the MP4, sample frames and fix burned-in labels or bad crops.
5. **Deliver**: send the MP4 to the owner (SendUserFile, status `proactive`) with a caption that lists sources and credits. Never post to TikTok or any platform.
6. **Save state**: set the queue entry to `"status": "made"`, make sure `build.js` logged the topic, then commit `topic-log.md`, `topic-queue.json`, `research/`, `videos/<slug>/script.json` (no media) and `git push origin tiktok-science-state`. Never commit or push to `main` or any other branch.
7. **Stop** after one video. If something blocks the run (no credits, missing ffmpeg/node, push rejected), send the owner a short message saying what is blocked and stop.

Budget per run: about 10 US cents of ElevenLabs credits and 60–90k tokens. Research adds about 15 vidIQ credits.
