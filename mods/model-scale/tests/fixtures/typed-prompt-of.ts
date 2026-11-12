import type { PromptSubmitInput } from 'claude-code'

/**
 * What a prompt submission carries beyond the declarations this repository
 * types: the slash command the engine says it runs, and the flag it sets on a
 * prompt the person did not type.
 */
export type TypedPrompt = PromptSubmitInput & {
  command?: { name: string; args: string }
  isMeta?: true
}

/**
 * A prompt as the person types it into the composer.
 *
 * @param text the prompt
 * @param extra the fields the engine sets on a command line or a meta prompt
 * @returns the submission
 */
export const typedPromptOf = (
  text: string,
  extra: Pick<TypedPrompt, 'command' | 'isMeta'> = {},
): TypedPrompt => ({
  text,
  wait: false,
  origin: { kind: 'composer' },
  ...extra,
})
