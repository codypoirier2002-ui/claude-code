// Approved-source fetcher. The station, not an agent, contacts the network:
// only https, only hosts on the approved list (re-checked on every redirect),
// with size and time limits. Every document is stored with its URL, retrieval
// time, and the SHA-256 of the exact text the agents read.
import { createHash } from 'node:crypto';

export type SourceType = 'wikipedia' | 'arxiv' | 'pypi' | 'github' | 'url';
export const SOURCE_TYPES: SourceType[] = ['wikipedia', 'arxiv', 'pypi', 'github', 'url'];

export interface SourceQuery {
  source: SourceType;
  query: string;
}

export interface FetchedSource {
  type: SourceType;
  url: string;
  title: string;
  content: string;
  retrievedAt: string;
  sha256: string;
  bytes: number;
}

export interface FetchPolicy {
  approvedDomains: string[];
  maxBytes: number;
  timeoutMs: number;
  userAgent: string;
}

export class SourceError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.transient = transient;
  }
}

export function hostAllowed(url: URL, approved: string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return url.protocol === 'https:' && url.port === '' && approved.map((d) => d.toLowerCase()).includes(host);
}

// Fetch one URL under the policy. Redirects are followed manually so each hop
// is checked against the allowlist.
export async function guardedFetch(rawUrl: string, policy: FetchPolicy, signal?: AbortSignal): Promise<{ url: string; text: string; bytes: number; contentType: string }> {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= 3; hop++) {
    if (!hostAllowed(url, policy.approvedDomains)) {
      throw new SourceError(
        `blocked: ${url.protocol}//${url.host} is not an approved source (approved: ${policy.approvedDomains.join(', ')})`,
        false,
      );
    }
    const timeout = AbortSignal.timeout(policy.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'user-agent': policy.userAgent, accept: 'text/html,application/json,application/atom+xml,text/plain;q=0.9,*/*;q=0.1' },
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const e = err as Error & { cause?: { code?: string } };
      throw new SourceError(`${url.host}: ${e.name === 'TimeoutError' ? `timed out after ${policy.timeoutMs / 1000}s` : e.cause?.code ?? e.message}`, true);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      const hint = res.status === 403 ? ' (refused: blocked by the network policy or by the site)' : '';
      throw new SourceError(`${url.host}: HTTP ${res.status}${hint}`, res.status >= 500 || res.status === 429);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!/^(text\/|application\/(json|atom\+xml|xml))/.test(contentType)) {
      await res.body?.cancel();
      throw new SourceError(`${url.host}: unsupported content type ${contentType || '(none)'}`, false);
    }
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > policy.maxBytes) {
        await reader.cancel();
        throw new SourceError(`${url.host}: response larger than ${policy.maxBytes} bytes`, false);
      }
      chunks.push(value);
    }
    return { url: url.toString(), text: Buffer.concat(chunks).toString('utf8'), bytes, contentType };
  }
  throw new SourceError(`${rawUrl}: too many redirects`, false);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim());
  const text = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
  return { title, text };
}

function makeSource(type: SourceType, url: string, title: string, content: string, bytes: number): FetchedSource {
  const clean = content.replace(/\r\n/g, '\n').trim();
  return {
    type,
    url,
    title: title.trim().slice(0, 200) || url,
    content: clean,
    retrievedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(clean).digest('hex'),
    bytes,
  };
}

async function fetchJson(url: string, policy: FetchPolicy, signal?: AbortSignal) {
  const r = await guardedFetch(url, policy, signal);
  try {
    return { json: JSON.parse(r.text), bytes: r.bytes, url: r.url };
  } catch {
    throw new SourceError(`${new URL(url).host}: invalid JSON`, false);
  }
}

