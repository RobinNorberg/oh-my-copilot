/**
 * The local forge's backlog files (offline forge plan §1.1): one
 * `<id>-<slug>.md` per item in factory.forge.local.backlogDir, with a small
 * strict frontmatter. Pure: parse and render text; tracker.ts reads files.
 *
 *   ---
 *   title: Add remove()
 *   state: open                 # open | closed (default open)
 *   labels: [factory, size:2]   # or a block list of "- name" lines
 *   dependsOn: [2]
 *   parent: 1
 *   priority: 2
 *   size: 3
 *   ---
 *   Markdown body. An "## Acceptance" (or "## Acceptance criteria") section
 *   becomes ForgeItem.acceptance.
 */

/** `<id>-<slug>.md`; other files in the directory (a README) are not items. */
export const BACKLOG_FILE = /^([1-9]\d{0,8})-([a-z0-9][a-z0-9-]{0,79})\.md$/;

export interface BacklogFields {
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  dependsOn: number[];
  parent?: number;
  priority?: number;
  size?: number;
}

export interface BacklogItem extends BacklogFields {
  id: number;
  /** Repo-relative path, `/`-separated. */
  path: string;
  /** The markdown after the frontmatter. */
  body: string;
  /** The text of the "## Acceptance" section, if any. */
  acceptance?: string;
  /** The frontmatter alone (dependsOn/parent above also include the body's edge lines); a rewrite starts from it. */
  fields: BacklogFields;
}

export class BacklogParseError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`local backlog ${path}: ${detail}`);
    this.name = 'BacklogParseError';
  }
}

const KEYS = new Set(['title', 'state', 'labels', 'dependsOn', 'parent', 'priority', 'size']);
const LIST_KEYS = new Set(['labels', 'dependsOn']);
const LABEL = /^[^\s,;\-\p{Cc}][^,;\p{Cc}]{0,49}$/u;
const TITLE = /^[^\p{Cc}]{1,256}$/u;
const ACCEPTANCE = /^##[^\S\r\n]+acceptance(?:[^\S\r\n]+criteria)?[^\S\r\n]*:?[^\S\r\n]*$/i;

/** The id a backlog file name carries, or undefined for a file that is not an item. */
export function backlogFileId(name: string): number | undefined {
  const m = BACKLOG_FILE.exec(name);
  return m ? Number(m[1]) : undefined;
}

/** A file-name slug for a title: lowercase words joined by `-`, 1-60 characters. */
export function backlogSlug(title: string): string {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return slug || 'item';
}

function scalar(raw: string, path: string, line: number): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // fall through to the error below
    }
    throw new BacklogParseError(path, `line ${line}: malformed double-quoted value ${v}`);
  }
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'")) throw new BacklogParseError(path, `line ${line}: malformed single-quoted value ${v}`);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v.replace(/[^\S\r\n]+#.*$/, '');
}

function positive(value: string, key: string, path: string): number {
  if (!/^[1-9]\d{0,8}$/.test(value)) throw new BacklogParseError(path, `${key} must be a positive integer, got ${JSON.stringify(value)}`);
  return Number(value);
}

/** Split the "## Acceptance" section out of a body (up to the next `#`/`##` heading). */
export function acceptanceSectionOf(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => ACCEPTANCE.test(l.trim()));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}[^\S\r\n]/.test(l));
  const text = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return text || undefined;
}

/** Body edges like GitHub's: `Depends on #n` / `Blocked by #n` lines and the first `Part of #n` line. */
const bodyRefs = (body: string, re: RegExp): number[] => [...body.matchAll(re)].map((m) => Number(m[1]));

/**
 * Parse one backlog file. `path` is the repo-relative path (it names the
 * file in every error, and its basename carries the id).
 */
