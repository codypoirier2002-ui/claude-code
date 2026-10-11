import { useState, type FormEvent } from 'react';
import type { Marketplace, SourceType, Task } from '../types.ts';
import { api } from '../api.ts';
import { Panel } from './ui.tsx';

const SOURCES: { id: SourceType; label: string }[] = [
  { id: 'wikipedia', label: 'Wikipedia' },
  { id: 'arxiv', label: 'arXiv' },
  { id: 'pypi', label: 'PyPI' },
  { id: 'github', label: 'GitHub READMEs' },
  { id: 'url', label: 'URLs I paste' },
];

type Kind = 'report' | 'listing';

export function TaskForm({ tasks, marketplaces, onCreated, onError, disabled }: { tasks: Task[]; marketplaces: Marketplace[]; onCreated: (id: number) => void; onError: (m: string) => void; disabled: boolean }) {
  const [kind, setKind] = useState<Kind>('report');
  const [description, setDescription] = useState('');
  const [project, setProject] = useState('');
  const [urls, setUrls] = useState('');
  const [sources, setSources] = useState<SourceType[]>(SOURCES.map((s) => s.id));
  const [dependsOn, setDependsOn] = useState('');
  const [product, setProduct] = useState('');
  const [facts, setFacts] = useState('');
  const [marketplace, setMarketplace] = useState('etsy');
  const [tone, setTone] = useState('');
  const [region, setRegion] = useState<'canada' | 'other'>('canada');
  const [busy, setBusy] = useState(false);
  // One key per form fill: a double click or a retried request cannot create two tasks.
  const [key, setKey] = useState(() => crypto.randomUUID());

  const market = marketplaces.find((m) => m.id === marketplace) ?? marketplaces[0];
  const isListing = kind === 'listing';
  // A listing's request text is optional extra guidance; the product name stands in for it.
  const listingDescription = `Write ${market?.name ?? ''} listing copy for ${product.trim()}${description.trim() ? `. ${description.trim()}` : '.'}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<{ task: { id: number }; created: boolean }>('/api/tasks', {
        description: isListing ? listingDescription : description,
        project: project || null,
        urls: urls.split('\n').map((u) => u.trim()).filter(Boolean),
        sourceTypes: sources,
        dependsOn: dep ? [Number(dep)] : [],
        idempotencyKey: key,
        ...(isListing ? { listing: { product, facts, marketplace, tone, region } } : {}),
      });
      setDescription('');
      setUrls('');
      setDependsOn('');
      setProduct('');
      setFacts('');
      setKey(crypto.randomUUID());
      onCreated(res.task.id);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const switchKind = (k: Kind) => {
    setKind(k);
    // Listings rely on the operator's facts; only pasted URLs are fetched unless more are ticked.
    setSources(k === 'listing' ? ['url'] : SOURCES.map((s) => s.id));
  };

  const open = tasks.filter((t) => !['completed', 'failed', 'cancelled'].includes(t.status));
  // If the chosen task finished or failed meanwhile it is no longer listed:
  // submit what the select shows, not a hidden stale choice.
  const dep = open.some((t) => String(t.id) === dependsOn) ? dependsOn : '';
  const ready = isListing ? product.trim().length >= 2 && facts.trim().length >= 20 : description.trim().length >= 10 && sources.length > 0;
  return (
    <Panel
      title="New task"
      id="new-task"
      actions={
        <div className="seg" role="group" aria-label="Task type">
          <button type="button" className={!isListing ? 'on' : ''} onClick={() => switchKind('report')}>Research report</button>
          <button type="button" className={isListing ? 'on' : ''} onClick={() => switchKind('listing')}>Product listing</button>
        </div>
      }
    >
      <form className="task-form" onSubmit={submit}>
        {isListing ? (
          <>
            <p className="muted small">Drafts listing copy for you to paste into the marketplace. The station never publishes it.</p>
            <div className="row2">
              <label className="stack">
                <span>Product</span>
                <input required minLength={2} maxLength={120} value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Handmade speckled mug" />
              </label>
              <label className="stack">
                <span>Marketplace</span>
                <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
                  {marketplaces.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
            </div>
            <label className="stack">
              <span>Selling in</span>
              <select value={region} onChange={(e) => setRegion(e.target.value as 'canada' | 'other')}>
                <option value="canada">Canada (Canadian spelling, metric first, origin claims checked)</option>
                <option value="other">Anywhere else</option>
              </select>
            </label>
            {market && <p className="muted small">{market.basis}</p>}
            <label className="stack">
              <span>Product facts (the copy can claim only what these, or approved sources, say)</span>
              <textarea required minLength={20} maxLength={6000} rows={5} value={facts} onChange={(e) => setFacts(e.target.value)} placeholder={'Material: glazed stoneware\nCapacity: 12 fl oz\nDishwasher safe'} />
            </label>
            <div className="row2">
              <label className="stack">
                <span>Tone (optional)</span>
                <input maxLength={200} value={tone} onChange={(e) => setTone(e.target.value)} placeholder="warm, plain, no hype" />
              </label>
              <label className="stack">
                <span>Anything else (optional)</span>
                <input maxLength={3000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Aimed at gift buyers" />
              </label>
            </div>
          </>
        ) : (
          <>
            <label htmlFor="desc">What should the station research?</label>
            <textarea id="desc" rows={3} required minLength={10} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Research a topic from approved sources and produce a sourced report…" />
          </>
        )}
        <fieldset className="sources">
          <legend>{isListing ? 'Sources the Commander may also fetch' : 'Approved source types'}</legend>
          {SOURCES.map((s) => (
            <label key={s.id}>
              <input type="checkbox" checked={sources.includes(s.id)} onChange={(e) => setSources((x) => (e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id)))} />
              {s.label}
            </label>
          ))}
        </fieldset>
        <div className="row2">
          <label className="stack">
            <span>Project (optional)</span>
            <input value={project} onChange={(e) => setProject(e.target.value)} maxLength={80} placeholder="Loads memory/projects/<name>.md" />
          </label>
          <label className="stack">
            <span>Start after (optional)</span>
            <select value={dep} onChange={(e) => setDependsOn(e.target.value)}>
              <option value="">No dependency</option>
              {open.map((t) => <option key={t.id} value={t.id}>{t.label}: {t.title.slice(0, 40)}</option>)}
            </select>
          </label>
        </div>
        <label className="stack">
          <span>URLs to read (one per line, up to 8, approved domains only{isListing ? '; for example the maker’s product page' : ''})</span>
          <textarea rows={2} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://en.wikipedia.org/wiki/…" />
        </label>
        <button className="btn primary" type="submit" disabled={busy || disabled || !ready}>
          {busy ? 'Queuing…' : isListing ? 'Queue listing' : 'Queue task'}
        </button>
      </form>
    </Panel>
  );
}
