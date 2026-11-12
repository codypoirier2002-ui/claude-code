import { describe, expect, test, tier } from 'claude-code/testing'

import {
  applyCommand,
  parseCommand,
  renderReport,
  USAGE,
  type Command,
  type Report,
} from '../hooks/command'
import type { Decision } from '../hooks/decision'
import { emptyLedger, type Ledger } from '../hooks/ledger'
import { DEFAULT_SETTINGS, type Settings } from '../hooks/settings'

tier('user')

const settingsOf = (change: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  ...change,
})

type Change = Exclude<Command, { kind: 'show' } | { kind: 'usage' }>

const apply = (command: Change, change: Partial<Settings> = {}) =>
  applyCommand(settingsOf(change), command)

const PARSED: readonly (readonly [string, Command])[] = [
  ['', { kind: 'show' }],
  ['   ', { kind: 'show' }],
  ['off', { kind: 'mode', mode: 'off' }],
  ['EFFORT', { kind: 'mode', mode: 'effort' }],
  ['  full  ', { kind: 'mode', mode: 'full' }],
  ['pin 3', { kind: 'pin', level: 3 }],
  ['pin L3', { kind: 'pin', level: 3 }],
  ['PIN l6', { kind: 'pin', level: 6 }],
  ['  pin    1 ', { kind: 'pin', level: 1 }],
  ['unpin', { kind: 'unpin' }],
  ['floor 2', { kind: 'floor', level: 2 }],
  ['ceiling 6', { kind: 'ceiling', level: 6 }],
  ['pin', { kind: 'usage' }],
  ['pin 0', { kind: 'usage' }],
  ['pin 7', { kind: 'usage' }],
  ['pin 3.5', { kind: 'usage' }],
  ['pin -1', { kind: 'usage' }],
  ['pin three', { kind: 'usage' }],
  ['pin 3 4', { kind: 'usage' }],
  ['floor', { kind: 'usage' }],
  ['ceiling x', { kind: 'usage' }],
  ['unpin 3', { kind: 'usage' }],
  ['full now', { kind: 'usage' }],
  ['bogus', { kind: 'usage' }],
  ['/scale', { kind: 'usage' }],
]

