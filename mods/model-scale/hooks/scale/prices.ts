import { familyOf, type ModelAlias } from './ladder'

/**
 * List prices, in US dollars per million tokens, from the live pricing page
 *
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *
 * fetched 2026-11-08. Cache writes are priced at the 5-minute rate: a response
 * does not say which lifetime a cache write used, and a 1-hour write costs
 * more. Data-residency, fast-mode and batch multipliers are not applied.
 */
export const PRICING_SOURCE =
  'https://platform.claude.com/docs/en/about-claude/pricing'

export const PRICING_DATE = '2026-11-08'

/**
 * What a million tokens of each kind cost.
 */
export type Rates = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/**
 * A model's prices. Haiku alone is priced by the length of the request: one
 * whose input (fresh, cache reads and cache writes together) is over
 * `aboveTokens` pays `rates` on every token of it, the first 100,000 included.
 */
export type Price = {
  readonly id: string
  readonly rates: Rates
  readonly longContext?: {
    readonly aboveTokens: number
    readonly rates: Rates
  }
}

export const PRICES: Readonly<Record<ModelAlias, Price>> = {
  haiku: {
    id: 'claude-haiku-5-5',
    rates: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    longContext: {
      aboveTokens: 100_000,
      rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
  },
  sonnet: {
    id: 'claude-sonnet-5-5',
    rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },
  opus: {
    id: 'claude-opus-5-5',
    rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
  fable: {
    id: 'claude-fable-5-1',
    rates: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  },
}

/**
 * A request's token counts, spelled as the API spells them (`TurnUsage`
 * carries these). A count left out is zero.
 */
export type Usage = {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
}

const PER_MILLION = 1_000_000

/**
 * A token count that can be priced: finite and not negative, else zero.
 */
function countOf(tokens: number | undefined): number {
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0
    ? tokens
    : 0
}

/**
 * The prices for a model id or alias: the four family words
 * (`haiku`/`sonnet`/`opus`/`fable`), or any id containing one, mean the
 * family's current model. An older id of a family is priced as that model.
 *
 * @param model a model id or alias
 * @returns the family's price, or null for any other model
 */
export function priceOf(model: string | undefined): Price | null {
  const family = familyOf(model)

  return family === null ? null : PRICES[family]
}

/**
 * Estimates what one request cost, in US dollars.
 *
 * @param model the model that answered, by id or alias
 * @param usage the request's token counts
 * @returns dollars, to the nanodollar; null when the model is none of the
 *   four families, so that an unknown price is never counted as free
 */
export function estimateCostUsd(
  model: string | undefined,
  usage: Usage,
): number | null {
  const price = priceOf(model)

  if (price === null) {
    return null
  }

  const input = countOf(usage.input_tokens)
  const output = countOf(usage.output_tokens)
  const cacheRead = countOf(usage.cache_read_input_tokens)
  const cacheWrite = countOf(usage.cache_creation_input_tokens)

  const isLong =
    price.longContext !== undefined &&
    input + cacheRead + cacheWrite > price.longContext.aboveTokens

  const rates =
    isLong && price.longContext !== undefined
      ? price.longContext.rates
      : price.rates

  const dollars =
    (input * rates.input +
      output * rates.output +
      cacheRead * rates.cacheRead +
      cacheWrite * rates.cacheWrite) /
    PER_MILLION

  return Math.round(dollars * 1e9) / 1e9
}
