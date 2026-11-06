// The image step (§3.9): every image, from the file picker or the camera,
// goes through createImageBitmap, is scaled so its longest side is at most
// 1280 px (never up), and is encoded as JPEG at quality 0.85.

export const MAX_IMAGE_SIDE = 1280;
export const JPEG_QUALITY = 0.85;

/** The scaled size: longest side at most `max`, never scaled up, at least 1 px. */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function encode(bitmap: ImageBitmap, width: number, height: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext("2d");
    if (!g) throw new Error("No 2D canvas.");
    g.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("No 2D canvas.");
  g.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode the image."))), "image/jpeg", JPEG_QUALITY),
  );
}

/** Base64 JPEG (no data: prefix) of a picked file, a camera frame or any image blob. */
export async function prepareImage(source: Blob): Promise<string> {
  const bitmap = await createImageBitmap(source);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const jpeg = await encode(bitmap, width, height);
    return bytesToBase64(new Uint8Array(await jpeg.arrayBuffer()));
  } finally {
    bitmap.close();
  }
}
