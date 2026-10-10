import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDraft, checkDraft, extractJsonObject, parseResearch, parsePlan } from '../src/workflow.ts';

const body = '# Report\n\n## Summary\n\n' + 'Alpha library supports asynchronous requests [S1]. '.repeat(5);
const draft = (extra: string) => `<<<REPORT\n${body}${extra}\nREPORT>>>`;

test('parseDraft drops a sources section the model added, but not sections that merely start with the word', () => {
  for (const heading of ['## Sources', '## References:', '### bibliography', '# Sources  ']) {
    assert.equal(parseDraft(draft(`\n\n${heading}\n\n- [S1] https://example.org`)), body.trim(), heading);
  }
  const kept = '\n\n## Sources of disagreement\n\nThe two reports differ [S2].\n\n## Open questions\n\n- None.';
  assert.equal(parseDraft(draft(kept)), (body + kept).trim());
});

test('parseDraft keeps sections after a model-added References section, and measures length after stripping', () => {
  const kept = '\n\n## Open questions\n\n- Speed was not measured.\n\n## Recommendation\n\nPrefer alpha for async services [S1].';
  assert.equal(parseDraft(draft(`\n\n## References\n\n- S1 https://example.org${kept}`)), (body + kept).trim());
  assert.throws(() => parseDraft(`<<<REPORT\n# T\n\nShort [S1].\n\n## Sources\n\n${'- https://example.org/a-long-link\n'.repeat(8)}REPORT>>>`), /shorter than 200/);
});

test('checkDraft: only a heading line exempts a section, and every S# in any bracket is checked', () => {
  const uncited = 'Alpha supports async requests and is widely used in production services today.';
  // A body under a normal heading that mentions "limitations" is still checked.
  assert.equal(checkDraft(`# Report\n\n## Findings\nThe panels have known limitations in hot climates and that matters a lot.\n\n${uncited}`, ['S1']).uncitedParagraphs, 2);
  // An H1 title containing "gaps" does not exempt the intro.
  assert.equal(checkDraft(`# Funding gaps in EU solar\n\n${uncited}`, ['S1']).uncitedParagraphs, 1);
  // A real open-questions section is still exempt.
  assert.equal(checkDraft(`# R\n\n## Open questions\n\n${uncited}`, ['S1']).uncitedParagraphs, 0);
  for (const cite of ['[S7, p. 4]', '[S1–S7]', '[S7 and S1]']) {
    assert.deepEqual(checkDraft(`# R\n\n${uncited} ${cite}`, ['S1', 'S2']).unknownRefs, ['S7'], cite);
  }
});

test('extractJsonObject: ``` inside a JSON string does not break parsing, fenced or not', () => {
  const obj = { findings: [{ quote: '```bash pip install httpx ```' }] };
  assert.deepEqual(extractJsonObject(JSON.stringify(obj)), obj);
  assert.deepEqual(extractJsonObject('```json\n' + JSON.stringify(obj, null, 1) + '\n```'), obj);
  assert.deepEqual(extractJsonObject('Here it is:\n```json\n{"a":1}\n```\nDone.'), { a: 1 });
});

test('parseResearch: stock phrases do not verify a claim; whole lines and REPL lines do', () => {
  const src = [{ ref: 'S1', url: 'u', title: 't', retrievedAt: '', sha256: '', content: 'License: MIT\nIn addition, the library supports HTTP/1.1 only.\n>>> r = httpx.get(url)\n' }];
  const r = parseResearch(JSON.stringify({ findings: [
    { claim: 'a', source: 'S1', quote: 'In addition,' },
    { claim: 'b', source: 'S1', quote: 'License: MIT' },
    { claim: 'c', source: 'S1', quote: 'the library supports HTTP/1.1 only' },
    { claim: 'd', source: 'S1', quote: '‹‹‹ r = httpx.get(url)' },
  ] }), src);
  assert.deepEqual(r.findings.map((f) => f.verified), [false, true, true, true]);
});

test('parsePlan: source types match case-insensitively; a ready plan with no usable query is bad output', () => {
  const plan = (queries: unknown[]) => JSON.stringify({ status: 'ready', title: 't', objective: 'o', success_criteria: ['c'], source_queries: queries });
  assert.equal(parsePlan(plan([{ source: 'Wikipedia', query: 'Solar panel' }]), ['wikipedia']).source_queries[0].source, 'wikipedia');
  assert.throws(() => parsePlan(plan([{ source: 'url', query: 'https://x.org' }]), ['wikipedia']), /no source_queries/);
  assert.equal(parsePlan(plan([]), ['wikipedia'], 1).source_queries.length, 0, 'fine when the operator pasted URLs');
});
