/**
 * Atlassian Document Format (ADF) helpers.
 *
 * Jira's REST API v3 returns rich text (descriptions, comments, some custom
 * fields) as ADF JSON. Groundwork needs two views of it:
 * - plain text, one block per line with list markers kept, for the checks;
 * - Markdown, for the context pack that people and agents read.
 *
 * Every function also accepts a plain string (older or custom fields) and
 * treats `null`/`undefined` as empty.
 */
import type { PersonRef } from './types';

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/g;

export function isAdfNode(value: unknown): value is AdfNode {
  return typeof value === 'object' && value !== null && typeof (value as AdfNode).type === 'string';
}

function attr(node: AdfNode, name: string): string | undefined {
  const value = node.attrs?.[name];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isAdfNode) : [];
}

interface RenderOptions {
  markdown: boolean;
}

function renderText(node: AdfNode, opts: RenderOptions): string {
  let text = node.text ?? '';
  if (!opts.markdown || text.length === 0) return text;
  const marks = node.marks ?? [];
  const has = (type: string): boolean => marks.some((m) => m.type === type);
  if (has('code')) {
    text = '`' + text + '`';
  } else {
    if (has('strong')) text = `**${text}**`;
    if (has('em')) text = `_${text}_`;
    if (has('strike')) text = `~~${text}~~`;
  }
  const link = marks.find((m) => m.type === 'link');
  const href = link?.attrs?.href;
  if (typeof href === 'string' && href.length > 0 && href !== node.text) {
    text = `[${text}](${href})`;
  }
  return text;
}

function formatDate(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const date = new Date(Number(timestamp));
  return Number.isNaN(date.getTime()) ? timestamp : date.toISOString().slice(0, 10);
}

function renderInline(nodes: AdfNode[], opts: RenderOptions): string {
  return nodes.map((node) => renderInlineNode(node, opts)).join('');
}

