# Orbit: the contest video

1:52, 1280×720 at 30 fps, H.264 with AAC stereo audio, 11.5 MB, no cuts. Real footage of
the live demo (https://orbit-demo-lake.vercel.app) running in Meta's Immersive Web
Emulation Runtime (IWER 2.8.0), emulating a Meta Quest 3 in hand mode. No controller is
connected at any point: every press is an emulated pinch, aimed with the hand's real
target ray. Recorded on 2026-11-11 with `scripts/emulator/record.mjs` (the fifth take).

In this take, ElevenLabs transcribed the spoken request word for word ("Hey Callie, start
a 25-minute focus session. I'm writing my essay"), and Claude Haiku 5.5 answered it. Haiku
called its focus-session tool: the 25-minute timer ("Writing my essay") shows in the
status strip while she answers out loud. A pinch on one of her suggested follow-ups
("Thanks, I'll get started now") got a real reply, shown on the panel.

What is real, and what is not:

- Everything in the frame is the app running: the 2D page, the VR session, Callie, the
  panel, the scenes, her replies (Claude Haiku 5.5 through the demo server) and her
  voice (ElevenLabs). Apart from the request (next point), the sound is the page's own
  output: her voice and the scene soundscapes.
- The emulator stands in for the headset, so head and hand motion are scripted.
- The spoken request is a recording made with Windows' built-in speech synthesizer,
  because the owner does not record their own voice. The recording script played it
  into the page's microphone (a stream the script controls, standing in for the
  headset's mic), and the same recording is mixed into the soundtrack at the moment it
  was played, so viewers hear what Callie heard. The caption says it was played into
  the emulator's microphone.
- Before recording started (not in the video), the script visited each scene once and
  used up her first-Talk greeting with one Talk and End voice. The first keeps the
  emulator's audio from stalling while a scene loads; the second keeps the request from
  talking over her greeting. On a headset, your first Talk of a visit starts with her
  saying hi.
- The soundtrack had one loudness pass (-20 LUFS). Captions are drawn into the
  recording. Nothing in the video is AI-generated video.

The file is not in git (it is large): the owner got it directly on 2026-11-11, as
`orbit-meta-vr-start-2026-final.mp4`. A dry run without the voice and reply shots is
`record.mjs --dry`.

## Shot list

Timings are from the delivered file. A new take runs a few seconds either way, depending
on how fast Callie answers.

| # | At | What happens | Caption |
|---|---|---|---|
| 1 | 0:00–0:14 | The 2D app on the live link: Callie's greeting card, modes, timers and to-dos | "Orbit: Callie, a Claude companion for Meta Quest" / "Real footage · the live demo in Meta's Immersive Web Emulator (Quest 3) · hands only"; then (0:07) "Open the link in the Quest Browser, then Enter VR" |
| 2 | 0:14–0:19 | Enter VR: the clock sky at dusk; Callie's hologram and her welcome on the panel | "Callie greets you when you arrive" / "Everything here is done by pinching: no controller" |
| 3 | 0:19–0:57 | A pinch on Talk; the spoken request (heard 0:27–0:33); "Got it…"; she answers out loud with lip-sync (0:40–0:50) and starts a 25-minute focus timer, shown in the status strip; a pinch on End voice (0:55) | "Pinch Talk and just speak"; (0:25) the request in quotes / "A spoken request played into the emulator's microphone"; (0:35) "She answers out loud, and starts the timer with her tools"; (0:52) "The focus timer runs in the status strip" |
| 4 | 0:57–1:06 | A pinch on one of her suggested follow-ups; her reply appears on the panel (replies to a pinched suggestion are spoken only with Aloud on) | "Or pinch one of her suggested follow-ups" |
| 5 | 1:06–1:35 | Scene, twice: a beach (1:08), then a lake (1:20), each with its soundscape | "Seven scenes, each with its own soundscape" |
| 6 | 1:35–1:41 | A pinch on empty floor: she glides there | "Point at the floor and pinch: she glides there" |
| 7 | 1:41–1:47 | A wave: she cheers back | "Wave, and she waves back" |
| 8 | 1:47–1:52 | End card over the scene | "Orbit · orbit-demo-lake.vercel.app" / "Built with Claude Code · runs Claude Haiku 5.5 and Claude Opus 5.5 · your own keys stay on your headset" |

There is no paging shot: at that point the conversation is about half a panel tall, so
the chat's arrows have nothing to page. Paging is checked in the hands-only pass instead
(`docs/CONTEST.md`).

## Earlier takes (discarded)

- Take 1: the emulator's audio clock stalled while scenes loaded, and the assembly packed
  the remaining sound together, so it ran up to 9 s ahead of the picture and the beach
  was nearly silent. Its paging shot showed nothing (cut). The 2:04 file that went to the
  owner first is this take, and was replaced.
- Take 2: the same drift (19.5 s by the end, the lake silent); Chrome's file-backed fake
  microphone also took 10 s to open, so the captions, then run on timers, got ahead of
  her.
- Take 3: the recorder sent every video frame to the script on its own, which backed up
  the script's own calls: the Talk pinch landed 30 s late, the request talked over her
  greeting, and only "I'm writing my" was heard.
- Take 4: End voice landed 1.5 s after the session had already timed out on silence, so
  it started a new session for a moment.

`scripts/emulator/README.md` has what changed for each.

## Upload (the owner)

Upload to YouTube (or Vimeo) as **Public**, then paste the link into the Devpost form.

- Title: Orbit: Callie, a Claude companion for Meta Quest (Meta VR Start 2026)
- Description: Real footage of Orbit's live demo running in Meta's Immersive Web
  Emulator (Quest 3, hand tracking, no controller). Callie is an animated Claude
  companion: talk to her hands-free, run focus sessions and timers, and work beside her
  in seven calm VR scenes. Try it: https://orbit-demo-lake.vercel.app. The spoken
  request in the video was synthesized and played into the emulator's microphone.
