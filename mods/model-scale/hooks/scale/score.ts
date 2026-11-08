import { MAX_LEVEL, type Level } from './ladder'

/**
 * What the scorer made of a task.
 */
export type ScoreResult = {
  /**
   * 0 to 100: how demanding the text looks.
   */
  score: number
  /**
   * The level the score falls in, lifted to the floor for high-stakes work.
   */
  level: Level
  /**
   * One short line per signal that moved the score, each starting with the
   * points it added (`+18 hard: concurrency`), so the score can be added up
   * from 30 and audited.
   */
  reasons: string[]
  /**
   * Whether the task touches something costly to get wrong (auth, billing,
   * production...), which keeps its level at or above `HIGH_STAKES_FLOOR`.
   */
  highStakes: boolean
}

/**
 * Where every score starts.
 */
export const BASE_SCORE = 30

/**
 * The lowest level a high-stakes task is given.
 */
export const HIGH_STAKES_FLOOR: Level = 4

/**
 * The text a pattern scan reads, at most: a task longer than this is scored
 * on its length and on its first part, so a pasted log cannot make a hook
 * slow.
 */
const SCAN_LIMIT = 200_000

const CHARS_PER_TOKEN = 4

/**
 * Signals counted by the words they contain: each distinct word found adds
 * `points`, and the group never adds more than `cap` in all.
 */
type WordGroup = {
  name: string
  points: number
  cap: number
  terms: readonly string[]
}

type Compiled = {
  name: string
  points: number
  cap: number
  patterns: readonly { label: string; pattern: RegExp }[]
}

const EASY: WordGroup = {
  name: 'easy',
  points: -15,
  cap: -25,
  terms: [
    'rename',
    'typo',
    'format',
    'reformat',
    'list',
    'what is',
    "what's",
    'summarize',
    'summarise',
    'translate',
    'convert',
    'classify',
    'extract',
    'lookup',
    'look up',
    'spell',
    'count',
    'sort',
  ],
}

const WORK: WordGroup = {
  name: 'work',
  points: 10,
  cap: 20,
  terms: [
    'implement',
    'refactor',
    'debug',
    'fix the bug',
    'write tests',
    'test suite',
    'review',
    'integrate',
    'build',
  ],
}

const HARD: WordGroup = {
  name: 'hard',
  points: 18,
  cap: 36,
  terms: [
    'architecture',
    'architect',
    'design',
    'migrate',
    'migration',
    'concurrency',
    'race condition',
    'deadlock',
    'performance',
    'optimize',
    'optimise',
    'distributed',
    'root cause',
    'security',
    'vulnerability',
    'audit',
    'prove',
    'proof',
    'trade-off',
    'tradeoff',
    'scalability',
  ],
}

const FRONTIER: WordGroup = {
  name: 'frontier',
  points: 25,
  cap: 25,
  terms: [
    'from scratch',
    'entire codebase',
    'whole codebase',
    'multi-day',
    'novel research',
    'end-to-end system',
    'research paper',
    'long-horizon',
  ],
}

/**
 * "This is small": any one of these takes 10 off, once.
 */
const HINT_LIGHT: WordGroup = {
  name: 'hint',
  points: -10,
  cap: -10,
  terms: ['quick', 'just', 'simple', 'simply', 'small'],
}

/**
 * "This matters": any one of these adds 15, once.
 */
const HINT_CARE: WordGroup = {
  name: 'hint',
  points: 15,
  cap: 15,
  terms: [
    'thorough',
    'carefully',
    'deep dive',
    'best possible',
    'think hard',
    'ultrathink',
    'high quality',
  ],
}

/**
 * Work that is costly to get wrong: no score change, but a floor on the level.
 */
const STAKES_TERMS: readonly string[] = [
  'auth',
  'authentication',
  'billing',
  'payment',
  'payments',
  'production',
  'prod',
  'security',
  'migration',
  'data loss',
  'credentials',
  'secret',
  'permissions',
  'encryption',
]

/**
 * A listed word or phrase as a case-insensitive whole-word pattern: spaces
 * match any run of whitespace, and an apostrophe either kind.
 *
 * @param term the word or phrase as listed
 * @returns the pattern, without the `g` flag so that `test` keeps no state
 */
