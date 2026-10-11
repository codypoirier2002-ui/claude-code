// Adapter for OpenClaw's documented Gateway HTTP surfaces:
//   GET  /readyz        readiness (200 ready, 503 not admitting work)
//   POST /v1/responses  OpenResponses-compatible agent run; agent chosen with
//                       the x-openclaw-agent-id header; Bearer token auth.
// Docs: gateway/health.md, gateway/openresponses-http-api.md.
// The gateway token stays in this process; it is never sent to the browser.

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number | null; // the Responses API carries no cost field; kept for providers that add one
}

export interface AgentRunResult {
  responseId: string;
  text: string;
  usage: Usage | null;
  status: string;
}

export class GatewayError extends Error {
  readonly transient: boolean;
  readonly httpStatus: number | null;
  constructor(message: string, opts: { transient: boolean; httpStatus?: number | null }) {
    super(message);
    this.transient = opts.transient;
    this.httpStatus = opts.httpStatus ?? null;
  }
}

export interface Health {
  connected: boolean;
  ready: boolean;
  checkedAt: string;
  detail: string;
}

export interface AgentRunner {
  run(agentId: string, input: string, opts: { signal: AbortSignal; sessionUser?: string }): Promise<AgentRunResult>;
  health(signal?: AbortSignal): Promise<Health>;
}

export function parseUsage(u: unknown): Usage | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, any>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const details = o.input_tokens_details ?? {};
  const input = n(o.input_tokens ?? o.prompt_tokens);
  const output = n(o.output_tokens ?? o.completion_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: n(details.cached_tokens),
    cacheWriteTokens: n(details.cache_write_tokens),
    totalTokens: n(o.total_tokens) || input + output,
    costUsd: typeof o.cost_usd === 'number' ? o.cost_usd : null,
  };
}

export function extractText(body: any): string {
  const parts: string[] = [];
  for (const item of body?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const c of item.content ?? []) {
      if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n');
}

export class OpenClawGateway implements AgentRunner {
  private readonly baseUrl: string;
  private readonly token: string;
  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async health(signal?: AbortSignal): Promise<Health> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(`${this.baseUrl}/readyz`, { signal: signal ?? AbortSignal.timeout(4000) });
      await res.body?.cancel();
      return {
        connected: true,
        ready: res.status === 200,
        checkedAt,
        detail: res.status === 200 ? 'ready' : `gateway not ready (HTTP ${res.status})`,
      };
    } catch (err) {
      return { connected: false, ready: false, checkedAt, detail: `unreachable: ${(err as Error).message}` };
    }
  }

  async run(agentId: string, input: string, opts: { signal: AbortSignal; sessionUser?: string }): Promise<AgentRunResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/responses`, {
        method: 'POST',
        signal: opts.signal, // aborting disconnects; the gateway then cancels the agent run
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'x-openclaw-agent-id': agentId,
        },
        body: JSON.stringify({ model: `openclaw/${agentId}`, input, ...(opts.sessionUser ? { user: opts.sessionUser } : {}) }),
      });
    } catch (err) {
      if (opts.signal.aborted) throw err;
      throw new GatewayError(`gateway unreachable: ${(err as Error).message}`, { transient: true });
    }
    const raw = await res.text();
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new GatewayError(`gateway returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`, {
        transient: res.status >= 500,
        httpStatus: res.status,
      });
    }
    if (!res.ok || body?.status === 'failed' || body?.error) {
      const msg = body?.error?.message ?? `HTTP ${res.status}`;
      const code = body?.error?.code ?? body?.error?.type ?? '';
      // 4xx other than 429 are configuration/auth problems: retrying will not help.
      const transient = res.status >= 500 || res.status === 429 || (res.ok && body?.status === 'failed');
      throw new GatewayError(`OpenClaw ${code ? code + ': ' : ''}${msg}`, { transient, httpStatus: res.status });
    }
    return { responseId: String(body.id ?? ''), text: extractText(body), usage: parseUsage(body.usage), status: String(body.status ?? '') };
  }
}
