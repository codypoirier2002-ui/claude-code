// The contest video: real footage of the live demo in Meta's Immersive Web
// Emulator (IWER, Quest 3 profile, hand mode, no controller), with captions.
//   node record.mjs <url> <outDir> [--dry]  (--dry: no voice or AI shots, for timing)
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { BTN, aimAt, launch, measureRig, panelAt, pinchAt, rayOf, remote, sleep } from "./xr.mjs";
import { recorderInit, sinkTo, startScreencast, writeConcat } from "./recorder.mjs";

const url = process.argv[2] ?? "https://orbit-demo-lake.vercel.app/";
const out = process.argv[3];
const dry = process.argv.includes("--dry");
// A WAV of the spoken request, fed to the fake microphone (see README.md).
const ASK = process.env.ORBIT_ASK_WAV ?? "";
if (!ASK && !process.argv.includes("--dry")) throw new Error("Set ORBIT_ASK_WAV, or pass --dry.");
const FOVY = 1.32;
fs.mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const { browser, page } = await launch({
  url,
  extraInit: recorderInit,
  args: ASK ? [`--use-file-for-fake-audio-capture=${ASK}%noloop`] : [],
});
page.on("console", (m) => /error|failed/i.test(m.text()) && log("page:", m.text().slice(0, 160)));
const bytes = await sinkTo(page, `${out}/vr.h264`, `${out}/vr-audio.webm`);

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
const rec = await page.evaluate(() => globalThis.__rec.start({ fps: 30 }));
log("recording", JSON.stringify(rec));
const cap = (text, sub = "") => page.evaluate(([t, s]) => globalThis.__rec.caption(t, s), [text, sub]);
const hover = (b) => aimAt(page, panelAt(...BTN[b]), { from: { x: 0.2, y: 1.27, z: -0.42 } });
const HAND = { from: { x: 0.2, y: 1.27, z: -0.42 } };
const press = (b) => pinchAt(page, panelAt(...BTN[b]), HAND);

await cap("Callie greets you when you arrive", "Everything here is done by pinching: no controller");
await sleep(5000);

// ---- 3. Voice: pinch Talk and just speak ----
if (!dry) {
  await cap("Pinch Talk and just speak");
  await hover("talk");
  await sleep(1200);
  await press("talk");
  await cap("“Hey Callie, start a 25-minute focus session. I'm writing my essay.”", "A spoken request played into the emulator's microphone");
  await rest();
  await sleep(9000);
  await cap("She answers out loud, and starts the timer with her tools", "Claude Haiku 5.5 listens through ElevenLabs speech to text, then speaks");
  await sleep(16000);
  await cap("The focus timer runs in the status strip", "Pinch End voice when you're done talking");
  await sleep(3000);
  await press("talk");
  await rest();
  await sleep(2500);

  // ---- 4. A suggestion chip ----
  await cap("Or pinch one of her suggested follow-ups");
  await hover("prompt0");
  await sleep(1200);
  await press("prompt0");
  await rest();
  await sleep(14000);
}

// ---- 5. Scroll by pinch ----
await cap("Arrows page through the chat: no thumbstick needed");
await hover("scrollUp");
await sleep(900);
await press("scrollUp");
await sleep(1300);
await press("scrollUp");
await sleep(1500);
await press("scrollDown");
await sleep(1100);
await press("scrollDown");
await rest();
await sleep(1500);

// ---- 6. Scenes ----
await cap("Seven scenes, each with its own soundscape");
await press("scene");
await rest();
await sleep(5500);
await press("scene");
await rest();
await sleep(5000);

// ---- 7. Move her and wave ----
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

// ---- 8. End card ----
await look(-0.25, 1.36, -1.2);
await cap("Orbit · orbit-demo-lake.vercel.app", "Built with Claude Code · runs Claude Haiku 5.5 and Claude Opus 5.5 · keys stay on your headset");
await sleep(5000);
await cap("");
const stats = await page.evaluate(() => globalThis.__rec.stop());
log("stopped", JSON.stringify(stats), JSON.stringify(bytes));
await browser.close();

// ---- Assemble ----
writeConcat(frames2d, `${out}/frames2d.txt`, end2d);
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", `${out}/frames2d.txt`, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
  "-vf", "scale=1280:720,fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-shortest", `${out}/part1-2d.mp4`]);
const off = ((rec.audioAt - rec.startedAt) / 1000).toFixed(3);
execFileSync("ffmpeg", ["-y", "-v", "error", "-r", "30", "-f", "h264", "-i", `${out}/vr.h264`, "-itsoffset", off, "-i", `${out}/vr-audio.webm`,
  "-map", "0:v", "-map", "1:a", "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000", "-shortest", `${out}/part2-vr.mp4`]);
fs.writeFileSync(`${out}/parts.txt`, `file '${out}/part1-2d.mp4'\nfile '${out}/part2-vr.mp4'\n`);
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", `${out}/parts.txt`, "-c", "copy", "-movflags", "+faststart", `${out}/orbit-demo${dry ? "-dry" : ""}.mp4`]);
log("wrote", `${out}/orbit-demo${dry ? "-dry" : ""}.mp4`, execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${out}/orbit-demo${dry ? "-dry" : ""}.mp4`]).toString().trim(), "s");
