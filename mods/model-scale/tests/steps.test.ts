import { describe, expect, test, tier } from 'claude-code/testing'

import { statusOf } from '../hooks/steps'

tier('user')

describe('steps', () => {
  describe('statusOf', () => {
    test('names the level, the model family and the effort', () => {
      expect(statusOf(3, 'claude-sonnet-5-5', 'medium')).toBe(
        'scale L3 Standard · sonnet medium',
      )
      expect(statusOf(1, 'haiku', 'low')).toBe('scale L1 Trivial · haiku low')
    })

    test('shows a model of no family by its id', () => {
      expect(statusOf(2, 'my-model', 'low')).toBe(
        'scale L2 Simple · my-model low',
      )
    })

    test('leaves the effort out where the step has none, and shows a number', () => {
      expect(statusOf(4, 'opus', undefined)).toBe('scale L4 Complex · opus')
      expect(statusOf(6, 'fable', 12_000)).toBe(
        'scale L6 Frontier · fable 12000',
      )
    })
  })
})