export function parseBacklogFile(path: string, text: string): BacklogItem {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const id = backlogFileId(name);
  if (id === undefined) throw new BacklogParseError(path, 'the file name must be <id>-<slug>.md');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new BacklogParseError(path, 'must start with a "---" frontmatter line');
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (close < 0) throw new BacklogParseError(path, 'the frontmatter has no closing "---" line');

  const raw = new Map<string, string | string[]>();
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z]+):(?:[^\S\r\n]+(.*))?$/.exec(line.trimEnd());
    if (!m) throw new BacklogParseError(path, `line ${i + 1}: expected "key: value", got ${JSON.stringify(line)}`);
    const key = m[1];
    if (!KEYS.has(key)) throw new BacklogParseError(path, `line ${i + 1}: unknown key ${key} (allowed: ${[...KEYS].join(', ')})`);
    if (raw.has(key)) throw new BacklogParseError(path, `line ${i + 1}: duplicate key ${key}`);
    const value = (m[2] ?? '').trim();
    if (value === '' && LIST_KEYS.has(key)) {
      const list: string[] = [];
      while (i + 1 < close && /^[^\S\r\n]+-[^\S\r\n]+/.test(lines[i + 1])) list.push(scalar(lines[++i].replace(/^[^\S\r\n]+-[^\S\r\n]+/, ''), path, i + 1));
      raw.set(key, list);
    } else if (value.startsWith('[')) {
      if (!LIST_KEYS.has(key)) throw new BacklogParseError(path, `line ${i + 1}: ${key} takes one value, not a list`);
      if (!value.endsWith(']')) throw new BacklogParseError(path, `line ${i + 1}: unclosed list for ${key}`);
      const inner = value.slice(1, -1).trim();
      raw.set(key, inner === '' ? [] : inner.split(',').map((v) => scalar(v, path, i + 1)));
    } else {
      if (value === '') throw new BacklogParseError(path, `line ${i + 1}: ${key} has no value`);
      raw.set(key, LIST_KEYS.has(key) ? [scalar(value, path, i + 1)] : scalar(value, path, i + 1));
    }
  }

  const one = (key: string): string | undefined => raw.get(key) as string | undefined;
  const list = (key: string): string[] => (raw.get(key) as string[] | undefined) ?? [];
  const title = one('title');
  if (title === undefined || !TITLE.test(title) || !title.trim()) throw new BacklogParseError(path, 'title is required (one line, up to 256 characters)');
  const state = one('state') ?? 'open';
  if (state !== 'open' && state !== 'closed') throw new BacklogParseError(path, `state must be open or closed, got ${JSON.stringify(state)}`);
  const labels = list('labels');
  const badLabel = labels.find((l) => !LABEL.test(l));
  if (badLabel !== undefined) throw new BacklogParseError(path, `label ${JSON.stringify(badLabel)} is not a plain name`);

  const body = lines.slice(close + 1).join('\n').replace(/^\n+/, '');
  const parentRaw = one('parent');
  const bodyParent = /^[^\S\r\n]*part of[^\S\r\n]+#(\d+)\b/im.exec(body)?.[1];
  const opt = (key: 'priority' | 'size') => (one(key) === undefined ? {} : { [key]: positive(one(key)!, key, path) });
  const fields: BacklogFields = {
    title,
    state,
    labels: [...new Set(labels)],
    dependsOn: [...new Set(list('dependsOn').map((d) => positive(d, 'dependsOn', path)))],
    ...(parentRaw !== undefined ? { parent: positive(parentRaw, 'parent', path) } : {}),
    ...opt('priority'),
    ...opt('size'),
  };
  const acceptance = acceptanceSectionOf(body);
  return {
    ...fields,
    id,
    path,
    dependsOn: [...new Set([...fields.dependsOn, ...bodyRefs(body, /^[^\S\r\n]*(?:depends on|blocked by)[^\S\r\n]+#(\d+)\b/gim)])],
    ...(fields.parent === undefined && bodyParent ? { parent: Number(bodyParent) } : {}),
    body,
    ...(acceptance ? { acceptance } : {}),
    fields,
  };
}

const quote = (s: string): string => JSON.stringify(s);
const plainLabel = (l: string): string => (/^[A-Za-z0-9._:/+-]+$/.test(l) ? l : quote(l));

/** Render a backlog file (frontmatter in a fixed key order, then the body). */
export function renderBacklogFile(fields: BacklogFields, body: string): string {
  if (!TITLE.test(fields.title) || !fields.title.trim()) throw new Error('local backlog: the title must be one line of up to 256 characters');
  const bad = fields.labels.find((l) => !LABEL.test(l));
  if (bad !== undefined) throw new Error(`local backlog: label ${JSON.stringify(bad)} is not a plain name`);
  const out = ['---', `title: ${quote(fields.title)}`, `state: ${fields.state}`];
  if (fields.labels.length > 0) out.push(`labels: [${fields.labels.map(plainLabel).join(', ')}]`);
  if (fields.dependsOn.length > 0) out.push(`dependsOn: [${fields.dependsOn.join(', ')}]`);
  if (fields.parent !== undefined) out.push(`parent: ${fields.parent}`);
  if (fields.priority !== undefined) out.push(`priority: ${fields.priority}`);
  if (fields.size !== undefined) out.push(`size: ${fields.size}`);
  out.push('---', '');
  return `${out.join('\n')}${body.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')}`;
}
