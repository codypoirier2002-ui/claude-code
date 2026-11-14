// The contest video: real footage of the live demo in Meta's Immersive Web
// Emulator (IWER, Quest 3 profile, hand mode, no controller), with captions.
//   node record.mjs <url> <outDir> [--dry]  (--dry: no voice or AI shots, for timing)
// The voice shot follows the app (her voice starting and stopping, the request
// reaching the chat), not a stopwatch, and the take stops early if the request
// never arrives, so a failed take spends little.
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { BTN, aimAt, launch, measureRig, panelAt, pinchAt, rayOf, remote, settings, sleep } from "./xr.mjs";
import { recorderInit, sinkTo, startScreencast, writeConcat } from "./recorder.mjs";

const url = process.argv[2] ?? "https://orbit-demo-lake.vercel.app/";
const out = process.argv[3];
const dry = process.argv.includes("--dry");
// A WAV of the spoken request, said into the page's microphone (see README.md).
const ASK = process.env.ORBIT_ASK_WAV ?? "";
if (!ASK && !dry) throw new Error("Set ORBIT_ASK_WAV, or pass --dry.");
const FOVY = 1.32;
/** Orbit's scene count: the Scene button cycles through them. */
const SCENES = 7;
fs.mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const { browser, page } = await launch({ url, extraInit: recorderInit });
page.on("console", (m) => /error|failed/i.test(m.text()) && log("page:", m.text().slice(0, 160)));
const bytes = await sinkTo(page, `${out}/vr.h264`, `${out}/vr-audio.webm`);
if (ASK) await page.exposeFunction("__askWav", () => fs.readFileSync(ASK).toString("base64"));
const abort = async (why) => {
  log("ABORT:", why);
  await browser.close();
  process.exit(1);
};

// The Everyday thread as stored: what was said to her, and her text replies.
const thread = () =>
  page.evaluate(() => {
    const t = JSON.parse(localStorage.getItem("orbit:threads") || "{}").everyday ?? { history: [] };
    const text = (m) =>
      typeof m.content === "string" ? m.content : (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
    const said = t.history.filter((m) => m.role === "user" && text(m));
    const replies = t.history.filter((m) => m.role === "assistant" && text(m));
    return {
      said: said.length,
      lastSaid: said.length ? text(said[said.length - 1]) : "",
      replies: replies.length,
      lastReply: replies.length ? text(replies[replies.length - 1]).slice(0, 140) : "",
    };
  });
const until = async (pred, ms) => {
  const t0 = Date.now();
  for (;;) {
    const t = await thread();
    if (pred(t)) return t;
    if (Date.now() - t0 > ms) return null;
    await sleep(250);
  }
};
const waitVoice = (opts) => page.evaluate((o) => globalThis.__rec.waitVoice(o), opts);
// How many times Orbit has opened and closed the mic, and waiting for a count.
const micCounts = () => page.evaluate(() => ({ opened: globalThis.__rec.micAt.length, closed: globalThis.__rec.micClosedAt.length }));
const waitMic = async (key, n, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await micCounts())[key] >= n) return true;
    await sleep(100);
  }
  return false;
};

// ---- 1. The 2D app on the live link ----
await page.goto(url, { waitUntil: "load" });
await page.evaluate((f) => {
  globalThis.__xr.fovy = f;
}, FOVY);
const caption2d = (text, sub) =>
  page.evaluate(
    ([text, sub]) => {
      let el = document.getElementById("__cap");
      if (!text) return el?.remove();
      if (!el) {
        el = document.createElement("div");
        el.id = "__cap";
        Object.assign(el.style, {
          position: "fixed", left: "50%", bottom: "4.5%", transform: "translateX(-50%)", zIndex: 99999,
          background: "rgba(10,12,18,0.78)", color: "#fff", borderRadius: "12px", padding: "10px 26px",
          font: '600 27px "Segoe UI", system-ui, sans-serif', textAlign: "center", pointerEvents: "none", whiteSpace: "nowrap", maxWidth: "94vw",
        });
        document.body.append(el);
      }
      el.innerHTML = `<div>${text}</div>${sub ? `<div style="font:400 19px 'Segoe UI',system-ui,sans-serif;color:rgba(255,226,180,.95);margin-top:4px">${sub}</div>` : ""}`;
    },
    [text, sub],
  );
