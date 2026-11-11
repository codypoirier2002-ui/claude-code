// Recording in the page.
// Video: each rendered XR frame is copied, right after the app draws it, into
// a 2D canvas (WebXR frames never reach canvas.captureStream), captions are
// drawn on top, and WebCodecs encodes it with the GPU's H.264 encoder at a
// constant 30 fps (a frame is repeated after a stall, so time stays exact).
// The Annex B stream goes to disk as it is made.
// Audio: every connection to an AudioContext's destination is also routed to
// a MediaStreamDestination, recorded with MediaRecorder (Opus).
// Both carry wall-clock start times, so ffmpeg can line them up.
import fs from "node:fs";
import path from "node:path";

export function recorderInit() {
  const taps = new WeakMap();
  const tracks = [];
  const origConnect = AudioNode.prototype.connect;
  function tapFor(ctx) {
    let t = taps.get(ctx);
    if (!t) {
      t = ctx.createMediaStreamDestination();
      taps.set(ctx, t);
      tracks.push(t.stream.getAudioTracks()[0]);
    }
    return t;
  }
  AudioNode.prototype.connect = function (dest, ...rest) {
    const out = origConnect.call(this, dest, ...rest);
    try {
      if (dest instanceof AudioDestinationNode) origConnect.call(this, tapFor(dest.context), ...rest.slice(0, 1));
    } catch {
      // never break the app's audio
    }
    return out;
  };

  // Her voice: Orbit plays each spoken chunk through a one-shot buffer source,
  // and soundscapes through looping ones, so counting the one-shot sources
  // that are playing tells when she speaks (loudness can't: the soundscape
  // shares the output and ducks under her).
  let voices = 0;
  let voiceEndedAt = 0;
  const origStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    if (!this.loop && !this.__rec) {
      voices++;
      this.addEventListener("ended", () => {
        voices--;
        voiceEndedAt = Date.now();
      }, { once: true });
    }
    return origStart.apply(this, a);
  };

  // The microphone: a stream the script controls instead of a device. It is
  // silent until the script says the request (__rec.say), which plays the WAV
  // from the Node side into it; each open gets a fresh stream, because Orbit
  // stops the tracks when it closes the mic. Opening is instant, unlike
  // Chrome's file-backed fake device, which took about 10 s to open while
  // recording. The WAV never reaches the page's output, so the assembly mixes
  // it in at the logged time.
  const micAt = [];
  const micClosedAt = [];
  let micCtx = null;
  let micDest = null;
  let askBuf = null;
  const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (gum) {
    navigator.mediaDevices.getUserMedia = async (c) => {
      if (!c?.audio) return gum(c);
      micCtx ??= new AudioContext({ sampleRate: 48000 });
      if (micCtx.state !== "running") await micCtx.resume().catch(() => {});
      micDest = micCtx.createMediaStreamDestination();
      micAt.push(Date.now());
      // Orbit stops the track when it closes the mic: note when.
      const track = micDest.stream.getAudioTracks()[0];
      const stopTrack = track.stop.bind(track);
      track.stop = () => {
        micClosedAt.push(Date.now());
        stopTrack();
      };
      askBuf ??= typeof globalThis.__askWav === "function"
        ? globalThis.__askWav().then((b64) => micCtx.decodeAudioData(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer))
        : Promise.resolve(null);
      return micDest.stream;
    };
  }

  const toB64 = (buf) => {
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const cap = { text: "", sub: "" };
  function drawCaption(g, w, h) {
    if (!cap.text) return;
    g.save();
    const size = Math.round(h * 0.04);
    const subSize = Math.round(size * 0.66);
    const font = (wt, px) => `${wt} ${px}px "Segoe UI", system-ui, sans-serif`;
    g.font = font(600, size);
    let tw = g.measureText(cap.text).width;
    if (cap.sub) {
      g.font = font(400, subSize);
      tw = Math.max(tw, g.measureText(cap.sub).width);
    }
    const boxW = tw + size * 1.8;
    const boxH = cap.sub ? size * 2.6 : size * 1.75;
    const x = (w - boxW) / 2;
    const y = h - boxH - h * 0.045;
    g.fillStyle = "rgba(10,12,18,0.74)";
    g.beginPath();
    g.roundRect(x, y, boxW, boxH, size * 0.45);
    g.fill();
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#ffffff";
    g.font = font(600, size);
    g.fillText(cap.text, w / 2, cap.sub ? y + size * 0.95 : y + boxH / 2);
    if (cap.sub) {
      g.fillStyle = "rgba(255,226,180,0.95)";
      g.font = font(400, subSize);
      g.fillText(cap.sub, w / 2, y + size * 1.95);
    }
    g.restore();
  }

  let state = null;
  globalThis.__rec = {
    micAt,
    micClosedAt,
    /** Plays the request into the open mic; resolves with the wall-clock start, or null. */
    async say() {
      const buf = askBuf && (await askBuf);
      if (!buf || !micDest) return null;
      const src = micCtx.createBufferSource();
      src.__rec = true; // not her voice
      src.buffer = buf;
      src.connect(micDest);
      src.start();
      return { at: Date.now(), ctx: micCtx.state, seconds: buf.duration };
    },
    /**
     * Waits for her to start speaking (within `startWithin` ms), then for
     * `quietMs` with nothing spoken. Times are ms from the call; started is
     * null if she never spoke.
     */
    waitVoice({ startWithin = 8000, quietMs = 1500, max = 60000 } = {}) {
      const t0 = Date.now();
      return new Promise((resolve) => {
        let started = voices > 0 ? t0 : null;
        const iv = setInterval(() => {
          const now = Date.now();
          if (!started && voices > 0) started = now;
          let out = null;
          if (!started && now - t0 > startWithin) out = { started: null };
          else if (started && voices === 0 && now - voiceEndedAt >= quietMs) out = { started: started - t0, ended: voiceEndedAt - t0 };
          else if (now - t0 > max) out = { started: started && started - t0, timeout: true };
          if (out) {
            clearInterval(iv);
            resolve(out);
          }
        }, 50);
      });
    },
    caption(text, sub = "") {
      cap.text = text;
      cap.sub = sub;
    },
    async start({ fps = 30, bitrate = 8_000_000 } = {}) {
      const canvas = document.querySelector("canvas.xr-canvas");
      const session = globalThis.__xr.activeSession;
      if (!canvas || !session) throw new Error("no XR canvas or session");
      const W = canvas.width;
      const H = canvas.height;
      const mirror = document.createElement("canvas");
      mirror.width = W;
      mirror.height = H;
      const g = mirror.getContext("2d");
      let chain = Promise.resolve();
      let frames = 0;
      let dropped = 0;
      // Encoded chunks go to Node in batches (every half second, or 512 KB):
      // one call per frame kept the DevTools connection so busy that the
      // script's own calls (aiming, pinching) waited up to 30 s behind them.
      let pend = [];
      let pendBytes = 0;
      const flush = () => {
        if (!pendBytes) return;
        const all = new Uint8Array(pendBytes);
        let o = 0;
        for (const p of pend) {
          all.set(p, o);
          o += p.length;
        }
        pend = [];
        pendBytes = 0;
        const b64 = toB64(all);
        chain = chain.then(() => globalThis.__saveVideo(b64));
      };
      const flusher = setInterval(flush, 500);
      const encoder = new VideoEncoder({
        output: (chunk) => {
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          pend.push(buf);
          pendBytes += buf.length;
          if (pendBytes > 512 * 1024) flush();
        },
        error: (e) => console.log("encoder error", e.message),
      });
      encoder.configure({
        codec: "avc1.4d0028",
        width: W,
        height: H,
        bitrate,
        framerate: fps,
        hardwareAcceleration: "prefer-hardware",
        latencyMode: "realtime",
        avc: { format: "annexb" },
      });
      let audioRec = null;
      let audioChain = Promise.resolve();
      if (tracks.length) {
        audioRec = new MediaRecorder(new MediaStream([tracks[0]]), { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 160000 });
        audioRec.ondataavailable = (e) => {
          if (!e.data.size) return;
          const blob = e.data;
          audioChain = audioChain.then(async () => globalThis.__saveAudio(toB64(new Uint8Array(await blob.arrayBuffer()))));
        };
      }
      const tick = 1000 / fps;
      let next = null;
      let on = true;
      const copy = () => {
        if (!on) return;
        const now = performance.now();
        g.drawImage(canvas, 0, 0, W, H);
        drawCaption(g, W, H);
        if (next === null) next = now;
        // One picture per call; ticks missed during a stall repeat it as cheap
        // clones (they share its pixels), so the stream stays exactly 30 fps.
        let base = null;
        while (now >= next) {
          if (encoder.encodeQueueSize > 900) {
            dropped++;
          } else {
            const ts = Math.round(frames * tick * 1000);
            base ??= new VideoFrame(mirror, { timestamp: ts, duration: Math.round(tick * 1000) });
            const vf = base.timestamp === ts ? base : new VideoFrame(base, { timestamp: ts, duration: Math.round(tick * 1000) });
            encoder.encode(vf, { keyFrame: frames % (fps * 2) === 0 });
            if (vf !== base) vf.close();
          }
          frames++;
          next += tick;
        }
        base?.close();
        if (globalThis.__xr.activeSession === session) session.requestAnimationFrame(copy);
      };
      const startedAt = Date.now();
      audioRec?.start(1000);
      const audioAt = Date.now();
      session.requestAnimationFrame(copy);
      state = {
        stop: async () => {
          on = false;
          await encoder.flush();
          clearInterval(flusher);
          flush();
          encoder.close();
          await chain;
          if (audioRec) {
            await new Promise((r) => {
              audioRec.onstop = r;
              audioRec.stop();
            });
            await new Promise((r) => setTimeout(r, 200));
            await audioChain;
          }
          return { frames, dropped };
        },
      };
      return { startedAt, audioAt, audio: !!audioRec, W, H };
    },
    stop() {
      return state ? state.stop() : null;
    },
  };
}

