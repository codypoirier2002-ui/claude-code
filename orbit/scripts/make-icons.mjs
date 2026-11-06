// Generates the PWA icon set (§12) into public/icons/ from an inline SVG:
//   icon-192.png, icon-512.png   purpose "any": a rounded square, transparent corners
//   icon-512-maskable.png        purpose "maskable": full-bleed, a smaller mark inside the safe zone
//
// Run with `npm run icons` after changing the artwork, and commit the PNGs.
// The colours are the app's own (src/ui/style.css): --bg, --mint and the amber
// orb of the CSS `.orb`.

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const BG = "#0f1218";
const MINT = "#7fd8c4";
const ORB = ["#fff1d6", "#ffb547", "#b8670c"];

/** Every icon in the set. `size` is the PNG's width and height in pixels. */
export const ICONS = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-512-maskable.png", size: 512, maskable: true },
];

/**
 * The artwork on a 512 x 512 canvas, rendered at `size` pixels: a mint ring
 * tilted -18 degrees around an amber orb. The ring's far half passes behind the
 * orb and its near half in front of it.
 */
export function iconSvg({ size, maskable }) {
  const ring = maskable ? { rx: 150, ry: 52, stroke: 12 } : { rx: 180, ry: 62, stroke: 14 };
  const orbRadius = maskable ? 92 : 110;
  const c = 256;
  const left = c - ring.rx;
  const right = c + ring.rx;
  const stroke = `fill="none" stroke="${MINT}" stroke-width="${ring.stroke}"`;
  const background = maskable
    ? `<rect width="512" height="512" fill="${BG}"/>`
    : `<rect width="512" height="512" rx="112" fill="${BG}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="orb" cx="0.36" cy="0.32" r="0.934">
      <stop offset="0" stop-color="${ORB[0]}"/>
      <stop offset="0.48" stop-color="${ORB[1]}"/>
      <stop offset="1" stop-color="${ORB[2]}"/>
    </radialGradient>
  </defs>
  ${background}
  <g transform="rotate(-18 ${c} ${c})">
    <ellipse cx="${c}" cy="${c}" rx="${ring.rx}" ry="${ring.ry}" ${stroke}/>
  </g>
  <circle cx="${c}" cy="${c}" r="${orbRadius}" fill="url(#orb)"/>
  <g transform="rotate(-18 ${c} ${c})">
    <path d="M ${right} ${c} A ${ring.rx} ${ring.ry} 0 0 1 ${left} ${c}" ${stroke}/>
  </g>
</svg>
`;
}

/** Writes the whole set into `outDir` and returns the file paths. */
export async function makeIcons(outDir) {
  await mkdir(outDir, { recursive: true });
  const written = [];
  for (const icon of ICONS) {
    const file = join(outDir, icon.file);
    await sharp(Buffer.from(iconSvg(icon)))
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(file);
    written.push(file);
  }
  return written;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = await makeIcons(resolve(root, process.argv[2] ?? "public/icons"));
  for (const file of files) console.log(`wrote ${file}`);
}
