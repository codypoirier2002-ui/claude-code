/**
 * Prompts whose level is known (see the scorer's tests for why): each is
 * written to score the same on every run.
 */
export const PROMPTS = {
  /** L1, score 7. */
  trivial: 'fix a typo in the README',
  /** L2, score 22. */
  simple: 'hello',
  /** L3, score 40. */
  standard: 'fix the bug in src/a.ts src/b.ts src/c.ts',
  /** L4, score 58. */
  complex:
    'Implement a new REST endpoint for orders, with tests, and review the existing handlers for consistency. Then update the docs and also add a changelog entry. Make sure it is all well covered and the error handling follows the same shape as the rest of the service so reviewers do not have to learn anything new.',
  /** L5, score 81. */
  advanced:
    'Design the architecture for a distributed rate limiter, prove it has no deadlock, and optimize performance. Think hard and be thorough about the trade-off between consistency and scalability.',
  /** L6, score 98. */
  frontier:
    'Design the architecture for a distributed rate limiter from scratch, prove it has no deadlock, optimize performance, and think hard about the trade-off',
} as const