await sleep(1500);
const cast = await startScreencast(page, `${out}/frames2d`);
const t2d = Date.now();
await caption2d("Orbit: Callie, a Claude companion for Meta Quest", "Real footage · the live demo in Meta's Immersive Web Emulator (Quest 3) · hands only");
await sleep(4500);
await caption2d("Open the link in the Quest Browser, then Enter VR", "Timers, focus sessions, to-dos and notes live on the side");
await sleep(4000);
await caption2d("");
const frames2d = await cast.stop();
const end2d = Date.now();
log("2D frames", frames2d.length, "over", ((end2d - t2d) / 1000).toFixed(1), "s");

// ---- 2. Enter VR ----
await page.getByRole("button", { name: "Enter VR" }).first().click();
await sleep(1100);
await remote(page, "set_input_mode", { mode: "hand" });
const rest = async () => {
  await remote(page, "set_transform", { device: "hand-left", position: { x: -0.24, y: 0.98, z: -0.38 } });
  await remote(page, "set_transform", { device: "hand-right", position: { x: 0.24, y: 0.98, z: -0.38 } });
};
await rest();
await rayOf(page, "right");
log("rig", JSON.stringify(await measureRig(page)));
const look = (x, y, z) => remote(page, "look_at", { device: "headset", target: { x, y, z } });
await look(-0.25, 1.36, -1.2);
const HAND = { from: { x: 0.2, y: 1.27, z: -0.42 } };
const hover = (b) => aimAt(page, panelAt(...BTN[b]), HAND);
const press = (b) => pinchAt(page, panelAt(...BTN[b]), HAND);

// Before recording: visit every scene once. Orbit decodes each soundscape once
// and keeps it, and the panoramas then come from the browser's cache. Loading
// them for the first time during a take stalled the emulator's audio clock for
// up to 13 s; after this warm-up, a dry run had one 0.04 s hole.
const scene0 = (await settings(page)).environmentId ?? "clock";
for (let i = 0; i < SCENES; i++) {
  await press("scene");
  await sleep(3000);
}
await rest();
const sceneBack = (await settings(page)).environmentId ?? "clock";
if (sceneBack !== scene0) await abort(`the scene warm-up ended on ${sceneBack}, not ${scene0}`);
await sleep(2500);

// Also before recording: the first Talk of a visit starts with her greeting,
// whose expressive voice can take several seconds to arrive; a request said
// before it plays barges into it, and barge-in keeps only the end of what was
// said. A Talk and End voice here uses the greeting up, so the recorded Talk
// goes straight to listening.
if (!dry) {
  const m = await micCounts();
  await press("talk");
  await rest();
  if (!(await waitMic("opened", m.opened + 1, 8000))) await abort("warm-up: Talk did not open the mic");
  await sleep(1500);
  await press("talk");
  await rest();
  if (!(await waitMic("closed", m.closed + 1, 8000))) await abort("warm-up: End voice did not close the mic");
  await sleep(2000);
}

const rec = await page.evaluate(() => globalThis.__rec.start({ fps: 30 }));
log("recording", JSON.stringify(rec));
const at = () => ((Date.now() - rec.startedAt) / 1000).toFixed(1) + " s";
const cap = (text, sub = "") => page.evaluate(([t, s]) => globalThis.__rec.caption(t, s), [text, sub]);

await cap("Callie greets you when you arrive", "Everything here is done by pinching: no controller");
await sleep(5000);

