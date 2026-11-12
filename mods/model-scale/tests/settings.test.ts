import { describe, expect, test, tier } from 'claude-code/testing'

import {
  createSettingsHolder,
  DEFAULT_SETTINGS,
  loadSettings,
  parseSettings,
  saveSettings,
  SETTINGS_KEY,
  type SettingsStore,
} from '../hooks/settings'

tier('user')

/**
 * A store in memory that counts its reads and keeps its writes, and can fail on
 * either.
 */
function storeOf(
  held: unknown,
  fails: { get?: boolean; set?: boolean } = {},
): SettingsStore & { reads: number; writes: unknown[]; held: () => unknown } {
  let current = held
  const store = {
    reads: 0,
    writes: [] as unknown[],
    held: () => current,
    async get(key: string): Promise<unknown> {
      store.reads += 1

      if (fails.get) {
        throw new Error('the store cannot be read')
      }

      return key === SETTINGS_KEY ? current : undefined
    },
    async set(key: string, value: unknown): Promise<void> {
      if (fails.set) {
        throw new Error('the store cannot be written')
      }

      if (key === SETTINGS_KEY) {
        current = value
        store.writes.push(value)
      }
    },
  }

  return store
}

const FULL = { mode: 'full', pin: 3, floor: 2, ceiling: 4 }

describe('settings', () => {
  describe('the defaults', () => {
    test('route effort only, with nothing pinned, from level 1 to 5', () => {
      expect(DEFAULT_SETTINGS).toEqual({
        mode: 'effort',
        pin: null,
        floor: 1,
        ceiling: 5,
      })
    })
  })

  describe('parseSettings', () => {
    test('reads a whole record as it is', () => {
      expect(parseSettings(FULL)).toEqual(FULL)
    })

    test('gives the defaults for anything that is not a record', () => {
      for (const stored of [undefined, null, 'full', 7, true]) {
        expect(parseSettings(stored)).toEqual(DEFAULT_SETTINGS)
      }
    })

    test('takes the default for each field that is missing or wrong, and keeps the rest', () => {
      expect(
        parseSettings({ mode: 'sideways', pin: 9, floor: 2, ceiling: 'high' }),
      ).toEqual({ mode: 'effort', pin: null, floor: 2, ceiling: 5 })
      expect(parseSettings({ mode: 'off' })).toEqual({
        ...DEFAULT_SETTINGS,
        mode: 'off',
      })
      expect(parseSettings({ pin: 2.5, floor: 0, ceiling: 7 })).toEqual(
        DEFAULT_SETTINGS,
      )
    })

    test('resets both bounds when the floor is above the ceiling', () => {
      expect(parseSettings({ floor: 5, ceiling: 2, pin: 4 })).toEqual({
        ...DEFAULT_SETTINGS,
        pin: 4,
      })
    })

    test('does not hand back the record it was given', () => {
      const stored = { ...FULL }
      const parsed = parseSettings(stored)

      stored.mode = 'off'

      expect(parsed.mode).toBe('full')
    })
  })

  describe('loadSettings', () => {
    test('reads them from the store', async () => {
      expect(await loadSettings(storeOf(FULL))).toEqual(FULL)
    })

    test('gives the defaults when the store cannot be read', async () => {
      expect(await loadSettings(storeOf(FULL, { get: true }))).toEqual(
        DEFAULT_SETTINGS,
      )
    })
  })

  describe('saveSettings', () => {
    test('writes them under one key, as a copy', async () => {
      const store = storeOf(undefined)
      const settings = { ...DEFAULT_SETTINGS, mode: 'full' as const }

      expect(await saveSettings(store, settings)).toBe(true)
      expect(store.held()).toEqual(settings)
      expect(store.held()).not.toBe(settings)
    })

    test('says so when they could not be kept', async () => {
      expect(
        await saveSettings(storeOf(undefined, { set: true }), DEFAULT_SETTINGS),
      ).toBe(false)
    })
  })

  describe('the holder', () => {
    test('reads the store once and then holds what it read', async () => {
      const store = storeOf(FULL)
      const holder = createSettingsHolder()

      expect(await holder.get(store)).toEqual(FULL)
      expect(await holder.get(store)).toEqual(FULL)
      expect(store.reads).toBe(1)
    })

    test('reads the store once for calls that overlap', async () => {
      const store = storeOf(FULL)
      const holder = createSettingsHolder()

      const all = await Promise.all([
        holder.get(store),
        holder.get(store),
        holder.get(store),
      ])

      expect(all).toEqual([FULL, FULL, FULL])
      expect(store.reads).toBe(1)
    })

    test('holds a change and writes it through', async () => {
      const store = storeOf(undefined)
      const holder = createSettingsHolder()
      const changed = { ...DEFAULT_SETTINGS, mode: 'off' as const }

      expect(await holder.set(store, changed)).toBe(true)
      expect(await holder.get(store)).toEqual(changed)
      expect(store.writes).toEqual([changed])
      expect(store.reads).toBe(0)
    })

    test('holds a change even when it could not be kept', async () => {
      const store = storeOf(undefined, { set: true })
      const holder = createSettingsHolder()
      const changed = { ...DEFAULT_SETTINGS, mode: 'full' as const }

      expect(await holder.set(store, changed)).toBe(false)
      expect(await holder.get(store)).toEqual(changed)
    })

    test('works from the defaults when the store cannot be read', async () => {
      const holder = createSettingsHolder()

      expect(await holder.get(storeOf(FULL, { get: true }))).toEqual(
        DEFAULT_SETTINGS,
      )
    })
  })
})
