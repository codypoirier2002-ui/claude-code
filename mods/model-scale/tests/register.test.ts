import type { AgentSpawnInput } from 'claude-code'
import { describe, expect, test, tier } from 'claude-code/testing'

import Fixtures from './fixtures'

tier('user')

/**
 * The status line for a decision: a middle dot between the level and the model.
 */
const status = (level: string, model: string, effort = ''): string =>
  `scale ${level} · ${model}${effort === '' ? '' : ` ${effort}`}`

/**
 * What a prompt gets in effort mode, by the name the fixtures give it. The
 * session asks for `max`, which no level does, so every change shows.
 */
const EFFORT_BY_PROMPT = [
  ['trivial', 'low'],
  ['simple', 'low'],
  ['standard', 'medium'],
  ['complex', 'high'],
  ['advanced', 'high'],
] as const

/**
 * What a prompt gets in full mode on an Opus session that is starting: the
 * model the step is sent to (the session's own id where the level means Opus)
 * and its effort.
 */
const FULL_BY_PROMPT = [
  ['trivial', 'haiku', 'low'],
  ['simple', 'haiku', 'medium'],
  ['standard', 'sonnet', 'medium'],
  ['complex', 'sonnet', 'high'],
  ['advanced', 'claude-opus-5-5', 'high'],
] as const

const NOT_TASKS: readonly {
  name: string
  text: string
  extra: Pick<Fixtures.TypedPrompt, 'command' | 'isMeta'>
}[] = [
  {
    name: 'a slash command the engine ran',
    text: Fixtures.PROMPTS.trivial,
    extra: { command: { name: 'review', args: 'the diff' } },
  },
  {
    name: 'a prompt the engine raised itself',
    text: Fixtures.PROMPTS.trivial,
    extra: { isMeta: true },
  },
  {
    name: 'a line that starts with a slash command',
    text: `/review ${Fixtures.PROMPTS.trivial}`,
    extra: {},
  },
]

