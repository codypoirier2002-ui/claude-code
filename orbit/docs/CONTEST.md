# Orbit: Meta VR Start Developer Competition 2026 submission draft

Copy for the Devpost form, and the owner's list of what is left. Deadline:
**November 18, 2026, 12:00 PT.** The project must stay free and testable until
the winners are announced (on or around **December 11, 2026**).

Fields marked _OWNER_ need the owner's input before submitting.

## Form fields

**Project name:** Orbit

**Tagline** (140 characters at most; this one is 133):

> Callie is a Claude companion who lives in your Quest: talk hands-free, run focus sessions and timers, and work beside her in calm VR.

**Track:** Productivity. Orbit is task management and focus: timers, daily reminders,
Pomodoro focus sessions with a halfway check-in, a to-do list, notes and a morning
"Brief me", all fully usable with hands.

**Division:** New. Orbit's first commit is November 6, 2026, inside the window that
began September 24.

**Special awards it fits** (judges assign these; nothing to opt into in the rules):
Best Agentic Interaction (a voice-first spatial agent that acts with tools), and
possibly Best Reason to Come Back (greetings, daily streak, a companion who remembers you).

**Link for judges:** _OWNER_ the deployed demo URL (see "Hosting" below).

**Video:** _OWNER_ the public YouTube or Vimeo link (under 3 minutes; see `docs/VIDEO.md`).

**Target launch date:** _OWNER_ confirm. Suggested: **January 31, 2027**, on the Meta
Horizon Store as a web app (the Trusted Web Activity templates in `twa/` are ready).

## Description (500 words at most; this one is 489)

> **Inspiration.** Most AI assistants are a text box. On a headset that box floats in front of you and asks you to type. I wanted the opposite: an assistant who feels like someone in the room with you. Callie is an animated Claude companion who talks out loud, keeps your timers and focus sessions, and stands beside you while you work, under a sky that follows the clock, on a beach, or in your own room through passthrough.
>
> **What it does.** Open the link in the Quest Browser and pinch Enter VR. Callie greets you. Pinch Talk and just speak: she answers out loud, lip-syncs, and stops when you talk over her. Ask her to start a 25-minute focus session, remind you to stretch at three, add milk to your list or brief you on your day; her tools act on a workspace that lives on your headset. The status line shows which model is answering: Claude Haiku 5.5 chats, and she hands harder questions to Claude Opus 5.5 on her own. Wave and she waves back. Point at the floor and pinch, and she glides there. When a focus session ends, she cheers.
>
> Everything works with hands alone. Every button, the chat's page arrows, the on-panel keyboard and her orb answer a pinch, and tracked hands show as soft joint spheres. The panel floats 1.15 m away, just below eye level, so a seated session in a small space works, and Recenter brings it back in front of you.
>
> **How I built it.** Orbit is a Vite, TypeScript and three.js WebXR app with no framework and no backend of its own: your keys stay on your headset. three.js loads as a separate chunk once the headset reports VR support, so the 2D app opens quickly and Enter VR keeps its tap. The VR panel is a canvas texture redrawn only when something changes, and sessions ask for 90 Hz with foveation. Voice runs on ElevenLabs, because the Quest Browser has no speech recognition. Callie's art, the six panoramas and their soundscapes were generated with AI models and processed by scripts kept in the repo. Over 700 unit tests cover the engine, tools, voice, VR panel and demo server. Orbit was built with AI assistance (Claude Code). For judging, the hosted link uses a small server with a shared, capped key that tops out at Claude Opus 5.5; a key you add in Settings is used instead.
>
> **Take Claude away** and Orbit is still a place to work: seven scenes with soundscapes, Callie's presence (she waves back, follows where you point and cheers your sessions), timers, the 25-minute focus session, the to-do list, your saved notes and memories, and your daily streak. Claude is her voice and judgement, not the app.
>
> **What's next.** A Meta Horizon Store release, spatial anchors so Callie keeps her place in your room, morning and evening routines she runs with you, and more scenes.