async function wikipediaArticle(title: string, policy: FetchPolicy, signal?: AbortSignal): Promise<FetchedSource> {
  const api = `https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}`;
  const { json, bytes } = await fetchJson(api, policy, signal);
  const page = json?.query?.pages?.[0];
  if (!page || page.missing || !page.extract) throw new SourceError(`Wikipedia: no article "${title}"`, false);
  const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, '_'))}`;
  return makeSource('wikipedia', pageUrl, `${page.title} (Wikipedia)`, page.extract, bytes);
}

async function wikipedia(query: string, policy: FetchPolicy, signal?: AbortSignal): Promise<FetchedSource[]> {
  const api = `https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&list=search&srlimit=2&srsearch=${encodeURIComponent(query)}`;
  const { json } = await fetchJson(api, policy, signal);
  const hits: string[] = (json?.query?.search ?? []).map((h: any) => String(h.title));
  if (!hits.length) throw new SourceError(`Wikipedia: no results for "${query}"`, false);
  return Promise.all(hits.map((t) => wikipediaArticle(t, policy, signal)));
}

function parseArxivAtom(xml: string, bytes: number): FetchedSource[] {
  const out: FetchedSource[] = [];
  for (const entry of xml.split('<entry>').slice(1)) {
    const tag = (name: string) => decodeEntities((new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry)?.[1] ?? '').replace(/\s+/g, ' ').trim());
    const id = tag('id');
    if (!/^https?:\/\/arxiv\.org\/abs\//.test(id)) continue;
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim()).join(', ');
    const content = `Title: ${tag('title')}\nAuthors: ${authors}\nPublished: ${tag('published')}\nUpdated: ${tag('updated')}\n\nAbstract: ${tag('summary')}`;
    out.push(makeSource('arxiv', id.replace(/^http:/, 'https:'), `${tag('title')} (arXiv)`, content, bytes));
  }
  return out;
}

async function arxiv(query: string, policy: FetchPolicy, signal?: AbortSignal): Promise<FetchedSource[]> {
  const idMatch = /^(?:arxiv:)?(\d{4}\.\d{4,5}(v\d+)?)$/i.exec(query.trim());
  const api = idMatch
    ? `https://export.arxiv.org/api/query?id_list=${idMatch[1]}`
    : `https://export.arxiv.org/api/query?max_results=3&search_query=${encodeURIComponent('all:' + query)}`;
  const r = await guardedFetch(api, policy, signal);
  const entries = parseArxivAtom(r.text, r.bytes);
  if (!entries.length) throw new SourceError(`arXiv: no results for "${query}"`, false);
  return entries;
}

async function pypi(name: string, policy: FetchPolicy, signal?: AbortSignal): Promise<FetchedSource[]> {
  const pkg = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(pkg)) throw new SourceError(`PyPI: "${name}" is not a valid package name`, false);
  let fetched;
  try {
    fetched = await fetchJson(`https://pypi.org/pypi/${pkg}/json`, policy, signal);
  } catch (err) {
    if (err instanceof SourceError && /HTTP 404/.test(err.message)) throw new SourceError(`PyPI: no package named "${pkg}"`, false);
    throw err;
  }
  const info = fetched.json?.info ?? {};
  const releases = fetched.json?.releases ?? {};
  const uploaded = releases[info.version]?.[0]?.upload_time_iso_8601 ?? releases[info.version]?.[0]?.upload_time ?? 'unknown';
  const urls = Object.entries(info.project_urls ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  const content = [
    `Package: ${info.name}`,
    `Latest version: ${info.version} (uploaded ${uploaded})`,
    `Summary: ${info.summary ?? ''}`,
    `Requires Python: ${info.requires_python ?? 'not stated'}`,
    `License: ${info.license_expression ?? info.license ?? 'not stated'}`,
    `Release count: ${Object.keys(releases).length}`,
    urls ? `Project URLs:\n${urls}` : '',
    '',
    'Project description (from PyPI):',
    String(info.description ?? ''),
  ].join('\n');
  return [makeSource('pypi', `https://pypi.org/project/${info.name ?? pkg}/`, `${info.name ?? pkg} on PyPI`, content, fetched.bytes)];
}

