// "Prepare product listing copy": a task type that drafts marketplace listing
// text (title, bullet points, description, tags) and publishes nothing.
//
// It runs through the same workflow as a research report. The operator's
// product facts become source S1, so every claim in the copy must trace to a
// quote the station checked against those facts or against an approved
// source. The Writer cites [S#] on every line; the station checks citations
// and marketplace length limits, and removes the markers from the paste-ready
// copy it saves after approval.
import { createHash } from 'node:crypto';
import type { DraftChecks, Plan, Research, SourceForPrompt } from './workflow.ts';
import { findingsBlock, OutputError } from './workflow.ts';

export interface Marketplace {
  name: string;
  titleMax: number | null;
  // 0 means the marketplace has no tags field.
  tagsMax: number;
  tagMax: number | null;
  basis: string;
}

// Only limits with a source are enforced. Bullet and description limits vary
// by category on Amazon and could not be confirmed, so none are enforced.
export const MARKETPLACES: Record<string, Marketplace> = {
  generic: { name: 'General (no marketplace)', titleMax: null, tagsMax: 15, tagMax: null, basis: 'No marketplace limits are applied.' },
  etsy: {
    name: 'Etsy',
    titleMax: 140,
    tagsMax: 13,
    tagMax: 20,
    basis: 'Etsy limits (title 140 characters; 13 tags of 20 characters) come from consistent seller guides, not Etsy’s own help pages. Etsy’s listing form has the final say.',
  },
  ebay: { name: 'eBay', titleMax: 80, tagsMax: 0, tagMax: null, basis: 'eBay title limit (80 characters) from eBay’s Trading API documentation for Item.Title. eBay has no tags field.' },
  amazon: {
    name: 'Amazon',
    titleMax: 200,
    tagsMax: 0,
    tagMax: null,
    basis: 'Amazon title limit (200 characters) from Seller Central product detail page rules (checked on amazon.com; confirm on Amazon.ca). Bullet limits vary by category: check your category template.',
  },
  kijiji: {
    name: 'Kijiji',
    titleMax: null,
    tagsMax: 0,
    tagMax: null,
    basis: 'Kijiji’s title limit could not be confirmed, so none is applied; its posting form shows the limit. Kijiji has no tags field.',
  },
};

export const REGIONS = { other: 'Anywhere (no regional rules)', canada: 'Canada' } as const;
export type Region = keyof typeof REGIONS;

