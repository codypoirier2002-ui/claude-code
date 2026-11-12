// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VR_REFUSED_TOAST,
  exitClosesApp,
  launchAction,
  readLaunchEnv,
  vrRefusedToast,
  type LaunchEnv,
} from "../src/core/launch";
import { DEFAULT_SETTINGS } from "../src/core/settings";

const BROWSER: LaunchEnv = { installed: false, immersiveBuild: false };
const STORE_2D: LaunchEnv = { installed: true, immersiveBuild: false };
const STORE_VR: LaunchEnv = { installed: true, immersiveBuild: true };

/** Settings as launch.ts reads them: configured by a key, by a proxy, or not at all. */
function settings(over: { apiKey?: string; baseURL?: string; startInVR?: boolean } = {}) {
  return { apiKey: "", baseURL: "", startInVR: DEFAULT_SETTINGS.startInVR, ...over };
}
const WITH_KEY = { apiKey: "test-key" };
const WITH_PROXY = { baseURL: "https://proxy.example.com" };

/** A window stand-in: `getDigitalGoodsService` exists only in the Quest store build. */
function fakeWindow(search: string, installed: boolean) {
  return installed ? { location: { search }, getDigitalGoodsService: () => undefined } : { location: { search } };
}

afterEach(() => vi.unstubAllGlobals());

describe("readLaunchEnv", () => {
  it("is neither installed nor immersive in a plain browser", () => {
    expect(readLaunchEnv(fakeWindow("", false))).toEqual(BROWSER);
  });

  it("is installed, but not immersive, when getDigitalGoodsService exists and there is no ?launch=vr", () => {
    expect(readLaunchEnv(fakeWindow("", true))).toEqual(STORE_2D);
    expect(readLaunchEnv(fakeWindow("?xr-preview", true))).toEqual(STORE_2D);
  });

  it("is the immersive build when installed and opened with ?launch=vr", () => {
    expect(readLaunchEnv(fakeWindow("?launch=vr", true))).toEqual(STORE_VR);
  });

  it("needs the installed app: ?launch=vr in a normal browser is still a browser", () => {
    expect(readLaunchEnv(fakeWindow("?launch=vr", false))).toEqual(BROWSER);
  });

  it("finds launch=vr among other parameters", () => {
    expect(readLaunchEnv(fakeWindow("?xr-preview&launch=vr&yaw=20", true)).immersiveBuild).toBe(true);
    expect(readLaunchEnv(fakeWindow("?a=1&launch=vr", true)).immersiveBuild).toBe(true);
  });

  it("accepts only the exact value vr", () => {
    for (const search of ["?launch=2d", "?launch=VR", "?launch=", "?launch", "?launched=vr", "?xlaunch=vr", "?launch=vr2", "?q=launch=vr"]) {
      expect(readLaunchEnv(fakeWindow(search, true)).immersiveBuild, search).toBe(false);
    }
  });

  it("uses the first launch value when it is repeated", () => {
    expect(readLaunchEnv(fakeWindow("?launch=vr&launch=2d", true)).immersiveBuild).toBe(true);
    expect(readLaunchEnv(fakeWindow("?launch=2d&launch=vr", true)).immersiveBuild).toBe(false);
  });

  it("counts the property as present whatever its value (it tests `in window`)", () => {
    const win = { location: { search: "" }, getDigitalGoodsService: undefined };
    expect(readLaunchEnv(win).installed).toBe(true);
  });

  it("reads the real window when none is passed", () => {
    vi.stubGlobal("window", fakeWindow("?launch=vr", true));
    expect(readLaunchEnv()).toEqual(STORE_VR);
    vi.stubGlobal("window", fakeWindow("?launch=vr", false));
    expect(readLaunchEnv()).toEqual(BROWSER);
  });
});

describe("launchAction", () => {
  it("stays in 2D in a normal browser, whatever else is true", () => {
    for (const vr of [true, false]) {
      for (const startInVR of [true, false]) {
        for (const extra of [{}, WITH_KEY, WITH_PROXY]) {
          expect(launchAction(BROWSER, vr, settings({ startInVR, ...extra }))).toBe("stay-2d");
        }
      }
    }
  });

  it("stays in 2D when immersive-vr is not supported, even in the immersive build", () => {
    for (const env of [STORE_2D, STORE_VR]) {
      expect(launchAction(env, false, settings({ ...WITH_KEY, startInVR: true }))).toBe("stay-2d");
      expect(launchAction(env, false, settings())).toBe("stay-2d");
    }
  });

  it("enters VR in the immersive build, even before setup", () => {
    expect(launchAction(STORE_VR, true, settings())).toBe("enter-vr");
    expect(launchAction(STORE_VR, true, settings({ startInVR: false }))).toBe("enter-vr");
    expect(launchAction(STORE_VR, true, settings({ ...WITH_KEY, startInVR: false }))).toBe("enter-vr");
  });

  it("enters VR in the 2D store build only when startInVR is on and the app is configured", () => {
    expect(launchAction(STORE_2D, true, settings({ ...WITH_KEY, startInVR: true }))).toBe("enter-vr");
    expect(launchAction(STORE_2D, true, settings({ ...WITH_KEY, startInVR: false }))).toBe("stay-2d");
    expect(launchAction(STORE_2D, true, settings({ startInVR: true }))).toBe("stay-2d");
    expect(launchAction(STORE_2D, true, settings({ startInVR: false }))).toBe("stay-2d");
  });

  it("counts a proxy URL as configured, and a blank key or proxy as not", () => {
    expect(launchAction(STORE_2D, true, settings(WITH_PROXY))).toBe("enter-vr");
    expect(launchAction(STORE_2D, true, settings({ apiKey: "   ", baseURL: "  " }))).toBe("stay-2d");
  });

  it("opens straight into VR by default once the app is configured", () => {
    expect(launchAction(STORE_2D, true, { ...DEFAULT_SETTINGS, apiKey: "test-key" })).toBe("enter-vr");
    expect(launchAction(STORE_2D, true, DEFAULT_SETTINGS)).toBe("stay-2d");
  });
});

describe("exitClosesApp", () => {
  it("closes the app when leaving VR in the immersive build once it is configured", () => {
    expect(exitClosesApp(STORE_VR, settings(WITH_KEY))).toBe(true);
    expect(exitClosesApp(STORE_VR, settings(WITH_PROXY))).toBe(true);
  });

  it("keeps the app open in the immersive build while it is not configured", () => {
    expect(exitClosesApp(STORE_VR, settings())).toBe(false);
    expect(exitClosesApp(STORE_VR, settings({ apiKey: "  ", baseURL: " " }))).toBe(false);
  });

  it("never closes the 2D store build or a browser tab", () => {
    expect(exitClosesApp(STORE_2D, settings(WITH_KEY))).toBe(false);
    expect(exitClosesApp(BROWSER, settings(WITH_KEY))).toBe(false);
    // The environment can't be immersive without being installed, but the rule asks for both.
    expect(exitClosesApp({ installed: false, immersiveBuild: true }, settings(WITH_KEY))).toBe(false);
  });
});

describe("vrRefusedToast", () => {
  it("shows a toast only in the immersive build", () => {
    expect(vrRefusedToast(STORE_VR)).toBe(VR_REFUSED_TOAST);
    expect(vrRefusedToast(STORE_2D)).toBeNull();
    expect(vrRefusedToast(BROWSER)).toBeNull();
  });

  it("has a plain sentence for the toast", () => {
    expect(VR_REFUSED_TOAST).toBe("Couldn't start VR. Staying in the regular app.");
  });
});
