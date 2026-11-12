import { describe, expect, test, tier } from 'claude-code/testing'

import { addStep, emptyLedger, savedUsd } from '../hooks/ledger'

tier('user')

const USAGE = { input_tokens: 100_000, output_tokens: 10_000 }

describe('ledger', () => {
  test('starts empty', () => {
    expect(emptyLedger()).toEqual({
      steps: 0,
      unpriced: 0,
      spentUsd: 0,
      originalUsd: 0,
    })
  })

  describe('addStep', () => {
    test('adds what a step cost and what it would have on the model it came in with', () => {
      const ledger = emptyLedger()

      addStep(ledger, {
        usage: { ...USAGE, model: 'claude-haiku-5-5' },
        sent: 'haiku',
        original: 'claude-opus-5-5',
      })

      expect(ledger).toEqual({
        steps: 1,
        unpriced: 0,
        spentUsd: 0.015,
        originalUsd: 0.6,
      })
    })

    test('prices a step by the model that answered, not the one it was sent to', () => {
      const ledger = emptyLedger()

      addStep(ledger, {
        usage: { ...USAGE, model: 'claude-sonnet-5-5' },
        sent: 'haiku',
        original: 'opus',
      })

      expect(ledger.spentUsd).toBe(0.3)
    })

    test('falls back to the model it was sent to when the response names none', () => {
      const ledger = emptyLedger()

      addStep(ledger, { usage: USAGE, sent: 'haiku', original: 'opus' })

      expect(ledger).toMatchObject({ steps: 1, unpriced: 0, spentUsd: 0.015 })
    })

    test('does not count a step with no usage', () => {
      const ledger = emptyLedger()

      addStep(ledger, { usage: null, sent: 'haiku', original: 'opus' })
      addStep(ledger, { usage: undefined, sent: 'haiku', original: 'opus' })

      expect(ledger).toEqual(emptyLedger())
    })

    test('counts a step on a model with no price, and leaves it out of both sums', () => {
      const ledger = emptyLedger()

      addStep(ledger, {
        usage: { ...USAGE, model: 'my-model' },
        sent: 'my-model',
        original: 'opus',
      })
      addStep(ledger, {
        usage: { ...USAGE, model: 'claude-opus-5-5' },
        sent: 'opus',
        original: 'my-model',
      })

      expect(ledger).toEqual({
        steps: 2,
        unpriced: 2,
        spentUsd: 0,
        originalUsd: 0,
      })
    })

    test('adds up over steps', () => {
      const ledger = emptyLedger()

      for (let step = 0; step < 3; step += 1) {
        addStep(ledger, { usage: USAGE, sent: 'opus', original: 'opus' })
      }

      expect(ledger).toMatchObject({
        steps: 3,
        spentUsd: 1.8,
        originalUsd: 1.8,
      })
    })
  })

  describe('savedUsd', () => {
    test('is what the original models would have cost less what was spent', () => {
      expect(
        savedUsd({ steps: 1, unpriced: 0, spentUsd: 0.1, originalUsd: 0.3 }),
      ).toBe(0.2)
    })

    test('is negative where routing up cost more', () => {
      expect(
        savedUsd({ steps: 1, unpriced: 0, spentUsd: 1.5, originalUsd: 0.015 }),
      ).toBe(-1.485)
    })

    test('is nothing for an empty ledger', () => {
      expect(savedUsd(emptyLedger())).toBe(0)
    })
  })
})
