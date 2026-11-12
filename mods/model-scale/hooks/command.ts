import type { Decision } from './decision'
import { savedUsd, type Ledger } from './ledger'
import {
  EFFORT_ONLY,
  LADDER,
  LEVELS,
  labelOf,
  parseLevel,
  type Level,
} from './scale/ladder'
import { clampLevel } from './scale/score'
import { MODES, type Mode, type Settings } from './settings'

export const COMMAND_NAME = 'scale'

export const COMMAND_DESCRIPTION =
  'Show or change how work is routed to the cheapest model and effort that should do it well'

export const ARGUMENT_HINT =
  '[off|effort|full|pin <1-6>|unpin|floor <1-6>|ceiling <1-6>]'

export const USAGE = `usage: /${COMMAND_NAME} ${ARGUMENT_HINT}`

/**
 * What `/scale` was asked to do.
 */
export type Command =
  | { kind: 'show' }
  | { kind: 'usage' }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'unpin' }
  | { kind: 'pin' | 'floor' | 'ceiling'; level: Level }

/**
 * Reads what followed `/scale`. Bare, it shows the report; a word it does not
 * know, a missing or out-of-range level, or anything extra is a usage error.
 * A level is typed `3` or `L3`.
 *
 * @param args everything after the command name
 * @returns the command
 */
export function parseCommand(args: string): Command {
  const words = args.toLowerCase().split(/\s+/).filter(Boolean)
  const [verb, value, ...extra] = words

  if (verb === undefined) {
    return { kind: 'show' }
  }

  if (extra.length > 0) {
    return { kind: 'usage' }
  }

  const mode = MODES.find(candidate => candidate === verb)

  if (mode !== undefined) {
    return value === undefined ? { kind: 'mode', mode } : { kind: 'usage' }
  }

  if (verb === 'unpin') {
    return value === undefined ? { kind: 'unpin' } : { kind: 'usage' }
  }

  if (verb === 'pin' || verb === 'floor' || verb === 'ceiling') {
    const level = value === undefined ? null : parseLevel(value)

    return level === null ? { kind: 'usage' } : { kind: verb, level }
  }

  return { kind: 'usage' }
}

/**
 * What a change did: the settings that stand now, and the line to answer with.
 */
export type Outcome = {
  settings: Settings
  text: string
  isChanged: boolean
}

const MODE_SUMMARIES: Readonly<Record<Mode, string>> = {
  effort:
    'your model stays as it is; only the thinking effort follows the task',
  full: 'a new conversation starts on the cheapest model that suits the task, and later turns only move up',
  off: 'nothing is routed; your model and effort are left as you set them',
}

/**
 * Says so when the floor and ceiling hold a level somewhere else, as a pin
 * outside them is.
 */
function boundsNote(level: Level, settings: Settings): string {
  const result = clampLevel(level, settings.floor, settings.ceiling)

  return result === level
    ? ''
    : ` The floor L${settings.floor} and ceiling L${settings.ceiling} hold it to ${labelOf(result)}.`
}

function sameSettings(a: Settings, b: Settings): boolean {
  return (
    a.mode === b.mode &&
    a.pin === b.pin &&
    a.floor === b.floor &&
    a.ceiling === b.ceiling
  )
}

/**
 * Applies a command that changes a setting. A floor above the ceiling (or the
 * other way round) is refused rather than reordered, so that the person says
 * which of the two they meant to move.
 *
 * @param settings the current settings
 * @param command the change
 * @returns the settings that stand and what to tell the person
 */
export function applyCommand(
  settings: Settings,
  command: Exclude<Command, { kind: 'show' } | { kind: 'usage' }>,
): Outcome {
  const done = (next: Settings, text: string): Outcome => ({
    settings: next,
    text: `scale: ${text}`,
    isChanged: !sameSettings(settings, next),
  })

  switch (command.kind) {
    case 'mode':
      return done(
        { ...settings, mode: command.mode },
        `mode ${command.mode}: ${MODE_SUMMARIES[command.mode]}.`,
      )

    case 'unpin':
      return settings.pin === null
        ? done(settings, 'nothing was pinned.')
        : done(
            { ...settings, pin: null },
            'unpinned; prompts are scored again.',
          )

    case 'pin':
      return done(
        { ...settings, pin: command.level },
        `pinned to ${labelOf(command.level)}.${boundsNote(command.level, settings)}`,
      )

    case 'floor':
      return command.level > settings.ceiling
        ? done(
            settings,
            `floor ${labelOf(command.level)} would be above the ceiling L${settings.ceiling}; raise the ceiling first.`,
          )
        : done(
            { ...settings, floor: command.level },
            `floor ${labelOf(command.level)}; no task runs below it.`,
          )

    case 'ceiling':
      return command.level < settings.floor
        ? done(
            settings,
            `ceiling ${labelOf(command.level)} would be below the floor L${settings.floor}; lower the floor first.`,
          )
        : done(
            { ...settings, ceiling: command.level },
            command.level === 6
              ? `ceiling ${labelOf(command.level)}; the hardest tasks may now run on Fable.`
              : `ceiling ${labelOf(command.level)}; no task runs above it.`,
          )
  }
}