async function githubReadme(repo: string, policy: FetchPolicy, signal?: AbortSignal): Promise<FetchedSource[]> {
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(repo.trim().replace(/\.git$/, ''));
  if (!m) throw new SourceError(`GitHub: "${repo}" is not in owner/repo form`, false);
  let lastErr: Error | null = null;
  for (const file of ['README.md', 'README.rst', 'readme.md', 'README']) {
    const url = `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/${file}`;
    try {
      const r = await guardedFetch(url, policy, signal);
      return [makeSource('github', url, `${m[1]}/${m[2]} ${file} (GitHub)`, r.text, r.bytes)];
    } catch (err) {
      lastErr = err as Error;
      if (!(err instanceof SourceError) || !/HTTP 404/.test(err.message)) throw err;
    }
  }
  throw new SourceError(`GitHub: no README found for ${m[1]}/${m[2]} (${lastErr?.message})`, false);
}

// A pasted URL. Well-known hosts go through their structured API; anything
// else on the approved list is fetched and reduced to text.
async function pastedUrl(raw: string, policy: FetchPolicy, signal?: AbortSignal): Promise<FetchedSource[]> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SourceError(`"${raw}" is not a valid URL`, false);
  }
  if (!hostAllowed(url, policy.approvedDomains)) {
    throw new SourceError(`blocked: ${url.host} is not an approved source (approved: ${policy.approvedDomains.join(', ')})`, false);
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'en.wikipedia.org' && parts[0] === 'wiki' && parts[1]) return [await wikipediaArticle(decodeURIComponent(parts[1]).replace(/_/g, ' '), policy, signal)];
  if ((host === 'arxiv.org' || host === 'export.arxiv.org') && (parts[0] === 'abs' || parts[0] === 'pdf') && parts[1]) return arxiv(parts[1].replace(/\.pdf$/, ''), policy, signal);
  if (host === 'pypi.org' && parts[0] === 'project' && parts[1]) return pypi(parts[1], policy, signal);
  if (host === 'github.com' && parts.length >= 2) return githubReadme(`${parts[0]}/${parts[1]}`, policy, signal);
  const r = await guardedFetch(url.toString(), policy, signal);
  if (/html/.test(r.contentType)) {
    const { title, text } = htmlToText(r.text);
    return [makeSource('url', r.url, title || r.url, text, r.bytes)];
  }
  return [makeSource('url', r.url, r.url, r.text, r.bytes)];
}

export async function fetchQuery(q: SourceQuery, policy: FetchPolicy, signal?: AbortSignal): Promise<FetchedSource[]> {
  switch (q.source) {
    case 'wikipedia':
      return wikipedia(q.query, policy, signal);
    case 'arxiv':
      return arxiv(q.query, policy, signal);
    case 'pypi':
      return pypi(q.query, policy, signal);
    case 'github':
      return githubReadme(q.query, policy, signal);
    case 'url':
      return pastedUrl(q.query, policy, signal);
    default:
      throw new SourceError(`unknown source type ${(q as SourceQuery).source}`, false);
  }
}

export interface FetchAllResult {
  sources: FetchedSource[];
  errors: { query: SourceQuery; error: string; transient: boolean }[];
}

export async function fetchAll(queries: SourceQuery[], policy: FetchPolicy, max: number, signal?: AbortSignal): Promise<FetchAllResult> {
  const sources: FetchedSource[] = [];
  const errors: FetchAllResult['errors'] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    if (sources.length >= max) break;
    try {
      for (const s of await fetchQuery(q, policy, signal)) {
        if (sources.length >= max || seen.has(s.url)) continue;
        seen.add(s.url);
        sources.push(s);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      errors.push({ query: q, error: (err as Error).message, transient: err instanceof SourceError ? err.transient : true });
    }
  }
  return { sources, errors };
}
