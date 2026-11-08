import type { CommandRunInput } from 'claude-code'

/**
 * `/scale` as the person types it, with the arguments after the name, in the
 * fullscreen layout on a 120-column terminal.
 *
 * @param args everything after the name
 * @returns the command's input
 */
export const scaleOf = (args = ''): CommandRunInput => ({
  command: 'scale',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
})
