// Thin client for the station API. The browser holds only an HttpOnly
// session cookie and a CSRF token; it never sees provider or gateway secrets.
import { useEffect, useRef, useState } from 'react';
import type { StationState } from './types.ts';

let csrf: string | null = null;

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(csrf && method !== 'GET' ? { 'x-station-csrf': csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  async session() {
    const s = await request<{ authenticated: boolean; csrf: string | null; mode: 'real' | 'demo' }>('GET', '/api/session');
    csrf = s.csrf;
    return s;
  },
  async login(token: string) {
    const r = await request<{ csrf: string }>('POST', '/api/login', { token });
    csrf = r.csrf;
  },
  async logout() {
    await request('POST', '/api/logout');
    csrf = null;
  },
};

export type Link = 'connecting' | 'connected' | 'disconnected';
const STALE_MS = 12_000; // the server pings every 5s

// Live state over Server-Sent Events. If no message arrives for 12s, or the
// stream errors, the link is reported as disconnected and the last snapshot
// must not be shown as live work.
export function useStationStream(enabled: boolean): { state: StationState | null; link: Link; lastMessageAt: number } {
  const [state, setState] = useState<StationState | null>(null);
  const [link, setLink] = useState<Link>('connecting');
  const [lastMessageAt, setLast] = useState(0);
  const last = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const touch = () => {
      last.current = Date.now();
      setLast(last.current);
      setLink('connected');
    };
    const open = () => {
      es = new EventSource('/api/stream', { withCredentials: true });
      es.addEventListener('state', (e) => {
        touch();
        setState(JSON.parse((e as MessageEvent).data));
      });
      es.addEventListener('ping', (e) => {
        touch();
        const p = JSON.parse((e as MessageEvent).data);
        setState((s) => (s ? { ...s, gateway: p.gateway } : s));
      });
      es.onerror = () => {
        setLink('disconnected');
        es?.close();
        if (!closed) retry = setTimeout(open, 3000);
      };
    };
    open();
    const watchdog = setInterval(() => {
      if (last.current && Date.now() - last.current > STALE_MS) setLink('disconnected');
    }, 2000);
    return () => {
      closed = true;
      es?.close();
      clearInterval(watchdog);
      if (retry) clearTimeout(retry);
    };
  }, [enabled]);

  return { state, link, lastMessageAt };
}
