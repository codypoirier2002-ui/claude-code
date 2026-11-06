// Launch modes (§11): when the installed Quest app opens straight into VR, and
// when leaving VR closes it. Pure: the window, the VR support probe and the
// settings come in as arguments, so every branch can be tested without a browser.

import { isConfigured, type Settings } from "./settings";

/** How the page was started. */
export interface LaunchEnv {
  /** The Quest store build: the browser exposes `getDigitalGoodsService`. */
  installed: boolean;
  /** The immersive store build: installed, and opened with `?launch=vr`. */
  immersiveBuild: boolean;
}

export type LaunchAction = "stay-2d" | "enter-vr";

/** The part of `window` that `readLaunchEnv` looks at. */
export interface LaunchWindow {
  location: { search: string };
}

/** The toast for a refused VR launch. Only the immersive build shows it. */
export const VR_REFUSED_TOAST = "Couldn't start VR. Staying in the regular app.";

/** Reads the environment from a window (the real one unless a test passes its own). */
export function readLaunchEnv(win: LaunchWindow = window): LaunchEnv {
  const installed = "getDigitalGoodsService" in win;
  const immersiveBuild = installed && new URLSearchParams(win.location.search).get("launch") === "vr";
  return { installed, immersiveBuild };
}

/**
 * What to do once the VR support probe has answered.
 * - Not installed, or no immersive-vr support: stay in 2D.
 * - The immersive build: enter VR, even before setup.
 * - Otherwise: enter VR only when "Open straight into VR" is on and the app is configured.
 */
export function launchAction(
  env: LaunchEnv,
  vrSupported: boolean,
  settings: Pick<Settings, "apiKey" | "baseURL" | "startInVR">,
): LaunchAction {
  if (!env.installed || !vrSupported) return "stay-2d";
  if (env.immersiveBuild) return "enter-vr";
  return settings.startInVR && isConfigured(settings) ? "enter-vr" : "stay-2d";
}

/** Leaving VR closes the app (`window.close()`) in an installed immersive build that is set up. */
export function exitClosesApp(env: LaunchEnv, settings: Pick<Settings, "apiKey" | "baseURL">): boolean {
  return env.installed && env.immersiveBuild && isConfigured(settings);
}

/**
 * The toast to show when entering VR at launch was refused, or null for the quiet
 * fall back to 2D (every build except the immersive one).
 */
export function vrRefusedToast(env: LaunchEnv): string | null {
  return env.immersiveBuild ? VR_REFUSED_TOAST : null;
}
