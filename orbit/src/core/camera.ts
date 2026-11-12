// The headset camera (§4.6): one frame from getUserMedia, for 👁 in the
// composer and for look phrases in the hands-free session (LOOK_PHRASE in
// session.ts). The frame goes through the same image step as a picked file
// (§3.9, images.ts) and comes back as base64 JPEG.

import { prepareImage } from "./images";

export const CAMERA_TEXT = {
  denied: "Camera permission was denied. Allow it in the browser's site settings.",
  notFound: "No camera found. On Quest 3, update Horizon OS and allow camera access for the browser.",
  failed: "Couldn't open the camera.",
} as const;

/** The getUserMedia request (§4.6 step 1). */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
  audio: false,
};

/** How long the stream plays before the frame is taken, so the exposure settles. */
export const SETTLE_MS = 450;
/** The capture's own JPEG quality, before the image step re-encodes it at 0.85. */
export const CAPTURE_QUALITY = 0.9;

/** The error a failed capture throws; `message` is the user-facing copy. */
export class CameraError extends Error {
  constructor(
    readonly kind: "denied" | "not-found" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "CameraError";
  }
}

/** Maps a getUserMedia (or capture) failure to the §4.6 copy. */
export function cameraError(err: unknown): CameraError {
  if (err instanceof CameraError) return err;
  const name = typeof err === "object" && err !== null ? String((err as { name?: unknown }).name ?? "") : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return new CameraError("denied", CAMERA_TEXT.denied);
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return new CameraError("not-found", CAMERA_TEXT.notFound);
  }
  return new CameraError("failed", CAMERA_TEXT.failed);
}

/** The video element and canvas the capture uses (tests pass fakes). */
export interface FrameSurface {
  video: HTMLVideoElement;
  /** Draws the video's current frame and encodes it as JPEG at `quality`. */
  encode(video: HTMLVideoElement, quality: number): Promise<Blob>;
}

export interface CameraDeps {
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  surface?: () => FrameSurface;
  wait?: (ms: number) => Promise<void>;
  prepare?: (blob: Blob) => Promise<string>;
}

function defaultGetUserMedia(c: MediaStreamConstraints): Promise<MediaStream> {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!md || typeof md.getUserMedia !== "function") return Promise.reject(new DOMException("No camera", "NotFoundError"));
  return md.getUserMedia(c);
}

function defaultSurface(): FrameSurface {
  return {
    video: document.createElement("video"),
    encode(video, quality) {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 960;
      const g = canvas.getContext("2d");
      if (!g) return Promise.reject(new Error("No 2D canvas."));
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      return new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode the frame."))), "image/jpeg", quality),
      );
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Takes one camera frame (§4.6): open the camera, play it muted and inline,
 * wait 450 ms, draw one frame as JPEG at 0.9, always stop the tracks, then run
 * it through the image step. Resolves to base64 JPEG; rejects with a CameraError.
 */
export async function captureFrame(deps: CameraDeps = {}): Promise<string> {
  const getUserMedia = deps.getUserMedia ?? defaultGetUserMedia;
  let stream: MediaStream;
  try {
    stream = await getUserMedia(CAMERA_CONSTRAINTS);
  } catch (err) {
    throw cameraError(err);
  }
  let jpeg: Blob;
  const surface = (deps.surface ?? defaultSurface)();
  const { video } = surface;
  try {
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.srcObject = stream;
    await video.play();
    await (deps.wait ?? sleep)(SETTLE_MS);
    jpeg = await surface.encode(video, CAPTURE_QUALITY);
  } catch {
    // The camera opened, so permission and presence are fine: playback or the frame failed.
    throw new CameraError("failed", CAMERA_TEXT.failed);
  } finally {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // already stopped
      }
    }
    try {
      video.pause();
      video.srcObject = null;
    } catch {
      // nothing to release
    }
  }
  try {
    return await (deps.prepare ?? prepareImage)(jpeg);
  } catch {
    throw new CameraError("failed", CAMERA_TEXT.failed);
  }
}
