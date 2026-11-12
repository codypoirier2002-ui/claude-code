import { describe, expect, test, tier } from 'claude-code/testing'

import { agentTypesOf, DEFAULT_AGENT_TYPES } from '../hooks/options'

tier('user')

const typesOf = (options: Record<string, unknown>): string[] =>
  [...agentTypesOf(options as Parameters<typeof agentTypesOf>[0])].sort()

describe('options', () => {
  describe('agentTypes', () => {
    test('is general-purpose when the option is not given', () => {
      expect(DEFAULT_AGENT_TYPES).toEqual(['general-purpose'])
      expect(typesOf({})).toEqual(['general-purpose'])
    })

    test('reads a comma- or space-separated string, in lower case', () => {
      expect(typesOf({ agentTypes: 'general-purpose' })).toEqual([
        'general-purpose',
      ])
      expect(typesOf({ agentTypes: 'General-Purpose, Explore' })).toEqual([
        'explore',
        'general-purpose',
      ])
      expect(typesOf({ agentTypes: 'a b,c ,, d' })).toEqual([
        'a',
        'b',
        'c',
        'd',
      ])
    })

    test('reads a list of strings, and skips what is not one', () => {
      expect(
        typesOf({ agentTypes: ['Explore', ' plan ', 3, null, ''] }),
      ).toEqual(['explore', 'plan'])
    })

    test('is the default when the value names nothing', () => {
      for (const agentTypes of ['', ' , ', [], [1, 2], 5, null, true, {}]) {
        expect(typesOf({ agentTypes })).toEqual(['general-purpose'])
      }
    })
  })
})