// Competition Bureau enforcement guidelines for non-food products (updated
// March 2025): "Product of Canada" needs at least 98% of total direct costs
// incurred in Canada; "Made in Canada" needs at least 51% plus a statement of
// imported content; both need the last substantial transformation in Canada.
const CANADA_ORIGIN = /\b(made in canada|product of canada|canadian[- ]made|made in [a-z .'-]*,? canada)\b/i;

export interface ListingRequest {
  product: string;
  facts: string;
  marketplace: string;
  tone: string;
  // Absent on listings created before regions existed.
  region?: Region;
}

export function validateListing(raw: unknown): ListingRequest {
  const r = (raw ?? {}) as Record<string, unknown>;
  const product = String(r.product ?? '').trim();
  const facts = String(r.facts ?? '').trim();
  const marketplace = String(r.marketplace ?? 'generic');
  const tone = String(r.tone ?? '').trim();
  if (product.length < 2 || product.length > 120) throw new Error('Name the product in 2 to 120 characters.');
  if (facts.length < 20) throw new Error('Give the product facts (at least 20 characters). The copy can only claim what they, or approved sources, say.');
  if (facts.length > 6000) throw new Error('Product facts are limited to 6,000 characters.');
  if (!Object.hasOwn(MARKETPLACES, marketplace)) throw new Error(`Marketplace must be one of: ${Object.keys(MARKETPLACES).join(', ')}.`);
  if (tone.length > 200) throw new Error('Tone is limited to 200 characters.');
  const region = String(r.region ?? 'other');
  if (!Object.hasOwn(REGIONS, region)) throw new Error(`Region must be one of: ${Object.keys(REGIONS).join(', ')}.`);
  return { product, facts, marketplace, tone, region: region as Region };
}

export const FACT_SHEET_URL = 'operator:fact-sheet';

// The operator's facts, stored as source S1 so quotes can be checked against them.
export function factSheetSource(l: ListingRequest, retrievedAt: string) {
  const content = `Product: ${l.product}\n${l.facts}`;
  return {
    type: 'operator',
    url: FACT_SHEET_URL,
    title: `Operator fact sheet: ${l.product}`,
    content,
    retrievedAt,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
  };
}

function rulesLine(m: Marketplace): string {
  const parts = [m.titleMax ? `title at most ${m.titleMax} characters` : 'no title limit'];
  parts.push(m.tagsMax === 0 ? 'no tags (leave "tags" empty)' : m.tagMax ? `up to ${m.tagsMax} tags of at most ${m.tagMax} characters each` : `up to ${m.tagsMax} tags`);
  return parts.join('; ');
}

export function listingPlanSection(l: ListingRequest, extraSourcesAllowed: boolean): string {
  const m = MARKETPLACES[l.marketplace];
  const queries = extraSourcesAllowed
    ? `Add 0 to 4
source_queries only if an approved source would confirm details the listing
needs.`
    : 'The operator allowed no other sources: return an empty source_queries list.';
  return `
## Task type: product listing copy (drafting only)
Product: ${l.product}
Marketplace: ${m.name}
The operator's fact sheet is source S1 and is the main source. ${queries} Use "Listing: <product>" as the title, and write success criteria about
accurate, supported, marketplace-ready copy. The station never publishes a
listing; nothing goes live from this task.`;
}

const CANADA_RULES = `Region: Canada. Write for Canadian shoppers:
- Canadian English spelling (colour, centre, metre, jewellery).
- Use units as the facts give them; if they give metric, lead with metric. Do
  not convert units yourself.
- Give a price only if the facts do, and add a currency only if the facts name
  one (CAD, C$).
- Say "Made in Canada", "Product of Canada", or similar only if the facts say
  it in those words. Canada's Competition Bureau sets thresholds for those
  claims; the station checks them against the fact sheet.`;

export function listingDraftPrompt(o: {
  taskLabel: string;
  memory: string;
  plan: Plan;
  listing: ListingRequest;
  operatorNotes: string;
  research: Research;
  sources: SourceForPrompt[];
  feedback: string[] | null;
  previousDraft: string | null;
}): string {
  const m = MARKETPLACES[o.listing.marketplace];
  const revision = o.feedback
    ? `\n## Feedback to fix in this revision\n${o.feedback.map((f) => `- ${f}`).join('\n')}\n\n## Previous draft\n<<<PREVIOUS\n${o.previousDraft ?? ''}\nPREVIOUS>>>\n`
    : '';
  return `# Station request: DRAFT (${o.taskLabel}) LISTING COPY

${o.memory}

## Listing brief
Product: ${o.listing.product}
Marketplace: ${m.name}. Limits the station checks: ${rulesLine(m)}.
Tone: ${o.listing.tone || 'clear, warm, and specific'}${o.listing.region === 'canada' ? `\n${CANADA_RULES}` : ''}
Operator request: ${o.operatorNotes}
Success criteria:
${o.plan.success_criteria.map((c) => `- ${c}`).join('\n')}

## Verified facts (quotes checked against the fact sheet S1 and other sources)
${findingsBlock(o.research.findings)}

## Known gaps and conflicts
${[...o.research.gaps.map((g) => `- gap: ${g}`), ...o.research.conflicts.map((c) => `- conflict: ${c}`)].join('\n') || '- none recorded'}
S1 is the operator's own fact sheet. Where another source disagrees with S1,
follow S1 and mention the conflict in "notes".

## Source IDs you may cite
${o.sources.map((s) => `- ${s.ref}: ${s.title}`).join('\n')}
${revision}
## Your output
Reply with exactly one JSON object and nothing else:
{
  "title": "the listing title, ending with its citations, e.g. ... [S1]",
  "bullets": [3 to 5 bullet points, each ending with [S#]],
  "description": "1 to 4 short paragraphs separated by a blank line; every paragraph cites [S#]",
  "tags": [search tags, no citations],
  "notes": "anything for the operator only: missing facts, questions, caveats"
}
Rules:
- The copy goes to shoppers. Put every note for the operator (missing
  details, questions, "delete before publishing") in "notes", never in the copy.
- Claim only what the verified facts say. Do not invent sizes, materials,
  quantities, prices, shipping, returns, warranty, or certifications.
- No superlatives ("best", "#1"), comparisons with other products, or health,
  safety, legal, or environmental claims unless a verified fact states them.
- Lengths are measured without the [S#] markers; the station removes them
  from the paste-ready copy.
- The report structure rule (summary, findings, open questions) does not
  apply to listing copy.`;
}

export interface Listing {
  title: string;
  bullets: string[];
  description: string;
  tags: string[];
  // For the operator only; never part of the paste-ready copy.
  notes: string;
}

const demoteHeadings = (s: string) => s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');

export function parseListingDraft(reply: string, extractJsonObject: (t: string) => any): Listing {
  const o = extractJsonObject(reply);
  const listing: Listing = {
    title: text(o.title, 400).replace(/\s*\n\s*/g, ' '),
    bullets: (Array.isArray(o.bullets) ? o.bullets : []).map((b: unknown) => text(b, 1000).replace(/\s*\n\s*/g, ' ').replace(/^[-*•]\s*/, '')).filter(Boolean).slice(0, 7),
    // Heading lines would end or replace sections when the approved draft is
    // read back, so they become plain lines.
    description: demoteHeadings(text(o.description, 6000)).replace(/\n{3,}/g, '\n\n'),
    // Tags are joined with commas in the draft, so a comma would split one tag into several.
    tags: (Array.isArray(o.tags) ? o.tags : []).flatMap((t: unknown) => text(t, 100).split(',')).map((t: string) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30),
    notes: demoteHeadings(text(o.notes, 2000)),
  };
  if (!listing.title) throw new OutputError('listing has no title');
  if (!listing.bullets.length) throw new OutputError('listing has no bullet points');
  if (listing.description.length < 40) throw new OutputError('listing description is missing or shorter than 40 characters');
  return listing;
}

// A citation is a bracket holding only source IDs: [S1], [S1, S2], [S1–S3].
// "[Galaxy S24]" is product text, not a citation.
const CITATION = /[ \t]*\[\s*S\d+(?:\s*(?:,|;|–|-|and)\s*S\d+)*\s*\]/g;

// Removes [S#] citation markers.
export const stripCitations = (s: string) => s.replace(CITATION, '').trim();

// The draft the operator approves: the copy with its citations, in fixed sections.
export function renderListingDraft(l: Listing, marketplace: string, product: string): string {
  const m = MARKETPLACES[marketplace];
  return [
    `# Listing copy: ${product} (${m.name})`,
    '',
    '## Title',
    '',
    l.title,
    '',
    '## Bullet points',
    '',
    ...l.bullets.map((b) => `- ${b}`),
    '',
    '## Description',
    '',
    l.description,
    '',
    '## Tags',
    '',
    l.tags.length ? l.tags.join(', ') : '(none)',
    ...(l.notes ? ['', NOTES_HEADING, '', l.notes] : []),
  ].join('\n');
}

const NOTES_HEADING = '## Notes for you (not part of the listing)';

// Reads a rendered draft back. The approved draft is the source of truth for
// what is published, so the paste-ready copy is derived from it, not from a
// separately stored object.
export function listingFromDraft(md: string): Listing {
  const sections = new Map<string, string>();
  let current: string | null = null;
  for (const line of md.split('\n')) {
    const h = /^## (Title|Bullet points|Description|Tags)\s*$/.exec(line);
    if (h && !sections.has(h[1])) {
      current = h[1];
      sections.set(current, '');
    } else if (/^## /.test(line) && !(line === NOTES_HEADING && sections.has('Notes'))) {
      current = line === NOTES_HEADING ? 'Notes' : null;
      if (current) sections.set(current, '');
    } else if (current) {
      sections.set(current, `${sections.get(current)}${line}\n`);
    }
  }
  const tags = (sections.get('Tags') ?? '').trim();
  return {
    title: (sections.get('Title') ?? '').trim(),
    bullets: (sections.get('Bullet points') ?? '').split('\n').filter((x) => x.startsWith('- ')).map((x) => x.slice(2).trim()),
    description: (sections.get('Description') ?? '').trim(),
    tags: tags && tags !== '(none)' ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    notes: (sections.get('Notes') ?? '').trim(),
  };
}

export interface ListingChecks extends DraftChecks {
  limitIssues: string[];
}

const cites = (s: string) => new RegExp(CITATION.source).test(s);

export function checkListing(l: Listing, knownRefs: string[], marketplace: string, facts = ''): ListingChecks {
  const m = MARKETPLACES[marketplace];
  const all = [l.title, ...l.bullets, l.description].join('\n');
  const cited = new Set<string>();
  for (const b of all.matchAll(CITATION)) for (const r of b[0].matchAll(/S\d+/g)) cited.add(r[0]);
  const known = new Set(knownRefs);
  const paragraphs = l.description.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length >= 40);
  const uncited = [l.title, ...l.bullets, ...paragraphs].filter((x) => !cites(x)).length;

  const issues: string[] = [];
  const title = stripCitations(l.title);
  if (m.titleMax && title.length > m.titleMax) issues.push(`Title is ${title.length} characters; ${m.name} allows ${m.titleMax}.`);
  if (l.bullets.length < 3 || l.bullets.length > 5) issues.push(`Give 3 to 5 bullet points (got ${l.bullets.length}).`);
  if (m.tagsMax === 0 && l.tags.length) issues.push(`${m.name} has no tags field; remove the ${l.tags.length} tag(s).`);
  else if (l.tags.length > m.tagsMax) issues.push(`${l.tags.length} tags; ${m.name} allows ${m.tagsMax}.`);
  if (m.tagMax) {
    const long = l.tags.filter((t) => t.length > m.tagMax!);
    if (long.length) issues.push(`Tags over ${m.tagMax} characters: ${long.map((t) => `"${t}" (${t.length})`).join(', ')}.`);
  }
  const lower = l.tags.map((t) => t.toLowerCase());
  const dupes = [...new Set(lower.filter((t, i) => lower.indexOf(t) !== i))];
  if (dupes.length) issues.push(`Repeated tags: ${dupes.join(', ')}.`);
  if (l.tags.some((t) => new RegExp(CITATION.source).test(t))) issues.push('Tags must not carry [S#] citations.');
  // A Canadian origin claim must be the operator's own words, not the Writer's.
  const origin = CANADA_ORIGIN.exec([l.title, ...l.bullets, l.description].join('\n'));
  if (origin && !facts.toLowerCase().includes(origin[0].toLowerCase())) {
    issues.push(`The copy says "${origin[0]}" but the fact sheet does not. Canada's Competition Bureau guidelines require at least 51% of direct costs in Canada for "Made in Canada" (with a note on imported content) and 98% for "Product of Canada", with the last substantial transformation in Canada. Remove it, or add it to the facts if it is true.`);
  }
  // Notes to the operator belong in "notes", where they stay out of the copy.
  if (/draft note|notes? (for|to) the operator|delete (this )?before publishing/i.test([l.title, ...l.bullets, l.description].join('\n'))) {
    issues.push('The copy contains a note meant for the operator; move it to "notes" so shoppers never see it.');
  }
  return {
    citedRefs: [...cited].sort(),
    unknownRefs: [...cited].filter((r) => !known.has(r)).sort(),
    uncitedParagraphs: uncited,
    bareUrls: [...all.matchAll(/https?:\/\/[^\s)\]]+/g)].map((x) => x[0]).slice(0, 10),
    limitIssues: issues,
  };
}