/**
 * Dollars for a report: cents when a dollar or more, else to a hundredth of a
 * cent, which is what a few steps of a cheap model cost.
 */
function usd(amount: number): string {
  return `$${amount >= 1 ? amount.toFixed(2) : amount.toFixed(4)}`
}

/**
 * Lays rows out as columns, two spaces apart, no trailing spaces.
 */
function tableOf(rows: readonly (readonly string[])[]): string[] {
  const columns = Math.max(0, ...rows.map(row => row.length))
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(0, ...rows.map(row => row[column]?.length ?? 0)),
  )

  return rows.map(row =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd(),
  )
}

function noteOf(level: Level, settings: Settings): string {
  if (level < settings.floor) {
    return 'below the floor'
  }

  if (level > settings.ceiling) {
    return 'above the ceiling'
  }

  return level === settings.pin ? 'pinned' : ''
}

function decisionLines(
  title: string,
  decision: Decision | undefined,
): string[] {
  if (decision === undefined) {
    return [`${title}: none yet`]
  }

  const how =
    decision.score === null ? 'pinned, not scored' : `score ${decision.score}`
  const subject =
    decision.subject === undefined ? '' : ` for "${decision.subject}"`

  return [
    `${title}: ${labelOf(decision.level)} (${how})${subject}`,
    ...decision.reasons.map(reason => `  ${reason}`),
  ]
}

/**
 * Whole percent of `whole` that `part` is, half rounded up. It is worked out in
 * nanodollars, which are whole numbers, so that a tie such as 87.5 is not lost
 * to the error of a division of fractions.
 */
function percentOf(part: number, whole: number): number {
  const nano = (dollars: number): number => Math.round(dollars * 1e9)

  return Math.round((nano(part) * 100) / nano(whole))
}

function stepsOf(count: number): string {
  return `${count} ${count === 1 ? 'step' : 'steps'}`
}

function ledgerLines(ledger: Ledger, mode: Mode): string[] {
  const lines: string[] = []
  const priced = ledger.steps - ledger.unpriced

  if (ledger.steps === 0) {
    lines.push('Spend: no model steps seen yet this session.')
  } else if (priced === 0) {
    lines.push(
      `Spend: no estimate; ${stepsOf(ledger.unpriced)} ran on a model with no price here.`,
    )
  } else {
    const saved = savedUsd(ledger)
    const share =
      ledger.originalUsd > 0
        ? ` (${percentOf(Math.abs(saved), ledger.originalUsd)}%)`
        : ''
    const verdict =
      saved > 0
        ? `saved ${usd(saved)}${share}`
        : saved < 0
          ? `${usd(-saved)} more${share}, the price of routing up`
          : 'no difference so far'

    lines.push(
      `Spend, estimated from list prices over ${stepsOf(priced)}: ` +
        `${usd(ledger.spentUsd)} against ${usd(ledger.originalUsd)} on the ` +
        `models the steps came in with: ${verdict}.`,
    )

    if (ledger.unpriced > 0) {
      lines.push(
        `${stepsOf(ledger.unpriced)} ran on a model with no price here and ` +
          `${ledger.unpriced === 1 ? 'is' : 'are'} left out.`,
      )
    }
  }

  if (mode === 'effort') {
    lines.push(
      "Effort mode runs on the session's own model, so it adds nothing to the saving: effort changes how many tokens a step uses, which cannot be priced against a baseline.",
    )
  }

  return lines
}

/**
 * What `/scale` is given to show.
 */
export type Report = {
  settings: Settings
  lastPrompt: Decision | undefined
  lastAgent: Decision | undefined
  ledger: Ledger
  agentTypes: readonly string[]
}

/**
 * The bare `/scale` answer: the scale, the settings, the last decisions with
 * their scores and reasons, and the ledger.
 *
 * @param report what to show
 * @returns the text, one line per row
 */
export function renderReport(report: Report): string {
  const { settings } = report
  const pin = settings.pin === null ? 'none' : labelOf(settings.pin)

  const table = tableOf([
    ['Level', 'Name', 'Full mode', 'Effort mode', ''],
    ...LEVELS.map(level => [
      `L${level}`,
      LADDER[level].name,
      `${LADDER[level].model} ${LADDER[level].effort}`,
      EFFORT_ONLY[level],
      noteOf(level, settings),
    ]),
  ])

  return [
    `scale: mode ${settings.mode}: ${MODE_SUMMARIES[settings.mode]}`,
    `pin ${pin}, floor L${settings.floor}, ceiling L${settings.ceiling}`,
    `subagents routed: ${report.agentTypes.join(', ')}`,
    '',
    ...table,
    '',
    ...decisionLines('Last prompt', report.lastPrompt),
    ...decisionLines('Last subagent', report.lastAgent),
    '',
    ...ledgerLines(report.ledger, settings.mode),
    '',
    USAGE,
  ].join('\n')
}
