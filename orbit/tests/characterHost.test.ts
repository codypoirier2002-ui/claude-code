// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvatarRecord } from "../src/core/blobstore";
import { createCharacterHost, planSlots, type AvatarViewModule } from "../src/ui/characterHost";
import { createSlot } from "../src/ui/slots";
import { BODY_NOTE_NONE, bodyErrorText, bodyNote } from "../src/ui/settingsDialog";
import { NOT_VRM_MESSAGE } from "../src/xr/avatar";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeAvatarModule(opts: { fail?: boolean } = {}) {
  const views: { el: HTMLElement; fps: unknown; disposed: boolean; cheered: number }[] = [];
  const mod: AvatarViewModule = {
    AVATAR_VIEW_FPS: { sidebar: [12, 30], voice: undefined },
    mountAvatarView(_container, o) {
      const el = document.createElement("div");
      el.className = "avatar-view";
      const v = { el, fps: o.fps, disposed: false, cheered: 0 };
      views.push(v);
      return {
        el,
        ready: opts.fail ? Promise.reject(new Error(NOT_VRM_MESSAGE)) : Promise.resolve(),
        wave() {},
        cheer() {
          v.cheered++;
        },
        dispose() {
          v.disposed = true;
          el.remove();
        },
      };
    },
  };
  return { mod, views };
}

function setup(opts: { record?: AvatarRecord | null; showCharacter?: boolean; inXr?: boolean; fail?: boolean } = {}) {
  const slots = { hero: createSlot("hero"), sidebar: createSlot("sidebar"), voice: createSlot("voice") };
  for (const s of Object.values(slots)) document.body.append(s.el);
  const state = { record: opts.record ?? null, showCharacter: opts.showCharacter ?? true, inXr: opts.inXr ?? false };
  const fake = fakeAvatarModule({ fail: opts.fail });
  const importAvatar = vi.fn(() => Promise.resolve(fake.mod));
  const loadAvatar = vi.fn(() => Promise.resolve(state.record));
  const host = createCharacterHost({
    slots,
    getSettings: () => ({ showCharacter: state.showCharacter }),
    getMood: () => "idle",
    getLevel: () => 0,
    getText: () => "",
    inXr: () => state.inXr,
    loadAvatar,
    importAvatar,
  });
  return { host, slots, state, fake, importAvatar, loadAvatar };
}

const RECORD: AvatarRecord = { name: "callie.vrm", data: new ArrayBuffer(8), savedAt: 1 };

beforeEach(() => {
  document.body.className = "";
  document.body.replaceChildren();
});

describe("planSlots (§7.3 fallbacks)", () => {
  it("shows her face everywhere by default", () => {
    expect(planSlots({ inXr: false, showCharacter: true, hasBody: false })).toEqual({ hero: "face", sidebar: "face", voice: "face" });
  });
  it("uses the body in the sidebar and voice overlay and the orb in the hero when a VRM is stored", () => {
    expect(planSlots({ inXr: false, showCharacter: true, hasBody: true })).toEqual({ hero: "orb", sidebar: "body", voice: "body" });
    expect(planSlots({ inXr: false, showCharacter: false, hasBody: true })).toEqual({ hero: "orb", sidebar: "body", voice: "body" });
  });
  it("shows the orb everywhere with the animated face off, and in VR", () => {
    expect(planSlots({ inXr: false, showCharacter: false, hasBody: false })).toEqual({ hero: "orb", sidebar: "orb", voice: "orb" });
    expect(planSlots({ inXr: true, showCharacter: true, hasBody: true })).toEqual({ hero: "orb", sidebar: "orb", voice: "orb" });
  });
});

describe("createCharacterHost", () => {
  it("mounts her face in all three slots and never loads three-vrm without a body", async () => {
    const t = setup();
    await t.host.rebuild();
    expect(t.host.kinds()).toEqual({ hero: "face", sidebar: "face", voice: "face" });
    expect(t.slots.hero.el.querySelector(".char")).not.toBeNull();
    expect(t.importAvatar).not.toHaveBeenCalled();
  });

  it("mounts the VRM view in the sidebar (12/30 fps) and voice overlay (uncapped), the orb in the hero", async () => {
    const t = setup({ record: RECORD });
    await t.host.rebuild();
    await flush();
    expect(t.host.kinds()).toEqual({ hero: "orb", sidebar: "body", voice: "body" });
    expect(t.fake.views.map((v) => v.fps)).toEqual([[12, 30], undefined]);
  });

  it("falls back to the orb when the stored file no longer loads", async () => {
    const t = setup({ record: RECORD, fail: true });
    await t.host.rebuild();
    await flush();
    expect(t.host.kinds()).toEqual({ hero: "orb", sidebar: "orb", voice: "orb" });
  });

  it("tears everything down in VR and rebuilds after it", async () => {
    const t = setup({ record: RECORD });
    await t.host.rebuild();
    t.state.inXr = true;
    await t.host.rebuild();
    expect(t.host.kinds()).toEqual({ hero: "orb", sidebar: "orb", voice: "orb" });
    expect(t.fake.views.every((v) => v.disposed)).toBe(true);
    t.state.inXr = false;
    await t.host.rebuild();
    await flush();
    expect(t.host.kinds()).toEqual({ hero: "orb", sidebar: "body", voice: "body" });
  });

  it("re-reads the stored body only when asked (Her body: Load / Remove)", async () => {
    const t = setup();
    await t.host.rebuild();
    t.state.record = RECORD;
    await t.host.rebuild();
    expect(t.host.kinds().sidebar).toBe("face");
    await t.host.rebuild({ reloadBody: true });
    await flush();
    expect(t.host.kinds().sidebar).toBe("body");
    t.state.record = null;
    await t.host.rebuild({ reloadBody: true });
    expect(t.host.kinds()).toEqual({ hero: "face", sidebar: "face", voice: "face" });
    expect(t.loadAvatar).toHaveBeenCalledTimes(3);
  });

  it("follows Show her animated face", async () => {
    const t = setup({ showCharacter: false });
    await t.host.rebuild();
    expect(t.host.kinds()).toEqual({ hero: "orb", sidebar: "orb", voice: "orb" });
    t.state.showCharacter = true;
    await t.host.rebuild();
    expect(t.host.kinds()).toEqual({ hero: "face", sidebar: "face", voice: "face" });
  });

  it("drops a slow rebuild that a newer one overtook", async () => {
    const t = setup({ record: RECORD });
    let release: (r: AvatarRecord | null) => void = () => {};
    t.loadAvatar.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const first = t.host.rebuild();
    t.state.inXr = true;
    await t.host.rebuild();
    release(RECORD);
    await first;
    await flush();
    expect(t.host.kinds()).toEqual({ hero: "orb", sidebar: "orb", voice: "orb" });
    expect(t.fake.views).toHaveLength(0);
  });

  it("cheers every live view", async () => {
    const t = setup({ record: RECORD });
    await t.host.rebuild();
    await flush();
    t.host.cheer();
    expect(t.fake.views.map((v) => v.cheered)).toEqual([1, 1]);
  });
});