export const LISTING_REVIEW_RULES = `
## Listing rules (this is marketplace listing copy, not a report)
- Every claim must be supported by the verified facts; flag any that is not as high.
- Flag superlatives, comparisons with other products, and health, safety,
  legal, environmental, or certification claims that no fact states.
- Flag invented specifics: sizes, materials, quantities, prices, shipping,
  returns, warranty.
- Judge whether a shopper would understand what the product is and who it is for.
- The station checks length limits and citations itself (see Mechanical checks),
  and removes every [S#] marker from the paste-ready copy; do not flag them.
- Notes for the operator belong in the "Notes for you" section, which is not
  part of the listing. Flag any such note that appears in the copy itself.
- The report structure rule (summary, findings, open questions) does not apply
  to listing copy. S1 is the operator's own fact sheet and counts as a source.`;

// The saved output: paste-ready copy first, then the approved draft with its
// citations, then the sources.
export function listingOutput(o: {
  taskLabel: string;
  title: string;
  product: string;
  marketplace: string;
  region?: Region;
  draft: string;
  sources: SourceForPrompt[];
  approvedAt: string;
  reviewVerdict: string;
}): string {
  const m = MARKETPLACES[o.marketplace];
  const l = listingFromDraft(o.draft);
  const title = stripCitations(l.title);
  const fm = [
    '---',
    `task: ${o.taskLabel}`,
    'kind: listing',
    `marketplace: ${m.name}`,
    ...(o.region === 'canada' ? ['region: Canada'] : []),
    `title: ${JSON.stringify(o.title)}`,
    `approved_at: ${o.approvedAt}`,
    `review_verdict: ${o.reviewVerdict}`,
    `sources: ${o.sources.length}`,
    '---',
  ].join('\n');
  const tagNote = l.tags.length ? ` (${l.tags.length} tag${l.tags.length === 1 ? '' : 's'}${m.tagMax ? `, longest ${Math.max(...l.tags.map((t) => t.length))}/${m.tagMax} characters` : ''})` : '';
  const ready = [
    '## Ready to paste',
    '',
    `Approved ${o.approvedAt.slice(0, 10)}. Nothing has been published: paste this into ${m.name === MARKETPLACES.generic.name ? 'your store' : m.name} yourself and check it there. ${m.basis}`,
    '',
    `### Title (${title.length}${m.titleMax ? `/${m.titleMax}` : ''} characters)`,
    '',
    title,
    '',
    '### Bullet points',
    '',
    ...l.bullets.map((b) => `- ${stripCitations(b)}`),
    '',
    '### Description',
    '',
    l.description.split('\n').map(stripCitations).join('\n'),
    ...(l.tags.length && m.tagsMax > 0 ? ['', `### Tags${tagNote}`, '', l.tags.join(', ')] : []),
  ].join('\n');
  const support = o.draft.replace(/^# .*\n+/, '').replace(/^## /gm, '### ');
  const list = o.sources
    .map((s) => (s.url === FACT_SHEET_URL
      ? `- **${s.ref}**: ${s.title} (your own facts). SHA-256: \`${s.sha256.slice(0, 16)}…\``
      : `- **${s.ref}**: [${s.title.replace(/[\[\]]/g, '')}](${s.url}). Retrieved ${s.retrievedAt}. SHA-256 of retrieved text: \`${s.sha256.slice(0, 16)}…\``))
    .join('\n');
  return `${fm}\n\n# ${o.title}\n\n${ready}\n\n## Claim support\n\nThe approved copy with the source behind each line. S1 is your fact sheet.\n\n${support}\n\n## Sources\n\n${list}\n`;
}
