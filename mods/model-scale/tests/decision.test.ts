import { describe, expect, test, tier } from 'claude-code/testing'

import {
  chooseFamily,
  decideAgent,
  decidePrompt,
  ESCALATION_REASON,
  isCutOff,
  isNotATask,
} from '../hooks/decision'
import type { ModelAlias } from '../hooks/scale/ladder'
import { DEFAULT_SETTINGS, type Settings } from '../hooks/settings'

import Fixtures from './fixtures'

tier('user')

const settingsOf = (change: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  ...change,
})

describe('decision', () => {
  describe('isNotATask', () => {
    test('is false for a prompt the person typed', () => {
      expect(isNotATask({ text: 'fix the bug in the parser' })).toBe(false)
    })

    test('is true for a line the engine ran as a command', () => {
      expect(isNotATask({ text: 'x', command: { name: 'a', args: '' } })).toBe(
        true,
      )
      expect(isNotATask({ text: 'x', command: null })).toBe(false)
      expect(isNotATask({ text: 'x', command: undefined })).toBe(false)
    })

    test('is true for a prompt the engine raised itself', () => {
      expect(isNotATask({ text: 'x', isMeta: true })).toBe(true)
      expect(isNotATask({ text: 'x', isMeta: false })).toBe(false)
      expect(isNotATask({ text: 'x', isMeta: 'yes' })).toBe(false)
    })

    test('is true for a line that starts with a slash command, where the engine does not say so', () => {
      for (const text of [
        '/review the diff',
        '  /clear',
        '/compact',
        '/plugin:command arg',
        '/model\nsonnet',
      ]) {
        expect(isNotATask({ text })).toBe(true)
      }
    })

    test('is false for text that only has a slash in it', () => {
      for (const text of [
        '/usr/bin/env is missing',
        '/ 3',
        'see /review',
        '//comment',
        '/9lives',
        'a/b',
      ]) {
        expect(isNotATask({ text })).toBe(false)
      }
    })
  })

  describe('isCutOff', () => {
    test('is true for a refusal and for running out of output', () => {
      expect(isCutOff('refusal')).toBe(true)
      expect(isCutOff('max_tokens')).toBe(true)
    })

    test('is false for any other end, or none', () => {
      for (const reason of [
        'end_turn',
        'tool_use',
        'stop_sequence',
        null,
        undefined,
      ]) {
        expect(isCutOff(reason)).toBe(false)
      }
    })
  })

  describe('decidePrompt', () => {
    test('scores the prompt', () => {
      expect(
        decidePrompt(Fixtures.PROMPTS.trivial, settingsOf(), false),
      ).toEqual({
        kind: 'prompt',
        level: 1,
        score: 7,
        reasons: [
          '-8 length: short prompt (under 40 tokens)',
          '-15 easy: typo',
        ],
        highStakes: false,
      })
    })

    test('keeps the high-stakes flag of the score', () => {
      expect(
        decidePrompt('rename the auth module', settingsOf(), false),
      ).toMatchObject({ level: 4, highStakes: true })
    })

    test('goes up one level after an answer that was cut off, and says so', () => {
      const decision = decidePrompt(
        Fixtures.PROMPTS.standard,
        settingsOf(),
        true,
      )

      expect(decision.level).toBe(4)
      expect(decision.score).toBe(40)
      expect(decision.reasons.at(-1)).toBe(ESCALATION_REASON)
      expect(ESCALATION_REASON).toBe(
        'escalated: last answer was cut off/refused',
      )
    })

    test('goes up no further than 6', () => {
      expect(
        decidePrompt(
          Fixtures.PROMPTS.frontier,
          settingsOf({ ceiling: 6 }),
          true,
        ).level,
      ).toBe(6)
    })

    test('is held between the floor and the ceiling, and says so', () => {
      expect(
        decidePrompt(
          Fixtures.PROMPTS.trivial,
          settingsOf({ floor: 3 }),
          false,
        ).reasons.at(-1),
      ).toBe('held to L3 Standard by floor L3 and ceiling L5')
      expect(
        decidePrompt(Fixtures.PROMPTS.frontier, settingsOf(), false),
      ).toMatchObject({ level: 5, score: 98 })
    })

    test('is held after it has been lifted', () => {
      const decision = decidePrompt(
        Fixtures.PROMPTS.advanced,
        settingsOf(),
        true,
      )

      expect(decision.level).toBe(5)
      expect(decision.reasons.slice(-2)).toEqual([
        ESCALATION_REASON,
        'held to L5 Advanced by floor L1 and ceiling L5',
      ])
    })

    test('uses a pin as the level, unscored and never lifted', () => {
      expect(
        decidePrompt(Fixtures.PROMPTS.frontier, settingsOf({ pin: 2 }), true),
      ).toEqual({
        kind: 'pinned',
        level: 2,
        score: null,
        reasons: ['pinned to L2 Simple'],
        highStakes: false,
      })
    })

    test('holds a pin between the floor and the ceiling too', () => {
      expect(decidePrompt('x', settingsOf({ pin: 6 }), false)).toMatchObject({
        level: 5,
        reasons: [
          'pinned to L6 Frontier',
          'held to L5 Advanced by floor L1 and ceiling L5',
        ],
      })
    })
  })

  describe('decideAgent', () => {
    test('scores the prompt and the description together', () => {
      const alone = decideAgent('hello', '', settingsOf())
      const both = decideAgent('hello', 'fix a typo', settingsOf())

      expect(alone).toMatchObject({ kind: 'agent', score: 22, level: 2 })
      expect(both.reasons).toContain('-15 easy: typo')
    })

    test('ignores a pin', () => {
      expect(decideAgent('hello', '', settingsOf({ pin: 6 }))).toMatchObject({
        kind: 'agent',
        level: 2,
        score: 22,
      })
    })

    test('holds the level between the floor and the ceiling', () => {
      const decision = decideAgent(
        Fixtures.PROMPTS.advanced,
        '',
        settingsOf({ ceiling: 3 }),
      )

      expect(decision.level).toBe(3)
      expect(decision.reasons.at(-1)).toBe(
        'held to L3 Standard by floor L1 and ceiling L3',
      )
    })

    test('keeps the first 60 characters of the description', () => {
      expect(decideAgent('x', 'a'.repeat(100), settingsOf()).subject).toBe(
        'a'.repeat(60),
      )
      expect(decideAgent('x', 'short', settingsOf()).subject).toBe('short')
    })
  })

  describe('chooseFamily', () => {
    const choose = (
      target: ModelAlias,
      session: ModelAlias,
      isFresh: boolean,
      chosen?: ModelAlias,
    ): ModelAlias => chooseFamily({ target, isFresh, chosen, session })

    test("takes the level's family, up or down, for a new conversation", () => {
      expect(choose('haiku', 'opus', true)).toBe('haiku')
      expect(choose('fable', 'haiku', true)).toBe('fable')
      expect(choose('haiku', 'opus', true, 'fable')).toBe('haiku')
    })

    test("never goes below the session's model once the conversation has begun", () => {
      expect(choose('haiku', 'opus', false)).toBe('opus')
      expect(choose('sonnet', 'opus', false)).toBe('opus')
      expect(choose('opus', 'opus', false)).toBe('opus')
    })

    test("goes up from the session's model when the level asks for more", () => {
      expect(choose('fable', 'opus', false)).toBe('fable')
      expect(choose('opus', 'sonnet', false)).toBe('opus')
    })

    test('works up from the family already chosen', () => {
      expect(choose('sonnet', 'opus', false, 'haiku')).toBe('sonnet')
      expect(choose('haiku', 'opus', false, 'haiku')).toBe('haiku')
      expect(choose('haiku', 'opus', false, 'sonnet')).toBe('sonnet')
      expect(choose('opus', 'opus', false, 'sonnet')).toBe('opus')
    })
  })
})
