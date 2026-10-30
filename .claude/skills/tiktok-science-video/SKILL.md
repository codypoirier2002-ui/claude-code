---
name: tiktok-science-video
description: Plan, script, render, and check short vertical science explainer videos for TikTok. Use when the user asks for a TikTok, Reels, or Shorts science video, a script or hook for one, a rendered MP4, or a review of an existing science video for accuracy and pacing.
---

# TikTok Science Video

Turn a science topic into a short vertical video: hook, script, captions, sources, and a rendered 1080×1920 MP4. Accuracy comes first, then retention.

## Tools

- `scripts/setup.sh`: one-time. Installs local text-to-speech (Piper plus an English voice, about 65 MB) into `~/.cache/tiktok-science`. Free, offline afterward, no tokens.
- `scripts/find-asset.js`: finds and downloads reusable footage and images.
  - NASA (most reliable): `search "<query>" image|video [n]`, then `get <nasa_id> <out>`. NASA material is generally free to use, but check each item's credit and description for third-party copyrighted content, NASA logos and insignia are protected, and identifiable people need care in commercial use. `search` marks items that look like a concern with ` [check rights]`.
  - Internet Archive: `archive "<query>" [n]`, then `archive-get <identifier> <out>`. Licenses are mixed: it prints the license when the item has one. Use only public-domain or CC items and credit them.
  - Pixabay: `pixabay "<query>"` and `pixabay-get <url> <out>`. Needs a free `PIXABAY_KEY`. Not tested here.
  - Not usable from this container: Pexels (403) and Wikimedia Commons (rate-limited). Coverr and Mixkit load but have no API.
- `scripts/build.js <script.json> [out.mp4]`: renders the MP4 with ffmpeg. Narration comes from local TTS, captions appear 2–3 words at a time timed to the audio, and each beat gets an image (slow zoom), a video clip, or an animated gradient. Appends the topic to `topic-log.md`. Default output: `~/tiktok-science/out/<topic-slug>.mp4`.
- `scripts/check.js <script.json> [video.mp4]`: validates the script and, given a video, its resolution, duration, and audio track. Exits 1 on errors.
- `examples/why-ice-floats.json`: complete reference script with NASA images.

Requires `ffmpeg`/`ffprobe`, Node 18+, and Python 3 (setup only). Environment variables: `TIKTOK_SCIENCE_DIR` (project folder, default `~/tiktok-science`), `TIKTOK_CACHE_DIR` (voice cache), `TIKTOK_FONT` (caption font).

## Script file

```json
{
  "topic": "Why ice floats",
  "claim": "One sentence the viewer should remember.",
  "accent": "#ffd166",
  "music": "assets/loop.mp3",
  "beats": [
    {
      "id": "hook", "seconds": 2,
      "caption": "Headline shown at the top",
      "vo": "Spoken line. It is narrated and shown as captions.",
      "image": "assets/sea-ice.jpg"
    }
  ],
  "sources": [ { "text": "Full citation, with DOI or URL" } ],
  "credits": ["Image credit lines for the post"]
}
```

- Beat length is the longer of `seconds` and the narration plus 0.4 s, so pacing follows the voice.
- Cuts: give a beat `clips` to cut several visuals together inside it, for example `"clips": [{"video": "assets/a.mp4", "videoStart": 4}, {"image": "assets/b.jpg"}, {"video": "assets/a.mp4", "videoStart": 20, "seconds": 2}]`. Each clip takes an equal share of the beat unless it has a relative `seconds` weight. Aim for a new shot every 2–4 seconds. Cuts are hard cuts.
- Crossfades: `"transition": {"type": "fade", "seconds": 0.25}` at the top level (or on a single beat) crossfades between a beat's clips instead of hard-cutting. Types are ffmpeg `xfade` names such as `fade`, `fadeblack`, `slideleft`, `wipeleft`, `circleopen`. Transitions apply between clips inside a beat, not between beats, because each beat's narration is its own audio segment.
- Images: `imageFocus` (0 left to 1 right, default 0.5) picks which part of a landscape image stays in the vertical crop, like `videoFocus` for clips. Check where the subject sits before relying on the center crop.
- Visual per beat, in priority order: `clips` (cut together), `video` (clip, looped and cropped to 9:16; optional `videoStart` seconds and `videoFocus` 0–1 to choose which part of landscape footage stays in frame), `image` (slow zoom), otherwise an animated gradient from `bg` and `bg2`.
- `audio` replaces local TTS with your own recording. `music` is optional and mixed low under the narration (`musicVolume`, default 0.12).
- Paths are relative to the script file.

