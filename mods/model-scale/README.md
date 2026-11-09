# model-scale

Routes work to the cheapest Claude model and effort that should do it well.
Each prompt is scored on a six-level scale. The level sets how hard the model
thinks for that turn and, if you ask for it, which model answers. A subagent
gets the model its task means. `/scale` shows what was decided and why, and an
estimate of what it saved.

This is a mod: a Claude Code plugin whose behaviour is a hooks module (see
[`../README.md`](../README.md)). It is this repository's own and is not part of
Claude Code. The scorer is a pure function of the prompt's words: it runs on
your machine, makes no model calls of its own and sends nothing anywhere.

    claude --plugin-dir mods/model-scale

## The scale

| Level | Name | Full mode | Effort mode |
| --- | --- | --- | --- |
| 1 | Trivial | haiku, low | low |
| 2 | Simple | haiku, medium | low |
| 3 | Standard | sonnet, medium | medium |
| 4 | Complex | sonnet, high | high |
| 5 | Advanced | opus, high | high |
| 6 | Frontier | fable, high | xhigh |

Level 6 is not used until you raise the ceiling: it starts at 5, so the
hardest prompts run on Opus. `/scale ceiling 6` lets them run on Fable.

## Modes

`effort` (the default) keeps the model the session is on and changes only how
hard it thinks. It is the default because switching model in the middle of a
conversation starts the prompt cache over and drops the earlier model's
thinking blocks, which can cost more than one easy turn saves.

`full` also picks the model. A new conversation (the first request, with no
earlier messages) starts on the cheapest family that suits its level. After
that it only moves up: a harder prompt later in the conversation can lift it to
a dearer family, and nothing brings it back down. If you switch model yourself,
that model is where it starts working up from. A request the engine moved to
another model (a fallback) is left on it, and so is a session on a model of
none of the four families.

`off` leaves everything as Claude Code would have it.

The status line shows the decision for the turn: the level, the model the
request runs on and its effort, as in `scale L3 Standard · sonnet medium`.
Effort is set on a request that arrives with one, and on a request whose model
the mod switches.

## How a prompt is scored

The score starts at 30 and moves with what the prompt says. Words match whole,
without regard to case (`format` does not match `formatted`), and each counts
once however often it appears.

| Signal | Points | What counts |
| --- | --- | --- |
| Length | -8, +10, +15 | under 40 tokens, over 800, over 3000 (a token is four characters) |
| Easy words | -15 each, down to -25 | rename, typo, format, reformat, list, what is, what's, summarize, summarise, translate, convert, classify, extract, lookup, look up, spell, count, sort |
| Work words | +10 each, up to +20 | implement, refactor, debug, fix the bug, write tests, test suite, review, integrate, build |
| Hard words | +18 each, up to +36 | architecture, architect, design, migrate, migration, concurrency, race condition, deadlock, performance, optimize, optimise, distributed, root cause, security, vulnerability, audit, prove, proof, trade-off, tradeoff, scalability |
| Frontier phrases | +25, once | from scratch, entire codebase, whole codebase, multi-day, novel research, end-to-end system, research paper, long-horizon |
| Code | +8, once | a fenced code block, or a line of a stack trace or compiler error |
| File paths | +8, once | three or more different paths |
| Steps | +8, once | a list of three or more items, or two or more of "then", "after that", "and also" |
| Light hints | -10, once | quick, just, simple, simply, small |
| Careful hints | +15, once | thorough, carefully, deep dive, best possible, think hard, ultrathink, high quality |

The score is held to 0 to 100 and mapped to a level: below 15 is 1, below 30 is
2, below 48 is 3, below 65 is 4, below 82 is 5, anything higher is 6.

Work that is costly to get wrong is never given less than level 4, whatever it
scores: auth, authentication, billing, payment, payments, production, prod,
security, migration, data loss, credentials, secret, permissions, encryption.

Every signal is shown by `/scale` as a line with its points (`+18 hard:
concurrency`), so a score can be added up from 30 and argued with.

After the scorer:

- If the last answer ended in a refusal or ran out of output (`max_tokens`),
  the next prompt goes up one level, once. `/scale` shows `escalated: last
  answer was cut off/refused`.
- A pin replaces the score (below). The floor and the ceiling hold the level
  either way.
- A slash command, and a prompt the engine raised itself, is not a task of
  yours and is not scored.

## Subagents

