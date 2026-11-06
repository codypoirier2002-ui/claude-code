// The service worker (public/sw.js, §12) runs here in a fake worker scope: the
// script is evaluated with a stand-in `self`, a Map-backed Cache API and a mock
// `fetch`, then driven by hand-made install, activate and fetch events.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const SW_SOURCE = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");
const STAMP_SCRIPT = resolve(__dirname, "../scripts/stamp-sw.mjs");
const BUILD_TOKEN = "__ORBIT_BUILD__";
const ORIGIN = "https://orbit.test";

// ---- A fake worker scope --------------------------------------------------------------

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
  headers: Headers;
}

function request(
  path: string,
  init: { method?: string; mode?: string; headers?: Record<string, string>; origin?: string } = {},
): FakeRequest {
  return {
    url: new URL(path, init.origin ?? ORIGIN).href,
    method: init.method ?? "GET",
    mode: init.mode ?? "no-cors",
    headers: new Headers(init.headers),
  };
}

const keyOf = (r: FakeRequest | string): string => (typeof r === "string" ? new URL(r, ORIGIN).href : r.url);

class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(r: FakeRequest | string): Promise<Response | undefined> {
    return this.entries.get(keyOf(r))?.clone();
  }

  async put(r: FakeRequest | string, response: Response): Promise<void> {
    if (response.bodyUsed) throw new TypeError("put() of a response whose body was already read");
    this.entries.set(keyOf(r), response);
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  readonly opened: string[] = [];

  async open(name: string): Promise<FakeCache> {
    this.opened.push(name);
    let cache = this.stores.get(name);
    if (!cache) this.stores.set(name, (cache = new FakeCache()));
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  async match(r: FakeRequest | string, options?: { cacheName?: string }): Promise<Response | undefined> {
    for (const name of options?.cacheName ? [options.cacheName] : [...this.stores.keys()]) {
      const hit = await this.stores.get(name)?.match(r);
      if (hit) return hit;
    }
    return undefined;
  }
}

const text = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/plain" }, ...init });
const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

interface Worker {
  caches: FakeCacheStorage;
  fetch: ReturnType<typeof vi.fn<(r: FakeRequest) => Promise<Response>>>;
  skipWaiting: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
  /** The cache this build writes to, as named by the stamped source. */
  cache: FakeCache;
  cacheName: string;
  install(): Promise<void>;
  activate(): Promise<void>;
  /** Sends a fetch event. `handled` is false when the worker left the request alone. */
  get(r: FakeRequest): Promise<{ handled: boolean; response: Response | null; error: unknown }>;
}

/** Evaluates sw.js (stamped with `build`) in a fake scope served from `scope`. */
function startWorker(options: { build?: string; scope?: string } = {}): Worker {
  const build = options.build ?? "test-build";
  const scope = options.scope ?? `${ORIGIN}/`;
  const listeners = new Map<string, (event: object) => void>();
  const caches = new FakeCacheStorage();
  const fetchMock = vi.fn<(r: FakeRequest) => Promise<Response>>(async (r) => text(`network:${new URL(r.url).pathname}`));
  const skipWaiting = vi.fn(() => Promise.resolve());
  const claim = vi.fn(() => Promise.resolve());
  const self = {
    registration: { scope },
    location: new URL(`${scope}sw.js`),
    skipWaiting,
    clients: { claim },
    addEventListener: (type: string, fn: (event: object) => void) => listeners.set(type, fn),
  };
  const source = SW_SOURCE.split(BUILD_TOKEN).join(build);
  new Function("self", "caches", "fetch", source)(self, caches, fetchMock);

  const lifecycle = async (type: string): Promise<void> => {
    const pending: Promise<unknown>[] = [];
    listeners.get(type)?.({ waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  };

  const cacheName = `orbit-v1-${build}`;
  if (!caches.stores.has(cacheName)) caches.stores.set(cacheName, new FakeCache());

  return {
    caches,
    fetch: fetchMock,
    skipWaiting,
    claim,
    cache: caches.stores.get(cacheName) as FakeCache,
    cacheName,
    install: () => lifecycle("install"),
    activate: () => lifecycle("activate"),
    async get(r) {
      let answer: Promise<Response> | Response | undefined;
      const pending: Promise<unknown>[] = [];
      listeners.get("fetch")?.({
        request: r,
        respondWith: (p: Promise<Response> | Response) => {
          answer = p;
        },
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      });
      let response: Response | null = null;
      let error: unknown;
      if (answer !== undefined) {
        try {
          response = await answer;
        } catch (err) {
          error = err;
        }
      }
      // waitUntil work can start more work (the background refresh stores what it fetched).
      for (let seen = 0; seen < pending.length; ) {
        const batch = pending.slice(seen);
        seen = pending.length;
        await Promise.all(batch);
      }
      return { handled: answer !== undefined, response, error };
    },
  };
}

// ---- Install, activate and the cache name ---------------------------------------------

describe("install and activate", () => {
  it("installs by taking over at once", async () => {
    const w = startWorker();
    await w.install();
    expect(w.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("activates by deleting the other Orbit caches, then claiming the open pages", async () => {
    const w = startWorker({ build: "new" });
    await w.caches.open("orbit-v1-old");
    await w.caches.open("orbit-v0");
    await w.caches.open("some-other-app");
    await w.activate();
    expect([...w.caches.stores.keys()].sort()).toEqual(["orbit-v1-new", "some-other-app"]);
    expect(w.claim).toHaveBeenCalledTimes(1);
  });

  it("names its cache orbit-v1 plus the build id, and writes only there", async () => {
    const w = startWorker({ build: "3fa9c1d2b7" });
    expect(w.cacheName).toBe("orbit-v1-3fa9c1d2b7");
    await w.get(request("/assets/index-abc.js"));
    expect(w.caches.opened).toEqual(["orbit-v1-3fa9c1d2b7"]);
    expect([...w.caches.stores.keys()]).toEqual(["orbit-v1-3fa9c1d2b7"]);
  });

  it("gives each build its own cache, so an update drops the previous build's files", async () => {
    const v1 = startWorker({ build: "aaaaaaaaaa" });
    await v1.get(request("/assets/index-old.js"));
    const v2 = startWorker({ build: "bbbbbbbbbb" });
    v2.caches.stores.set("orbit-v1-aaaaaaaaaa", v1.cache);
    await v2.activate();
    expect([...v2.caches.stores.keys()]).toEqual(["orbit-v1-bbbbbbbbbb"]);
  });
});

// ---- What it must never touch ---------------------------------------------------------

describe("requests it leaves alone", () => {
  function expectUntouched(w: Worker, result: { handled: boolean }): void {
    expect(result.handled).toBe(false);
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.caches.opened).toEqual([]);
    expect(w.cache.entries.size).toBe(0);
  }

  it("never handles a cross-origin request: the Claude API, a proxy or ElevenLabs", async () => {
    const w = startWorker();
    for (const url of [
      "https://api.anthropic.com/v1/messages",
      "https://api.elevenlabs.io/v1/text-to-speech/7YaUDeaStRuoYg3FKsmU/stream",
      "https://api.elevenlabs.io/v1/user",
      "https://orbit-proxy.example.com/v1/messages",
      "https://cdn.example.com/assets/index-abc.js",
    ]) {
      const origin = new URL(url).origin;
      expectUntouched(w, await w.get(request(url, { origin })));
    }
  });

  it("never handles a POST or any other method, even to the app's own paths", async () => {
    const w = startWorker();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expectUntouched(w, await w.get(request("/v1/messages", { method })));
      expectUntouched(w, await w.get(request("/assets/index-abc.js", { method })));
      expectUntouched(w, await w.get(request("/", { method, mode: "navigate" })));
    }
  });

  it("skips a same-origin GET that carries an API key header, even under /assets/", async () => {
    const w = startWorker();
    for (const header of ["x-api-key", "xi-api-key", "authorization", "anthropic-version", "anthropic-beta"]) {
      expectUntouched(w, await w.get(request("/assets/index-abc.js", { headers: { [header]: "value" } })));
      expectUntouched(w, await w.get(request("/v1/models", { headers: { [header]: "value" } })));
    }
  });

  it("passes every other same-origin GET straight through", async () => {
    const w = startWorker();
    for (const path of ["/manifest.webmanifest", "/icons/icon-192.png", "/sw.js", "/favicon.ico", "/api/proxy", "/v1/models", "/assetsx/a.js", "/skies"]) {
      expectUntouched(w, await w.get(request(path)));
    }
  });

  it("leaves Range requests to the network, so partial files are never stored or served", async () => {
    const w = startWorker();
    for (const path of ["/assets/clip.mp4", "/ambience/beach.ogg", "/skies/beach.jpg"]) {
      expectUntouched(w, await w.get(request(path, { headers: { range: "bytes=0-1023" } })));
    }
  });
});

// ---- Pages: network first -------------------------------------------------------------

describe("page navigations", () => {
  const navigate = (path = "/") => request(path, { mode: "navigate" });

  it("answers from the network and keeps the page under the root", async () => {
    const w = startWorker();
    w.fetch.mockResolvedValueOnce(html("<p>fresh</p>"));
    const { handled, response } = await w.get(navigate("/?launch=vr"));
    expect(handled).toBe(true);
    expect(await response?.text()).toBe("<p>fresh</p>");
    expect([...w.cache.entries.keys()]).toEqual([`${ORIGIN}/`]);
    expect(await w.cache.entries.get(`${ORIGIN}/`)?.text()).toBe("<p>fresh</p>");
  });

  it("prefers the network over what it stored before", async () => {
    const w = startWorker();
    w.fetch.mockResolvedValueOnce(html("old"));
    await w.get(navigate());
    w.fetch.mockResolvedValueOnce(html("new"));
    const { response } = await w.get(navigate());
    expect(await response?.text()).toBe("new");
    expect(await w.cache.entries.get(`${ORIGIN}/`)?.text()).toBe("new");
  });

  it("serves the stored page for any navigation when offline", async () => {
    const w = startWorker();
    w.fetch.mockResolvedValueOnce(html("the shell"));
    await w.get(navigate());
    w.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    for (const path of ["/", "/?launch=vr", "/index.html"]) {
      const { response } = await w.get(navigate(path));
      expect(await response?.text(), path).toBe("the shell");
    }
  });

  it("fails like a normal offline page load when nothing is stored yet", async () => {
    const w = startWorker();
    w.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const { response, error } = await w.get(navigate());
    expect(error).toBeUndefined();
    expect(response?.type).toBe("error");
  });

  it("never replaces the stored page with an error page, or a file that is not HTML", async () => {
    const w = startWorker();
    w.fetch.mockResolvedValueOnce(html("good"));
    await w.get(navigate());
    for (const bad of [
      html("not found", { status: 404 }),
      html("server error", { status: 500 }),
      text("console.log(1)", { headers: { "content-type": "text/javascript" } }),
      new Response(null, { status: 200 }),
    ]) {
      w.fetch.mockResolvedValueOnce(bad);
      await w.get(navigate("/somewhere"));
    }
    expect(await w.cache.entries.get(`${ORIGIN}/`)?.text()).toBe("good");
    expect(w.cache.entries.size).toBe(1);
  });

  it("hands the page the network's own response, error pages included", async () => {
    const w = startWorker();
    w.fetch.mockResolvedValueOnce(html("not found", { status: 404 }));
    const { response } = await w.get(navigate("/missing"));
    expect(response?.status).toBe(404);
  });
});

// ---- /assets/: cache first ------------------------------------------------------------

describe("built files under /assets/", () => {
  it("fetches once, then answers from the cache", async () => {
    const w = startWorker();
    const first = await w.get(request("/assets/index-abc.js"));
    expect(await first.response?.text()).toBe("network:/assets/index-abc.js");
    expect(w.cache.entries.has(`${ORIGIN}/assets/index-abc.js`)).toBe(true);
    w.fetch.mockClear();
    const second = await w.get(request("/assets/index-abc.js"));
    expect(await second.response?.text()).toBe("network:/assets/index-abc.js");
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it("stores only complete (200) responses", async () => {
    const w = startWorker();
    w.fetch.mockResolvedValueOnce(text("missing", { status: 404 }));
    const missing = await w.get(request("/assets/gone.js"));
    expect(missing.response?.status).toBe(404);
    w.fetch.mockResolvedValueOnce(text("partial", { status: 206 }));
    await w.get(request("/assets/partial.js"));
    expect(w.cache.entries.size).toBe(0);
  });

  it("keeps serving stored files when offline and fails for files it never stored", async () => {
    const w = startWorker();
    await w.get(request("/assets/index-abc.js"));
    w.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const hit = await w.get(request("/assets/index-abc.js"));
    expect(await hit.response?.text()).toBe("network:/assets/index-abc.js");
    const miss = await w.get(request("/assets/other.js"));
    expect(miss.error).toBeInstanceOf(TypeError);
  });
});

// ---- /skies/, /character/, /ambience/: stale while revalidate -------------------------

describe("scenes, her art and the soundscapes", () => {
  const files = ["/skies/beach.jpg", "/skies/thumbs/beach.jpg", "/character/base.webp", "/ambience/forest.ogg"];

  it("fetches and stores a file the first time", async () => {
    for (const path of files) {
      const w = startWorker();
      const { handled, response } = await w.get(request(path));
      expect(handled, path).toBe(true);
      expect(await response?.text()).toBe(`network:${path}`);
      expect(await w.cache.entries.get(`${ORIGIN}${path}`)?.text()).toBe(`network:${path}`);
    }
  });

  it("answers from what it stored and refreshes the stored copy behind it", async () => {
    const w = startWorker();
    w.fetch.mockResolvedValueOnce(text("version 1"));
    await w.get(request("/skies/beach.jpg"));
    w.fetch.mockResolvedValueOnce(text("version 2"));
    const { response } = await w.get(request("/skies/beach.jpg"));
    expect(await response?.text()).toBe("version 1");
    expect(w.fetch).toHaveBeenCalledTimes(2);
    expect(await w.cache.entries.get(`${ORIGIN}/skies/beach.jpg`)?.text()).toBe("version 2");
  });

  it("serves the stored copy when the refresh fails offline, and fails when there is none", async () => {
    const w = startWorker();
    await w.get(request("/ambience/lake.ogg"));
    w.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const hit = await w.get(request("/ambience/lake.ogg"));
    expect(hit.error).toBeUndefined();
    expect(await hit.response?.text()).toBe("network:/ambience/lake.ogg");
    const miss = await w.get(request("/ambience/loft.ogg"));
    expect(miss.error).toBeInstanceOf(TypeError);
  });

  it("does not store a failed refresh over a good copy", async () => {
    const w = startWorker();
    w.fetch.mockResolvedValueOnce(text("good"));
    await w.get(request("/character/face.webp"));
    w.fetch.mockResolvedValueOnce(text("gone", { status: 404 }));
    await w.get(request("/character/face.webp"));
    expect(await w.cache.entries.get(`${ORIGIN}/character/face.webp`)?.text()).toBe("good");
  });
});

// ---- A worker served from a sub-folder ------------------------------------------------

describe("an app deployed under a sub-folder", () => {
  const scope = `${ORIGIN}/orbit/`;

  it("applies the path rules relative to the worker's scope", async () => {
    const w = startWorker({ scope });
    expect((await w.get(request("/orbit/assets/a.js"))).handled).toBe(true);
    expect((await w.get(request("/orbit/skies/beach.jpg"))).handled).toBe(true);
    expect((await w.get(request("/assets/a.js"))).handled).toBe(false);
    expect((await w.get(request("/skies/beach.jpg"))).handled).toBe(false);
  });

  it("keeps the page under the scope's root", async () => {
    const w = startWorker({ scope });
    w.fetch.mockResolvedValueOnce(html("sub-folder shell"));
    await w.get(request("/orbit/?launch=vr", { mode: "navigate" }));
    expect([...w.cache.entries.keys()]).toEqual([scope]);
  });
});

// ---- The build stamp ------------------------------------------------------------------

interface StampScript {
  BUILD_TOKEN: string;
  buildId(distDir: string): string;
  stampServiceWorker(source: string, id: string): string;
  stampDist(distDir: string): string;
}

describe("scripts/stamp-sw.mjs", () => {
  let stamp: StampScript;
  const dirs: string[] = [];

  beforeAll(async () => {
    // Node loads it directly: it is a plain .mjs build script, not part of the app.
    stamp = (await import(/* @vite-ignore */ pathToFileURL(STAMP_SCRIPT).href)) as StampScript;
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A fake dist/: an index page, hashed assets and the unstamped worker. */
  function makeDist(assets: string[] = ["index-AbC123.js", "index-9xYz.css"], index = "<html>orbit</html>"): string {
    const root = mkdtempSync(join(tmpdir(), "orbit-stamp-"));
    dirs.push(root);
    const dist = join(root, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), index);
    for (const name of assets) writeFileSync(join(dist, "assets", name), "// built");
    cpSync(resolve(__dirname, "../public/sw.js"), join(dist, "sw.js"));
    return dist;
  }

  it("ships a worker with exactly the placeholder the script replaces", () => {
    expect(stamp.BUILD_TOKEN).toBe(BUILD_TOKEN);
    expect(SW_SOURCE.split(BUILD_TOKEN)).toHaveLength(2);
    expect(SW_SOURCE).toContain(`const BUILD = "${BUILD_TOKEN}";`);
  });

  it("replaces the placeholder with a 10-character build id", () => {
    const dist = makeDist();
    const id = stamp.stampDist(dist);
    expect(id).toMatch(/^[0-9a-f]{10}$/);
    const stamped = readFileSync(join(dist, "sw.js"), "utf8");
    expect(stamped).not.toContain(BUILD_TOKEN);
    expect(stamped).toContain(`const BUILD = "${id}";`);
  });

  it("gives the same id to the same build and a new one when the build changes", () => {
    const id = stamp.buildId(makeDist());
    expect(stamp.buildId(makeDist())).toBe(id);
    const renamedAsset = stamp.buildId(makeDist(["index-NEW999.js", "index-9xYz.css"]));
    const newPage = stamp.buildId(makeDist(undefined, "<html>orbit v2</html>"));
    expect(new Set([id, renamedAsset, newPage]).size).toBe(3);
  });

  it("refuses to stamp a worker twice, or a dist folder without one", () => {
    const dist = makeDist();
    stamp.stampDist(dist);
    expect(() => stamp.stampDist(dist)).toThrow(BUILD_TOKEN);
    rmSync(join(dist, "sw.js"));
    expect(() => stamp.stampDist(dist)).toThrow(/sw\.js/);
  });

  it("runs from the command line on the dist folder it is given", () => {
    const dist = makeDist();
    const run = spawnSync(process.execPath, [STAMP_SCRIPT, dist], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/orbit-v1-[0-9a-f]{10}/);
    expect(readFileSync(join(dist, "sw.js"), "utf8")).not.toContain(BUILD_TOKEN);
  }, 30_000);
});
