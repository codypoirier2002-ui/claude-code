import { labelOf, rankOf, type Level, type ModelAlias } from './scale/ladder'
import { clampLevel, escalate, scoreTask } from './scale/score'
import type { Settings } from './settings'

/**
 * Why a level went up a step after an answer that did not finish.
 */
export const ESCALATION_REASON = 'escalated: last answer was cut off/refused'

/**
 * Where a level came from: scored from a prompt, pinned by the person, or
 * scored from a subagent's task.
 */
export type DecisionKind = 'prompt' | 'pinned' | 'agent'

/**
 * The level one task was given, and why.
 */
export type Decision = {
  kind: DecisionKind
  level: Level
  /**
   * The scorer's score, 0 to 100; null when a pin decided and nothing was
   * scored.
   */
  score: number | null
  /**
   * One short line per signal that moved the score, then any step the level
   * took after it (escalation, floor, ceiling).
   */
  reasons: readonly string[]
  highStakes: boolean
  /**
   * For a subagent, its task description, to tell routes apart in `/scale`.
   */
  subject?: string
}

/**
 * A submitted prompt, as far as deciding whether it is a task reads it. The
 * engine sets `command` on a slash command's line and `isMeta` on a prompt the
 * person did not type; older declarations lack both, so they are read as
 * unknowns.
 */
export type PromptLike = {
  text: string
  command?: unknown
  isMeta?: unknown
}

/**
 * A line that is a slash command: `/review the diff`, `/clear`. A path such as
 * `/usr/bin/env` is not (the name runs on into another slash).
 */
const SLASH_LINE = /^\s*\/[A-Za-z][\w:.-]*(?:\s|$)/

const SUBJECT_LIMIT = 60

/**
 * Whether a submitted prompt is no task of the person's to score: a slash
 * command (the engine says so with `command`, and a bare slash line says so
 * where it does not) or a prompt the engine raised itself (`isMeta`).
 *
 * @param prompt the prompt
 * @returns true when it is to be left alone
 */
export function isNotATask(prompt: PromptLike): boolean {
  const isCommand = prompt.command !== undefined && prompt.command !== null

  return isCommand || prompt.isMeta === true || SLASH_LINE.test(prompt.text)
}

/**
 * Whether an answer ended without finishing: the model refused, or ran out of
 * output.
 *
 * @param stopReason how the last step stopped
 * @returns true for `refusal` and `max_tokens`
 */
export function isCutOff(stopReason: string | null | undefined): boolean {
  return stopReason === 'refusal' || stopReason === 'max_tokens'
}

/**
 * Holds a level between the floor and the ceiling, saying so in `reasons` when
 * that moved it.
 */
function held(level: Level, settings: Settings, reasons: string[]): Level {
  const result = clampLevel(level, settings.floor, settings.ceiling)

  if (result !== level) {
    reasons.push(
      `held to ${labelOf(result)} by floor L${settings.floor} and ceiling L${settings.ceiling}`,
    )
  }

  return result
}

/**
 * Decides the level of a prompt the person typed. A pin is the level and
 * nothing is scored; otherwise the prompt is scored, the level goes up one
 * step when the last answer did not finish, and the floor and ceiling hold it.
 *
 * @param text the prompt
 * @param settings the current settings
 * @param isLastCutOff whether the previous answer was refused or cut off
 * @returns the decision
 */
export function decidePrompt(
  text: string,
  settings: Settings,
  isLastCutOff: boolean,
): Decision {
  if (settings.pin !== null) {
    const reasons = [`pinned to ${labelOf(settings.pin)}`]
    const level = held(settings.pin, settings, reasons)

    return { kind: 'pinned', level, score: null, reasons, highStakes: false }
  }

  const scored = scoreTask(text)
  const reasons = [...scored.reasons]
  let level = scored.level

  if (isLastCutOff) {
    level = escalate(level)
    reasons.push(ESCALATION_REASON)
  }

  return {
    kind: 'prompt',
    level: held(level, settings, reasons),
    score: scored.score,
    reasons,
    highStakes: scored.highStakes,
  }
}

/**
 * Decides the level of a subagent's task from its prompt and description. A
 * pin does not apply to a subagent; the floor and ceiling do.
 *
 * @param prompt the task the subagent is given
 * @param description the task's short description
 * @param settings the current settings
 * @returns the decision
 */
export function decideAgent(
  prompt: string,
  description: string,
  settings: Settings,
): Decision {
  const scored = scoreTask(
    [prompt, description].filter(part => part.length > 0).join('\n'),
  )
  const reasons = [...scored.reasons]

  return {
    kind: 'agent',
    level: held(scored.level, settings, reasons),
    score: scored.score,
    reasons,
    highStakes: scored.highStakes,
    subject: description.slice(0, SUBJECT_LIMIT),
  }
}

/**
 * What picks the model family a conversation runs on in full mode.
 */
export type FamilyChoice = {
  /**
   * The family the level means.
   */
  target: ModelAlias
  /**
   * Whether this is the first request of a conversation.
   */
  isFresh: boolean
  /**
   * The family the conversation already runs on because of an earlier choice.
   */
  chosen: ModelAlias | undefined
  /**
   * The family of the model the session came in with.
   */
  session: ModelAlias
}

/**
 * Picks the model family for a turn in full mode. A fresh conversation takes
 * the level's family, up or down. After that a conversation only ever moves
 * up: switching model mid-conversation starts the prompt cache over and drops
 * the earlier model's thinking, which is not worth saving on one easy turn.
 *
 * @param choice the level's family and what the conversation runs on
 * @returns the family to run the turn on
 */
export function chooseFamily({
  target,
  isFresh,
  chosen,
  session,
}: FamilyChoice): ModelAlias {
  if (isFresh) {
    return target
  }

  const current = chosen ?? session

  return rankOf(target) > rankOf(current) ? target : current
}