// ---- 3. Voice: pinch Talk and just speak ----
let sayAt = null;
if (!dry) {
  await cap("Pinch Talk and just speak");
  await hover("talk");
  await sleep(1200);
  const before = await thread();
  const m = await micCounts();
  await press("talk");
  await rest();
  if (!(await waitMic("opened", m.opened + 1, 8000))) await abort("Talk did not open the mic");
  log("listening at", at());
  await sleep(900);
  await cap("“Hey Callie, start a 25-minute focus session. I'm writing my essay.”", "A spoken request played into the emulator's microphone");
  const said = await page.evaluate(() => globalThis.__rec.say());
  if (!said) await abort("the request could not be played into the mic");
  sayAt = said.at;
  log("request said at", ((sayAt - rec.startedAt) / 1000).toFixed(1), "s", JSON.stringify(said));
  const heard = await until((t) => t.said > before.said, 30000);
  if (!heard) await abort("the request never reached the chat");
  log("heard", JSON.stringify(heard.lastSaid), "at", at());
  if (!/focus/i.test(heard.lastSaid)) await abort(`the request was heard as "${heard.lastSaid}"`);
  await cap("She answers out loud, and starts the timer with her tools", "ElevenLabs hears and speaks; Claude answers and runs her tools");
  // Done when her voice has been quiet a moment and her reply is saved (a reply
  // is saved once it has finished streaming, tool calls included).
  const answer = await waitVoice({ startWithin: 25000, quietMs: 1200, max: 60000 });
  if (!answer.started) await abort("she never answered out loud");
  const saved = await until((t) => t.replies > before.replies, 15000);
  log("answer", JSON.stringify(answer), "until", at(), JSON.stringify(saved?.lastReply ?? null));
  await cap("The focus timer runs in the status strip", "Pinch End voice when you're done talking");
  await sleep(1800);
  // Well before the listen step gives up on silence (9 s after she stops), or
  // the pinch would start a new session instead (take 4 did, by 1.5 s).
  const m2 = await micCounts();
  await press("talk");
  await rest();
  const closed = await waitMic("closed", m2.closed + 1, 4000);
  const reopened = (await micCounts()).opened > m2.opened;
  log("End voice at", at(), closed ? "closed the mic" : "did NOT close the mic", reopened ? "but started a new session" : "");
  if (reopened) {
    await press("talk");
    await rest();
  }
  await sleep(1500);

  // ---- 4. A suggestion chip ----
  await cap("Or pinch one of her suggested follow-ups");
  await hover("prompt0");
  await sleep(1200);
  const b4 = await thread();
  await press("prompt0");
  await rest();
  const reply = await until((t) => t.replies > b4.replies, 40000);
  log("chip reply", JSON.stringify(reply?.lastReply ?? null), "at", at());
  const spoken = await waitVoice({ startWithin: 2500, quietMs: 1200, max: 40000 });
  log("chip voice", JSON.stringify(spoken));
  await sleep(3000);
}

// No paging shot: by now the chat is about half a panel tall, so the page
// arrows have nothing to page (they show once it overflows).

// ---- 5. Scenes ----
// Each scene's sound fades in over a couple of seconds from a random point in
// its loop, so each one is held long enough to be heard.
await cap("Seven scenes, each with its own soundscape");
await press("scene");
await rest();
await sleep(11000);
await press("scene");
await rest();
await sleep(11000);

// ---- 6. Move her and wave ----
await cap("Point at the floor and pinch: she glides there");
await pinchAt(page, { x: 0.85, y: 0, z: -1.45 }, { hand: "hand-right", from: { x: 0.25, y: 1.2, z: -0.4 } });
await rest();
await look(0.3, 1.25, -1.35);
await sleep(4500);
await cap("Wave, and she waves back");
for (let i = 0; i < 12; i++) {
  await remote(page, "set_transform", { device: "hand-right", position: { x: i % 2 ? 0.2 : -0.05, y: 1.47, z: -0.5 } });
  await sleep(150);
}
await rest();
await sleep(3500);

