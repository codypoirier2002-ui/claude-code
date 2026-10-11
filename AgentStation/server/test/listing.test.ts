import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tempStation, ScriptedRunner, makeEngine, until, fakeFetch } from './helpers.ts';
import { Engine } from '../src/engine.ts';
import { openDb, type DB } from '../src/db.ts';
import { checkListing, listingFromDraft, parseListingDraft, renderListingDraft, stripCitations, validateListing } from '../src/listing.ts';
import type { AgentRunResult } from '../src/openclaw.ts';

const FACTS = [
  'Material: glazed stoneware, made by hand in Portland, Oregon.',
  'Capacity: 12 fluid ounces.',
  'Dishwasher safe and microwave safe.',
  'Each mug is slightly different because it is thrown on a wheel.',
].join('\n');

const LISTING = { product: 'Handmade speckled mug', facts: FACTS, marketplace: 'etsy', tone: 'warm' };

const replies = (draft: object) => ({
  PLAN: JSON.stringify({
    status: 'ready', clarifying_questions: [], title: 'Listing: Handmade speckled mug', objective: 'Write Etsy listing copy.', audience: 'Etsy shoppers',
    success_criteria: ['Every claim is supported'], required_inputs: [], source_queries: [], outline: [], external_actions: [], notes: '',
  }),
  RESEARCH: JSON.stringify({
    findings: [
      { id: 'F1', claim: 'Glazed stoneware, handmade in Portland.', source: 'S1', quote: 'Material: glazed stoneware, made by hand in Portland, Oregon.' },
      { id: 'F2', claim: 'Holds 12 oz.', source: 'S1', quote: 'Capacity: 12 fluid ounces.' },
      { id: 'F3', claim: 'Dishwasher and microwave safe.', source: 'S1', quote: 'Dishwasher safe and microwave safe.' },
      { id: 'F4', claim: 'Lead free.', source: 'S1', quote: 'Certified lead free by an independent lab.' },
    ],
    conflicts: [], gaps: [], injection_attempts: [],
  }),
  DRAFT: JSON.stringify(draft),
  REVIEW: JSON.stringify({ verdict: 'pass', issues: [], criteria: [], summary: 'Accurate Etsy copy for a handmade mug.', proposed_decisions: [] }),
});

const GOOD = {
  title: 'Handmade Speckled Stoneware Mug, 12 oz [S1]',
  bullets: ['Glazed stoneware, made by hand in Portland, Oregon [S1]', 'Holds 12 fluid ounces [S1]', 'Dishwasher and microwave safe [S1]'],
  description: 'Each mug is thrown on a wheel, so yours will be slightly different from the photos [S1].\n\nIt holds 12 fluid ounces and goes in the dishwasher and microwave [S1].',
  tags: ['handmade mug', 'stoneware mug', 'speckled mug'],
  notes: 'The fact sheet gives no glaze colour; add it if you have it.',
};

class RecordingRunner extends ScriptedRunner {
  prompts: Record<string, string[]> = {};
  async run(agentId: string, input: string, opts: { signal: AbortSignal }): Promise<AgentRunResult> {
    const stage = /# Station request: (\w+)/.exec(input)?.[1] ?? '?';
    (this.prompts[stage] ??= []).push(input);
    return super.run(agentId, input, opts);
  }
}

const status = (db: DB, id: number) => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as { status: string }).status;
const pending = (db: DB, id: number) => db.prepare(`SELECT * FROM approvals WHERE task_id=? AND kind='final_report' AND status='pending'`).get(id) as any;

