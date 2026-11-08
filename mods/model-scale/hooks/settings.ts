import {
  DEFAULT_CEILING,
  DEFAULT_FLOOR,
  isLevel,
  type Level,
} from './scale/ladder'

/**
 * How the mod routes work:
 *
 * - `effort` (the default) keeps the session's model and changes only how hard
 *   it thinks. Switching model mid-conversation starts the prompt cache over
 *   and drops the model's thinking blocks, so the default never does.
 * - `full` also picks the model: once for a new conversation, and only ever
 *   upward after that.
 * - `off` leaves everything as Claude Code would have it.
 */
export type Mode = 'effort' | 'full' | 'off'

export const MODES: readonly Mode[] = ['effort', 'full', 'off']

/**
 * What a person can change with `/scale`, and what is kept between sessions.
 */
export type Settings = {
  mode: Mode
  /**
   * A level every prompt is given instead of a scored one, or null.
   */
  pin: Level | null
  /**
   * The lowest level any decision is given.
   */
  floor: Level
  /**
   * The highest level any decision is given. 5 by default: Fable (level 6) is
   * used only once the person raises it.
   */
  ceiling: Level
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  mode: 'effort',
  pin: null,
  floor: DEFAULT_FLOOR,
  ceiling: DEFAULT_CEILING,
}

/**
 * The `$.store` key the settings are kept under.
 */
export const SETTINGS_KEY = 'settings'

/**
 * What keeps the settings between sessions: `$.store`'s `get` and `set`. A hook
 * hands them over as closures (`key => $.store.get(key)`), because `$` is only
 * ever used where it is called.
 */
export type SettingsStore = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
}

/**
 * Reads settings back from what the store held, field by field: a field that
 * is missing or is not what it should be takes its default, and a floor above
 * the ceiling resets both.
 *
 * @param stored whatever was stored
 * @returns settings that hold together
 */
export function parseSettings(stored: unknown): Settings {
  if (typeof stored !== 'object' || stored === null) {
    return { ...DEFAULT_SETTINGS }
  }

  const raw = stored as Record<string, unknown>
  const floor = isLevel(raw.floor) ? raw.floor : DEFAULT_SETTINGS.floor
  const ceiling = isLevel(raw.ceiling) ? raw.ceiling : DEFAULT_SETTINGS.ceiling
  const isCrossed = floor > ceiling

  return {
    mode: MODES.find(mode => mode === raw.mode) ?? DEFAULT_SETTINGS.mode,
    pin: isLevel(raw.pin) ? raw.pin : null,
    floor: isCrossed ? DEFAULT_SETTINGS.floor : floor,
    ceiling: isCrossed ? DEFAULT_SETTINGS.ceiling : ceiling,
  }
}

/**
 * Loads the settings kept between sessions. A store that cannot be read gives
 * the defaults: the mod works without its memory.
 *
 * @param store `$.store`
 * @returns the settings
 */
export async function loadSettings(store: SettingsStore): Promise<Settings> {
  try {
    return parseSettings(await store.get(SETTINGS_KEY))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Keeps the settings for the next session.
 *
 * @param store `$.store`
 * @param settings the settings
 * @returns whether they were kept
 */
export async function saveSettings(
  store: SettingsStore,
  settings: Settings,
): Promise<boolean> {
  try {
    await store.set(SETTINGS_KEY, { ...settings })

    return true
  } catch {
    return false
  }
}

/**
 * The settings a running mod holds: read from the store on first use, then
 * kept in memory and written through on a change.
 */
export type SettingsHolder = {
  /**
   * The settings that stand now.
   */
  get: (store: SettingsStore) => Promise<Settings>
  /**
   * Makes `settings` stand and keeps them for the next session; resolves to
   * whether they were kept.
   */
  set: (store: SettingsStore, settings: Settings) => Promise<boolean>
}

export function createSettingsHolder(): SettingsHolder {
  let current: Settings | undefined
  let loading: Promise<Settings> | undefined

  return {
    async get(store) {
      if (current !== undefined) {
        return current
      }

      loading ??= loadSettings(store)
      const loaded = await loading
      current ??= loaded

      return current
    },
    async set(store, settings) {
      current = settings

      return saveSettings(store, settings)
    },
  }
}
