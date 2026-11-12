// Model tiers, routing and escalation (§3.2).

import type { Settings } from "./settings";

export type Tier = "quick" | "think" | "deep";

export interface TierInfo {
  tier: Tier;
  model: string;
  label: string;
  short: string;
}

export const TIER_ORDER: readonly Tier[] = ["quick", "think", "deep"];

export const TIERS: Readonly<Record<Tier, TierInfo>> = Object.freeze({
  quick: { tier: "quick", model: "claude-haiku-5-5", label: "Claude Haiku 5.5", short: "Haiku" },
  think: { tier: "think", model: "claude-opus-5-5", label: "Claude Opus 5.5", short: "Opus" },
  deep: { tier: "deep", model: "claude-fable-5-1", label: "Claude Fable 5.1", short: "Fable" },
});

export const HAIKU_MODEL = TIERS.quick.model;

function infoFor(modelId: string): TierInfo | undefined {
  return TIER_ORDER.map((t) => TIERS[t]).find((i) => i.model === modelId);
}

/** The tier of a model id; an unknown id counts as "think". */
export function tierOf(modelId: string): Tier {
  return infoFor(modelId)?.tier ?? "think";
}

/** "Claude Opus 5.5"; an unknown id is returned as is. */
export function labelOf(modelId: string): string {
  return infoFor(modelId)?.label ?? modelId;
}

/** "Opus"; an unknown id drops its "claude-" prefix. */
export function shortLabel(modelId: string): string {
  return infoFor(modelId)?.short ?? modelId.replace(/^claude-/, "");
}

/** One tier up, stopping at deep. */
export function nextTier(tier: Tier): Tier {
  const i = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, i + 1)];
}

/** A forced tier wins; otherwise Haiku in Auto; otherwise the pinned model. */
export function modelForRun(settings: Pick<Settings, "model">, forcedTier?: Tier): string {
  if (forcedTier) return TIERS[forcedTier].model;
  if (settings.model === "auto") return HAIKU_MODEL;
  return settings.model;
}

/** Haiku has no server-side fallback. */
export function isHaiku(modelId: string): boolean {
  return modelId.startsWith("claude-haiku");
}

export interface EscalationResult {
  content: string;
  is_error?: boolean;
  /** Set only on a successful hand-off. */
  target?: Tier;
}

/** The result of the escalate tool (§3.2). Pure. */
export function decideEscalation(input: unknown, currentModel: string, auto: boolean): EscalationResult {
  if (!auto) return { content: "Routing is pinned to one model. Answer the user directly.", is_error: true };
  const level = typeof input === "object" && input !== null ? (input as { level?: unknown }).level : undefined;
  if (level !== "think" && level !== "deep") {
    return { content: "INVALID_INPUT: level must be 'think' or 'deep'.", is_error: true };
  }
  const current = tierOf(currentModel);
  if (TIER_ORDER.indexOf(level) <= TIER_ORDER.indexOf(current)) {
    return { content: `You are already ${labelOf(currentModel)}. Answer the user directly.`, is_error: true };
  }
  return { content: `Handed off to ${TIERS[level].label}. It now answers the user's latest request.`, target: level };
}
