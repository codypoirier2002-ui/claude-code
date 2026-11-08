import type { PluginOptions } from 'claude-code'

/**
 * The agent types whose spawns are routed when the option lists none.
 */
export const DEFAULT_AGENT_TYPES: readonly string[] = ['general-purpose']

/**
 * Reads the `agentTypes` option: the agent types whose spawns the mod gives a
 * model. A comma- or space-separated string, or a list of strings; names match
 * without regard to case. An empty or unreadable value means the default, so
 * that a typo in settings never widens the mod to agents with a model of their
 * own.
 *
 * @param options the plugin's options, as `register` received them
 * @returns the agent types, lower-cased
 */
export function agentTypesOf(options: PluginOptions): ReadonlySet<string> {
  const raw: unknown = options.agentTypes
  const listed: readonly unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[\s,]+/)
      : []

  const names = listed
    .filter((name): name is string => typeof name === 'string')
    .map(name => name.trim().toLowerCase())
    .filter(name => name.length > 0)

  return new Set(
    names.length > 0
      ? names
      : DEFAULT_AGENT_TYPES.map(name => name.toLowerCase()),
  )
}
