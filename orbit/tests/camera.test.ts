// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAMERA_CONSTRAINTS,
  CAMERA_TEXT,
  CAPTURE_QUALITY,
  CameraError,
  SETTLE_MS,
  cameraError,
  captureFrame,
  type FrameSurface,
} from "../src/core/camera";
import { LOOK_PHRASE } from "../src/core/session";
import type { AppCtx } from "../src/ui/context";
import { createComposer, LOOK_PLACEHOLDER } from "../src/ui/composer";

// ---- Fakes ----------------------------------------------------------------------------------------

function fakeStream(trackCount = 1) {
  const tracks = Array.from({ length: trackCount }, () => {
    const t = { stopped: 0, stop: () => void t.stopped++ };
    return t;
  });
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  return { stream, tracks };
}

interface FakeVideo {
  muted: boolean;
  playsInline: boolean;
  srcObject: unknown;
  attrs: Record<string, string>;
  setAttribute(k: string, v: string): void;
  play(): Promise<void>;
  pause(): void;
}

function fakeSurface(opts: { playFails?: boolean; encodeFails?: boolean } = {}) {
  const log: string[] = [];
  const video: FakeVideo = {
    muted: false,
    playsInline: false,
    srcObject: null,
    attrs: {},
    setAttribute(k, v) {
      video.attrs[k] = v;
    },
    play() {
      log.push("play");
      return opts.playFails ? Promise.reject(new DOMException("nope", "NotAllowedError")) : Promise.resolve();
    },
    pause() {},
  };
  let state: { muted: boolean; playsInline: boolean; src: unknown } | null = null;
  let quality = 0;
  const surface: FrameSurface = {
    video: video as unknown as HTMLVideoElement,
    encode(_v, q) {
      log.push("encode");
      state = { muted: video.muted, playsInline: video.playsInline, src: video.srcObject };
      quality = q;
      return opts.encodeFails ? Promise.reject(new Error("canvas")) : Promise.resolve(new Blob(["jpeg"], { type: "image/jpeg" }));
    },
  };
  return { surface, video, log, state: () => state, quality: () => quality };
}

interface HarnessOpts {
  gum?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  playFails?: boolean;
  encodeFails?: boolean;
  prepareFails?: boolean;
}

function harness(opts: HarnessOpts = {}) {
  const { stream, tracks } = fakeStream(2);
  const s = fakeSurface(opts);
  const waits: number[] = [];
  const asked: MediaStreamConstraints[] = [];
  const prepared: Blob[] = [];
  const run = () =>
    captureFrame({
      getUserMedia: (c) => {
        asked.push(c);
        return opts.gum ? opts.gum(c) : Promise.resolve(stream);
      },
      surface: () => s.surface,
      wait: (ms) => {
        waits.push(ms);
        s.log.push(`wait ${ms}`);
        return Promise.resolve();
      },
      prepare: (b) => {
        prepared.push(b);
        s.log.push("prepare");
        return opts.prepareFails ? Promise.reject(new Error("decode")) : Promise.resolve("BASE64JPEG");
      },
    });
  return { run, tracks, waits, asked, prepared, ...s };
}

// ---- captureFrame ---------------------------------------------------------------------------------

describe("captureFrame (§4.6)", () => {
  it("asks for the environment camera at 1280×960 without audio", async () => {
    const h = harness();
    await h.run();
    expect(h.asked).toEqual([
      { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false },
    ]);
    expect(h.asked[0]).toBe(CAMERA_CONSTRAINTS);
  });

  it("plays muted and inline, waits 450 ms, takes a JPEG at 0.9, then runs the image step", async () => {
    const h = harness();
    expect(await h.run()).toBe("BASE64JPEG");
    expect(SETTLE_MS).toBe(450);
    expect(h.waits).toEqual([450]);
    expect(h.log).toEqual(["play", "wait 450", "encode", "prepare"]);
    expect(h.state()).toMatchObject({ muted: true, playsInline: true });
    expect(h.state()?.src).not.toBeNull();
    expect(h.video.attrs.playsinline).toBe("");
    expect(h.quality()).toBe(CAPTURE_QUALITY);
    expect(CAPTURE_QUALITY).toBe(0.9);
    expect(h.prepared).toHaveLength(1);
    expect(h.prepared[0].type).toBe("image/jpeg");
  });

  it("always stops every track and releases the video, on success and on failure", async () => {
    const ok = harness();
    await ok.run();
    expect(ok.tracks.map((t) => t.stopped)).toEqual([1, 1]);
    expect(ok.video.srcObject).toBeNull();

    const playFails = harness({ playFails: true });
    // Playback refused after the camera opened is a failed capture, not a denied permission.
    await expect(playFails.run()).rejects.toThrow(CAMERA_TEXT.failed);
    expect(playFails.tracks.map((t) => t.stopped)).toEqual([1, 1]);

    const encodeFails = harness({ encodeFails: true });
    await expect(encodeFails.run()).rejects.toThrow(CAMERA_TEXT.failed);
    expect(encodeFails.tracks.map((t) => t.stopped)).toEqual([1, 1]);
    expect(encodeFails.video.srcObject).toBeNull();

    // The tracks are already stopped before the image step runs.
    const prepareFails = harness({ prepareFails: true });
    await expect(prepareFails.run()).rejects.toThrow(CAMERA_TEXT.failed);
    expect(prepareFails.tracks.map((t) => t.stopped)).toEqual([1, 1]);
  });

  it("maps a denied permission, a missing camera and anything else to the §4.6 copy", async () => {
    const denied = harness({ gum: () => Promise.reject(new DOMException("x", "NotAllowedError")) });
    await expect(denied.run()).rejects.toThrow("Camera permission was denied. Allow it in the browser's site settings.");
    expect(denied.log).toEqual([]); // nothing played

    const missing = harness({ gum: () => Promise.reject(new DOMException("x", "NotFoundError")) });
    await expect(missing.run()).rejects.toThrow(
      "No camera found. On Quest 3, update Horizon OS and allow camera access for the browser.",
    );

    const other = harness({ gum: () => Promise.reject(new DOMException("x", "NotReadableError")) });
    const err = await other.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as CameraError).kind).toBe("failed");
    expect((err as Error).message).toBe("Couldn't open the camera.");
  });

  it("classifies errors by name", () => {
    expect(cameraError({ name: "PermissionDeniedError" }).kind).toBe("denied");
    expect(cameraError({ name: "SecurityError" }).kind).toBe("denied");
    expect(cameraError({ name: "DevicesNotFoundError" }).kind).toBe("not-found");
    expect(cameraError(new Error("boom")).kind).toBe("failed");
    expect(cameraError(null).kind).toBe("failed");
    const same = new CameraError("denied", CAMERA_TEXT.denied);
    expect(cameraError(same)).toBe(same);
  });

  it("reports a missing camera when the browser has no getUserMedia", async () => {
    const md = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    try {
      await expect(captureFrame({ wait: () => Promise.resolve() })).rejects.toThrow(CAMERA_TEXT.notFound);
    } finally {
      if (md) Object.defineProperty(navigator, "mediaDevices", md);
      else delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    }
  });
});