function renderInlineNode(node: AdfNode, opts: RenderOptions): string {
  switch (node.type) {
    case 'text':
      return renderText(node, opts);
    case 'hardBreak':
      return '\n';
    case 'mention': {
      const text = attr(node, 'text') ?? '';
      return text.startsWith('@') || text.length === 0 ? text : `@${text}`;
    }
    case 'emoji':
      return attr(node, 'text') ?? attr(node, 'shortName') ?? '';
    case 'inlineCard':
      return attr(node, 'url') ?? '';
    case 'date':
      return formatDate(attr(node, 'timestamp'));
    case 'status': {
      const text = attr(node, 'text') ?? '';
      return text ? `[${text}]` : '';
    }
    case 'placeholder':
    case 'media':
    case 'mediaInline':
      return '';
    default:
      return node.text ?? renderInline(children(node), opts);
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join('\n');
}

function renderListItem(item: AdfNode, marker: string, opts: RenderOptions): string {
  const blocks = children(item)
    .map((child) => renderBlock(child, opts))
    .filter((block) => block.length > 0);
  if (blocks.length === 0) return marker.trimEnd();
  const continuation = ' '.repeat(marker.length);
  return blocks
    .join('\n')
    .split('\n')
    .map((line, index) => {
      if (index === 0) return marker + line;
      return line.length > 0 ? continuation + line : line;
    })
    .join('\n');
}

function renderTable(node: AdfNode, opts: RenderOptions): string {
  const rows = children(node).map((row) =>
    children(row).map((cell) =>
      children(cell)
        .map((block) => renderBlock(block, opts))
        .join(' ')
        .replace(/\n+/g, ' ')
        .replace(/\|/g, '\\|')
        .trim(),
    ),
  );
  if (rows.length === 0) return '';
  const lines = rows.map((cells) => `| ${cells.join(' | ')} |`);
  if (opts.markdown) {
    const firstRowIsHeader = children(children(node)[0] ?? { type: 'tableRow' }).every(
      (cell) => cell.type === 'tableHeader',
    );
    if (firstRowIsHeader) {
      const width = rows[0].length;
      lines.splice(1, 0, `| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
    }
  }
  return lines.join('\n');
}

function renderBlock(node: AdfNode, opts: RenderOptions): string {
  switch (node.type) {
    case 'doc':
      return renderBlocks(children(node), opts);
    case 'paragraph':
      return renderInline(children(node), opts);
    case 'heading': {
      const text = renderInline(children(node), opts);
      if (!opts.markdown) return text;
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      return `${'#'.repeat(level)} ${text}`;
    }
    case 'bulletList':
      return children(node)
        .map((item) => renderListItem(item, '- ', opts))
        .join('\n');
    case 'orderedList': {
      const start = Number(node.attrs?.order ?? 1);
      const first = Number.isFinite(start) ? start : 1;
      return children(node)
        .map((item, index) => renderListItem(item, `${first + index}. `, opts))
        .join('\n');
    }
    case 'taskList':
      return children(node)
        .map((item) => {
          if (item.type === 'taskList') return indent(renderBlock(item, opts), '  ');
          const done = attr(item, 'state') === 'DONE';
          return `- [${done ? 'x' : ' '}] ${renderInline(children(item), opts)}`;
        })
        .join('\n');
    case 'decisionList':
      return children(node)
        .map((item) => `- Decision: ${renderInline(children(item), opts)}`)
        .join('\n');
    case 'listItem':
      return renderListItem(node, '- ', opts);
    case 'codeBlock': {
      const code = children(node)
        .map((child) => child.text ?? '')
        .join('');
      if (!opts.markdown) return code;
      return '```' + (attr(node, 'language') ?? '') + '\n' + code + '\n```';
    }
    case 'blockquote':
      return indent(renderBlocks(children(node), opts), opts.markdown ? '> ' : '');
    case 'panel': {
      const body = renderBlocks(children(node), opts);
      if (!opts.markdown) return body;
      const kind = attr(node, 'panelType') || 'info';
      return indent(`**${kind[0].toUpperCase()}${kind.slice(1)}:** ${body}`, '> ');
    }
    case 'expand':
    case 'nestedExpand': {
      const title = attr(node, 'title');
      const body = renderBlocks(children(node), opts);
      if (!title) return body;
      return `${opts.markdown ? `**${title}**` : title}\n${body}`;
    }
    case 'rule':
      return opts.markdown ? '---' : '';
    case 'table':
      return renderTable(node, opts);
    case 'blockCard':
    case 'embedCard':
      return attr(node, 'url') ?? '';
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '';
    default:
      if (node.text !== undefined) return renderInlineNode(node, opts);
      return renderBlocks(children(node), opts);
  }
}

function renderBlocks(nodes: AdfNode[], opts: RenderOptions): string {
  const separator = opts.markdown ? '\n\n' : '\n';
  return nodes
    .map((node) => renderBlock(node, opts))
    .filter((block) => block.trim().length > 0)
    .join(separator);
}

function render(value: unknown, opts: RenderOptions): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (!isAdfNode(value)) return '';
  return renderBlock(value, opts).trim();
}

/** Renders ADF (or a string) as Markdown. */
export function adfToMarkdown(value: unknown): string {
  return render(value, { markdown: true });
}

/** Renders ADF (or a string) as plain text: one block per line, list markers kept. */
export function adfToPlainText(value: unknown): string {
  return render(value, { markdown: false });
}

function walk(value: unknown, visit: (node: AdfNode) => void): void {
  if (!isAdfNode(value)) return;
  visit(value);
  for (const child of children(value)) walk(child, visit);
}

/** People @-mentioned in an ADF document, de-duplicated by account ID. */
export function extractMentions(value: unknown): PersonRef[] {
  const found = new Map<string, PersonRef>();
  walk(value, (node) => {
    if (node.type !== 'mention') return;
    const accountId = attr(node, 'id');
    if (!accountId || accountId === 'all' || accountId === 'here') return;
    const name = (attr(node, 'text') ?? '').replace(/^@/, '').trim() || 'Unknown user';
    if (!found.has(accountId)) found.set(accountId, { accountId, name });
  });
  return [...found.values()];
}

function trimUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, '');
}

/** Every URL in an ADF document or string: link marks, smart links and bare URLs. */
export function extractUrls(value: unknown): string[] {
  const urls: string[] = [];
  const add = (url: unknown): void => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) urls.push(trimUrl(url));
  };
  if (typeof value === 'string') {
    for (const match of value.match(URL_PATTERN) ?? []) add(match);
  } else {
    walk(value, (node) => {
      if (node.type === 'inlineCard' || node.type === 'blockCard' || node.type === 'embedCard') {
        add(node.attrs?.url);
      }
      for (const mark of node.marks ?? []) {
        if (mark.type === 'link') add(mark.attrs?.href);
      }
      if (node.type === 'text' && node.text) {
        for (const match of node.text.match(URL_PATTERN) ?? []) add(match);
      }
    });
  }
  return [...new Set(urls)];
}
