import { describe, expect, test, tier } from 'claude-code/testing'

import type { Level } from '../hooks/scale/ladder'
import { clampLevel, escalate, scoreTask } from '../hooks/scale/score'

tier('user')

/**
 * A text of about forty-four tokens that no list of the scorer's mentions, so
 * that it scores exactly the base 30 and every signal added to it shows as its
 * own change.
 */
const BASE =
  'Here is the situation with the service as it stands today and what the team wants from the next release of the product, set out plainly so that nothing in it moves the score. '

/**
 * The scorer's answer for the base text with `extra` added after it.
 */
const withBase = (extra: string) => scoreTask(`${BASE}${extra}`)

const FENCE = '\n```ts\nlet a = 1\n```'
const THREE_PATHS = '\nsrc/a.ts src/b.ts src/c.ts'

describe('score', () => {
  describe('the base text', () => {
    test('scores 30 with no reason, at level 3', () => {
      expect(scoreTask(BASE)).toEqual({
        score: 30,
        level: 3,
        reasons: [],
        highStakes: false,
      })
    })
  })

  describe('length', () => {
    test('takes 8 off under 40 tokens', () => {
      expect(scoreTask('hello')).toEqual({
        score: 22,
        level: 2,
        reasons: ['-8 length: short prompt (under 40 tokens)'],
        highStakes: false,
      })
    })

    test('takes nothing off at exactly 40 tokens', () => {
      expect(scoreTask('a '.repeat(80)).reasons).toEqual([])
      expect(scoreTask(`${'a '.repeat(79)}a`).reasons).toEqual([
        '-8 length: short prompt (under 40 tokens)',
      ])
    })

    test('adds 10 over 800 tokens and 15 over 3000', () => {
      expect(scoreTask('a'.repeat(3200)).reasons).toEqual([])
      expect(scoreTask('a'.repeat(3201)).reasons).toEqual([
        '+10 length: long prompt (over 800 tokens)',
      ])
      expect(scoreTask('a'.repeat(12_000)).reasons).toEqual([
        '+10 length: long prompt (over 800 tokens)',
      ])
      expect(scoreTask('a'.repeat(12_001)).reasons).toEqual([
        '+15 length: very long prompt (over 3000 tokens)',
      ])
    })

    test('reads only the first 200,000 characters for words', () => {
      const early = scoreTask(`rename ${'a '.repeat(100_000)}`)
      const late = scoreTask(`${'a '.repeat(100_001)}rename`)

      expect(early.reasons).toContain('-15 easy: rename')
      expect(late.reasons).toEqual([
        '+15 length: very long prompt (over 3000 tokens)',
      ])
    })
  })

  describe('easy words', () => {
    test('take 15 off each, once, up to 25', () => {
      expect(withBase(' rename').reasons).toEqual(['-15 easy: rename'])
      expect(withBase(' rename rename RENAME').score).toBe(15)
      expect(withBase(' rename the typo').reasons).toEqual([
        '-25 easy: rename, typo (capped at -25)',
      ])
      expect(withBase(' rename typo format').score).toBe(5)
    })

    test('are named in the order of the list, not of the text', () => {
      expect(withBase(' typo, then rename').reasons).toContain(
        '-25 easy: rename, typo (capped at -25)',
      )
    })

    test('match whole words only', () => {
      expect(
        withBase(' formatted sorted counting listing discount accounting')
          .reasons,
      ).toEqual([])
    })

    test('match phrases across any run of whitespace and either apostrophe', () => {
      expect(withBase(' what   is this').reasons).toEqual(['-15 easy: what is'])
      expect(withBase(' look\nup the answer').reasons).toEqual([
        '-15 easy: look up',
      ])
      expect(withBase(" what's this").reasons).toEqual(["-15 easy: what's"])
      expect(withBase(' what’s this').reasons).toEqual(["-15 easy: what's"])
    })
  })

  describe('work words', () => {
    test('add 10 each, up to 20', () => {
      expect(withBase(' implement').reasons).toEqual(['+10 work: implement'])
      expect(withBase(' implement and refactor').reasons).toEqual([
        '+20 work: implement, refactor',
      ])
      expect(withBase(' implement refactor debug').reasons).toEqual([
        '+20 work: implement, refactor, debug (capped at +20)',
      ])
    })

    test('include the phrases', () => {
      for (const phrase of ['fix the bug', 'write tests', 'test suite']) {
        expect(withBase(` ${phrase}`).reasons).toEqual([`+10 work: ${phrase}`])
      }
    })

    test('do not match inside longer words', () => {
      expect(withBase(' reviewer building rebuild debugging').reasons).toEqual(
        [],
      )
    })
  })

  describe('hard words', () => {
    test('add 18 each, up to 36', () => {
      expect(withBase(' design').reasons).toEqual(['+18 hard: design'])
      expect(withBase(' design deadlock').reasons).toEqual([
        '+36 hard: design, deadlock',
      ])
      expect(withBase(' design deadlock performance').reasons).toEqual([
        '+36 hard: design, deadlock, performance (capped at +36)',
      ])
    })

    test('include every word of the list', () => {
      const words = [
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
      ]

      for (const word of words) {
        expect(withBase(` ${word}`).reasons).toContain(`+18 hard: ${word}`)
      }
    })
  })

  describe('frontier phrases', () => {
    test('add 25 once however many there are', () => {
      expect(withBase(' from scratch').reasons).toEqual([
        '+25 frontier: from scratch',
      ])
      expect(
        withBase(' from scratch, over the entire codebase').reasons,
      ).toEqual(['+25 frontier: from scratch, entire codebase (capped at +25)'])
    })

    test('match across a line break', () => {
      expect(withBase(' from\n   scratch').score).toBe(55)
    })
  })

  describe('code', () => {
    test('adds 8 for a fenced block', () => {
      expect(withBase(FENCE).reasons).toEqual([
        '+8 code: a code block or stack trace',
      ])
      expect(withBase('\n~~~\nx\n~~~').score).toBe(38)
    })

    test('does not take a fence in the middle of a line', () => {
      expect(withBase(' use ``` inline').reasons).toEqual([])
    })

    test('adds 8 for a line of a stack trace or compiler error', () => {
      const traces = [
        '\n    at run (/app/main.js:10:5)',
        '\n\tat com.acme.Main.run(Main.java:12)',
        '\n  File "app.py", line 3, in <module>',
        '\nTraceback (most recent call last):',
        '\njava.lang.NullPointerException: x',
        '\nsrc/a.ts(3,1): error TS2322: no',
      ]

      for (const trace of traces) {
        expect(withBase(trace).reasons).toEqual([
          '+8 code: a code block or stack trace',
        ])
      }
    })

    test('adds 8 once for a block and a trace together', () => {
      expect(withBase(`${FENCE}\n    at run (/app/main.js:10:5)`).score).toBe(
        38,
      )
    })
  })

  describe('file paths', () => {
    test('add 8 from three distinct paths', () => {
      expect(withBase(THREE_PATHS).reasons).toEqual(['+8 paths: 3 file paths'])
      expect(withBase('\nsrc/a.ts src/b.ts').reasons).toEqual([])
    })

    test('count a path once however often it is named', () => {
      expect(withBase('\nsrc/a.ts src/a.ts SRC/A.TS src/b.ts').reasons).toEqual(
        [],
      )
    })

    test('read directories, extensions and both slashes', () => {
      expect(
        withBase('\nsrc/deep/dir/file.tsx .\\lib\\b.cs notes.md').reasons,
      ).toEqual(['+8 paths: 3 file paths'])
    })

    test('do not read a word with a dot as a path', () => {
      expect(withBase(' e.g. i.e. etc. and so on, v1.5 too').reasons).toEqual(
        [],
      )
    })
  })

  describe('steps', () => {
    test('add 8 for a list of three items, bulleted or numbered', () => {
      expect(withBase('\n- one\n- two\n- three').reasons).toEqual([
        '+8 steps: a list of 3 items',
      ])
      expect(withBase('\n1. one\n2) two\n3. three').reasons).toEqual([
        '+8 steps: a list of 3 items',
      ])
      expect(withBase('\n- one\n- two').reasons).toEqual([])
    })

    test('add 8 for two sequencing words', () => {
      expect(
        withBase(' first this, then that, and also the other').reasons,
      ).toEqual(['+8 steps: 2 sequencing words'])
      expect(withBase(' this, after that this').reasons).toEqual([])
      expect(withBase(' this, then that').reasons).toEqual([])
    })

    test('add 8 once, and say the list when there is both', () => {
      expect(withBase('\n- a\n- b\n- c\nthen d, then e').reasons).toEqual([
        '+8 steps: a list of 3 items',
      ])
    })
  })

  describe('hints', () => {
    test('a light word takes 10 off, once', () => {
      expect(withBase(' just').reasons).toEqual(['-10 hint: just'])
      expect(withBase(' a quick and simple change').reasons).toEqual([
        '-10 hint: quick, simple (capped at -10)',
      ])
    })

    test('a careful word adds 15, once', () => {
      expect(withBase(' be thorough').reasons).toEqual(['+15 hint: thorough'])
      expect(withBase(' be thorough and think hard').reasons).toEqual([
        '+15 hint: thorough, think hard (capped at +15)',
      ])
    })

    test('both can apply, one after the other', () => {
      const result = withBase(' just be careful, think hard')

      expect(result.reasons).toEqual(['-10 hint: just', '+15 hint: think hard'])
      expect(result.score).toBe(35)
    })

    test('include every careful phrase', () => {
      for (const phrase of [
        'thorough',
        'carefully',
        'deep dive',
        'best possible',
        'think hard',
        'ultrathink',
        'high quality',
      ]) {
        expect(withBase(` ${phrase}`).score).toBe(45)
      }
    })
  })

  describe('high stakes', () => {
    test('keep a level at 4 or above without changing the score', () => {
      expect(scoreTask('rename the auth module')).toEqual({
        score: 7,
        level: 4,
        reasons: [
          '-8 length: short prompt (under 40 tokens)',
          '-15 easy: rename',
          'high stakes: auth (level floor 4)',
        ],
        highStakes: true,
      })
    })

    test('leave a level that is already higher alone', () => {
      const result = withBase(' design deadlock, be thorough about production')

      expect(result.score).toBe(81)
      expect(result.level).toBe(5)
      expect(result.highStakes).toBe(true)
    })

    test('are named by every word of the list', () => {
      const words = [
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

      for (const word of words) {
        const result = withBase(` the ${word} is involved`)

        expect(result.highStakes).toBe(true)
        expect(result.level).toBeGreaterThanOrEqual(4)
        expect(result.reasons.at(-1)).toContain(`high stakes: ${word}`)
      }
    })

    test('are not named by words that only contain them', () => {
      const result = withBase(
        ' the author of the product, a secretary and a reproduction',
      )

      expect(result.highStakes).toBe(false)
      expect(result.level).toBe(3)
    })
  })

  describe('the score and its level', () => {
    const CASES: readonly (readonly [string, string, number, Level])[] = [
      ['13, the top of level 1', ` rename typo${FENCE}`, 13, 1],
      ['15, the bottom of level 2', ' rename', 15, 2],
      ['28, the top of level 2', ` just${FENCE}`, 28, 2],
      ['30, the bottom of level 3', '', 30, 3],
      ['47, the top of level 3', '\u0000', 0, 3],
      ['48, the bottom of level 4', ' design', 48, 4],
      ['64, the top of level 4', ` design${FENCE}${THREE_PATHS}`, 64, 4],
      ['65, the bottom of level 5', ' from scratch implement', 65, 5],
      ['81, the top of level 5', ' design deadlock thorough', 81, 5],
      [
        '82, the bottom of level 6',
        ` design deadlock${FENCE}${THREE_PATHS}`,
        82,
        6,
      ],
    ]

    for (const [name, extra, expectedScore, level] of CASES) {
      if (extra === '\u0000') {
        continue
      }

      test(`${name}`, () => {
        const result = withBase(extra)

        expect(result.score).toBe(expectedScore)
        expect(result.level).toBe(level)
      })
    }

    test('47, the top of level 3', () => {
      expect(scoreTask('do it from scratch')).toMatchObject({
        score: 47,
        level: 3,
      })
    })

    test('is held to 0', () => {
      const result = scoreTask('typo rename just')

      expect(result.score).toBe(0)
      expect(result.level).toBe(1)
      expect(result.reasons.at(-1)).toBe('score held to 0')
    })

    test('is held to 100', () => {
      const loud =
        BASE.repeat(80) +
        ' implement refactor design deadlock from scratch, be thorough' +
        FENCE +
        THREE_PATHS +
        '\n- a\n- b\n- c'
      const result = scoreTask(loud)

      expect(result.score).toBe(100)
      expect(result.level).toBe(6)
      expect(result.reasons.at(-1)).toBe('score held to 100')
    })
  })

  describe('the reasons', () => {
    const SAMPLES = [
      'fix a typo in the README',
      'hello',
      'fix the bug in src/a.ts src/b.ts src/c.ts',
      'Design the architecture for a distributed rate limiter, prove it has no deadlock, and optimize performance. Think hard and be thorough.',
      `${BASE} implement and review the billing code, then test it, then ship`,
    ]

    test('each start with the points it added, so the score adds up', () => {
      for (const text of SAMPLES) {
        const result = scoreTask(text)
        const points = result.reasons
          .map(reason => /^([+-]\d+) /.exec(reason)?.[1])
          .filter((value): value is string => value !== undefined)
          .reduce((sum, value) => sum + Number(value), 30)

        expect(points).toBe(result.score)
      }
    })

    test('are all of a known shape', () => {
      for (const text of SAMPLES) {
        for (const reason of scoreTask(text).reasons) {
          expect(reason).toMatch(
            /^([+-]\d+ [a-z]+: |score held to |high stakes: )/,
          )
        }
      }
    })
  })

  describe('as a function', () => {
    test('gives the same answer for the same text, whatever came between', () => {
      const a = scoreTask('Design a distributed lock. Think hard.')
      const b = scoreTask(`${BASE}\nsrc/a.ts src/b.ts src/c.ts`)

      expect(scoreTask('Design a distributed lock. Think hard.')).toEqual(a)
      expect(scoreTask(`${BASE}\nsrc/a.ts src/b.ts src/c.ts`)).toEqual(b)
      expect(scoreTask('Design a distributed lock. Think hard.')).toEqual(a)
    })

    test('reads a text that is not one as empty', () => {
      expect(scoreTask(undefined as unknown as string)).toEqual(scoreTask(''))
      expect(scoreTask(42 as unknown as string).score).toBe(22)
    })

    test('always answers with a whole score from 0 to 100 and a level from 1 to 6', () => {
      for (const text of [
        '',
        ' ',
        'x',
        BASE,
        BASE.repeat(200),
        '\n'.repeat(500),
      ]) {
        const { score, level } = scoreTask(text)

        expect(Number.isInteger(score)).toBe(true)
        expect(score).toBeGreaterThanOrEqual(0)
        expect(score).toBeLessThanOrEqual(100)
        expect(level).toBeGreaterThanOrEqual(1)
        expect(level).toBeLessThanOrEqual(6)
      }
    })

    test('copes with a long run of one character', () => {
      expect(scoreTask('a'.repeat(150_000)).score).toBe(45)
      expect(scoreTask(' '.repeat(150_000)).score).toBe(45)
      expect(scoreTask('at '.repeat(60_000)).level).toBeGreaterThanOrEqual(1)
    })
  })

  describe('escalate', () => {
    test('goes up one level and stops at 6', () => {
      expect([1, 2, 3, 4, 5, 6].map(level => escalate(level as Level))).toEqual(
        [2, 3, 4, 5, 6, 6],
      )
    })
  })

  describe('clampLevel', () => {
    test('lifts a level to the floor and holds it to the ceiling', () => {
      expect(clampLevel(1, 3, 5)).toBe(3)
      expect(clampLevel(6, 1, 4)).toBe(4)
      expect(clampLevel(3, 1, 5)).toBe(3)
      expect(clampLevel(3, 3, 3)).toBe(3)
    })

    test('lets the ceiling win where the two cross', () => {
      expect(clampLevel(2, 5, 3)).toBe(3)
      expect(clampLevel(6, 5, 3)).toBe(3)
    })
  })
})
