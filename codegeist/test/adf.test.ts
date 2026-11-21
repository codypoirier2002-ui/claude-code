import { describe, expect, it } from 'vitest';
import { adfToMarkdown, adfToPlainText, extractMentions, extractUrls, type AdfNode } from '../src/core/adf';
import { bulletList, doc, heading, orderedList, paragraph, text } from './fixtures';

describe('adfToMarkdown', () => {
  it('renders headings, paragraphs and lists', () => {
    const value = doc(heading(2, 'Scope'), paragraph(text('Export the log.')), bulletList('one', 'two'), orderedList('a', 'b'));
    expect(adfToMarkdown(value)).toBe('## Scope\n\nExport the log.\n\n- one\n- two\n\n1. a\n2. b');
  });

  it('applies marks and keeps link targets', () => {
    const value = doc(
      paragraph(
        text('bold', [{ type: 'strong' }]),
        text(' '),
        text('code', [{ type: 'code' }]),
        text(' '),
        text('spec', [{ type: 'link', attrs: { href: 'https://example.com/spec' } }]),
      ),
    );
    expect(adfToMarkdown(value)).toBe('**bold** `code` [spec](https://example.com/spec)');
  });

  it('renders task lists, code blocks, mentions, smart links and tables', () => {
    const value: AdfNode = doc(
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('design approved')] },
          { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('copy reviewed')] },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'sql' }, content: [text('select 1;')] },
      paragraph({ type: 'mention', attrs: { id: 'acc-1', text: '@Ben Ode' } }, text(' see '), {
        type: 'inlineCard',
        attrs: { url: 'https://example.com/doc' },
      }),
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph(text('Col'))] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(text('a|b'))] }] },
        ],
      },
    );
    expect(adfToMarkdown(value)).toBe(
      [
        '- [x] design approved\n- [ ] copy reviewed',
        '```sql\nselect 1;\n```',
        '@Ben Ode see https://example.com/doc',
        '| Col |\n| --- |\n| a\\|b |',
      ].join('\n\n'),
    );
  });

  it('renders dates, statuses, panels and expands', () => {
    const value = doc(
      paragraph(
        text('Due '),
        { type: 'date', attrs: { timestamp: '1767225600000' } },
        text(' '),
        { type: 'status', attrs: { text: 'IN REVIEW' } },
        text(' '),
        { type: 'date', attrs: { timestamp: 'not-a-date' } },
      ),
      { type: 'panel', attrs: { panelType: 'warning' }, content: [paragraph(text('Feature flag required'))] },
      { type: 'panel', attrs: { panelType: '' }, content: [paragraph(text('Untyped panel'))] },
      { type: 'expand', attrs: { title: 'Details' }, content: [paragraph(text('Hidden text'))] },
    );
    expect(adfToMarkdown(value)).toBe(
      [
        'Due 2026-01-01 [IN REVIEW] not-a-date',
        '> **Warning:** Feature flag required',
        '> **Info:** Untyped panel',
        '**Details**\nHidden text',
      ].join('\n\n'),
    );
  });

  it('indents nested lists under their item', () => {
    const value = doc({
      type: 'bulletList',
      content: [{ type: 'listItem', content: [paragraph(text('parent')), bulletList('child')] }],
    });
    expect(adfToMarkdown(value)).toBe('- parent\n  - child');
  });

  it('accepts strings and empty values', () => {
    expect(adfToMarkdown('  plain text  ')).toBe('plain text');
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(undefined)).toBe('');
    expect(adfToMarkdown({ not: 'adf' })).toBe('');
  });
});

describe('adfToPlainText', () => {
  it('puts one block per line and keeps list markers', () => {
    const value = doc(heading(1, 'Steps to reproduce'), orderedList('Open the page', 'Click export'), paragraph(text('Expected: a file')));
    expect(adfToPlainText(value)).toBe('Steps to reproduce\n1. Open the page\n2. Click export\nExpected: a file');
  });

  it('drops marks and code fences', () => {
    const value = doc(paragraph(text('bold', [{ type: 'strong' }])), { type: 'codeBlock', content: [text('x = 1')] });
    expect(adfToPlainText(value)).toBe('bold\nx = 1');
  });
});

describe('extractMentions', () => {
  it('returns each mentioned person once and skips group mentions', () => {
    const value = doc(
      paragraph(
        { type: 'mention', attrs: { id: 'acc-1', text: '@Ana Silva' } },
        { type: 'mention', attrs: { id: 'acc-1', text: '@Ana Silva' } },
        { type: 'mention', attrs: { id: 'all', text: '@all' } },
        { type: 'mention', attrs: { id: 'acc-2', text: 'Ben' } },
      ),
    );
    expect(extractMentions(value)).toEqual([
      { accountId: 'acc-1', name: 'Ana Silva' },
      { accountId: 'acc-2', name: 'Ben' },
    ]);
  });
});

describe('extractUrls', () => {
  it('collects link marks, smart links and bare URLs without duplicates', () => {
    const value = doc(
      paragraph(text('spec', [{ type: 'link', attrs: { href: 'https://example.com/spec' } }])),
      paragraph(text('see https://example.com/spec, and https://example.com/other.')),
      { type: 'blockCard', attrs: { url: 'https://figma.example/file/1' } },
    );
    expect(extractUrls(value)).toEqual(['https://example.com/spec', 'https://example.com/other', 'https://figma.example/file/1']);
  });

  it('works on plain strings', () => {
    expect(extractUrls('docs: https://example.com/a?b=1 and mailto:x@y.z')).toEqual(['https://example.com/a?b=1']);
  });
});
