// Think harder / Stop by emulated pinch, with live replies (needs the demo
// server's keys; it spends one short reply and one Opus re-answer).
//   node thinkstop.mjs <url> <outDir>
import fs from "node:fs";
import { BTN, launch, measureRig, panelAt, pinchAt, rayOf, remote, sleep } from "./xr.mjs";

const url = process.argv[2] ?? "https://orbit-demo-lake.vercel.app/";
const out = process.argv[3];
fs.mkdirSync(out, { recursive: true });
const { browser, page } = await launch({ url });
await page.goto(url, { waitUntil: "load" });
await sleep(2500);
let n = 0;
const snap = (name) => page.screenshot({ path: `${out}/${String(++n).padStart(2, "0")}-${name}.png` });
// The Everyday thread as stored: its length, last turn, and which model answered it.
const thread = () =>
  page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem("orbit:threads") || "{}");
    const t = all.everyday ?? { history: [], models: {} };
    const h = t.history ?? [];
    const last = h[h.length - 1];
    const blocks = Array.isArray(last?.content) ? last.content : [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    return { len: h.length, role: last?.role, text: text.slice(0, 160), model: (t.models ?? {})[String(h.length - 1)] ?? null };
  });
const waitFor = async (pred, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = await thread();
    if (pred(t)) return t;
    await sleep(500);
  }
  return thread();
};

await page.getByRole("button", { name: "Enter VR" }).first().click();
await sleep(2500);
await remote(page, "set_input_mode", { mode: "hand" });
await remote(page, "set_transform", { device: "hand-left", position: { x: -0.22, y: 0.95, z: -0.3 } });
await rayOf(page, "right");
console.log("rig", JSON.stringify(await measureRig(page)));
await sleep(6000); // her greeting

// Stop: send a suggestion, then pinch the same button (now Stop) while she answers.
await pinchAt(page, panelAt(...BTN.prompt0), { settle: 150 });
await sleep(400);
await snap("busy");
await pinchAt(page, panelAt(...BTN.think), { settle: 150 });
await sleep(1500);
await snap("stopped");
const t1 = await thread();
await sleep(4000);
const t1b = await thread();
const stopped = JSON.stringify(t1) === JSON.stringify(t1b);
console.log(`${stopped ? "PASS" : "FAIL"}  Stop: thread unchanged for 4 s after the pinch`, JSON.stringify(t1b));

// Think harder: send another suggestion, let it finish, then pinch Think harder.
await pinchAt(page, panelAt(...BTN.prompt1));
const t2 = await waitFor((t) => t.len > t1b.len + 1 && t.role === "assistant" && !!t.model, 40000);
await sleep(1500);
await snap("answered");
await pinchAt(page, panelAt(...BTN.think));
await sleep(800);
await snap("thinking-harder");
const t3 = await waitFor((t) => t.role === "assistant" && !!t.model && t.model !== t2.model, 60000);
await sleep(1500);
await snap("thought-harder");
const harder = t3.model !== t2.model && /opus/.test(t3.model ?? "");
console.log(`${harder ? "PASS" : "FAIL"}  Think harder: ${t2.model} → ${t3.model}`, JSON.stringify(t3.text));
await browser.close();
