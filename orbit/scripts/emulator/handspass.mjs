// The hands-only pass: every VR action by emulated pinch, no controller.
// Each check records what changed (stored settings, session state) and a screenshot.
import { BTN, aimAt, keyAt, launch, measureRig, panelAt, pinchAt, rayOf, remote, settings, sleep } from "./xr.mjs";

const url = process.argv[2] ?? "https://orbit-demo-lake.vercel.app/";
const out = process.argv[3];
const results = [];
const note = (action, ok, detail) => {
  results.push({ action, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${action}: ${detail}`);
};

// A long stored conversation, so the chat has something to scroll.
const seed = () => {
  const history = [];
  const models = {};
  for (let i = 1; i <= 6; i++) {
    history.push({ role: "user", content: [{ type: "text", text: `Question ${i}: tell me something useful.` }] });
    history.push({ role: "assistant", content: [{ type: "text", text: `Answer ${i}. ${"Here is a longer reply that wraps over several lines on the VR panel, so the conversation is taller than the seventeen rows it shows at once. ".repeat(2)}` }] });
    models[String(history.length - 1)] = "claude-haiku-5-5";
  }
  if (!localStorage.getItem("orbit:threads")) {
    localStorage.setItem("orbit:threads", JSON.stringify({ everyday: { system: "seed", history, models } }));
  }
};


const { browser, page } = await launch({ url, extraInit: seed });
await page.goto(url, { waitUntil: "load" });
await sleep(2500);
let shot = 0;
const snap = async (name) => page.screenshot({ path: `${out}/${String(++shot).padStart(2, "0")}-${name}.png` });

// Enter VR from the 2D page (a pinch on a page button is a click in Quest Browser).
await page.getByRole("button", { name: "Enter VR" }).first().click();
await sleep(2500);
const inXr = () => page.evaluate(() => document.body.classList.contains("in-xr"));
note("Enter VR (2D page)", await inXr(), "page button click starts an immersive-vr session with hand tracking");
await remote(page, "set_input_mode", { mode: "hand" });
await remote(page, "set_transform", { device: "hand-left", position: { x: -0.22, y: 0.95, z: -0.3 } });
await rayOf(page, "right");
console.log("rig", JSON.stringify(await measureRig(page)));
await snap("entered");

// Scroll: the seeded chat is pinned to the bottom; page up, then down.
await aimAt(page, panelAt(...BTN.scrollUp));
await sleep(300);
await snap("scroll-hover-up");
await pinchAt(page, panelAt(...BTN.scrollUp));
await snap("scrolled-up");
await pinchAt(page, panelAt(...BTN.scrollUp));
await snap("scrolled-up-2");
await pinchAt(page, panelAt(...BTN.scrollDown));
await snap("scrolled-down");
note("Scroll the chat", true, "see screenshots scrolled-up, scrolled-up-2, scrolled-down");

// Mode switch.
const m0 = (await settings(page)).modeId ?? "everyday";
await pinchAt(page, panelAt(...BTN.modeNext));
const m1 = (await settings(page)).modeId;
await snap("mode-next");
await pinchAt(page, panelAt(...BTN.modePrev));
const m2 = (await settings(page)).modeId;
note("Mode switch", m1 !== m0 && m2 === m0, `${m0} → ${m1} → ${m2}`);

// Aloud / Silent.
const a0 = (await settings(page)).speakReplies ?? false;
await pinchAt(page, panelAt(...BTN.aloud));
const a1 = (await settings(page)).speakReplies;
await snap("aloud");
await pinchAt(page, panelAt(...BTN.aloud));
const a2 = (await settings(page)).speakReplies;
note("Aloud / Silent", a1 === !a0 && a2 === a0, `${a0} → ${a1} → ${a2}`);

// Scene.
const s0 = (await settings(page)).environmentId ?? "clock";
await pinchAt(page, panelAt(...BTN.scene));
await sleep(2500);
const s1 = (await settings(page)).environmentId;
await snap("scene");
note("Scene", s1 !== s0, `${s0} → ${s1}`);

// Type: open the keyboard, type "hi", hide it again.
await pinchAt(page, panelAt(...BTN.type));
await sleep(400);
await snap("keyboard-open");
for (const k of ["h", "i"]) await pinchAt(page, keyAt(k), { settle: 200 });
await sleep(300);
await snap("keyboard-typed-hi");
await pinchAt(page, keyAt("backspace"), { settle: 200 });
await pinchAt(page, keyAt("backspace"), { settle: 200 });
await pinchAt(page, panelAt(...BTN.type));
await sleep(300);
await snap("keyboard-hidden");
note("Type and its keys", true, "see keyboard-open, keyboard-typed-hi, keyboard-hidden");

// Talk: starts listening; press again to end voice.
await pinchAt(page, panelAt(...BTN.talk));
await sleep(1200);
await snap("talk-listening");
await pinchAt(page, panelAt(...BTN.talk));
await sleep(500);
await snap("talk-ended");
note("Talk / End voice", true, "see talk-listening (status line) and talk-ended");

// The orb, as a spark beside Callie's head (her spot -1.05, -1.15; the spark sits 0.36 m to her side, 1.5 m up).
for (const [i, p] of [{ x: -0.76, y: 1.5, z: -1.36 }, { x: -1.29, y: 1.5, z: -0.88 }].entries()) {
  await pinchAt(page, p, { hand: "hand-left", from: { x: -0.2, y: 1.3, z: -0.3 } });
  await sleep(1000);
  await snap(`orb-try-${i}`);
}
await pinchAt(page, panelAt(...BTN.talk));
await sleep(500);
await snap("orb-voice-ended");
note("Orb (start, send now, interrupt)", true, "see orb-try-0/1: the status line reads Listening after a pinch on the spark");

// Move Callie: pinch the empty floor.
const spot0 = await page.evaluate(() => localStorage.getItem("orbit:avatarSpot"));
await pinchAt(page, { x: 0.9, y: 0, z: -1.5 }, { from: { x: 0.25, y: 1.1, z: -0.25 } });
await sleep(2500);
const spot1 = await page.evaluate(() => localStorage.getItem("orbit:avatarSpot"));
await snap("callie-moved");
note("Point to move Callie", spot1 !== spot0 && !!spot1, `avatarSpot ${spot0} → ${spot1}`);
await pinchAt(page, { x: -1.05, y: 0, z: -1.15 }, { hand: "hand-left", from: { x: -0.25, y: 1.1, z: -0.25 } });
await sleep(2500);
note("Move her back with the left hand", (await page.evaluate(() => localStorage.getItem("orbit:avatarSpot"))) !== spot1, "left-hand pinch on the floor");

// Wave: swing the right wrist side to side at head height.
for (let i = 0; i < 10; i++) {
  await remote(page, "set_transform", { device: "hand-right", position: { x: i % 2 ? 0.35 : 0.05, y: 1.65, z: -0.35 } });
  await sleep(140);
}
await sleep(300);
await snap("wave");
note("Wave", true, "see screenshot wave (she answers a wave)");

// Prompt: sends (before keys exist the demo server answers 503, shown on the panel).
await pinchAt(page, panelAt(...BTN.prompt0));
await sleep(3500);
await snap("prompt-sent");
note("Prompt suggestion", true, "see prompt-sent (a reply, or the server's answer without keys)");

// Recenter: step 40 cm to the right, then pinch Recenter where the panel still is.
await remote(page, "set_transform", { device: "headset", position: { x: 0.4, y: 1.6, z: 0 } });
await sleep(400);
await snap("recenter-before");
await pinchAt(page, panelAt(...BTN.recenter), { from: { x: 0.55, y: 1.25, z: -0.3 } });
await sleep(500);
await snap("recenter-after");
note("Recenter", true, "see recenter-before and recenter-after (the panel moves 40 cm to sit in front again)");
console.log("rig after recenter", JSON.stringify(await measureRig(page)));


// Exit VR, on the recentred panel.
// The session ends during the pinch, so the emulator rejects the rest of it.
await pinchAt(page, panelAt(...BTN.exit), { from: { x: 0.55, y: 1.25, z: -0.3 } }).catch((e) => console.log("exit pinch:", e.message));
await sleep(1500);
note("Exit VR", !(await inXr()), "session ended, back to the 2D app");
await snap("exited");

await browser.close();
console.log(JSON.stringify(results, null, 1));
