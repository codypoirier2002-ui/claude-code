// Gives dist/sw.js a cache name that changes with every build (§18), so the
// worker's activate step can delete the previous build's cache and old hashed
// files never pile up. npm runs this as the "postbuild" hook after `vite build`
// (and so does Vercel, through `npm run build`).
//
// The id is a short hash of dist/index.html plus the names of the files in
// dist/assets/ (Vite puts a content hash in each name). Rebuilding unchanged
// source keeps the same id; any change to the built app gives a new one.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The value public/sw.js carries until the build replaces it. */
export const BUILD_TOKEN = "__ORBIT_BUILD__";

/** A 10-character id for the build in `distDir`. */
export function buildId(distDir) {
  const hash = createHash("sha256");
  hash.update(readFileSync(join(distDir, "index.html")));
  const assets = join(distDir, "assets");
  const names = existsSync(assets) ? readdirSync(assets).sort() : [];
  for (const name of names) hash.update(`\n${name}`);
  return hash.digest("hex").slice(0, 10);
}

/** Returns the worker's source with the build id in place of the token. */
export function stampServiceWorker(source, id) {
  if (!source.includes(BUILD_TOKEN)) {
    throw new Error(`sw.js has no ${BUILD_TOKEN} to replace (stamped already? run the build again).`);
  }
  return source.split(BUILD_TOKEN).join(id);
}

/** Stamps dist/sw.js in place and returns the id it used. */
export function stampDist(distDir) {
  const file = join(distDir, "sw.js");
  if (!existsSync(file)) throw new Error(`${file} not found: run \`vite build\` first.`);
  const id = buildId(distDir);
  writeFileSync(file, stampServiceWorker(readFileSync(file, "utf8"), id));
  return id;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const id = stampDist(resolve(root, process.argv[2] ?? "dist"));
  console.log(`sw.js cache: orbit-v1-${id}`);
}
