import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDraft } from '../src/workflow.ts';

const body = '# Report\n\n## Summary\n\n' + 'Alpha library supports asynchronous requests [S1]. '.repeat(5);
const draft = (extra: string) => `<<<REPORT\n${body}${extra}\nREPORT>>>`;

test('parseDraft drops a sources section the model added, but not sections that merely start with the word', () => {
  for (const heading of ['## Sources', '## References:', '### bibliography', '# Sources  ']) {
    assert.equal(parseDraft(draft(`\n\n${heading}\n\n- [S1] https://example.org`)), body.trim(), heading);
  }
  const kept = '\n\n## Sources of disagreement\n\nThe two reports differ [S2].\n\n## Open questions\n\n- None.';
  assert.equal(parseDraft(draft(kept)), (body + kept).trim());
});