## Narration options

1. **Local Piper voice (default, free).** Omit `audio` and the builder speaks `vo` itself. Run `scripts/setup.sh` once.
2. **ElevenLabs voice (better quality, uses the user's credits).** Per beat:
   1. Call `creative_generate_speech` with `model_id` `eleven_v4`, voice `TX3LPaxmHKxFdv7VOQHJ` (Liam, energetic social-media creator), `generations_count` 1, and the beat's `vo` text. Pass the same `flow_id` for every beat.
   2. Call `creative_get_flow_run_status` with the returned session ids until `all_completed`.
   3. Download `content_url` with `curl -L -o assets/vo/<beat-id>.mp3 '<url>'`. The signed URLs expire after 2 hours.
   4. Set `"audio": "assets/vo/<beat-id>.mp3"` on the beat. Keep `vo` too, since it drives the captions.
   Cost is about 1 credit per character; the 4-beat example (about 300 characters) cost roughly 5 US cents.
   Both `creative_list_voices` and the status call return very large responses (every URL repeated). Reuse the voice id above instead of listing voices, and poll once for all sessions.

## Music and polish

- **Music:** `node scripts/find-asset.js music "Floating Cities" assets/music.mp3 60` downloads a Kevin MacLeod track (CC BY 4.0, free to use with credit) and trims it to 60 s. Set `"music": "assets/music.mp3"` in the script (`musicVolume` defaults to 0.12, about 7 dB under the voice). The builder fades it in and out. Always add the printed credit line to `credits` and to the post. Avoid very long tracks: "Fluidscape" is 30 minutes. Titles verified to download: Floating Cities, Marty Gots a Plan, Dream Culture, Local Forecast - Elevator. I have not auditioned them, so ask the user to preview the mood.
- **Punch-in:** every visual starts slightly zoomed in and settles in about 0.28 s. Script-level `"punch"` sets the amount (default 0.12, `0` turns it off). Set `"punch": false` on a single clip to skip it.
- **Loudness:** the final pass normalizes audio to about -14 LUFS, which suits TikTok. Without it, music plus voice rendered at -25 LUFS, which sounds quiet on a phone.

## Research agent (trend scout)

`agents/tiktok-trend-scout.md` defines a research-only agent. It searches vidIQ (TikTok/Reels and Shorts outliers, rising keywords), Firecrawl and web search (science news, Reddit, trend articles), Apify (TikTok hashtag scrapers, only when other sources are thin), and paper feeds. Pass `PROJECT_DIR` in its prompt; it must be the same directory as `TIKTOK_SCIENCE_DIR` (default `~/tiktok-science`), so the scout and `build.js` share one `topic-log.md`. It writes:
- `PROJECT_DIR/research/<date>-trends.md`: signals with links, breakout patterns, rising niches, and which sources failed.
- `PROJECT_DIR/topic-queue.json`: 5–10 scored ideas (hook, claim, why now, evidence, sources to cite, visuals, score out of 25, status).

In the `claude-code` repo it is already installed at `.claude/agents/tiktok-trend-scout.md`. Elsewhere, install it with `cp agents/tiktok-trend-scout.md ~/.claude/agents/`; it registers as an agent type in the next session. In a session where it is not registered yet, launch a general-purpose agent and tell it to read and follow that file. The scout lists `sources_to_cite` from memory, so open each one before scripting.

## Production cycle

Run this loop to keep the channel going. One cycle is one finished video.

1. **Research** (at most once a day): run the trend scout. Skip if `topic-queue.json` has 3+ `queued` topics from the last 7 days.
2. **Pick** the highest-scoring `queued` topic not in `topic-log.md`.
3. **Verify** each fact against a source you open yourself (`curl` the page and `grep` for the number, or one Firecrawl search). Rewrite or drop any claim you cannot confirm.
4. **Script** four beats in `PROJECT_DIR/videos/<slug>/script.json`. Keep the hook to about 6 words.
5. **Visuals**: build a contact sheet of NASA candidates (download the search thumbnails, tile them with PIL) and pick from that one image instead of guessing. Before using a pick, read its credit and description for third-party content; `search` marks suspects with `[check rights]`. For long NASA videos, make a 10-second-interval sheet, cut the useful 4–5 s segments into one small source file, and point clips at offsets in it.
6. **Narration**: ElevenLabs as above, or local Piper.
7. **Render, check, look**: run `build.js`, then `check.js` on the MP4, then sample frames (`fps=1/2,tile=9x2`). Fix burned-in labels or timestamps from source footage: move the clip window, change `imageFocus`, or crop the source file.
8. **Log and hand off**: set the queue entry's `status` to `made`, send the MP4 to the user with its sources and credits, and stop. Never post to TikTok or any platform yourself.

A cycle costs about 6–10 US cents of ElevenLabs credits, about 15 vidIQ credits per research run, and roughly 60–90k tokens, most of them from the ElevenLabs status responses.

## Token-saving rules

- Reuse existing material before generating anything: NASA media via `find-asset.js` (generally free to use; check each item's credit and description for third-party content), the user's own footage, or Wikimedia Commons (it rate-limits shared IPs, so retry later).
- Narrate with the local Piper voice by default. Use ElevenLabs when the user wants a higher-quality voice.
- To study how a successful video is structured, pull its transcript or metadata (for example vidIQ's outliers and transcript tools, if the account has credits) instead of watching or describing the video. Copy the structure and pacing, never the wording.
- Keep tool output small: list 5 results, not 50, and download only what you will use.

## Workflow

1. **Pin down the claim.** Write the one idea the viewer should remember. Park other ideas for later videos.
2. **Check the topic log.** Read `$TIKTOK_SCIENCE_DIR/topic-log.md` (default `~/tiktok-science/topic-log.md`), the same file `build.js` appends to, and skip anything already covered.
3. **Source every fact.** Each claim needs a source the user can verify: a peer-reviewed paper, a textbook, or an official agency page. Mark uncertain claims as uncertain. Do not invent statistics, quotes, or study results. Cut what you cannot source.
4. **Write the hook** for the first 2 seconds: a surprising result, a question the viewer already has, or a visual that needs explaining. No greetings or channel intros.
5. **Structure the body:** setup (the everyday observation or misconception), mechanism (one idea per beat, plain language), payoff (answer the hook and add one takeaway).
6. **End with a loop or a specific question.** Skip generic "follow for more."
7. **Gather visuals** with `find-asset.js`, one image or clip per beat where it helps the explanation. Record each credit in `credits`.
8. **Write `script.json`** and run `node scripts/check.js script.json`. Fix errors, then review warnings.
9. **Render** with `node scripts/build.js script.json` (run `scripts/setup.sh` first if narration is not set up), then run `node scripts/check.js script.json <video>` on the MP4. Extract one or two frames and look at them before handing back.
10. **Hand back** the MP4, the script, and the sources and credits. Put them in the post caption or a pinned comment.

## Format defaults

- 9:16 vertical, 1080×1920, 30 fps.
- 30–60 seconds total. Spoken hook about 2 seconds; the checker warns above 3 s rendered (the line plus the 0.4 s narration pad).
- About 2.5 spoken words per second (checker accepts 1.5–3.2).
- Captions: short lines, 4 or fewer wrapped lines per beat, burned in because many viewers watch muted.
- Plain language. Define each technical term the first time it appears.

## Review checklist

When asked to review an existing script or video, check in this order and report a numbered list, most important first, each with a fix:

1. Is every factual claim correct and sourced? Flag overstatements such as "proves" for "suggests," and missing caveats.
2. Does the hook land in 2 seconds?
3. Is there one main idea?
4. Is the mechanism explained in the order a viewer needs it?
5. Does the ending pay off the hook?
6. Do length, word rate, and captions pass `check.js`?
7. Are technical terms defined?

## Things to avoid

- Medical, nutrition, or safety advice presented as settled without a source and a "talk to a professional" caveat where it matters.
- Clickbait hooks the video does not deliver on.
- Trivia lists with no mechanism.
- Music, footage, or images without rights. Use original assets or ones whose license you have checked (for NASA items, read the credit and description for third-party content, protected logos and insignia, and identifiable people), and keep the credits.
- Real people quoted without a verified source.