// ---- 7. End card ----
await look(-0.25, 1.36, -1.2);
await cap("Orbit · orbit-demo-lake.vercel.app", "Built with Claude Code · runs Claude Haiku 5.5 and Claude Opus 5.5 · your own keys stay on your headset");
await sleep(5000);
await cap("");
const micAt = await page.evaluate(() => globalThis.__rec.micAt);
const stats = await page.evaluate(() => globalThis.__rec.stop());
log("stopped", JSON.stringify(stats), JSON.stringify(bytes), "mic opened at", JSON.stringify(micAt.map((t) => t - rec.startedAt)));
await browser.close();

// ---- Assemble ----
const probe = (args) => execFileSync("ffprobe", ["-v", "error", ...args]).toString().trim();
writeConcat(frames2d, `${out}/frames2d.txt`, end2d);
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", `${out}/frames2d.txt`, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
  "-vf", "scale=1280:720,fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-shortest", `${out}/part1-2d.mp4`]);
// The page's audio has holes where the emulator's audio clock stalled. Its
// timestamps are wall-clock, so each hole is filled with silence where it is
// (aresample async) and the sound stays in step with the picture; packing the
// samples together instead drifts by the total of the holes. The request is
// mixed in where it was said, at half volume (about her voice's level), since
// the mic's sound never reaches the page's output. Then one loudness pass
// for the whole soundtrack (-20 LUFS).
const appMs = Math.max(0, rec.audioAt - rec.startedAt);
const askMs = sayAt === null ? null : Math.max(0, sayAt - rec.startedAt);
const fill = "aresample=48000:async=1:first_pts=0";
const stereo = "aresample=48000,aformat=channel_layouts=stereo";
const level = "loudnorm=I=-20:TP=-1.5:LRA=11,aresample=48000";
const audio =
  askMs === null
    ? `[1:a]${fill},adelay=${appMs}:all=1,${stereo},${level}[a]`
    : `[1:a]${fill},adelay=${appMs}:all=1,${stereo}[app];[2:a]adelay=${askMs}:all=1,volume=0.5,${stereo}[ask];` +
      `[app][ask]amix=inputs=2:duration=first:normalize=0,${level}[a]`;
execFileSync("ffmpeg", ["-y", "-v", "error", "-r", "30", "-f", "h264", "-i", `${out}/vr.h264`, "-i", `${out}/vr-audio.webm`,
  ...(askMs === null ? [] : ["-i", ASK]), "-filter_complex", audio,
  "-map", "0:v", "-map", "[a]", "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-shortest", `${out}/part2-vr.mp4`]);
fs.writeFileSync(`${out}/parts.txt`, `file '${out}/part1-2d.mp4'\nfile '${out}/part2-vr.mp4'\n`);
const final = `${out}/orbit-demo${dry ? "-dry" : ""}.mp4`;
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", `${out}/parts.txt`, "-c", "copy", "-movflags", "+faststart", final]);

// Checks: the soundtrack must decode to the picture's length (no packed holes),
// and the video must stay under the contest's 3 minutes.
const soundSeconds = (f) => {
  const r = spawnSync("ffmpeg", ["-v", "info", "-i", f, "-vn", "-af", "aresample=48000,astats=measure_perchannel=none:measure_overall=Number_of_samples", "-f", "null", "-"], { encoding: "utf8" });
  const m = [...(r.stderr ?? "").matchAll(/Number of samples: (\d+)/g)].pop();
  return m ? Number(m[1]) / 48000 : 0;
};
const length = Number(probe(["-show_entries", "format=duration", "-of", "csv=p=0", final]));
const soundLength = soundSeconds(final);
log("wrote", final, length.toFixed(2), "s; sound decodes to", soundLength.toFixed(2), "s");
if (Math.abs(length - soundLength) > 0.5) log("WARNING: the sound is", (length - soundLength).toFixed(2), "s short of the picture");
if (length >= 178) log("WARNING: over the 3-minute limit's margin:", length.toFixed(1), "s");