describe("hidden tabs (§14)", () => {
  /** Flips document.visibilityState and fires visibilitychange, as a tab switch would. */
  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, "visibilityState", { value: hidden ? "hidden" : "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => {
    setHidden(false);
  });

  it("tears her face down when the tab is hidden and rebuilds it when shown", async () => {
    const t = setup();
    await t.host.rebuild();
    expect(t.host.kinds()).toEqual({ hero: "face", sidebar: "face", voice: "face" });
    setHidden(true);
    await flush();
    expect(t.host.kinds()).toEqual({ hero: "orb", sidebar: "orb", voice: "orb" });
    expect(t.slots.sidebar.el.querySelector(".char")).toBeNull();
    setHidden(false);
    await flush();
    expect(t.host.kinds()).toEqual({ hero: "face", sidebar: "face", voice: "face" });
    t.host.dispose();
  });

  it("disposes her VRM views while hidden and mounts fresh ones after", async () => {
    const t = setup({ record: RECORD });
    await t.host.rebuild();
    await flush();
    expect(t.fake.views).toHaveLength(2);
    setHidden(true);
    await flush();
    expect(t.fake.views.every((v) => v.disposed)).toBe(true);
    expect(t.host.kinds()).toEqual({ hero: "orb", sidebar: "orb", voice: "orb" });
    setHidden(false);
    await flush();
    await flush();
    expect(t.host.kinds()).toEqual({ hero: "orb", sidebar: "body", voice: "body" });
    expect(t.fake.views).toHaveLength(4);
    expect(t.loadAvatar).toHaveBeenCalledTimes(1); // the stored body is read once
    t.host.dispose();
  });

  it("keeps the VR behaviour: a tab switch in VR changes nothing, and leaving VR while hidden stays torn down", async () => {
    const t = setup();
    await t.host.rebuild();
    t.state.inXr = true;
    await t.host.rebuild();
    setHidden(true);
    setHidden(false);
    setHidden(true);
    await flush();
    expect(t.host.kinds()).toEqual({ hero: "orb", sidebar: "orb", voice: "orb" });
    // Leaving VR rebuilds (main.ts does this) while the tab is still hidden: nothing comes back yet.
    t.state.inXr = false;
    await t.host.rebuild();
    expect(t.host.kinds()).toEqual({ hero: "orb", sidebar: "orb", voice: "orb" });
    setHidden(false);
    await flush();
    expect(t.host.kinds()).toEqual({ hero: "face", sidebar: "face", voice: "face" });
    t.host.dispose();
  });

  it("does nothing on a visibilitychange that changes nothing, and stops after dispose", async () => {
    const t = setup();
    await t.host.rebuild();
    const calls = t.loadAvatar.mock.calls.length;
    document.dispatchEvent(new Event("visibilitychange")); // still visible
    await flush();
    expect(t.host.kinds()).toEqual({ hero: "face", sidebar: "face", voice: "face" });
    t.host.dispose();
    setHidden(true);
    await flush();
    expect(t.host.kinds()).toEqual({ hero: "face", sidebar: "face", voice: "face" });
    expect(t.loadAvatar.mock.calls.length).toBe(calls);
  });

  it("starts torn down when the tab is already hidden", async () => {
    setHidden(true);
    const t = setup();
    await t.host.rebuild();
    expect(t.host.kinds()).toEqual({ hero: "orb", sidebar: "orb", voice: "orb" });
    setHidden(false);
    await flush();
    expect(t.host.kinds()).toEqual({ hero: "face", sidebar: "face", voice: "face" });
    t.host.dispose();
  });
});

describe("Her body copy (§6.9 item 11, §7.4)", () => {
  it("shows the no-body note, the body name, and load errors", () => {
    expect(bodyNote(null)).toBe(BODY_NOTE_NONE);
    expect(bodyNote("callie.vrm")).toBe("Body: callie.vrm. She stands beside your panel in VR and appears in voice mode.");
    expect(bodyErrorText(new Error(NOT_VRM_MESSAGE))).toBe(
      "Couldn't load her body: That file isn't a VRM avatar. Export one from VRoid Studio as .vrm.",
    );
  });
});