A `general-purpose` subagent that the Agent call gives no model, and that is
not a fork of the conversation, gets the model its task means: the prompt and
description are scored, the floor and ceiling apply, and `agent.spawn` passes
the alias (`haiku`, `sonnet`, `opus` or `fable`) on. The subagent's own
requests then ask for the effort of its level. A pin does not apply to
subagents. Other agent types (Explore, Plan, and the like) keep the model they
have; the `agentTypes` option below widens the list. This works in `effort` and
`full` modes alike, and not in `off`.

## `/scale`

| Command | Does |
| --- | --- |
| `/scale` | Shows the scale, the mode, pin, floor and ceiling, the last prompt's and the last subagent's score and reasons, and the spend. |
| `/scale effort`, `full`, `off` | Sets the mode. |
| `/scale pin <1-6>` | Gives every prompt that level, unscored. The floor and ceiling still hold it. |
| `/scale unpin` | Scores prompts again. |
| `/scale floor <1-6>` | No task runs below that level. |
| `/scale ceiling <1-6>` | No task runs above that level. |

A level is written `3` or `L3`. A floor above the ceiling, or a ceiling below
the floor, is refused rather than reordered, so you say which one you meant to
move. Anything `/scale` cannot read gets its usage line and changes nothing.

The settings are kept in the store and hold between sessions. The last
decisions and the spend live as long as the session does.

## The spend

For each request of the main conversation (not in `off` mode) and each request
of a subagent the mod routed, `/scale` adds up what the request cost at the
list prices below, from the token counts the API reported, and what the same
tokens would have cost on the model the request came in with: the session's
model, or for a subagent its parent's. The difference is the saving. A request
on a model with no price here is counted and left out of both sums.

In `effort` mode the model does not change, so the main conversation shows no
difference. Effort changes how many tokens a request uses, and there is no
baseline to price that against; the report says so.

It is an estimate from list prices, not a bill.

## Prices

US dollars per million tokens, from <https://platform.claude.com/docs/en/about-claude/pricing>,
fetched 2026-11-08:

| Model | Input | Output | Cache read | Cache write (5 minutes) |
| --- | --- | --- | --- | --- |
| `claude-haiku-5-5` | 0.10 | 0.50 | 0.01 | 0.125 |
| `claude-sonnet-5-5` | 2 | 10 | 0.10 | 2.50 |
| `claude-opus-5-5` | 4 | 20 | 0.20 | 5 |
| `claude-fable-5-1` | 10 | 50 | 0.25 | 12.50 |

Haiku alone is priced by the length of the request: one whose input, cache
reads and cache writes together come to more than 100,000 tokens costs 0.50,
2.50, 0.05 and 0.625 on every token of it, the first 100,000 included.

The aliases, and any model id that contains `haiku`, `sonnet`, `opus` or
`fable`, are priced as that family's current model. A model of none of the four
has no price. Cache writes are priced at the 5-minute rate, because a response
does not say which lifetime a write used. Batch, fast-mode and data-residency
multipliers are not applied.

The table lives in `hooks/scale/prices.ts`, with the source and the date.

## Option

`agentTypes`: the agent types whose spawns get a model from their task, as a
comma-separated list (default `general-purpose`). Names match without regard to
case. A value that names nothing means the default, so a typo never widens the
mod to agents with models of their own.

## Limits

- The scorer reads words, not meaning, and only English ones. A short prompt
  that asks for something hard scores low, and a long, careful one that asks
  for something small scores high. `/scale pin`, `floor` and `ceiling` are the
  controls for the cases it gets wrong, and `/scale` shows why it decided.
- The mod asks for a model by alias and for an effort; whether the engine takes
  them for a given session is the engine's call. A step it moves to another
  model is left there.
- A routed subagent's effort is set on the requests raised after the engine
  reports its id; a first request raised before that keeps the effort it had
  (its model is routed at spawn either way).
- Whether a conversation is new is read from the request's message count (one
  or fewer), the only sign the mod has; a conversation the engine reports with
  that few messages counts as new, however it came about.
- The last decisions, the spend and the memory of which subagents were routed
  are in memory, and start afresh when the hooks module reloads.

## Testing

    claude plugin validate mods/model-scale
    claude plugin test mods/model-scale
    npx -p typescript@5 tsc -p mods

The tests run the mod through the engine's own `$` with a stand-in for what is
beneath it (`tests/fixtures/`), and test the scorer, the prices, the ledger,
the settings and `/scale`'s parsing and report on their own.
