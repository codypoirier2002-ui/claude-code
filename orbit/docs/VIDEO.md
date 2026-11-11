# Orbit: the contest video

2:04, 1280×720 at 30 fps, H.264 with AAC stereo audio, 12.3 MB. Real footage of the live
demo (https://orbit-demo-lake.vercel.app) running in Meta's Immersive Web Emulation
Runtime (IWER 2.8.0), emulating a Meta Quest 3 in hand mode. No controller is connected
at any point: every press is an emulated pinch, aimed with the hand's real target ray.
Recorded on 2026-11-11 with `scripts/emulator/record.mjs`.

In this take, ElevenLabs transcribed the spoken request word for word, and Claude Haiku
5.5 answered it. Haiku called its focus-session tool: the 25-minute timer ("Writing my
essay") shows in the status strip while she speaks. The follow-up chip ("Thanks, I'll
keep writing") got a real spoken reply too. Nothing was re-recorded or staged; one
17-second part was cut (see below).

What is real, and what is not:

- Everything in the frame is the app running: the 2D page, the VR session, Callie, the
  panel, the scenes, her replies (Claude Haiku 5.5 through the demo server) and her
  voice (ElevenLabs). The audio is the page's own output: her voice and the scene
  soundscapes.
- The emulator stands in for the headset, so head and hand motion are scripted.
- The spoken request ("Hey Callie, start a 25-minute focus session…") is a recording
  made with Windows' built-in speech synthesizer and played into the emulator's
  microphone, because the owner does not record their own voice. The caption says so.
- Captions are drawn into the recording. Nothing in the video is AI-generated video.

The file is not in git (it is large): the owner got it directly on 2026-11-11. A dry run
without the voice and reply shots is `record.mjs --dry`.

## Shot list

Timings are from the delivered file. A new take runs a few seconds either way, depending
on how fast Callie answers.

| # | At | What happens | Caption |
|---|---|---|---|
| 1 | 0:00–0:11 | The 2D app on the live link: Callie's greeting card, modes, timers and to-dos | "Orbit: Callie, a Claude companion for Meta Quest" / "Real footage · the live demo in Meta's Immersive Web Emulator (Quest 3) · hands only"; then "Open the link in the Quest Browser, then Enter VR" |
| 2 | 0:11–0:16 | Enter VR: the clock sky; Callie's hologram greets you out loud | "Callie greets you when you arrive" / "Everything here is done by pinching: no controller" |
| 3 | 0:16–1:01 | A pinch on Talk; the spoken request (0:24); she answers out loud with lip-sync (0:39) and starts a 25-minute focus timer, shown in the status strip (0:55); a pinch on End voice | "Pinch Talk and just speak"; the request in quotes / "A spoken request played into the emulator's microphone"; "She answers out loud, and starts the timer with her tools"; "The focus timer runs in the status strip" |
| 4 | 1:01–1:25 | A pinch on one of her suggested follow-ups; she replies out loud | "Or pinch one of her suggested follow-ups" |
| 5 | 1:25–1:37 | Scene, twice: a beach, then a lake, each with its soundscape | "Seven scenes, each with its own soundscape" |
| 6 | 1:37–1:49 | A pinch on empty floor: she glides there | "Point at the floor and pinch: she glides there" |
| 7 | 1:49–1:57 | A wave: she cheers back | "Wave, and she waves back" |
| 8 | 1:57–2:04 | End card over the scene | "Orbit · orbit-demo-lake.vercel.app" / "Built with Claude Code · runs Claude Haiku 5.5 and Claude Opus 5.5 · keys stay on your headset" |

The one cut: the take had a paging shot between 4 and 5 (17 seconds of pinching the
chat's arrows). The conversation was still only half a panel tall, so the arrows had
nothing to page and nothing moved. That stretch was cut from both picture and sound at
the caption changes (with an 80 ms audio crossfade), and `record.mjs` no longer records
it. Paging is checked in the hands-only pass instead (`docs/CONTEST.md`).

## Upload (the owner)

Upload to YouTube (or Vimeo) as **Public**, then paste the link into the Devpost form.

- Title: Orbit: Callie, a Claude companion for Meta Quest (Meta VR Start 2026)
- Description: Real footage of Orbit's live demo running in Meta's Immersive Web
  Emulator (Quest 3, hand tracking, no controller). Callie is an animated Claude
  companion: talk to her hands-free, run focus sessions and timers, and work beside her
  in seven calm VR scenes. Try it: https://orbit-demo-lake.vercel.app. The spoken
  request in the video was synthesized and played into the emulator's microphone.