/** Wires the page's sinks to files. Call before navigating. */
export async function sinkTo(page, videoFile, audioFile) {
  for (const f of [videoFile, audioFile]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(0));
  }
  const bytes = { video: 0, audio: 0 };
  await page.exposeFunction("__saveVideo", (b64) => {
    const b = Buffer.from(b64, "base64");
    bytes.video += b.length;
    fs.appendFileSync(videoFile, b);
  });
  await page.exposeFunction("__saveAudio", (b64) => {
    const b = Buffer.from(b64, "base64");
    bytes.audio += b.length;
    fs.appendFileSync(audioFile, b);
  });
  return bytes;
}

/** Chrome's screencast into `dir` (for the 2D part); stop() returns frames with wall-clock times. */
export async function startScreencast(page, dir, { quality = 92 } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let n = 0;
  cdp.on("Page.screencastFrame", (f) => {
    const file = path.join(dir, `f${String(n++).padStart(6, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp * 1000 });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality, everyNthFrame: 1 });
  return {
    frames,
    async stop() {
      await cdp.send("Page.stopScreencast").catch(() => {});
      return frames;
    },
  };
}

/** An ffmpeg concat list that holds each frame until the next one. */
export function writeConcat(frames, listFile, endAt) {
  const lines = ["ffconcat version 1.0"];
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : endAt;
    lines.push(`file '${frames[i].file.replace(/\\/g, "/")}'`);
    lines.push(`duration ${Math.max(0.001, (next - frames[i].t) / 1000).toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file.replace(/\\/g, "/")}'`);
  fs.writeFileSync(listFile, lines.join("\n"));
}
