import { describe, expect, test, tier } from 'claude-code/testing'

import {
  estimateCostUsd,
  PRICES,
  PRICING_DATE,
  PRICING_SOURCE,
  priceOf,
} from '../hooks/scale/prices'

tier('user')

const MILLION = 1_000_000

describe('prices', () => {
  describe('where they come from', () => {
    test('name the page they were read from and the day', () => {
      expect(PRICING_SOURCE).toBe(
        'https://platform.claude.com/docs/en/about-claude/pricing',
      )
      expect(PRICING_DATE).toBe('2026-11-08')
    })
  })

  describe('the rates', () => {
    test('are those of the pricing page, per million tokens', () => {
      expect(PRICES.haiku).toEqual({
        id: 'claude-haiku-5-5',
        rates: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
        longContext: {
          aboveTokens: 100_000,
          rates: {
            input: 0.5,
            output: 2.5,
            cacheRead: 0.05,
            cacheWrite: 0.625,
          },
        },
      })
      expect(PRICES.sonnet).toEqual({
        id: 'claude-sonnet-5-5',
        rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
      })
      expect(PRICES.opus).toEqual({
        id: 'claude-opus-5-5',
        rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      })
      expect(PRICES.fable).toEqual({
        id: 'claude-fable-5-1',
        rates: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
      })
    })

    test('cost a million tokens of each kind as listed (Sonnet, Opus, Fable)', () => {
      const kinds = [
        ['input_tokens', 'input'],
        ['output_tokens', 'output'],
        ['cache_read_input_tokens', 'cacheRead'],
        ['cache_creation_input_tokens', 'cacheWrite'],
      ] as const

      for (const family of ['sonnet', 'opus', 'fable'] as const) {
        for (const [field, rate] of kinds) {
          expect(estimateCostUsd(family, { [field]: MILLION })).toBe(
            PRICES[family].rates[rate],
          )
        }
      }
    })

    test('cost Haiku as listed while the request is short', () => {
      expect(estimateCostUsd('haiku', { input_tokens: 100_000 })).toBe(0.01)
      expect(estimateCostUsd('haiku', { output_tokens: MILLION })).toBe(0.5)
      expect(
        estimateCostUsd('haiku', { cache_read_input_tokens: 100_000 }),
      ).toBe(0.001)
      expect(
        estimateCostUsd('haiku', { cache_creation_input_tokens: 100_000 }),
      ).toBe(0.0125)
    })
  })

  describe('the Haiku long-request rule', () => {
    test('prices a request of 100,000 input tokens at the short rates', () => {
      expect(
        estimateCostUsd('haiku', {
          input_tokens: 100_000,
          output_tokens: 10_000,
        }),
      ).toBe(0.015)
    })

    test('prices one of 100,001 whole at the long rates, output included', () => {
      expect(
        estimateCostUsd('haiku', {
          input_tokens: 100_001,
          output_tokens: 10_000,
        }),
      ).toBe(0.0750005)
      expect(
        estimateCostUsd('haiku', {
          input_tokens: 100_001,
          output_tokens: MILLION,
        }),
      ).toBe(2.5500005)
    })

    test('counts fresh input, cache reads and cache writes together', () => {
      expect(
        estimateCostUsd('haiku', {
          input_tokens: 50_000,
          cache_read_input_tokens: 50_000,
        }),
      ).toBe(0.0055)
      expect(
        estimateCostUsd('haiku', {
          input_tokens: 50_000,
          cache_read_input_tokens: 49_999,
          cache_creation_input_tokens: 2,
        }),
      ).toBe(0.0275012)
    })

    test('does not count output tokens toward the length', () => {
      expect(
        estimateCostUsd('haiku', { input_tokens: 1, output_tokens: 500_000 }),
      ).toBe(0.2500001)
    })

    test('applies to Haiku alone', () => {
      expect(estimateCostUsd('sonnet', { input_tokens: 300_000 })).toBe(0.6)
      expect(estimateCostUsd('opus', { input_tokens: 300_000 })).toBe(1.2)
      expect(estimateCostUsd('fable', { input_tokens: 300_000 })).toBe(3)
    })
  })

  describe('which model a name means', () => {
    test('takes the four aliases', () => {
      expect(priceOf('haiku')?.id).toBe('claude-haiku-5-5')
      expect(priceOf('sonnet')?.id).toBe('claude-sonnet-5-5')
      expect(priceOf('opus')?.id).toBe('claude-opus-5-5')
      expect(priceOf('fable')?.id).toBe('claude-fable-5-1')
    })

    test('takes any id that contains a family word, in any case', () => {
      expect(priceOf('claude-haiku-5-5')?.id).toBe('claude-haiku-5-5')
      expect(priceOf('anthropic.claude-opus-5-5-v1:0')?.id).toBe(
        'claude-opus-5-5',
      )
      expect(priceOf('CLAUDE-FABLE-5-1')?.id).toBe('claude-fable-5-1')
      expect(priceOf('claude-3-5-sonnet-20241022')?.id).toBe(
        'claude-sonnet-5-5',
      )
    })

    test('gives none for any other model', () => {
      for (const model of ['gpt-5', 'my-model', '', undefined]) {
        expect(priceOf(model)).toBeNull()
        expect(estimateCostUsd(model, { input_tokens: 1000 })).toBeNull()
      }
    })
  })

  describe('the estimate', () => {
    test('is nothing for a request with no tokens', () => {
      expect(estimateCostUsd('opus', {})).toBe(0)
    })

    test('adds the four kinds', () => {
      expect(
        estimateCostUsd('opus', {
          input_tokens: 100_000,
          output_tokens: 10_000,
          cache_read_input_tokens: 500_000,
          cache_creation_input_tokens: 20_000,
        }),
      ).toBe(0.8)
    })

    test('is rounded to the nanodollar', () => {
      expect(
        estimateCostUsd('sonnet', {
          input_tokens: 123_456,
          output_tokens: 7_890,
        }),
      ).toBe(0.325812)
      expect(estimateCostUsd('haiku', { cache_creation_input_tokens: 1 })).toBe(
        0.000000125,
      )
    })

    test('reads a count that is not a usable number as zero', () => {
      expect(
        estimateCostUsd('opus', {
          input_tokens: -5,
          output_tokens: Number.NaN,
          cache_read_input_tokens: Number.POSITIVE_INFINITY,
          cache_creation_input_tokens: undefined,
        }),
      ).toBe(0)
      expect(
        estimateCostUsd('opus', {
          input_tokens: '10' as unknown as number,
          output_tokens: 1000,
        }),
      ).toBe(0.02)
    })
  })
})