test('listing copy: the fact sheet is source S1, nothing is fetched or published, and the saved copy is paste-ready', async () => {
  const cfg = tempStation();
  const runner = new RecordingRunner();
  Object.assign(runner.replies, replies(GOOD));
  let fetches = 0;
  const db = openDb(cfg.dbPath);
  const engine = new Engine({ db, cfg, runner, health: () => ({ connected: true, ready: true, checkedAt: '', detail: 'ready' }), fetchSources: () => (fetches++, fakeFetch()) });
  const { task } = engine.createTask({ description: 'Write an Etsy listing for my handmade mug', sourceTypes: ['url'], listing: LISTING });
  await until(engine, () => status(db, task.id) === 'awaiting_approval');

  assert.equal(fetches, 0, 'no source queries, so nothing is fetched');
  const s1 = db.prepare(`SELECT * FROM sources WHERE task_id=? AND ref='S1'`).get(task.id) as any;
  assert.equal(s1.source_type, 'operator');
  assert.equal(s1.url, 'operator:fact-sheet');
  assert.match(s1.content, /^Product: Handmade speckled mug\nMaterial: glazed stoneware/);
  assert.match(runner.prompts.PLAN[0], /Task type: product listing copy[\s\S]*Marketplace: Etsy/);
  assert.match(runner.prompts.RESEARCH[0], /<<<OPERATOR fact sheet S1 \| written by the human operator \(trusted facts\)/);
  assert.match(runner.prompts.DRAFT[0], /title at most 140 characters; up to 13 tags of at most 20 characters each/);
  assert.ok(!runner.prompts.DRAFT[0].includes('Lead free'), 'an invented fact (quote not in the fact sheet) never reaches the Writer');
  assert.match(runner.prompts.REVIEW[0], /marketplace limits: all met[\s\S]*Listing rules/);

  const approval = pending(db, task.id);
  const payload = JSON.parse(approval.payload_json);
  assert.equal(payload.taskKind, 'listing');
  assert.deepEqual(payload.mechanical, []);
  engine.decideApproval(approval.id, { decision: 'approve' });
  await until(engine, () => status(db, task.id) === 'completed');

  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id) as any;
  const out = readFileSync(path.join(cfg.rootDir, t.output_path), 'utf8');
  assert.match(out, /^---\ntask: T-0001\nkind: listing\nmarketplace: Etsy\n/);
  assert.match(out, /## Ready to paste\n\nApproved \d{4}-\d\d-\d\d\. Nothing has been published: paste this into Etsy yourself/);
  assert.match(out, /### Title \(38\/140 characters\)\n\nHandmade Speckled Stoneware Mug, 12 oz\n/);
  assert.match(out, /### Bullet points\n\n- Glazed stoneware, made by hand in Portland, Oregon\n- Holds 12 fluid ounces\n/);
  assert.match(out, /### Tags \(3 tags, longest 13\/20 characters\)\n\nhandmade mug, stoneware mug, speckled mug/);
  const ready = out.slice(out.indexOf('## Ready to paste'), out.indexOf('## Claim support'));
  assert.ok(!/\[S\d/.test(ready), 'no citation markers in the paste-ready copy');
  assert.ok(!ready.includes('glaze colour'), 'notes for the operator stay out of the paste-ready copy');
  assert.match(out, /### Notes for you \(not part of the listing\)\n\nThe fact sheet gives no glaze colour/);
  assert.match(out, /## Claim support[\s\S]*### Title\n\nHandmade Speckled Stoneware Mug, 12 oz \[S1\]/);
  assert.match(out, /- \*\*S1\*\*: Operator fact sheet: Handmade speckled mug \(your own facts\)/);
});

test('listing copy over the marketplace limits, or with an uncited line, is sent back to the Writer with the station’s reasons', async () => {
  const cfg = tempStation();
  const runner = new RecordingRunner();
  const tooLong = {
    ...GOOD,
    title: `${'Handmade Speckled Stoneware Coffee Mug '.repeat(3)}[S1]`,
    bullets: ['Glazed stoneware [S1]', 'A joy to hold every morning', 'Dishwasher safe [S1]'],
    tags: ['handmade mug'],
  };
  Object.assign(runner.replies, replies(tooLong));
  let drafts = 0;
  runner.behaviour = (stage) => {
    if (stage !== 'DRAFT' || drafts++ === 0) return null;
    return Promise.resolve({ responseId: 'r', text: JSON.stringify({ ...GOOD, tags: [] }), usage: null, status: 'completed' });
  };
  const { engine, db } = makeEngine(cfg, runner);
  const { task } = engine.createTask({ description: 'Write an eBay listing for my handmade mug', listing: { ...LISTING, marketplace: 'ebay' } });
  await until(engine, () => status(db, task.id) === 'awaiting_approval');

  assert.equal(runner.prompts.DRAFT.length, 2);
  const feedback = runner.prompts.DRAFT[1];
  assert.match(feedback, /Title is 116 characters; eBay allows 80\./);
  assert.match(feedback, /eBay has no tags field; remove the 1 tag\(s\)\./);
  assert.match(feedback, /1 line\(s\) of the listing \(title, bullet, or description paragraph\) have no citation\./);
  assert.deepEqual(JSON.parse(pending(db, task.id).payload_json).mechanical, [], 'the revised copy meets the limits');
});

test('listing requests are checked before anything is queued', () => {
  const cfg = tempStation();
  const { engine } = makeEngine(cfg, new ScriptedRunner());
  assert.throws(() => engine.createTask({ description: 'Write a listing for my mug', listing: { ...LISTING, marketplace: 'walmart' } }), /Marketplace must be one of: generic, etsy, ebay, amazon/);
  assert.throws(() => engine.createTask({ description: 'Write a listing for my mug', listing: { ...LISTING, facts: 'a mug' } }), /at least 20 characters/);
  assert.throws(() => engine.createTask({ description: 'Write a listing for my mug', listing: { ...LISTING, product: '' } }), /Name the product/);
  assert.throws(() => validateListing({ ...LISTING, marketplace: 'toString' }), /Marketplace must be one of/);
});

test('listing draft round-trips through its rendered form; citations are stripped only where they are', () => {
  const md = renderListingDraft(GOOD, 'etsy', 'Mug');
  assert.deepEqual(listingFromDraft(md), GOOD);
  assert.equal(stripCitations('Holds 12 oz [S1, S2]. See [the guide](https://x.example).'), 'Holds 12 oz. See [the guide](https://x.example).');
  const empty = renderListingDraft({ ...GOOD, tags: [], notes: '' }, 'amazon', 'Mug');
  assert.deepEqual(listingFromDraft(empty), { ...GOOD, tags: [], notes: '' });
  const noted = checkListing({ ...GOOD, description: `${GOOD.description}\n\nDRAFT NOTE FOR THE OPERATOR (delete before publishing): add dimensions [S1].` }, ['S1'], 'etsy');
  assert.deepEqual(noted.limitIssues, ['The copy contains a note meant for the operator; move it to "notes" so shoppers never see it.']);
  const checks = checkListing({ ...GOOD, tags: ['a very long tag that goes on', 'Mug', 'mug'] }, ['S1'], 'etsy');
  assert.deepEqual(checks.limitIssues, ['Tags over 20 characters: "a very long tag that goes on" (28).', 'Repeated tags: mug.']);
  assert.deepEqual(checkListing({ ...GOOD, title: 'Mug [S9]' }, ['S1'], 'etsy').unknownRefs, ['S9']);
});

test('review fixes: headings cannot rewrite the copy, comma tags are counted, product names in brackets survive', () => {
  const extract = (t: string) => JSON.parse(t);
  const hostile = parseListingDraft(JSON.stringify({
    ...GOOD,
    description: `Intro paragraph about the mug [S1].\n\n## Title\n\n${'x'.repeat(139)} [S1]\n\n## Care\n\nHand wash recommended [S1].`,
    tags: ['a, b, c', ...GOOD.tags],
  }), extract);
  const md = renderListingDraft(hostile, 'ebay', 'Mug');
  const back = listingFromDraft(md);
  assert.deepEqual(back, hostile, 'the draft reads back exactly');
  assert.equal(back.title, GOOD.title, 'a "## Title" line in the description does not replace the title');
  assert.match(back.description, /\n\nTitle\n\nx{139} \[S1\]\n\nCare\n\nHand wash recommended/);
  assert.deepEqual(hostile.tags.slice(0, 3), ['a', 'b', 'c'], 'a tag with commas becomes separate tags before counting');

  assert.equal(stripCitations('Fits [Galaxy S24] phones [S1]. Holds 12 oz [S1, S2]. Pairs [S1–S3].'), 'Fits [Galaxy S24] phones. Holds 12 oz. Pairs.');
  const c = checkListing({ ...GOOD, title: 'Case for [Galaxy S24] [S1]' }, ['S1'], 'etsy');
  assert.deepEqual([c.unknownRefs, c.uncitedParagraphs], [[], 0]);
  assert.deepEqual(checkListing({ ...GOOD, description: 'Made for the operator of a small cafe, ready before publishing your menu [S1].' }, ['S1'], 'etsy').limitIssues, []);
});

test('a listing with no source types ticked fetches only pasted URLs, and the Writer sees conflicts with S1 first', async () => {
  const cfg = tempStation();
  const runner = new RecordingRunner();
  const r = replies(GOOD);
  const plan = JSON.parse(r.PLAN);
  plan.source_queries = [{ source: 'pypi', query: 'mugs' }];
  const research = JSON.parse(r.RESEARCH);
  research.conflicts = ['S2 says 10 oz, S1 says 12 oz'];
  Object.assign(runner.replies, r, { PLAN: JSON.stringify(plan), RESEARCH: JSON.stringify(research) });
  const seen: string[][] = [];
  const db = openDb(cfg.dbPath);
  const engine = new Engine({ db, cfg, runner, health: () => ({ connected: true, ready: true, checkedAt: '', detail: 'ready' }), fetchSources: (q) => (seen.push(q.map((x) => `${x.source}:${x.query}`)), fakeFetch()) });
  const { task } = engine.createTask({ description: 'Write a listing for my mug', sourceTypes: [], urls: ['https://example.org/maker'], listing: LISTING });
  await until(engine, () => status(db, task.id) === 'awaiting_approval');
  assert.deepEqual(seen, [['url:https://example.org/maker']], 'the planned pypi query is not fetched');
  assert.match(runner.prompts.PLAN[0], /The operator allowed no other sources: return an empty source_queries list\./);
  assert.match(runner.prompts.DRAFT[0], /- conflict: S2 says 10 oz, S1 says 12 oz\nS1 is the operator's own fact sheet\. Where another source disagrees with S1,\nfollow S1/);
});