function patternOf(term: string): RegExp {
  const body = term
    .split(' ')
    .map(word =>
      word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['\u2019]"),
    )
    .join('\\s+')

  return new RegExp(`\\b${body}\\b`, 'i')
}

function compile(group: WordGroup): Compiled {
  return {
    name: group.name,
    points: group.points,
    cap: group.cap,
    patterns: group.terms.map(label => ({ label, pattern: patternOf(label) })),
  }
}

const EASY_C = compile(EASY)
const WORK_C = compile(WORK)
const HARD_C = compile(HARD)
const FRONTIER_C = compile(FRONTIER)
const HINT_LIGHT_C = compile(HINT_LIGHT)
const HINT_CARE_C = compile(HINT_CARE)
const STAKES_C = compile({
  name: 'stakes',
  points: 0,
  cap: 0,
  terms: STAKES_TERMS,
})

/**
 * Which of a group's words the text contains, each counted once.
 *
 * @param text the text
 * @param group the compiled group
 * @returns the words as listed, in list order
 */
function foundIn(text: string, group: Compiled): string[] {
  return group.patterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label)
}

function signed(points: number): string {
  return points > 0 ? `+${points}` : String(points)
}

/**
 * A fenced code block, opened at the start of a line.
 */
const FENCE = /^[ \t]*(?:`{3,}|~{3,})/m

/**
 * One line of a stack trace or compiler error. Every repetition is bounded so
 * that a long unbroken run of characters cannot make a scan slow.
 */
const TRACES: readonly RegExp[] = [
  // JavaScript: at fn (file.js:1:2), at file.js:1:2
  /^[ \t]*at\s[^\n]{0,200}?:\d+:\d+\)?[ \t]*$/m,
  // Java: at com.acme.Main.run(Main.java:12)
  /^[ \t]*at\s+[\w$.<>]{1,120}\((?:[\w$.]{1,80}:\d+|Native Method|Unknown Source)\)/m,
  // Python: File "app.py", line 3
  /^[ \t]*File ".{1,200}", line \d+/m,
  /\bTraceback\b/,
  /\b[\w.$]{0,80}Exception\b/,
  /\berror TS\d{3,5}\b/,
]

const EXTENSIONS =
  'ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|' +
  'php|scala|sh|bash|ps1|sql|json|ya?ml|toml|ini|cfg|md|mdx|txt|html?|css|' +
  'scss|vue|svelte|xml|gradle|proto|tf'

/**
 * A file path with a known extension (`src/a.ts`, `foo.py`, `.\lib\b.cs`).
 */
const PATHS = new RegExp(
  String.raw`(?:^|[^\w.\\/-])((?:[\w.-]{1,64}[\\/]){0,8}\w[\w.-]{0,63}\.(?:${EXTENSIONS}))(?![\w-])`,
  'gi',
)

/**
 * A line that starts a numbered or bulleted list item.
 */
const LIST_ITEMS = /^[ \t]*(?:[-*\u2022]|\d{1,3}[.)])[ \t]+\S/gm

/**
 * Words that put steps in order.
 */
const SEQUENCE = /\b(?:then|after\s+that|and\s+also)\b/gi

function countOf(text: string, pattern: RegExp): number {
  let count = 0

  for (const _ of text.matchAll(pattern)) {
    count += 1
  }

  return count
}

/**
 * The level a score falls in: below 15 is 1, below 30 is 2, below 48 is 3,
 * below 65 is 4, below 82 is 5, and 82 or higher is 6.
 *
 * @param score the score, 0 to 100
 * @returns the level
 */
function levelOfScore(score: number): Level {
  if (score < 15) return 1
  if (score < 30) return 2
  if (score < 48) return 3
  if (score < 65) return 4
  if (score < 82) return 5

  return 6
}

/**
 * Scores how demanding a task looks, from its words alone. Pure and
 * deterministic: the same text always scores the same, nothing is sent
 * anywhere, and matching is case-insensitive on whole words (`format` does
 * not match `formatted`).
 *
 * The score starts at 30. A short text (under 40 tokens, estimated at four
 * characters each) takes 8 off, a long one (over 800) adds 10 and a very long
 * one (over 3000) 15. Each distinct word from a list moves the score (easy
 * -15 up to -25, work +10 up to +20, hard +18 up to +36, frontier phrases
 * +25 once), a code block or stack trace, three file paths, and a list of
 * steps add 8 each, a "quick" style hint takes 10 off and a "careful" style
 * hint adds 15. The score is held to 0..100 and mapped to a level; work that
 * is costly to get wrong (auth, billing, production...) is never given less
 * than level 4.
 *
 * @param text the task as the person wrote it
 * @returns the score, the level, why, and whether it is high stakes
 */
export function scoreTask(text: string): ScoreResult {
  const whole = typeof text === 'string' ? text : ''
  const scanned = whole.length > SCAN_LIMIT ? whole.slice(0, SCAN_LIMIT) : whole
  const tokens = whole.length / CHARS_PER_TOKEN
  const reasons: string[] = []
  let score = BASE_SCORE

  const add = (points: number, why: string): void => {
    score += points
    reasons.push(`${signed(points)} ${why}`)
  }

  const addGroup = (group: Compiled): void => {
    const found = foundIn(scanned, group)

    if (found.length === 0) {
      return
    }

    const raw = found.length * group.points

    const points =
      group.points > 0 ? Math.min(raw, group.cap) : Math.max(raw, group.cap)

    const capped = points === raw ? '' : ` (capped at ${signed(group.cap)})`

    add(points, `${group.name}: ${found.join(', ')}${capped}`)
  }

  if (tokens < 40) {
    add(-8, 'length: short prompt (under 40 tokens)')
  } else if (tokens > 3000) {
    add(15, 'length: very long prompt (over 3000 tokens)')
  } else if (tokens > 800) {
    add(10, 'length: long prompt (over 800 tokens)')
  }

  addGroup(EASY_C)
  addGroup(WORK_C)
  addGroup(HARD_C)
  addGroup(FRONTIER_C)

  if (FENCE.test(scanned) || TRACES.some(trace => trace.test(scanned))) {
    add(8, 'code: a code block or stack trace')
  }

  const paths = new Set<string>()

  for (const match of scanned.matchAll(PATHS)) {
    paths.add((match[1] ?? '').toLowerCase())
  }

  if (paths.size >= 3) {
    add(8, `paths: ${paths.size} file paths`)
  }

  const listed = countOf(scanned, LIST_ITEMS)
  const sequenced = countOf(scanned, SEQUENCE)

  if (listed >= 3 || sequenced >= 2) {
    add(
      8,
      listed >= 3
        ? `steps: a list of ${listed} items`
        : `steps: ${sequenced} sequencing words`,
    )
  }

  addGroup(HINT_LIGHT_C)
  addGroup(HINT_CARE_C)

  const held = Math.max(0, Math.min(100, score))

  if (held !== score) {
    reasons.push(`score held to ${held}`)
  }

  const stakes = foundIn(scanned, STAKES_C)
  const highStakes = stakes.length > 0
  const scored = levelOfScore(held)
  const level = highStakes ? maxLevel(scored, HIGH_STAKES_FLOOR) : scored

  if (highStakes) {
    reasons.push(
      `high stakes: ${stakes.join(', ')} (level floor ${HIGH_STAKES_FLOOR})`,
    )
  }

  return { score: held, level, reasons, highStakes }
}

function maxLevel(a: Level, b: Level): Level {
  return a >= b ? a : b
}

/**
 * One level up, from the top level to itself.
 *
 * @param level the level
 * @returns the next level, at most 6
 */
export function escalate(level: Level): Level {
  return (level >= MAX_LEVEL ? MAX_LEVEL : level + 1) as Level
}

/**
 * Holds a level between a floor and a ceiling. Where the two cross, the
 * ceiling wins: it is the one that caps spend.
 *
 * @param level the level
 * @param floor the lowest level allowed
 * @param ceiling the highest level allowed
 * @returns the level, no lower than the floor and no higher than the ceiling
 */
export function clampLevel(level: Level, floor: Level, ceiling: Level): Level {
  const lifted = maxLevel(level, floor)

  return lifted > ceiling ? ceiling : lifted
}