describe('register', () => {
  describe('the start', () => {
    test('registers /scale', async ($, on) => {
      const world = Fixtures.worldOf(on)

      expect(await $.session.start(Fixtures.SESSION)).toEqual({ cwd: '/work' })
      expect(world.registered).toMatchObject([
        {
          name: 'scale',
          argumentHint:
            '[off|effort|full|pin <1-6>|unpin|floor <1-6>|ceiling <1-6>]',
        },
      ])
    })

    test('goes on when the name is taken, and the mod still routes', async ($, on) => {
      const world = Fixtures.worldOf(on, {}, ['command.register'])

      expect(await $.session.start(Fixtures.SESSION)).toEqual({ cwd: '/work' })
      expect(world.registered).toEqual([])

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)

      expect(world.steps[0]?.effort).toBe('low')
    })
  })

  describe('effort mode', () => {
    for (const [name, effort] of EFFORT_BY_PROMPT) {
      test(`gives a ${name} prompt ${effort} effort`, async ($, on) => {
        const world = await Fixtures.startedWorldOf($, on)

        await Fixtures.runTurn($, Fixtures.PROMPTS[name], 't1', {
          effort: 'max',
        })

        expect(world.steps).toEqual([{ ...Fixtures.stepOf('t1'), effort }])
      })
    }

    test('shows the level, the session model and the effort', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      const { chunks, result } = await Fixtures.runTurn(
        $,
        Fixtures.PROMPTS.trivial,
      )

      expect(world.steps).toEqual([{ ...Fixtures.stepOf('t1'), effort: 'low' }])
      expect(world.statuses).toEqual([status('L1 Trivial', 'opus', 'low')])
      expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'ok' }])
      expect(result.stopReason).toBe('end_turn')
    })

    test('holds the ceiling at level 5 until it is raised', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await Fixtures.runTurn($, Fixtures.PROMPTS.frontier, 't1', {
        effort: 'max',
      })

      expect(await Fixtures.scaleSays($, 'ceiling 6')).toBe(
        'scale: ceiling L6 Frontier; the hardest tasks may now run on Fable.',
      )

      await Fixtures.runTurn($, Fixtures.PROMPTS.frontier, 't2', {
        effort: 'max',
      })

      expect(world.steps.map(step => step.effort)).toEqual(['high', 'xhigh'])
      expect(world.statuses).toEqual([
        status('L5 Advanced', 'opus', 'high'),
        status('L6 Frontier', 'opus', 'xhigh'),
      ])
    })

    test('keeps the decision for every step of the turn', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await $.prompt.submit(Fixtures.typedPromptOf(Fixtures.PROMPTS.standard))

      for (const index of [0, 1, 2]) {
        await Fixtures.runStep(
          $,
          Fixtures.stepOf('t1', index, { effort: 'max' }),
        )
      }

      expect(world.steps.map(step => step.effort)).toEqual([
        'medium',
        'medium',
        'medium',
      ])
      expect(world.statuses).toEqual([status('L3 Standard', 'opus', 'medium')])
    })

    test('leaves a prompt sent during a turn for the next turn', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', {
        effort: 'max',
      })
      await $.prompt.submit(Fixtures.typedPromptOf(Fixtures.PROMPTS.complex))
      await Fixtures.runStep($, Fixtures.stepOf('t1', 1, { effort: 'max' }))
      await Fixtures.runStep($, Fixtures.stepOf('t2', 0, { effort: 'max' }))

      expect(world.steps.map(step => step.effort)).toEqual([
        'low',
        'low',
        'high',
      ])
    })

    test('leaves a turn no prompt started as it is', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await Fixtures.runStep($, Fixtures.stepOf('t1'))

      expect(world.steps).toEqual([Fixtures.stepOf('t1')])
      expect(world.statuses).toEqual([])
    })

    test('sets no effort on a model that takes none', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)
      const noEffort = { effort: undefined }

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', noEffort)

      expect(world.steps).toEqual([Fixtures.stepOf('t1', 0, noEffort)])
      expect(world.steps[0]?.effort).toBeUndefined()
      expect(world.statuses).toEqual([status('L1 Trivial', 'opus')])
    })

    for (const { name, text, extra } of NOT_TASKS) {
      test(`does not score ${name}`, async ($, on) => {
        const world = await Fixtures.startedWorldOf($, on)

        await $.prompt.submit(Fixtures.typedPromptOf(Fixtures.PROMPTS.complex))
        await $.prompt.submit(Fixtures.typedPromptOf(text, extra))
        await Fixtures.runStep($, Fixtures.stepOf('t1', 0, { effort: 'max' }))

        expect(world.steps[0]?.effort).toBe('high')
        expect(await Fixtures.scaleSays($)).toContain(
          'Last prompt: L4 Complex (score 58)',
        )
      })
    }
  })

  describe('an answer that did not finish', () => {
    for (const stopReason of ['max_tokens', 'refusal'] as const) {
      test(`after ${stopReason} the next prompt is lifted one level, once`, async ($, on) => {
        const world = await Fixtures.startedWorldOf($, on)
        const session = { effort: 'max' } as const

        world.reply.stopReason = stopReason
        await Fixtures.runTurn($, Fixtures.PROMPTS.standard, 't1', session)
        world.reply.stopReason = 'end_turn'
        await Fixtures.runTurn($, Fixtures.PROMPTS.standard, 't2', session)

        const report = await Fixtures.scaleSays($)

        await Fixtures.runTurn($, Fixtures.PROMPTS.standard, 't3', session)

        expect(world.steps.map(step => step.effort)).toEqual([
          'medium',
          'high',
          'medium',
        ])
        expect(report).toContain('Last prompt: L4 Complex (score 40)')
        expect(report).toContain('  escalated: last answer was cut off/refused')
      })
    }

    test('after a turn that used tools and then finished nothing is lifted', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      world.reply.stopReason = 'tool_use'
      await Fixtures.runTurn($, Fixtures.PROMPTS.standard, 't1')
      world.reply.stopReason = 'end_turn'
      await Fixtures.runStep($, Fixtures.stepOf('t1', 1))
      await Fixtures.runTurn($, Fixtures.PROMPTS.standard, 't2')

      expect(await Fixtures.scaleSays($)).not.toContain('escalated')
    })
  })

  describe('a pin, a floor and a ceiling', () => {
    test('a pin is the level, unscored, until it is lifted', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)
      const session = { effort: 'max' } as const

      expect(await Fixtures.scaleSays($, 'pin 1')).toBe(
        'scale: pinned to L1 Trivial.',
      )

      await Fixtures.runTurn($, Fixtures.PROMPTS.complex, 't1', session)

      const report = await Fixtures.scaleSays($)

      expect(await Fixtures.scaleSays($, 'unpin')).toBe(
        'scale: unpinned; prompts are scored again.',
      )

      await Fixtures.runTurn($, Fixtures.PROMPTS.complex, 't2', session)

      expect(world.steps.map(step => step.effort)).toEqual(['low', 'high'])
      expect(report).toContain('pin L1 Trivial, floor L1, ceiling L5')
      expect(report).toContain('Last prompt: L1 Trivial (pinned, not scored)')
      expect(report).toMatch(/^L1 +Trivial +haiku low +low +pinned$/m)
    })

    test('a pin is held by the floor and the ceiling', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await Fixtures.scaleSays($, 'ceiling 3')

      expect(await Fixtures.scaleSays($, 'pin 5')).toBe(
        'scale: pinned to L5 Advanced. The floor L1 and ceiling L3 hold it to L3 Standard.',
      )

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', {
        effort: 'max',
      })

      expect(world.steps[0]?.effort).toBe('medium')
      expect(await Fixtures.scaleSays($)).toContain(
        '  held to L3 Standard by floor L1 and ceiling L3',
      )
    })

    test('a pin is not lifted by a cut-off answer', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await Fixtures.scaleSays($, 'pin 2')
      world.reply.stopReason = 'max_tokens'
      await Fixtures.runTurn($, Fixtures.PROMPTS.complex, 't1')
      await Fixtures.runTurn($, Fixtures.PROMPTS.complex, 't2', {
        effort: 'max',
      })

      expect(world.steps[1]?.effort).toBe('low')
    })

    test('the floor lifts an easy prompt', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      expect(await Fixtures.scaleSays($, 'floor 3')).toBe(
        'scale: floor L3 Standard; no task runs below it.',
      )

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', {
        effort: 'max',
      })

      const report = await Fixtures.scaleSays($)

      expect(world.steps[0]?.effort).toBe('medium')
      expect(report).toContain('Last prompt: L3 Standard (score 7)')
      expect(report).toContain(
        '  held to L3 Standard by floor L3 and ceiling L5',
      )
      expect(report).toMatch(/^L1 +Trivial +haiku low +low +below the floor$/m)
      expect(report).toMatch(
        /^L2 +Simple +haiku medium +low +below the floor$/m,
      )
    })

    test('the ceiling holds a hard prompt down', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      expect(await Fixtures.scaleSays($, 'ceiling 2')).toBe(
        'scale: ceiling L2 Simple; no task runs above it.',
      )

      await Fixtures.runTurn($, Fixtures.PROMPTS.advanced, 't1', {
        effort: 'max',
      })

      const report = await Fixtures.scaleSays($)

      expect(world.steps[0]?.effort).toBe('low')
      expect(report).toContain('Last prompt: L2 Simple (score 81)')
      expect(report).toContain('  held to L2 Simple by floor L1 and ceiling L2')
      expect(report).toMatch(
        /^L3 +Standard +sonnet medium +medium +above the ceiling$/m,
      )
    })

    test('a floor above the ceiling is refused, and so is the reverse', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      expect(await Fixtures.scaleSays($, 'floor 6')).toBe(
        'scale: floor L6 Frontier would be above the ceiling L5; raise the ceiling first.',
      )
      expect(world.stored.has('settings')).toBe(false)

      await Fixtures.scaleSays($, 'floor 3')

      expect(await Fixtures.scaleSays($, 'ceiling 2')).toBe(
        'scale: ceiling L2 Simple would be below the floor L3; lower the floor first.',
      )
      expect(world.stored.get('settings')).toEqual({
        mode: 'effort',
        pin: null,
        floor: 3,
        ceiling: 5,
      })
    })
  })

  describe('full mode', () => {
    for (const [name, model, effort] of FULL_BY_PROMPT) {
      test(`starts a ${name} conversation on ${model} at ${effort}`, async ($, on) => {
        const world = await Fixtures.startedWorldOf($, on)

        await Fixtures.scaleSays($, 'full')
        await Fixtures.runTurn($, Fixtures.PROMPTS[name], 't1', {
          effort: 'max',
        })

        expect(world.steps).toEqual([
          { ...Fixtures.stepOf('t1'), model, effort },
        ])
      })
    }

    test('shows the model it chose', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      expect(await Fixtures.scaleSays($, 'full')).toBe(
        'scale: mode full: a new conversation starts on the cheapest model that suits the task, and later turns only move up.',
      )

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)

      expect(world.statuses).toEqual([status('L1 Trivial', 'haiku', 'low')])
    })

    test('never moves a conversation that has begun below its own model', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await Fixtures.scaleSays($, 'full')
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', {
        effort: 'max',
        messageCount: 5,
      })

      expect(world.steps).toEqual([
        { ...Fixtures.stepOf('t1'), messageCount: 5, effort: 'low' },
      ])
      expect(world.statuses).toEqual([status('L1 Trivial', 'opus', 'low')])
    })

    test('moves later turns of a conversation only up', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)
      const session = { effort: 'max' } as const

      await Fixtures.scaleSays($, 'full')
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', session)
      await Fixtures.runTurn($, Fixtures.PROMPTS.standard, 't2', {
        ...session,
        messageCount: 3,
      })
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't3', {
        ...session,
        messageCount: 5,
      })

      expect(world.steps.map(step => [step.model, step.effort])).toEqual([
        ['haiku', 'low'],
        ['sonnet', 'medium'],
        ['sonnet', 'low'],
      ])
    })

    test('picks again when a new conversation begins', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)
      const session = { effort: 'max' } as const

      await Fixtures.scaleSays($, 'full')
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', session)
      await Fixtures.runTurn($, Fixtures.PROMPTS.complex, 't2', session)
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't3', session)

      expect(world.steps.map(step => step.model)).toEqual([
        'haiku',
        'sonnet',
        'haiku',
      ])
    })

    test('keeps the model on every step of the turn', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await Fixtures.scaleSays($, 'full')
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)
      await Fixtures.runStep($, Fixtures.stepOf('t1', 1))
      await Fixtures.runStep($, Fixtures.stepOf('t1', 2))

      expect(world.steps.map(step => step.model)).toEqual([
        'haiku',
        'haiku',
        'haiku',
      ])
    })

    test('leaves a model the engine fell back to', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await Fixtures.scaleSays($, 'full')
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', {
        effort: 'max',
      })
      await Fixtures.runStep(
        $,
        Fixtures.stepOf('t1', 1, { model: 'claude-sonnet-5-5', effort: 'max' }),
      )

      expect(world.steps[1]).toEqual({
        ...Fixtures.stepOf('t1', 1),
        model: 'claude-sonnet-5-5',
        effort: 'low',
      })
      expect(world.statuses).toEqual([
        status('L1 Trivial', 'haiku', 'low'),
        status('L1 Trivial', 'sonnet', 'low'),
      ])
    })

    test('starts from the model a person switches to', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)
      const session = { effort: 'max' } as const

      await Fixtures.scaleSays($, 'full')
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', session)
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't2', {
        ...session,
        model: 'claude-sonnet-5-5',
        messageCount: 3,
      })

      expect(world.steps[1]).toEqual({
        ...Fixtures.stepOf('t2'),
        model: 'claude-sonnet-5-5',
        messageCount: 3,
        effort: 'low',
      })
    })

    test('does not route a model of none of the four families', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await Fixtures.scaleSays($, 'full')
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', {
        model: 'my-model',
        effort: 'max',
      })

      expect(world.steps).toEqual([
        { ...Fixtures.stepOf('t1'), model: 'my-model', effort: 'low' },
      ])
      expect(world.statuses).toEqual([status('L1 Trivial', 'my-model', 'low')])
    })

    test('runs on Fable only once the ceiling is raised', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)
      const session = { model: 'claude-sonnet-5-5', effort: 'max' } as const

      await Fixtures.scaleSays($, 'full')
      await Fixtures.runTurn($, Fixtures.PROMPTS.frontier, 't1', session)
      await Fixtures.scaleSays($, 'ceiling 6')
      await Fixtures.runTurn($, Fixtures.PROMPTS.frontier, 't2', session)

      expect(world.steps.map(step => [step.model, step.effort])).toEqual([
        ['opus', 'high'],
        ['fable', 'high'],
      ])
      expect(world.statuses).toEqual([
        status('L5 Advanced', 'opus', 'high'),
        status('L6 Frontier', 'fable', 'high'),
      ])
    })

    test('goes back to the session model when switched to effort mode', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)
      const session = { effort: 'max' } as const

      await Fixtures.scaleSays($, 'full')
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', session)
      await Fixtures.scaleSays($, 'effort')
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't2', session)

      expect(world.steps.map(step => [step.model, step.effort])).toEqual([
        ['haiku', 'low'],
        ['claude-opus-5-5', 'low'],
      ])
    })
  })

  describe('off', () => {
    test('leaves requests alone and clears the status line', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)

      expect(await Fixtures.scaleSays($, 'off')).toBe(
        'scale: mode off: nothing is routed; your model and effort are left as you set them.',
      )

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't2')

      expect(world.steps[1]).toEqual(Fixtures.stepOf('t2'))
      expect(world.statuses).toEqual([
        status('L1 Trivial', 'opus', 'low'),
        undefined,
      ])
    })

    test('drops the decision that was waiting', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await $.prompt.submit(Fixtures.typedPromptOf(Fixtures.PROMPTS.trivial))
      await Fixtures.scaleSays($, 'off')
      await Fixtures.scaleSays($, 'effort')
      await Fixtures.runStep($, Fixtures.stepOf('t1'))

      expect(world.steps).toEqual([Fixtures.stepOf('t1')])
    })

    test('does not touch a subagent either', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)
      const spawn = Fixtures.spawnOf(Fixtures.PROMPTS.trivial)

      await Fixtures.scaleSays($, 'off')

      expect(await $.agent.spawn(spawn)).toEqual({
        model: 'claude-opus-5-5',
        agentId: 'agent-1',
      })
      expect(world.spawns).toEqual([spawn])
    })
  })

  describe('subagents', () => {
    test('a general-purpose agent with no model gets the one its task means', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)
      const spawn = Fixtures.spawnOf(Fixtures.PROMPTS.trivial)

      expect(await $.agent.spawn(spawn)).toEqual({
        model: 'haiku',
        agentId: 'agent-1',
      })
      expect(world.spawns).toEqual([{ ...spawn, model: 'haiku' }])
    })

    test('the task is scored from its prompt and its description', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await $.agent.spawn(
        Fixtures.spawnOf(Fixtures.PROMPTS.advanced, {
          description: 'rate limiter design',
        }),
      )

      expect(world.spawns[0]?.model).toBe('opus')
      expect(await Fixtures.scaleSays($)).toMatch(
        /^Last subagent: L5 Advanced \(score \d+\) for "rate limiter design"$/m,
      )
    })

    test('the type is matched without regard to case', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await $.agent.spawn(
        Fixtures.spawnOf(Fixtures.PROMPTS.trivial, {
          subagentType: 'General-Purpose',
        }),
      )

      expect(world.spawns[0]?.model).toBe('haiku')
    })

    const UNTOUCHED: readonly {
      name: string
      extra: Partial<AgentSpawnInput>
    }[] = [
      { name: 'one that names its model', extra: { model: 'opus' } },
      { name: 'a fork of the conversation', extra: { fork: true } },
      { name: 'another type of agent', extra: { subagentType: 'Explore' } },
    ]

    for (const { name, extra } of UNTOUCHED) {
      test(`leaves ${name} as it is`, async ($, on) => {
        const world = await Fixtures.startedWorldOf($, on)
        const spawn = Fixtures.spawnOf(Fixtures.PROMPTS.trivial, extra)

        await $.agent.spawn(spawn)

        expect(world.spawns).toEqual([spawn])
        expect(await Fixtures.scaleSays($)).toContain('Last subagent: none yet')
      })
    }

    test('the floor and the ceiling apply, a pin does not', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await Fixtures.scaleSays($, 'pin 6')
      await $.agent.spawn(Fixtures.spawnOf(Fixtures.PROMPTS.trivial))
      await Fixtures.scaleSays($, 'unpin')
      await Fixtures.scaleSays($, 'floor 3')
      await $.agent.spawn(Fixtures.spawnOf(Fixtures.PROMPTS.trivial))
      await Fixtures.scaleSays($, 'floor 1')
      await Fixtures.scaleSays($, 'ceiling 3')
      await $.agent.spawn(Fixtures.spawnOf(Fixtures.PROMPTS.advanced))

      expect(world.spawns.map(spawn => spawn.model)).toEqual([
        'haiku',
        'sonnet',
        'sonnet',
      ])
    })

    test('works in effort mode and in full mode alike', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await $.agent.spawn(Fixtures.spawnOf(Fixtures.PROMPTS.standard))
      await Fixtures.scaleSays($, 'full')
      await $.agent.spawn(Fixtures.spawnOf(Fixtures.PROMPTS.standard))

      expect(world.spawns.map(spawn => spawn.model)).toEqual([
        'sonnet',
        'sonnet',
      ])
    })

    test('its steps ask for the effort of its level', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await $.agent.spawn(Fixtures.spawnOf(Fixtures.PROMPTS.standard))
      await Fixtures.runStep(
        $,
        Fixtures.stepOf('s1', 0, {
          agentId: 'agent-1',
          model: 'sonnet',
          effort: 'max',
        }),
      )

      expect(world.steps).toEqual([
        {
          ...Fixtures.stepOf('s1'),
          agentId: 'agent-1',
          model: 'sonnet',
          effort: 'medium',
        },
      ])
      expect(world.statuses).toEqual([])
    })

    test('leaves the steps of a subagent it did not route', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)
      const step = Fixtures.stepOf('s1', 0, {
        agentId: 'agent-9',
        effort: 'max',
      })

      await Fixtures.runStep($, step)

      expect(world.steps).toEqual([step])
    })

    test('counts its spend against the model its parent ran on', async ($, on) => {
      await Fixtures.startedWorldOf($, on)

      await $.agent.spawn(Fixtures.spawnOf(Fixtures.PROMPTS.trivial))
      await Fixtures.runStep(
        $,
        Fixtures.stepOf('s1', 0, { agentId: 'agent-1', model: 'haiku' }),
      )

      const report = await Fixtures.scaleSays($)

      expect(report).toContain(
        'Spend, estimated from list prices over 1 step: $0.0150 against $0.6000 on the models the steps came in with: saved $0.5850 (98%).',
      )
      expect(report).toContain(
        'Last subagent: L1 Trivial (score 7) for "a task"',
      )
    })
  })

  describe('/scale', () => {
    test('shows the scale, the settings and a start with nothing seen', async ($, on) => {
      await Fixtures.startedWorldOf($, on)

      const report = await Fixtures.scaleSays($)

      expect(report).toStartWith(
        'scale: mode effort: your model stays as it is; only the thinking effort follows the task\n' +
          'pin none, floor L1, ceiling L5\n' +
          'subagents routed: general-purpose\n',
      )
      expect(report).toMatch(/^Level +Name +Full mode +Effort mode$/m)
      expect(report).toMatch(/^L1 +Trivial +haiku low +low$/m)
      expect(report).toMatch(/^L2 +Simple +haiku medium +low$/m)
      expect(report).toMatch(/^L3 +Standard +sonnet medium +medium$/m)
      expect(report).toMatch(/^L4 +Complex +sonnet high +high$/m)
      expect(report).toMatch(/^L5 +Advanced +opus high +high$/m)
      expect(report).toMatch(
        /^L6 +Frontier +fable high +xhigh +above the ceiling$/m,
      )
      expect(report).toContain('Last prompt: none yet')
      expect(report).toContain('Last subagent: none yet')
      expect(report).toContain('Spend: no model steps seen yet this session.')
      expect(report).toEndWith(
        'usage: /scale [off|effort|full|pin <1-6>|unpin|floor <1-6>|ceiling <1-6>]',
      )
    })

    test('shows the last prompt with its score and each reason', async ($, on) => {
      await Fixtures.startedWorldOf($, on)

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)

      expect(await Fixtures.scaleSays($)).toContain(
        [
          'Last prompt: L1 Trivial (score 7)',
          '  -8 length: short prompt (under 40 tokens)',
          '  -15 easy: typo',
          'Last subagent: none yet',
        ].join('\n'),
      )
    })

    test('says when high stakes held a level up', async ($, on) => {
      await Fixtures.startedWorldOf($, on)

      await Fixtures.runTurn($, 'rename the auth module')

      expect(await Fixtures.scaleSays($)).toContain(
        'Last prompt: L4 Complex (score 7)',
      )
      expect(await Fixtures.scaleSays($)).toContain(
        '  high stakes: auth (level floor 4)',
      )
    })

    test('answers a request it cannot read with the usage', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)
      const usage =
        'usage: /scale [off|effort|full|pin <1-6>|unpin|floor <1-6>|ceiling <1-6>]'

      for (const args of [
        'bogus',
        'pin',
        'pin 7',
        'floor x',
        'full now',
        'off 1',
      ]) {
        expect(await Fixtures.scaleSays($, args)).toBe(usage)
      }

      expect(world.stored.has('settings')).toBe(false)
    })

    test('an unpin with nothing pinned changes nothing', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      expect(await Fixtures.scaleSays($, 'unpin')).toBe(
        'scale: nothing was pinned.',
      )
      expect(world.stored.has('settings')).toBe(false)
    })

    test('reads a level as 3 or L3 in any case', async ($, on) => {
      await Fixtures.startedWorldOf($, on)

      expect(await Fixtures.scaleSays($, 'PIN l4')).toBe(
        'scale: pinned to L4 Complex.',
      )
    })
  })

  describe('the spend', () => {
    test('is saved by a cheaper model, in full mode', async ($, on) => {
      await Fixtures.startedWorldOf($, on)

      await Fixtures.scaleSays($, 'full')
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)

      const report = await Fixtures.scaleSays($)

      expect(report).toContain(
        'Spend, estimated from list prices over 1 step: $0.0150 against $0.6000 on the models the steps came in with: saved $0.5850 (98%).',
      )
      expect(report).not.toContain('Effort mode runs')
    })

    test('is no different in effort mode, and says why', async ($, on) => {
      await Fixtures.startedWorldOf($, on)

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)

      const report = await Fixtures.scaleSays($)

      expect(report).toContain(
        'Spend, estimated from list prices over 1 step: $0.6000 against $0.6000 on the models the steps came in with: no difference so far.',
      )
      expect(report).toContain("Effort mode runs on the session's own model")
    })

    test('adds up the steps of a turn', async ($, on) => {
      await Fixtures.startedWorldOf($, on)

      await Fixtures.scaleSays($, 'full')
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)
      await Fixtures.runStep($, Fixtures.stepOf('t1', 1))

      expect(await Fixtures.scaleSays($)).toContain(
        'over 2 steps: $0.0300 against $1.20 on the models the steps came in with: saved $1.17 (98%).',
      )
    })

    test('says what routing up cost', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      world.reply.tokens = {
        input: 10_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
      }

      await Fixtures.scaleSays($, 'full')
      await Fixtures.scaleSays($, 'ceiling 6')
      await Fixtures.runTurn($, Fixtures.PROMPTS.frontier, 't1', {
        model: 'claude-haiku-5-5',
      })

      expect(world.steps[0]?.model).toBe('fable')
      expect(await Fixtures.scaleSays($)).toContain(
        'over 1 step: $0.1500 against $0.0015 on the models the steps came in with: $0.1485 more (9900%), the price of routing up.',
      )
    })

    test('prices a long Haiku request at the long-context rates', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      world.reply.tokens = {
        input: 150_000,
        output: 10_000,
        cacheRead: 0,
        cacheWrite: 0,
      }

      await Fixtures.scaleSays($, 'full')
      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)

      expect(await Fixtures.scaleSays($)).toContain(
        'over 1 step: $0.1000 against $0.8000 on the models the steps came in with: saved $0.7000 (88%).',
      )
    })

    test('leaves a step on a model with no price out of both sums', async ($, on) => {
      await Fixtures.startedWorldOf($, on)

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', {
        model: 'my-model',
      })

      expect(await Fixtures.scaleSays($)).toContain(
        'Spend: no estimate; 1 step ran on a model with no price here.',
      )

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't2')

      const report = await Fixtures.scaleSays($)

      expect(report).toContain('over 1 step: $0.6000 against $0.6000')
      expect(report).toContain(
        '1 step ran on a model with no price here and is left out.',
      )
    })

    test('does not count a step that came back with no usage', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      world.reply.tokens = null

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)

      expect(await Fixtures.scaleSays($)).toContain(
        'Spend: no model steps seen yet this session.',
      )
    })
  })

  describe('the settings', () => {
    test('are kept in the store when changed', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on)

      await Fixtures.scaleSays($, 'full')
      await Fixtures.scaleSays($, 'floor 2')
      await Fixtures.scaleSays($, 'ceiling 4')
      await Fixtures.scaleSays($, 'pin 3')

      expect(world.stored.get('settings')).toEqual({
        mode: 'full',
        pin: 3,
        floor: 2,
        ceiling: 4,
      })
    })

    test('are read from the store at the start', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on, {
        settings: { mode: 'full', pin: null, floor: 2, ceiling: 4 },
      })

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', {
        effort: 'max',
      })

      expect(world.steps).toEqual([
        { ...Fixtures.stepOf('t1'), model: 'haiku', effort: 'medium' },
      ])
      expect(world.statuses).toEqual([status('L2 Simple', 'haiku', 'medium')])
      expect(await Fixtures.scaleSays($)).toContain(
        'pin none, floor L2, ceiling L4',
      )
    })

    test('fall back to the defaults field by field when the store holds nonsense', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on, {
        settings: { mode: 'sideways', pin: 9, floor: 2, ceiling: 'high' },
      })

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial, 't1', {
        effort: 'max',
      })

      expect(world.steps[0]?.effort).toBe('low')
      expect(await Fixtures.scaleSays($)).toContain(
        'mode effort: your model stays as it is',
      )
      expect(await Fixtures.scaleSays($)).toContain(
        'pin none, floor L2, ceiling L5',
      )
    })

    test('stand for the session when the store cannot be written', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on, {}, ['store.set'])

      expect(await Fixtures.scaleSays($, 'full')).toBe(
        'scale: mode full: a new conversation starts on the cheapest model that suits the task, and later turns only move up. (this could not be kept for the next session)',
      )

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)

      expect(world.steps[0]?.model).toBe('haiku')
      expect(world.stored.has('settings')).toBe(false)
    })

    test('are the defaults when the store cannot be read', async ($, on) => {
      const world = await Fixtures.startedWorldOf(
        $,
        on,
        {
          settings: { mode: 'off', pin: null, floor: 1, ceiling: 5 },
        },
        ['store.get'],
      )

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)

      expect(world.steps[0]?.effort).toBe('low')
    })
  })

  describe('when something beneath fails', () => {
    test('a status line that cannot be set does not stop the rewrite', async ($, on) => {
      const world = await Fixtures.startedWorldOf($, on, {}, ['ui.status'])

      await Fixtures.runTurn($, Fixtures.PROMPTS.trivial)

      expect(world.steps).toEqual([{ ...Fixtures.stepOf('t1'), effort: 'low' }])
      expect(world.statuses).toEqual([])
    })

    test('a status line that cannot be cleared does not stop /scale off', async ($, on) => {
      await Fixtures.startedWorldOf($, on, {}, ['ui.status'])

      expect(await Fixtures.scaleSays($, 'off')).toStartWith('scale: mode off:')
    })
  })
})