// ---- LOOK_PHRASE ------------------------------------------------------------------------------------

describe("LOOK_PHRASE (§4.6 voice trigger)", () => {
  it("matches the look phrases", () => {
    for (const t of [
      "look at this",
      "Can you look at that for me",
      "look at these shoes",
      "look at my screen",
      "What's this?",
      "what is that thing",
      "What are these",
      "can you see the label",
      "what am I looking at",
      "What am I holding?",
      "take a look",
    ]) {
      expect(LOOK_PHRASE.test(t), t).toBe(true);
    }
  });

  it("leaves ordinary requests alone", () => {
    for (const t of ["what time is it", "look it up", "what's the weather", "this is great", "I can see why", "lookout"]) {
      expect(LOOK_PHRASE.test(t), t).toBe(false);
    }
  });
});

// ---- The 👁 button ---------------------------------------------------------------------------------

function composerCtx() {
  const toasts: string[] = [];
  const send = vi.fn();
  const ctx = {
    assistant: { getState: () => ({ busy: false }), send, stop: vi.fn() },
    voice: { isTranscribing: () => false, isDictating: () => false, startDictation: vi.fn() },
    getSettings: () => ({ assistantName: "Callie", apiKey: "sk-ant-x", baseURL: "" }),
    toast: (m: string) => void toasts.push(m),
    openSettings: vi.fn(),
  } as unknown as AppCtx;
  return { ctx, toasts, send };
}

describe("👁 in the composer (§6.6)", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("pulses while capturing, shows “What should I look at?”, then attaches the frame", async () => {
    const { ctx, toasts } = composerCtx();
    let finish!: (v: string) => void;
    const shot = vi.fn(() => new Promise<string>((r) => (finish = r)));
    const c = createComposer(ctx, shot);
    document.body.append(c.el);
    const btn = c.el.querySelector<HTMLButtonElement>(".icon-btn.look")!;
    const ta = c.el.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(btn.title).toBe("Show her what you see (headset camera)");

    btn.click();
    expect(shot).toHaveBeenCalledTimes(1);
    expect(btn.classList.contains("capturing")).toBe(true);
    expect(ta.placeholder).toBe(LOOK_PLACEHOLDER);
    btn.click(); // a second tap while capturing does nothing
    expect(shot).toHaveBeenCalledTimes(1);

    finish("FRAME");
    await vi.waitFor(() => expect(btn.classList.contains("capturing")).toBe(false));
    expect(c.el.querySelector<HTMLImageElement>(".attachment img")?.getAttribute("src")).toBe("data:image/jpeg;base64,FRAME");
    expect(ta.placeholder).toBe("What should I look at?");
    expect(toasts).toEqual([]);

    c.setDraft("What brand is this?");
    expect(ta.placeholder).toBe("Message Callie…");
  });

  it("toasts the camera error and attaches nothing", async () => {
    const { ctx, toasts } = composerCtx();
    const c = createComposer(ctx, () => Promise.reject(new CameraError("denied", CAMERA_TEXT.denied)));
    await c.look();
    expect(toasts).toEqual([CAMERA_TEXT.denied]);
    expect(c.el.querySelector(".attachment img")).toBeNull();
    expect(c.isCapturing()).toBe(false);
    expect(c.el.querySelector<HTMLTextAreaElement>("textarea")!.placeholder).toBe("Message Callie…");
  });

  it("sends the frame with the text", async () => {
    const { ctx, send } = composerCtx();
    const c = createComposer(ctx, () => Promise.resolve("FRAME"));
    await c.look();
    c.setDraft("what is this");
    c.el.querySelector<HTMLButtonElement>(".send")!.click();
    expect(send).toHaveBeenCalledWith({ text: "what is this", attachment: { data: "FRAME" } });
  });
});
