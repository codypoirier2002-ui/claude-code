/**
 * The scale itself: six levels, each with a name, the cheapest model that
 * should still do that level of work well, and the thinking effort to ask it
 * for. Everything else in the mod (scoring, routing, `/scale`) reads this
 * table and nothing else decides which model a level means.
 */

/**
 * One of the six levels, 1 (trivial) to 6 (frontier).
 */
export type Level = 1 | 2 | 3 | 4 | 5 | 6

/**
 * A model family by the alias Claude Code accepts for `model`. They are in
 * price order, cheapest first.
 */
export type ModelAlias = 'haiku' | 'sonnet' | 'opus' | 'fable'

/**
 * A thinking effort the scale asks for.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'

/**
 * One row of the scale.
 */
export type Rung = {
  readonly name: string
  /**
   * The model full mode runs this level on.
   */
  readonly model: ModelAlias
  /**
   * The effort full mode asks of that model.
   */
  readonly effort: Effort
}

/**
 * Every level, lowest first.
 */
export const LEVELS: readonly Level[] = [1, 2, 3, 4, 5, 6]

export const MIN_LEVEL: Level = 1
export const MAX_LEVEL: Level = 6

/**
 * The floor and ceiling a fresh install starts with: Fable is spent only when
 * the person raises the ceiling to 6.
 */
export const DEFAULT_FLOOR: Level = 1
export const DEFAULT_CEILING: Level = 5

/**
 * The scale: the model and effort each level means in full mode.
 */
export const LADDER: Readonly<Record<Level, Rung>> = {
  1: { name: 'Trivial', model: 'haiku', effort: 'low' },
  2: { name: 'Simple', model: 'haiku', effort: 'medium' },
  3: { name: 'Standard', model: 'sonnet', effort: 'medium' },
  4: { name: 'Complex', model: 'sonnet', effort: 'high' },
  5: { name: 'Advanced', model: 'opus', effort: 'high' },
  6: { name: 'Frontier', model: 'fable', effort: 'high' },
}

/**
 * The effort each level means when the session's model stays as it is
 * (effort mode): only how hard it thinks changes.
 */
export const EFFORT_ONLY: Readonly<Record<Level, Effort>> = {
  1: 'low',
  2: 'low',
  3: 'medium',
  4: 'high',
  5: 'high',
  6: 'xhigh',
}

/**
 * Model families from cheapest to dearest, which is also their order of
 * capability for the "never downgrade" rule.
 */
const FAMILIES: readonly ModelAlias[] = ['haiku', 'sonnet', 'opus', 'fable']

/**
 * Whether `value` is one of the six levels.
 *
 * @param value anything
 * @returns true for the integers 1 to 6
 */
export function isLevel(value: unknown): value is Level {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_LEVEL &&
    value <= MAX_LEVEL
  )
}

/**
 * Reads a level as a person types it: `3` or `L3`.
 *
 * @param text what was typed
 * @returns the level, or null when it names none
 */
export function parseLevel(text: string): Level | null {
  const match = /^l?([1-6])$/i.exec(text.trim())
  const level = match ? Number(match[1]) : NaN

  return isLevel(level) ? level : null
}

/**
 * A level as one short label: `L3 Standard`.
 *
 * @param level the level
 * @returns the label
 */
export function labelOf(level: Level): string {
  return `L${level} ${LADDER[level].name}`
}

/**
 * The family a model id or alias belongs to, by the family word it contains
 * (`claude-sonnet-5-5`, `sonnet`, `anthropic.claude-haiku-5-5-v1:0`).
 *
 * @param model a model id or alias
 * @returns the family, or null for a model of none of the four
 */
export function familyOf(model: string | undefined): ModelAlias | null {
  if (typeof model !== 'string') {
    return null
  }

  const lower = model.toLowerCase()

  return FAMILIES.find(family => lower.includes(family)) ?? null
}

/**
 * Where a family sits from cheapest (0) to dearest (3).
 *
 * @param family the family
 * @returns its rank
 */
export function rankOf(family: ModelAlias): number {
  return FAMILIES.indexOf(family)
}
