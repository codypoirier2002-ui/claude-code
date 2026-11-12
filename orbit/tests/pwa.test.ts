// Everything that ships the app as a PWA and a Quest-store package (§12): the web
// manifest, the icon set and the script that draws it, vercel.json, the two TWA
// templates and the .gitignore that keeps signing material out of the repo.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Drawing the icons and decoding PNGs is native work: leave room for a busy machine.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const root = resolve(__dirname, "..");
const read = (file: string): string => readFileSync(resolve(root, file), "utf8");

interface WebManifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  categories: string[];
  icons: { src: string; sizes: string; type: string; purpose: string }[];
}

interface VercelConfig {
  buildCommand: string;
  outputDirectory: string;
  headers: { source: string; headers: { key: string; value: string }[] }[];
}

type TwaManifest = Record<string, unknown> & { signingKey: { path: string; alias: string } };

const manifest = JSON.parse(read("public/manifest.webmanifest")) as WebManifest;

// ---- Web manifest ---------------------------------------------------------------------

describe("web manifest", () => {
  it("names the app and describes it", () => {
    expect(manifest.name).toBe("Orbit: AI Assistant");
    expect(manifest.short_name).toBe("Orbit");
    expect(manifest.description).toBe(
      "An all-in-one Claude assistant for Meta Quest: chat, voice, web search, timers, tasks, notes and an immersive VR mode.",
    );
  });

  it("starts and scopes at the app root, standalone and landscape", () => {
    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
    expect(manifest.display).toBe("standalone");
    expect(manifest.orientation).toBe("landscape");
  });

  it("uses the app's dark background for both colours, and lists its categories", () => {
    expect(manifest.background_color).toBe("#0f1218");
    expect(manifest.theme_color).toBe("#0f1218");
    expect(manifest.categories).toEqual(["productivity", "utilities"]);
  });

  it("lists a 192 and a 512 icon for any use, and a maskable 512", () => {
    expect(manifest.icons).toEqual([
      { src: "./icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "./icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "./icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });

  it("points at icon files that exist, at the sizes it claims", async () => {
    for (const icon of manifest.icons) {
      const meta = await sharp(resolve(root, "public", icon.src)).metadata();
      expect(`${meta.width}x${meta.height}`, icon.src).toBe(icon.sizes);
      expect(meta.format, icon.src).toBe("png");
    }
  });

  it("matches the page that links it", () => {
    const page = read("index.html");
    expect(page).toContain('<link rel="manifest" href="./manifest.webmanifest" />');
    expect(page).toContain(`<meta name="theme-color" content="${manifest.theme_color}" />`);
    expect(page).toContain('<link rel="icon" href="./icons/icon-192.png" />');
    expect(page).toContain('<link rel="apple-touch-icon" href="./icons/icon-192.png" />');
  });
});

// ---- vercel.json and package.json -----------------------------------------------------

describe("vercel.json", () => {
  const vercel = JSON.parse(read("vercel.json")) as VercelConfig;
  const headersFor = (source: string) => Object.fromEntries((vercel.headers.find((h) => h.source === source)?.headers ?? []).map((h) => [h.key, h.value]));

  it("builds with npm run build into dist", () => {
    expect(vercel.buildCommand).toBe("npm run build");
    expect(vercel.outputDirectory).toBe("dist");
  });

  it("never caches the service worker", () => {
    expect(headersFor("/sw.js")).toEqual({ "Cache-Control": "no-cache" });
  });

  it("serves the manifest as application/manifest+json", () => {
    expect(headersFor("/manifest.webmanifest")).toEqual({ "Content-Type": "application/manifest+json" });
  });

  it("allows the microphone and WebXR tracking for the app itself, on every path", () => {
    expect(headersFor("/(.*)")).toEqual({ "Permissions-Policy": "microphone=(self), xr-spatial-tracking=(self)" });
    expect(vercel.headers.map((h) => h.source)).toEqual(["/sw.js", "/manifest.webmanifest", "/(.*)"]);
  });
});

describe("package.json scripts", () => {
  const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;

  it("draws the icons and stamps the service worker after every build", () => {
    expect(scripts.icons).toBe("node scripts/make-icons.mjs");
    expect(scripts.build).toBe("tsc --noEmit && vite build");
    expect(scripts.postbuild).toBe("node scripts/stamp-sw.mjs");
  });
});

// ---- Icons ----------------------------------------------------------------------------

type RGB = readonly [number, number, number];
const BG: RGB = [0x0f, 0x12, 0x18];
const MINT: RGB = [0x7f, 0xd8, 0xc4];
const HIGHLIGHT: RGB = [0xff, 0xf1, 0xd6];

interface IconSpec {
  file: string;
  size: number;
  maskable: boolean;
}

const ICON_SPECS: IconSpec[] = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-512-maskable.png", size: 512, maskable: true },
];

/** A point on the ring's centre line on the 512 canvas: ellipse point (rx cos t, ry sin t), tilted -18 degrees about the centre. */
function ringPoint(rx: number, ry: number, t: number): [number, number] {
  const a = (-18 * Math.PI) / 180;
  const x = rx * Math.cos(t);
  const y = ry * Math.sin(t);
  return [256 + x * Math.cos(a) - y * Math.sin(a), 256 + x * Math.sin(a) + y * Math.cos(a)];
}

/** The largest per-channel difference between two colours. */
const distance = (a: RGB, b: RGB): number => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

interface Raster {
  size: number;
  at(x: number, y: number): { rgb: RGB; alpha: number };
  data: Buffer;
}

async function raster(file: string): Promise<Raster> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const scale = info.width / 512;
  return {
    size: info.width,
    data,
    // Coordinates are on the 512 canvas whatever the icon's own size.
    at(x, y) {
      const px = (v: number) => Math.min(info.width - 1, Math.round(v * scale));
      const o = (px(y) * info.width + px(x)) * 4;
      return { rgb: [data[o], data[o + 1], data[o + 2]], alpha: data[o + 3] };
    },
  };
}

interface IconScript {
  makeIcons(outDir: string): Promise<string[]>;
}

let generatedDir = "";

beforeAll(async () => {
  // Node loads the plain .mjs script directly; sharp does the drawing.
  const script = (await import(/* @vite-ignore */ pathToFileURL(resolve(root, "scripts/make-icons.mjs")).href)) as IconScript;
  generatedDir = mkdtempSync(join(tmpdir(), "orbit-icons-"));
  await script.makeIcons(generatedDir);
});

afterAll(() => {
  if (generatedDir) rmSync(generatedDir, { recursive: true, force: true });
});

const ICON_DIRS: [string, () => string][] = [
  ["committed", () => resolve(root, "public/icons")],
  ["freshly generated", () => generatedDir],
];

describe.each(ICON_DIRS)("%s icons", (_label, dirOf) => {
  it.each(ICON_SPECS)("$file is a $size px PNG", async ({ file, size }) => {
    const meta = await sharp(join(dirOf(), file)).metadata();
    expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(["png", size, size, true]);
  });

  it.each(ICON_SPECS)("$file draws the ring and the orb at the specified size and place", async ({ file, maskable }) => {
    const img = await raster(join(dirOf(), file));
    const ring = maskable ? { rx: 150, ry: 52 } : { rx: 180, ry: 62 };
    const orbRadius = maskable ? 92 : 110;
    const mintAt = (t: number) => img.at(...ringPoint(ring.rx, ring.ry, t));

    // Both ends of the ring and its near side (which crosses the orb) are mint.
    expect(distance(mintAt(Math.PI).rgb, MINT), "ring, left end").toBeLessThanOrEqual(8);
    expect(distance(mintAt(0).rgb, MINT), "ring, right end").toBeLessThanOrEqual(8);
    expect(distance(mintAt(Math.PI / 2).rgb, MINT), "ring, near side over the orb").toBeLessThanOrEqual(8);
    // The far side passes behind the orb, so the orb shows there.
    expect(mintAt(-Math.PI / 2).rgb[0], "ring, far side hidden").toBeGreaterThan(200);

    // The orb's highlight sits at 36% / 32% of its box and starts at #fff1d6.
    const highlight = img.at(256 - orbRadius + 0.36 * 2 * orbRadius, 256 - orbRadius + 0.32 * 2 * orbRadius);
    expect(distance(highlight.rgb, HIGHLIGHT), "orb highlight").toBeLessThanOrEqual(8);
    // Just outside the orb, away from the ring, it is still the dark background.
    expect(distance(img.at(256, 256 - orbRadius - 20).rgb, BG), "background above the orb").toBeLessThanOrEqual(2);
  });

  it("rounds the corners of the 'any' icons and fills the maskable one to its edges", async () => {
    for (const { file, maskable } of ICON_SPECS) {
      const img = await raster(join(dirOf(), file));
      for (const [x, y] of [[0, 0], [511, 0], [0, 511], [511, 511]]) {
        const px = img.at(x, y);
        if (maskable) {
          expect([px.alpha, distance(px.rgb, BG)], `${file} corner ${x},${y}`).toEqual([255, 0]);
        } else {
          expect(px.alpha, `${file} corner ${x},${y}`).toBe(0);
        }
      }
      // The middle of an edge is inside every icon.
      const edge = img.at(256, 4);
      expect([edge.alpha, distance(edge.rgb, BG)], `${file} top edge`).toEqual([255, 0]);
    }
  });

  it("keeps the maskable mark inside the 80% safe circle", async () => {
    const img = await raster(join(dirOf(), "icon-512-maskable.png"));
    const half = img.size / 2;
    let outside = 0;
    for (let y = 0; y < img.size; y++) {
      for (let x = 0; x < img.size; x++) {
        const o = (y * img.size + x) * 4;
        const differs = distance([img.data[o], img.data[o + 1], img.data[o + 2]], BG) > 12;
        if (differs && Math.hypot(x + 0.5 - half, y + 0.5 - half) > 0.4 * img.size + 1) outside++;
      }
    }
    expect(outside).toBe(0);
  });
});

// ---- Quest store (TWA) templates ------------------------------------------------------

describe("TWA templates", () => {
  const FILES = ["twa/twa-manifest.template.json", "twa/twa-manifest.immersive.template.json"];
  const [twa2d, twaVr] = FILES.map((file) => JSON.parse(read(file)) as TwaManifest);

  it("share the app's identity and the Quest settings", () => {
    for (const twa of [twa2d, twaVr]) {
      expect(twa).toMatchObject({
        packageId: "com.REPLACE_ORG.orbit",
        host: "REPLACE_DOMAIN",
        name: "Orbit: AI Assistant",
        launcherName: "Orbit",
        display: "standalone",
        orientation: "landscape",
        themeColor: "#0f1218",
        backgroundColor: "#0f1218",
        isMetaQuest: true,
        minSdkVersion: 23,
        fallbackType: "customtabs",
      });
    }
  });

  it("differ only in the app mode and the start URL", () => {
    expect(twa2d.horizonOSAppMode).toBe("2D");
    expect(twa2d.startUrl).toBe("/");
    expect(twaVr.horizonOSAppMode).toBe("immersive");
    expect(twaVr.startUrl).toBe("/?launch=vr");
    const { horizonOSAppMode: _mode2d, startUrl: _start2d, ...shared2d } = twa2d;
    const { horizonOSAppMode: _modeVr, startUrl: _startVr, ...sharedVr } = twaVr;
    expect(shared2d).toEqual(sharedVr);
  });

  it("find the app's icons and manifest on the placeholder domain", () => {
    for (const twa of [twa2d, twaVr]) {
      expect(twa.iconUrl).toBe("https://REPLACE_DOMAIN/icons/icon-512.png");
      expect(twa.maskableIconUrl).toBe("https://REPLACE_DOMAIN/icons/icon-512-maskable.png");
      expect(twa.webManifestUrl).toBe("https://REPLACE_DOMAIN/manifest.webmanifest");
      expect(twa.fullScopeUrl).toBe("https://REPLACE_DOMAIN/");
    }
  });

  it("have exactly the known fields, so no credential field can slip in", () => {
    const known = [
      "appVersionCode", "appVersionName", "backgroundColor", "display", "enableNotifications", "fallbackType", "fullScopeUrl",
      "horizonOSAppMode", "host", "iconUrl", "isMetaQuest", "launcherName", "maskableIconUrl", "minSdkVersion", "name",
      "navigationColor", "orientation", "packageId", "signingKey", "splashScreenFadeOutDuration", "startUrl", "themeColor",
      "webManifestUrl",
    ];
    for (const twa of [twa2d, twaVr]) expect(Object.keys(twa).sort()).toEqual(known);
  });

  it("name the keystore only as a labelled placeholder, to be kept outside the repo", () => {
    for (const twa of [twa2d, twaVr]) {
      expect(twa.signingKey).toEqual({
        path: "REPLACE_WITH_ABSOLUTE_PATH_TO_YOUR_KEYSTORE_OUTSIDE_THIS_REPO",
        alias: "REPLACE_WITH_YOUR_KEY_ALIAS",
      });
    }
  });

  it("start from the first app version", () => {
    expect([twa2d.appVersionName, twa2d.appVersionCode]).toEqual(["1.0.0", 1]);
  });
});

// ---- .gitignore -----------------------------------------------------------------------

describe(".gitignore", () => {
  const lines = read(".gitignore")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  it("keeps keystores out of the repo, in every common format", () => {
    for (const entry of ["*.keystore", "*.jks", "*.p12", "*.pfx", "keystore.properties"]) {
      expect(lines, entry).toContain(entry);
    }
  });

  it("keeps the TWA build outputs, .vercel and local env files out", () => {
    for (const entry of ["twa/app", "twa/android", "twa/*.apk", "twa/*.aab", ".vercel", ".env.local"]) {
      expect(lines, entry).toContain(entry);
    }
  });

  it("tracks only the two templates in twa/", () => {
    expect(lines).toContain("twa/*");
    expect(lines).toContain("!twa/twa-manifest.template.json");
    expect(lines).toContain("!twa/twa-manifest.immersive.template.json");
    expect(lines.filter((line) => line.startsWith("!twa/"))).toHaveLength(2);
  });
});