describe('command', () => {
  describe('parseCommand', () => {
    for (const [args, expected] of PARSED) {
      test(`reads ${JSON.stringify(args)} as ${JSON.stringify(expected)}`, () => {
        expect(parseCommand(args)).toEqual(expected)
      })
    }
  })

  describe('applyCommand', () => {
    test('changes the mode and says what it means', () => {
      expect(apply({ kind: 'mode', mode: 'full' })).toEqual({
        settings: settingsOf({ mode: 'full' }),
        text: 'scale: mode full: a new conversation starts on the cheapest model that suits the task, and later turns only move up.',
        isChanged: true,
      })
      expect(apply({ kind: 'mode', mode: 'off' }).text).toBe(
        'scale: mode off: nothing is routed; your model and effort are left as you set them.',
      )
      expect(
        apply({ kind: 'mode', mode: 'effort' }, { mode: 'off' }).text,
      ).toBe(
        'scale: mode effort: your model stays as it is; only the thinking effort follows the task.',
      )
    })

    test('says the mode again without calling it a change', () => {
      const outcome = apply({ kind: 'mode', mode: 'effort' })

      expect(outcome.isChanged).toBe(false)
      expect(outcome.text).toContain('scale: mode effort:')
    })

    test('pins a level', () => {
      expect(apply({ kind: 'pin', level: 3 })).toEqual({
        settings: settingsOf({ pin: 3 }),
        text: 'scale: pinned to L3 Standard.',
        isChanged: true,
      })
    })

    test('says so when the floor and ceiling hold a pin somewhere else', () => {
      expect(apply({ kind: 'pin', level: 6 }).text).toBe(
        'scale: pinned to L6 Frontier. The floor L1 and ceiling L5 hold it to L5 Advanced.',
      )
      expect(apply({ kind: 'pin', level: 1 }, { floor: 2 }).text).toBe(
        'scale: pinned to L1 Trivial. The floor L2 and ceiling L5 hold it to L2 Simple.',
      )
    })

    test('lifts a pin, or says there was none', () => {
      expect(apply({ kind: 'unpin' }, { pin: 4 })).toEqual({
        settings: settingsOf({ pin: null }),
        text: 'scale: unpinned; prompts are scored again.',
        isChanged: true,
      })
      expect(apply({ kind: 'unpin' })).toEqual({
        settings: settingsOf(),
        text: 'scale: nothing was pinned.',
        isChanged: false,
      })
    })

    test('sets the floor', () => {
      expect(apply({ kind: 'floor', level: 3 })).toEqual({
        settings: settingsOf({ floor: 3 }),
        text: 'scale: floor L3 Standard; no task runs below it.',
        isChanged: true,
      })
      expect(apply({ kind: 'floor', level: 5 }).isChanged).toBe(true)
      expect(apply({ kind: 'floor', level: 1 }).isChanged).toBe(false)
    })

    test('sets the ceiling, and says what Fable means', () => {
      expect(apply({ kind: 'ceiling', level: 4 })).toEqual({
        settings: settingsOf({ ceiling: 4 }),
        text: 'scale: ceiling L4 Complex; no task runs above it.',
        isChanged: true,
      })
      expect(apply({ kind: 'ceiling', level: 6 }).text).toBe(
        'scale: ceiling L6 Frontier; the hardest tasks may now run on Fable.',
      )
    })

    test('refuses a floor above the ceiling and a ceiling below the floor', () => {
      expect(apply({ kind: 'floor', level: 6 })).toEqual({
        settings: settingsOf(),
        text: 'scale: floor L6 Frontier would be above the ceiling L5; raise the ceiling first.',
        isChanged: false,
      })
      expect(apply({ kind: 'ceiling', level: 1 }, { floor: 2 })).toEqual({
        settings: settingsOf({ floor: 2 }),
        text: 'scale: ceiling L1 Trivial would be below the floor L2; lower the floor first.',
        isChanged: false,
      })
    })

    test('lets the floor and the ceiling meet', () => {
      expect(apply({ kind: 'floor', level: 5 }).settings.floor).toBe(5)
      expect(
        apply({ kind: 'ceiling', level: 2 }, { floor: 2 }).settings.ceiling,
      ).toBe(2)
    })

    test('does not change the settings it was given', () => {
      const settings = settingsOf()

      applyCommand(settings, { kind: 'mode', mode: 'full' })
      applyCommand(settings, { kind: 'pin', level: 2 })

      expect(settings).toEqual(DEFAULT_SETTINGS)
    })
  })

  describe('renderReport', () => {
    const scored: Decision = {
      kind: 'prompt',
      level: 4,
      score: 58,
      reasons: ['+10 work: implement', '+18 hard: design'],
      highStakes: false,
    }
    const pinned: Decision = {
      kind: 'pinned',
      level: 2,
      score: null,
      reasons: ['pinned to L2 Simple'],
      highStakes: false,
    }
    const agent: Decision = {
      kind: 'agent',
      level: 1,
      score: 7,
      reasons: ['-15 easy: typo'],
      highStakes: false,
      subject: 'fix a typo',
    }

    const reportOf = (change: Partial<Report> = {}): string =>
      renderReport({
        settings: settingsOf(),
        lastPrompt: undefined,
        lastAgent: undefined,
        ledger: emptyLedger(),
        agentTypes: ['general-purpose'],
        ...change,
      })

    const ledgerOf = (change: Partial<Ledger>): Ledger => ({
      ...emptyLedger(),
      ...change,
    })

    test('opens with the mode, the bounds and the agent types', () => {
      const lines = reportOf({
        settings: settingsOf({ mode: 'full', pin: 3, floor: 2, ceiling: 4 }),
        agentTypes: ['general-purpose', 'explore'],
      }).split('\n')

      expect(lines.slice(0, 3)).toEqual([
        'scale: mode full: a new conversation starts on the cheapest model that suits the task, and later turns only move up',
        'pin L3 Standard, floor L2, ceiling L4',
        'subagents routed: general-purpose, explore',
      ])
    })

    test('ends with the usage', () => {
      expect(reportOf().endsWith(USAGE)).toBe(true)
      expect(USAGE).toBe(
        'usage: /scale [off|effort|full|pin <1-6>|unpin|floor <1-6>|ceiling <1-6>]',
      )
    })

    test('notes the levels the bounds and the pin touch', () => {
      const report = reportOf({
        settings: settingsOf({ pin: 3, floor: 2, ceiling: 4 }),
      })

      expect(report).toMatch(/^L1 +Trivial +haiku low +low +below the floor$/m)
      expect(report).toMatch(/^L2 +Simple +haiku medium +low$/m)
      expect(report).toMatch(/^L3 +Standard +sonnet medium +medium +pinned$/m)
      expect(report).toMatch(
        /^L5 +Advanced +opus high +high +above the ceiling$/m,
      )
      expect(report).toMatch(
        /^L6 +Frontier +fable high +xhigh +above the ceiling$/m,
      )
    })

    test('notes a pin outside the bounds as outside them, not as pinned', () => {
      const report = reportOf({ settings: settingsOf({ pin: 6 }) })

      expect(report).toMatch(
        /^L6 +Frontier +fable high +xhigh +above the ceiling$/m,
      )
    })

    test('shows the last prompt, scored, with each reason', () => {
      expect(reportOf({ lastPrompt: scored })).toContain(
        'Last prompt: L4 Complex (score 58)\n  +10 work: implement\n  +18 hard: design\nLast subagent: none yet',
      )
    })

    test('shows a pinned prompt as not scored', () => {
      expect(reportOf({ lastPrompt: pinned })).toContain(
        'Last prompt: L2 Simple (pinned, not scored)\n  pinned to L2 Simple',
      )
    })

    test('shows the last subagent with what it was for', () => {
      expect(reportOf({ lastAgent: agent })).toContain(
        'Last subagent: L1 Trivial (score 7) for "fix a typo"\n  -15 easy: typo',
      )
    })

    test('says when no step has been seen', () => {
      expect(reportOf()).toContain(
        'Spend: no model steps seen yet this session.',
      )
    })

    test('says what was saved, with its share', () => {
      expect(
        reportOf({
          ledger: ledgerOf({ steps: 2, spentUsd: 0.03, originalUsd: 1.2 }),
        }),
      ).toContain(
        'Spend, estimated from list prices over 2 steps: $0.0300 against $1.20 on the models the steps came in with: saved $1.17 (98%).',
      )
    })

    test('rounds the share half up', () => {
      expect(
        reportOf({
          ledger: ledgerOf({ steps: 1, spentUsd: 0.1, originalUsd: 0.8 }),
        }),
      ).toContain('saved $0.7000 (88%).')
    })

    test('says what routing up cost', () => {
      expect(
        reportOf({
          ledger: ledgerOf({ steps: 1, spentUsd: 0.15, originalUsd: 0.0015 }),
        }),
      ).toContain('$0.1485 more (9900%), the price of routing up.')
    })

    test('says when there is no difference', () => {
      expect(
        reportOf({
          ledger: ledgerOf({ steps: 1, spentUsd: 0.6, originalUsd: 0.6 }),
        }),
      ).toContain(
        'over 1 step: $0.6000 against $0.6000 on the models the steps came in with: no difference so far.',
      )
    })

    test('counts the steps with no price apart from the sums', () => {
      expect(
        reportOf({
          ledger: ledgerOf({
            steps: 3,
            unpriced: 2,
            spentUsd: 0.1,
            originalUsd: 0.2,
          }),
        }),
      ).toContain(
        'over 1 step: $0.1000 against $0.2000 on the models the steps came in with: saved $0.1000 (50%).\n2 steps ran on a model with no price here and are left out.',
      )
      expect(
        reportOf({ ledger: ledgerOf({ steps: 2, unpriced: 2 }) }),
      ).toContain(
        'Spend: no estimate; 2 steps ran on a model with no price here.',
      )
    })

    test('explains the effort mode saving only in effort mode', () => {
      const note = "Effort mode runs on the session's own model"

      expect(reportOf()).toContain(note)
      expect(
        reportOf({ settings: settingsOf({ mode: 'full' }) }),
      ).not.toContain(note)
      expect(reportOf({ settings: settingsOf({ mode: 'off' }) })).not.toContain(
        note,
      )
    })

    test('has no trailing space on any line', () => {
      const report = reportOf({
        settings: settingsOf({ pin: 3, floor: 2, ceiling: 4 }),
        lastPrompt: scored,
      })

      expect(
        report.split('\n').filter(line => line !== line.trimEnd()),
      ).toEqual([])
    })
  })
})