## How hand interactions work

For the form's optional field:

> Orbit is hands-first: you never need a controller. Point your hand and pinch to press anything: every panel button, the up and down arrows that page through the chat, each key of the on-panel keyboard, and Callie's orb (pinch it to start talking, to send what you said straight away, or to interrupt her). Pinch the empty floor to move Callie there. Wave and she waves back. Your tracked hands show as soft joint spheres (hidden in passthrough, where you see your real hands). Voice is the main input: pinch Talk once and just speak. Controllers work too: trigger to press, A or X to talk, thumbstick to scroll.

### Hands-only check, action by action

How each VR action is reached by pinch, and how it was checked. "Code" means traced in
the source (`src/xr/immersive.ts`: a pinch fires `selectstart`, the same event as a
trigger, and every target below is hit by that select ray). "Emulator" means run with
emulated hands and no controller (Meta's Immersive Web Emulation Runtime). A real-Quest
pass is still on the owner's list.

| Action | By pinch | Checked |
|---|---|---|
| Enter VR (2D page) | A normal page button; Quest Browser turns a pinch into a click | Code |
| Talk / End voice | Panel button | Code |
| Send now, interrupt | Pinch the orb (its hit sphere is enlarged beside Callie); she also stops when you talk over her | Code |
| Type, and every key | Panel button, then keyboard keys | Code |
| Think harder / Stop | Panel button | Code |
| Mode switch (‹ ›) | Panel buttons | Code |
| Prompt suggestions | Panel buttons | Code |
| Aloud / Silent | Panel button | Code |
| Recenter | Panel button | Code |
| Scene | Panel button | Code |
| Exit VR | Panel button | Code |
| Scroll the chat | Up and down arrows in the chat's right gutter page by 14 rows; each answers a pinch anywhere in its half of the gutter | Code, unit tests |
| Wave | Tracked wrist joint | Code |
| Point to move Callie | Pinch on empty floor 0.6 to 4 m away | Code |

_The emulator column is filled in after the emulator pass._

## Hosting

Plan: a Vercel project (Hobby plan) with root directory `orbit/`, the environment
variable `VITE_ORBIT_DEMO=1`, and the two keys set by the owner in the Vercel dashboard
as sensitive variables. The Hobby plan is for non-commercial use; a contest entry with
nothing for sale fits that.

- `ANTHROPIC_API_KEY`: from a Claude Console workspace made for the demo, with a
  monthly spend limit of $10.
- `ELEVENLABS_API_KEY`: a key made for the demo, restricted to Text to Speech, Speech to
  Text and Voices, with a credit limit. Visitors can see the voice list of that account.

## Owner's steps before November 18, 12:00 PT

1. _OWNER_ Apply to the Meta VR Start program and register on Devpost (your plan).
2. Claude Console: make a workspace for the demo, set its monthly spend limit to $10, and
   create an API key in it. The limit is monthly: judging runs into December, so
   December gets its own $10 unless you lower it then.
3. ElevenLabs: create a key for the demo (restricted as above, with a credit limit). The
   free plan works; on it Callie speaks with the free "Laura" voice.
4. Say yes (or no) to creating the Vercel project and deploying, and which Vercel
   account to use.
5. Enter both keys in the Vercel dashboard yourself (Project → Settings → Environment
   Variables, marked sensitive), then say so. I redeploy, then check one chat turn and
   one voice turn on the live link.
6. On your Quest, with controllers put away: open the link, Enter VR, and try the
   hands-only table above. Note anything that misses.
7. Watch the video (`docs/VIDEO.md` has the shot list), then upload it to YouTube or
   Vimeo as public, or tell me to prepare it differently.
8. Fill in the Devpost form from this page: tagline, description, track (Productivity),
   division (New), link, video, hand interactions and target launch date. Submit before
   **November 18, 12:00 PT**.
9. Keep the link working and the keys funded until about December 11. If the Console
   limit runs out, Orbit shows the Claude API's error in the chat; judges can still add
   their own key in Settings.
