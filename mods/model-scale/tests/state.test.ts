import { describe, expect, test, tier } from 'claude-code/testing'

import { createState, remember } from '../hooks/state'

tier('user')

describe('state', () => {
  test('starts with nothing seen', () => {
    const state = createState(new Set(['general-purpose']))

    expect(state.pending).toBeUndefined()
    expect(state.lastStop).toBeUndefined()
    expect(state.turns.size).toBe(0)
    expect(state.agents.size).toBe(0)
    expect(state.ledger).toEqual({
      steps: 0,
      unpriced: 0,
      spentUsd: 0,
      originalUsd: 0,
    })
    expect([...state.agentTypes]).toEqual(['general-purpose'])
  })

  describe('remember', () => {
    test('keeps the newest entries, up to the limit', () => {
      const map = new Map<string, number>()

      for (const [index, key] of ['a', 'b', 'c', 'd'].entries()) {
        remember(map, key, index, 3)
      }

      expect([...map.keys()]).toEqual(['b', 'c', 'd'])
    })

    test('moves a key that is put again to the newest place', () => {
      const map = new Map<string, number>()

      remember(map, 'a', 1, 2)
      remember(map, 'b', 2, 2)
      remember(map, 'a', 3, 2)
      remember(map, 'c', 4, 2)

      expect([...map.entries()]).toEqual([
        ['a', 3],
        ['c', 4],
      ])
    })
  })
})
