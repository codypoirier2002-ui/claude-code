import { estimateCostUsd, type Usage } from './scale/prices'

/**
 * What the session's steps cost under the mod, estimated from list prices, and
 * what the same tokens would have cost on the model each step came in with.
 * The difference is the mod's saving; it is an estimate, not a bill.
 */
export type Ledger = {
  /**
   * Steps that reported usage.
   */
  steps: number
  /**
   * Of those, the steps whose model has no price here: they are in neither
   * sum, so the two stay comparable.
   */
  unpriced: number
  spentUsd: number
  originalUsd: number
}

/**
 * One finished step, as the ledger takes it.
 */
export type LedgerStep = {
  /**
   * What the step cost as the API reported it (`TurnStepResult.usage`), with
   * the id of the model that answered; null when no response arrived.
   */
  usage: (Usage & { readonly model?: string }) | null | undefined
  /**
   * The model the step was sent to, when the response names none.
   */
  sent: string
  /**
   * The model the step would have run on without the mod.
   */
  original: string
}

const NANODOLLAR = 1e9

/**
 * Dollars held to the nanodollar, so that sums of prices do not drift.
 */
function toNano(dollars: number): number {
  return Math.round(dollars * NANODOLLAR) / NANODOLLAR
}

export function emptyLedger(): Ledger {
  return { steps: 0, unpriced: 0, spentUsd: 0, originalUsd: 0 }
}

/**
 * Adds one finished step. A step without usage (the request failed or was
 * interrupted) is not counted: nothing was billed that the ledger can see.
 *
 * @param ledger the ledger, changed in place
 * @param step the finished step
 */
export function addStep(ledger: Ledger, step: LedgerStep): void {
  const { usage } = step

  if (usage === null || usage === undefined) {
    return
  }

  ledger.steps += 1

  const spent =
    estimateCostUsd(usage.model, usage) ?? estimateCostUsd(step.sent, usage)
  const original = estimateCostUsd(step.original, usage)

  if (spent === null || original === null) {
    ledger.unpriced += 1

    return
  }

  ledger.spentUsd = toNano(ledger.spentUsd + spent)
  ledger.originalUsd = toNano(ledger.originalUsd + original)
}

/**
 * What the mod saved so far: the original spend less the actual one. Negative
 * when routing up cost more than the original model would have.
 *
 * @param ledger the ledger
 * @returns dollars, to the nanodollar
 */
export function savedUsd(ledger: Ledger): number {
  return toNano(ledger.originalUsd - ledger.spentUsd)
}
