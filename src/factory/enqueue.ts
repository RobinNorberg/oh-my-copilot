/**
 * `omg factory enqueue --spec <id> --file <tickets.json> [--dry-run] [--json]`
 * (shipyard ↔ factory design §3.2-§3.4, PR 8; GitHub only, Azure DevOps is
 * PR 9): push launch's C3-approved tickets to the tracker as child items of
 * the spec, idempotently.
 *
 * - The ticket file is validated strictly (unknown fields, duplicate keys,
 *   `blockedBy` cycles, unknown references, AC count, rendered body length,
 *   all-vague AC); any refusal exits 2 before anything is written.
 * - Every item carries a `shipyard-key: <spec>/<key>` footer. A key counts
 *   only on an issue of the configured repository whose author is trusted and
 *   whose `Part of #<spec>` line names the spec; any other holder is ignored
 *   and reported, so an external issue cannot claim a key.
 * - Per key: missing → created; present and equal → unchanged (no write);
 *   present, changed and unclaimed → updated; claimed (closed, a factory run
 *   state, an open or merged `factory/issue-<n>` PR, or the branch on origin)
 *   → kept-claimed, never edited. A key in the tracker but not in the file is
 *   reported `orphaned` and never closed.
 * - `Blocked by #n` lines are written in a second pass, once every id is
 *   known; the spec body's `<!-- shipyard:tickets -->` task list is rewritten
 *   as one section.
 * - Model-written text is neutralized before it is posted from the user's
 *   account: @-mentions, cross-repository `owner/repo#n` references and issue
 *   or PR urls go into code spans (nobody is notified, no backlink appears),
 *   and `omg-plan:`, `shipyard-key:`, `Acceptance criteria` headings, edge,
 *   parent and task-list lines are escaped so they cannot become trusted
 *   plan, key or edge input.
 * - The mark step is `omg factory check --parent <spec> --mark --yes`: the C3
 *   signature covers it (design Q11), and with the intake label enqueue adds
 *   at create it is what makes the runnable children factory work.
 *
 * Writes go through the factory guard with a TrackerWriteContext (the 7a
 * shapes: `gh issue create|edit --repo … --body-file`, the key search); body
 * files sit in a fresh temporary directory outside the worktree. Every other
 * gh and git call is one of `omg factory check`'s read shapes. `--dry-run`
 * never sets the write mode, so the guard refuses any write it might reach.
 *
 * Exit codes: 0 enqueued (or planned), 1 a tracker read or write failed, or
 * the mark step did, 2 usage or a refused ticket file (nothing written), 5
 * incompatible (no forge, or a forge other than GitHub).
 */

import chalk from 'chalk';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, relative } from 'path';
import { ForgeConfigError, resolveForgeConfig } from '../forge/config.js';
import { ghRepoArg } from '../forge/github/gh.js';
import { shipyardKeyLine, type Forge, type ForgeItem, type ResolvedForgeConfig } from '../forge/types.js';
import { isPlainBranchName } from '../ship/config.js';
import { TRUSTED_READ_ENV, type Exec } from '../ship/exec.js';
import {
  baseLayer, CheckIncompatibleError, CheckUsageError, checkGuardExec, EXIT_CHECK_FAILED, fetchBase, parseItemId, runFactoryCheck,
  type CheckJson, type FactoryCheckDeps,
} from './check/cli.js';
import { isVague, type CheckBucket } from './check/rules.js';
import { plainText } from './check/score.js';
import { factoryForgeOptions } from './run/forge-roots.js';
import { factoryGuardExec, FactorySafetyError, MAX_TRACKER_BODY_CHARS, type TrackerWriteContext } from './run/exec.js';
import { factoryBranch, readFactoryState, TERMINAL_FACTORY_PHASES } from './run/state.js';

export const ENQUEUE_SCHEMA_VERSION = 1;
/** The most tickets one file may carry (one launch effort; each is a few gh calls). */
export const MAX_TICKETS = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const KEY = /^[a-z0-9-]{3,60}$/;
const TICKET_FIELDS = ['key', 'title', 'body', 'acceptance', 'blockedBy', 'priority'];
const PRIORITY_LABELS = ['priority:p0', 'priority:p1', 'priority:p2', 'priority:p3'];
export const EDGES_OPEN = '<!-- shipyard:edges -->';
export const EDGES_CLOSE = '<!-- /shipyard:edges -->';
export const TICKETS_OPEN = '<!-- shipyard:tickets -->';
export const TICKETS_CLOSE = '<!-- /shipyard:tickets -->';

export interface Ticket {
  key: string;
  title: string;
  body: string;
  acceptance: string[];
  /** Keys in the file, or `#<n>` for an existing item. */
  blockedBy: string[];
  /** 1..4 → the `priority:p<n-1>` label. */
  priority?: number;
}

export interface TicketFile {
  schemaVersion: 1;
  spec: number;
  tickets: Ticket[];
}

export type EnqueueAction = 'created' | 'updated' | 'unchanged' | 'kept-claimed' | 'orphaned';

export interface EnqueueRow {
  key: string;
  /** null for a ticket a dry run would create. */
  id: number | null;
  action: EnqueueAction;
  /** From the mark step's check; null on a dry run or when the check did not list the item. */
  bucket: CheckBucket | null;
  /** The claim for kept-claimed, else the check's reason codes. */
  reasons: string[];
  /** Dry run only: the exact write. */
  planned?: { title: string; body: string; addLabels: string[]; removeLabels: string[] };
}

export interface EnqueueJson {
  schemaVersion: number;
  ok: boolean;
  dryRun: boolean;
  spec: { id: number; taskList: 'unchanged' | 'updated'; planned?: string };
  items: EnqueueRow[];
  /** Key holders that do not count: untrusted author, or not a child of the spec. */
  ignored: Array<{ id: number; key: string; reason: string }>;
  mark: CheckJson['mark'] | null;
  warnings: string[];
}

export interface FactoryEnqueueOptions {
  spec: string;
  file: string;
  dryRun?: boolean;
  json?: boolean;
}

// ---------------------------------------------------------------- the file

/** Control characters other than tab and line breaks, and format characters (bidi overrides, zero-width). */
const BODY_CONTROL = /[\p{Cf}]|[^\P{Cc}\t\n\r]/u;
const LINE_CONTROL = /[\p{Cc}\p{Cf}]/u;

function fail(message: string): never {
  throw new CheckUsageError(`ticket file: ${message}`);
}

function line(v: unknown, where: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) fail(`${where} must be a non-empty string`);
  if (LINE_CONTROL.test(v)) fail(`${where} must be one line without control or format characters`);
  if (v.trim().length > max) fail(`${where} is longer than ${max} characters`);
  return v.trim();
}

/** Parse and validate a ticket file; CheckUsageError (exit 2) on the first problem. */
export function parseTicketFile(raw: unknown, maxAcceptanceItems: number): TicketFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('must be a JSON object');
  const top = raw as Record<string, unknown>;
  const extra = Object.keys(top).filter((k) => !['schemaVersion', 'spec', 'tickets'].includes(k));
  if (extra.length > 0) fail(`unknown field ${JSON.stringify(extra[0])}`);
  if (top.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (typeof top.spec !== 'number' || !Number.isInteger(top.spec) || top.spec <= 0) fail('spec must be a positive integer');
  if (!Array.isArray(top.tickets) || top.tickets.length === 0) fail('tickets must be a non-empty array');
  if (top.tickets.length > MAX_TICKETS) fail(`at most ${MAX_TICKETS} tickets`);

  const tickets = top.tickets.map((t, i): Ticket => {
    const at = `tickets[${i}]`;
    if (!t || typeof t !== 'object' || Array.isArray(t)) fail(`${at} must be an object`);
    const o = t as Record<string, unknown>;
    const unknown = Object.keys(o).find((k) => !TICKET_FIELDS.includes(k));
    if (unknown !== undefined) fail(`${at} has unknown field ${JSON.stringify(unknown)}`);
    if (typeof o.key !== 'string' || !KEY.test(o.key)) fail(`${at}.key must match [a-z0-9-]{3,60}`);
    const title = line(o.title, `${at}.title`, 200);
    if (title.startsWith('-')) fail(`${at}.title must not start with "-"`);
    if (typeof o.body !== 'string') fail(`${at}.body must be a string`);
    if (BODY_CONTROL.test(o.body)) fail(`${at}.body has control or format characters`);
    if (!Array.isArray(o.acceptance) || o.acceptance.length === 0) fail(`${at}.acceptance must be a non-empty array`);
    if (o.acceptance.length > maxAcceptanceItems) fail(`${at}.acceptance has ${o.acceptance.length} items (factory.check.maxAcceptanceItems is ${maxAcceptanceItems})`);
    const acceptance = o.acceptance.map((a, j) => line(a, `${at}.acceptance[${j}]`, 500));
    if (acceptance.every(isVague)) fail(`${at}.acceptance: every item is vague and names nothing concrete (name the contract in backticks)`);
    const blockedBy = o.blockedBy === undefined ? [] : o.blockedBy;
    if (!Array.isArray(blockedBy) || blockedBy.some((b) => typeof b !== 'string')) fail(`${at}.blockedBy must be an array of strings`);
    if (new Set(blockedBy).size !== blockedBy.length) fail(`${at}.blockedBy lists an edge twice`);
    if (o.priority !== undefined && (typeof o.priority !== 'number' || !Number.isInteger(o.priority) || o.priority < 1 || o.priority > 4)) {
      fail(`${at}.priority must be an integer 1..4`);
    }
    return { key: o.key, title, body: o.body, acceptance, blockedBy: blockedBy as string[], ...(o.priority !== undefined ? { priority: o.priority as number } : {}) };
  });

  const keys = new Set<string>();
  for (const t of tickets) {
    if (keys.has(t.key)) fail(`duplicate key ${t.key}`);
    keys.add(t.key);
  }
  for (const t of tickets) {
    for (const b of t.blockedBy) {
      if (keys.has(b)) continue;
      if (!/^#\d+$/.test(b) || Number(b.slice(1)) <= 0) fail(`${t.key}.blockedBy ${JSON.stringify(b)} is neither a key in this file nor #<n>`);
      if (Number(b.slice(1)) === top.spec) fail(`${t.key} cannot be blocked by its spec #${top.spec}`);
    }
  }
  const cycle = findCycle(tickets);
  if (cycle) fail(`blockedBy cycle: ${cycle.join(' -> ')}`);
  return { schemaVersion: 1, spec: top.spec, tickets };
}

/** A `blockedBy` cycle among the file's keys as the path that closes it, or null. */
export function findCycle(tickets: readonly Ticket[]): string[] | null {
  const edges = new Map(tickets.map((t) => [t.key, t.blockedBy.filter((b) => !b.startsWith('#'))]));
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (key: string): string[] | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'open') return [...path.slice(path.indexOf(key)), key];
    state.set(key, 'open');
    path.push(key);
    for (const next of edges.get(key) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(key, 'done');
    return null;
  };
  for (const t of tickets) {
    const found = visit(t.key);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------- rendering

/**
 * Escape what the factory reads as trusted input when an item's author is
 * trusted, as enqueue's items are: the `omg-plan:` link, the `shipyard-key:`
 * footer, an `Acceptance criteria` heading, `Depends on|Blocked by|Part of
 * #n` lines and task-list `- [ ] #n` children (src/forge/github/tracker.ts,
 * src/factory/run/plan-rules.ts). The backslashes render as nothing.
 */
export function neutralizeTrusted(text: string): string {
  return text
    .replace(/(omg-plan|shipyard-key):/gi, '$1\\:')
    .replace(/^([^\S\r\n]*)(#{1,6}[^\S\r\n]*acceptance criteria)/gim, '$1\\$2')
    .replace(/^([^\S\r\n]*(?:depends on|blocked by|part of)[^\S\r\n]+)#(?=\d)/gim, '$1\\#')
    .replace(/^([^\S\r\n]*[-*][^\S\r\n]+\[[ xX]\][^\S\r\n]+)#(?=\d)/gm, '$1\\#');
}

/** An issue/PR/discussion url, an @-mention (user or org/team), or a cross-repository `owner/repo#n`. */
const NOTIFYING = /https?:\/\/[^\s/<>()`]+\/[^\s/<>()`]+\/[^\s/<>()`]+\/(?:issues|pull|discussions)\/\d+|(?<![A-Za-z0-9_])@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?|(?<![\w./-])[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+#\d+/g;

/**
 * Put every mention and cross-reference in a code span, so posting the text
 * notifies nobody and leaves no backlink. The span's backtick run is one
 * longer than any run in the text, so it pairs only with itself (CommonMark
 * code spans close on a run of the same length); a backtick right next to it
 * gets a space so the runs never merge. Inside an existing code span or
 * block it shows as literal backticks, which is harmless.
 */
export function neutralizeNotifying(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const tick = '`'.repeat(longest + 1);
  return text.replace(NOTIFYING, (m: string, at: number, s: string) =>
    `${s[at - 1] === '`' ? ' ' : ''}${tick}${m}${tick}${s[at + m.length] === '`' ? ' ' : ''}`);
}

const modelText = (s: string): string => neutralizeTrusted(neutralizeNotifying(s));

/** The item title as posted. */
export const renderTitle = (t: Ticket): string => neutralizeNotifying(t.title);

/** The item body (design §3.3): the ticket body, the AC list, the edges section, the key footer. `edges` are `#<n>` refs. */
export function renderTicketBody(spec: number, t: Ticket, edges: readonly string[]): string {
  const body = modelText(t.body).trim();
  return [
    ...(body ? [body, ''] : []),
    '## Acceptance criteria',
    '',
    ...t.acceptance.map((a) => neutralizeTrusted(`- [ ] ${neutralizeNotifying(a)}`)),
    '',
    EDGES_OPEN,
    `Part of #${spec}`,
    ...edges.map((e) => `Blocked by ${e}`),
    EDGES_CLOSE,
    '',
    shipyardKeyLine(spec, t.key),
    '',
  ].join('\n');
}

const normalized = (s: string): string => s.replace(/\r\n/g, '\n').trimEnd();

/**
 * The spec body with its `<!-- shipyard:tickets -->` task list set to
 * `children` (appended when absent); a box already ticked stays ticked.
 * Throws CheckUsageError when the section markers are not one ordered pair.
 */
export function specBodyWithTickets(body: string, children: readonly number[]): string {
  const opens = body.split(TICKETS_OPEN).length - 1;
  const closes = body.split(TICKETS_CLOSE).length - 1;
  const start = body.indexOf(TICKETS_OPEN);
  const end = body.indexOf(TICKETS_CLOSE);
  if (opens !== closes || opens > 1 || (opens === 1 && end < start)) {
    throw new CheckUsageError(`the spec body's ${TICKETS_OPEN} section is malformed; fix it by hand`);
  }
  const old = opens === 1 ? body.slice(start + TICKETS_OPEN.length, end) : '';
  const ticked = new Set([...old.matchAll(/^- \[[xX]\] #(\d+)\r?$/gm)].map((m) => Number(m[1])));
  const section = [TICKETS_OPEN, ...children.map((id) => `- [${ticked.has(id) ? 'x' : ' '}] #${id}`), TICKETS_CLOSE].join('\n');
  if (opens === 1) return body.slice(0, start) + section + body.slice(end + TICKETS_CLOSE.length);
  return `${body.trimEnd()}${body.trim() ? '\n\n' : ''}${section}\n`;
}

// ---------------------------------------------------------------- the guard

/**
 * enqueue's Exec: the key search, and while `writing()` the issue create and
 * edit, go through the factory guard with the TrackerWriteContext (PR 7a's
 * exact shapes); every other gh and git call through `omg factory check`'s
 * read-only guard. Nothing else runs.
 */
export function enqueueGuardExec(exec: Exec, writes: () => TrackerWriteContext | undefined, writing: () => boolean): Exec {
  const reads = checkGuardExec(exec);
  const tracker = factoryGuardExec(exec, () => [], () => undefined, writes);
  return (cmd, args, opts) => {
    const file = cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
    if (file === 'gh' && args[0] === 'issue') {
      if (args[1] === 'list' && args[2] === '--repo') return tracker(cmd, args, opts);
      if (writing() && (args[1] === 'create' || (args[1] === 'edit' && args[3] === '--repo'))) return tracker(cmd, args, opts);
    }
    if (file === 'gh' || file === 'git') return reads(cmd, args, opts);
    throw new FactorySafetyError(`omg factory enqueue refuses \`${file} ${args.join(' ')}\`: not a command omg factory enqueue runs`);
  };
}

// ---------------------------------------------------------------- the run

interface Planned {
  ticket: Ticket;
  item?: ForgeItem;
  action: EnqueueAction;
  reasons: string[];
  title: string;
  labels: string[];
  addLabels: string[];
  removeLabels: string[];
}

/** Why an existing item must not be edited: closed, or what `omg factory check` reads as an active or finished run. */
function claimOf(forge: Forge, root: string, base: string, item: ForgeItem, remoteBranch: (branch: string) => boolean): string | undefined {
  if (!item.open) return 'closed';
  try {
    const run = readFactoryState(root, item.id);
    if (run) return TERMINAL_FACTORY_PHASES.includes(run.phase) ? `run-finished:${run.phase}` : `run-active:${run.phase}`;
    const branch = factoryBranch(item.id);
    if (forge.reviews.findOpenPrForBranch(branch) !== undefined) return 'pr-exists';
    if (forge.reviews.findMergedPrForBranch(branch, base) !== undefined) return 'merged';
    return remoteBranch(branch) ? 'branch-exists' : undefined;
  } catch (error) {
    // An unreadable claim is a claim: never edit an item that may be under a running engine.
    return `claim-unknown: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function git(exec: Exec, root: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = exec('git', args, { cwd: root, env: TRUSTED_READ_ENV });
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim().split('\n')[0] ?? '' };
}

function readTicketFile(path: string, maxAcceptanceItems: number): TicketFile {
  if (!existsSync(path) || !statSync(path).isFile()) throw new CheckUsageError(`--file ${path} is not a file`);
  if (statSync(path).size > MAX_FILE_BYTES) throw new CheckUsageError(`--file ${path} is larger than ${MAX_FILE_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CheckUsageError(`--file ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseTicketFile(raw, maxAcceptanceItems);
}

/** Run one enqueue; returns the exit code. Usage and incompatible errors propagate (exit 2 / 5 at the CLI). */
export async function runFactoryEnqueue(o: FactoryEnqueueOptions, deps: FactoryCheckDeps): Promise<number> {
  const specId = parseItemId(o.spec);
  const warnings: string[] = [];
  let ctx: TrackerWriteContext | undefined;
  let writing = false;
  const exec = enqueueGuardExec(deps.exec, () => ctx, () => writing);

  const top = git(exec, process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new CheckUsageError('omg factory enqueue must run inside a git repository');
  const root = top.out;
  const origin = git(exec, root, ['remote', 'get-url', 'origin']);
  if (!origin.ok) throw new CheckIncompatibleError(`git remote get-url origin failed: ${origin.err}`);
  const base = deps.base(root);
  if (!isPlainBranchName(base)) throw new CheckUsageError(`base ${JSON.stringify(base)} is not a branch name`);
  const baseSha = fetchBase(exec, root, base, warnings);
  const trustedUser = deps.trustedUser();
  let config: ResolvedForgeConfig;
  try {
    const loaded = resolveForgeConfig(trustedUser, baseLayer(exec, root, base, baseSha, trustedUser, warnings), deps.projectConfig(root), origin.out);
    config = loaded.config;
    warnings.push(...loaded.warnings);
  } catch (error) {
    if (!(error instanceof ForgeConfigError)) throw error;
    throw error.code === 'invalid' ? new CheckUsageError(error.message) : new CheckIncompatibleError(`${error.code}: ${error.message}`);
  }
  if (config.kind !== 'github') throw new CheckIncompatibleError(`omg factory enqueue supports GitHub only for now; the forge is ${config.kind}`);

  const file = readTicketFile(o.file, config.check.maxAcceptanceItems);
  if (file.spec !== specId) throw new CheckUsageError(`--spec ${specId} does not match the ticket file's spec ${file.spec}`);

  const source = config.intake.source;
  const intakeLabel = source?.type === 'label' ? source.label : undefined;
  if (!intakeLabel) warnings.push('factory.intake.source is not a label: the items are not added to the intake source (omg factory check --parent still lists them)');
  ctx = { repo: ghRepoArg(config.repo), bodyDir: '', labels: [...(intakeLabel ? [intakeLabel] : []), ...PRIORITY_LABELS] };

  let forge: Forge;
  try {
    forge = deps.createForge(exec, root, config, factoryForgeOptions(root));
  } catch (error) {
    throw new CheckIncompatibleError(error instanceof Error ? error.message : String(error));
  }
  const tracker = forge.tracker;
  if (!tracker.findByKey || !tracker.createItem || !tracker.updateItem) throw new CheckIncompatibleError(`the ${config.kind} tracker cannot write items`);
  const remoteBranch = (branch: string): boolean => {
    const res = git(exec, root, ['ls-remote', 'origin', `refs/heads/${branch}`]);
    if (!res.ok) throw new Error(`git ls-remote origin refs/heads/${branch} failed: ${res.err}`);
    return res.out.length > 0;
  };

  // The spec: an open issue of this repository.
  let spec: ForgeItem;
  try {
    spec = tracker.viewItem(specId);
  } catch (error) {
    throw new CheckUsageError(`spec #${specId} cannot be read as an issue of ${config.repo.url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (spec.repoUrl.toLowerCase() !== config.repo.url.toLowerCase()) throw new CheckUsageError(`spec #${specId} is not an issue of ${config.repo.url}`);
  if (!spec.open) throw new CheckUsageError(`spec #${specId} is closed`);

  // Key holders: trusted children of the spec only.
  const holders = new Map<string, ForgeItem>();
  const ignored: EnqueueJson['ignored'] = [];
  for (const { key, item } of tracker.findByKey(specId)) {
    if (!item.authorTrusted) ignored.push({ id: item.id, key, reason: 'author is not trusted' });
    else if (item.parent !== specId) ignored.push({ id: item.id, key, reason: `not a child of #${specId}` });
    else if (holders.has(key)) throw new CheckUsageError(`key ${key} is held by #${holders.get(key)!.id} and #${item.id}; close one by hand`);
    else holders.set(key, item);
  }

  // `#n` edges must name existing items.
  for (const ref of new Set(file.tickets.flatMap((t) => t.blockedBy.filter((b) => b.startsWith('#'))))) {
    try {
      tracker.viewItem(Number(ref.slice(1)));
    } catch {
      throw new CheckUsageError(`blockedBy ${ref} is not an issue of ${config.repo.url}`);
    }
  }

  const ids = new Map<string, number>([...holders].map(([k, item]) => [k, item.id]));
  const ref = (b: string, known: ReadonlyMap<string, number>): string | undefined => (b.startsWith('#') ? b : known.has(b) ? `#${known.get(b)}` : undefined);
  /** The full edge list; a key without an id yet shows as `#<key>` (dry run only). */
  const edgesOf = (t: Ticket, known: ReadonlyMap<string, number>) => t.blockedBy.map((b) => ref(b, known) ?? `#${b}`);

  const planned: Planned[] = file.tickets.map((t) => {
    const item = holders.get(t.key);
    const title = renderTitle(t);
    if (title.length > 256) throw new CheckUsageError(`${t.key}: the title is longer than 256 characters once mentions are neutralized`);
    const body = renderTicketBody(specId, t, edgesOf(t, ids));
    if (body.length > config.check.maxBodyChars) throw new CheckUsageError(`${t.key}: the rendered body is ${body.length} characters (factory.check.maxBodyChars is ${config.check.maxBodyChars})`);
    const labels = [...(intakeLabel ? [intakeLabel] : []), ...(t.priority ? [PRIORITY_LABELS[t.priority - 1]] : [])];
    if (!item) return { ticket: t, action: 'created', reasons: [], title, labels, addLabels: labels, removeLabels: [] };
    const has = (l: string) => item.labels.some((x) => x.toLowerCase() === l.toLowerCase());
    const addLabels = labels.filter((l) => !has(l));
    const removeLabels = PRIORITY_LABELS.filter((l) => !labels.includes(l) && item.labels.includes(l)).slice(0, Math.max(0, 4 - addLabels.length));
    const claim = claimOf(forge, root, base, item, remoteBranch);
    if (claim) return { ticket: t, item, action: 'kept-claimed', reasons: [claim], title, labels, addLabels: [], removeLabels: [] };
    const pending = t.blockedBy.some((b) => ref(b, ids) === undefined);
    const same = !pending && item.title === title && normalized(item.body) === normalized(body) && addLabels.length === 0 && removeLabels.length === 0;
    return { ticket: t, item, action: same ? 'unchanged' : 'updated', reasons: [], title, labels, addLabels, removeLabels };
  });
  const fileKeys = new Set(file.tickets.map((t) => t.key));
  const orphans = [...holders].filter(([k]) => !fileKeys.has(k)).map(([, item]) => item).sort((a, b) => a.id - b.id);
  const specBody = (known: ReadonlyMap<string, number>) => specBodyWithTickets(spec.body, [
    ...file.tickets.map((t) => known.get(t.key)).filter((id): id is number => id !== undefined),
    ...orphans.map((i) => i.id),
  ]);
  const orphanRows = orphans.map((item): EnqueueRow => ({ key: [...holders].find(([, i]) => i === item)![0], id: item.id, action: 'orphaned', bucket: null, reasons: [] }));

  const newKeys = planned.filter((p) => p.action === 'created').map((p) => p.ticket.key);
  // Each new child adds one `- [ ] #<id>` line; refuse now rather than after the creates.
  if (specBody(ids).length + newKeys.length * 20 > MAX_TRACKER_BODY_CHARS) throw new CheckUsageError(`spec #${specId}'s body would exceed ${MAX_TRACKER_BODY_CHARS} characters with the task list`);

  if (o.dryRun) {
    // Ids a create would assign are unknown: the planned spec body lists the known ones and names the new keys.
    const taskList = newKeys.length > 0 || normalized(specBody(ids)) !== normalized(spec.body) ? 'updated' : 'unchanged';
    const specPlanned = `${specBody(ids)}${newKeys.length > 0 ? `\n(plus the new ${newKeys.join(', ')} once created)` : ''}`;
    const rows: EnqueueRow[] = [
      ...planned.map((p): EnqueueRow => ({
        key: p.ticket.key,
        id: p.item?.id ?? null,
        action: p.action,
        bucket: null,
        reasons: p.reasons,
        ...(p.action === 'created' || p.action === 'updated'
          ? { planned: { title: p.title, body: renderTicketBody(specId, p.ticket, edgesOf(p.ticket, ids)), addLabels: p.addLabels, removeLabels: p.removeLabels } }
          : {}),
      })),
      ...orphanRows,
    ];
    report(o, deps, { schemaVersion: ENQUEUE_SCHEMA_VERSION, ok: true, dryRun: true, spec: { id: specId, taskList, ...(taskList === 'updated' ? { planned: specPlanned } : {}) }, items: rows, ignored, mark: null, warnings });
    return 0;
  }

  // The writes: body files in a fresh directory outside the worktree (the guard reads its own copy of each).
  const bodyDir = mkdtempSync(join(tmpdir(), 'omg-enqueue-'));
  const rel = relative(root, bodyDir);
  const rows: EnqueueRow[] = [];
  let taskList: 'unchanged' | 'updated' = 'unchanged';
  let failed = false;
  try {
    if (!rel.startsWith('..') && !isAbsolute(rel)) throw new CheckIncompatibleError(`the temporary directory ${bodyDir} is inside the worktree ${root}; set TMPDIR elsewhere`);
    ctx = { ...ctx, bodyDir };
    writing = true;
    let n = 0;
    const bodyFile = (name: string, text: string): string => {
      const path = join(bodyDir, `${++n}-${name}.md`);
      writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
      return path;
    };
    const written = new Map<string, string>();
    try {
      // Pass 1: create the missing items with the edges already known.
      for (const p of planned.filter((x) => x.action === 'created')) {
        const body = renderTicketBody(specId, p.ticket, p.ticket.blockedBy.map((b) => ref(b, ids)).filter((r): r is string => r !== undefined));
        ids.set(p.ticket.key, tracker.createItem({ title: p.title, bodyFile: bodyFile(p.ticket.key, body), labels: p.labels }));
        written.set(p.ticket.key, body);
      }
      // Pass 2: every edge is known now; rewrite the created items that missed one, and update the changed ones.
      for (const p of planned) {
        if (p.action !== 'created' && p.action !== 'updated') continue;
        const body = renderTicketBody(specId, p.ticket, edgesOf(p.ticket, ids));
        if (p.action === 'created' && written.get(p.ticket.key) === body) continue;
        tracker.updateItem(ids.get(p.ticket.key)!, {
          title: p.title,
          bodyFile: bodyFile(p.ticket.key, body),
          // A created item got its labels at create.
          addLabels: p.action === 'updated' ? p.addLabels : [],
          removeLabels: p.removeLabels,
        });
      }
      // The spec's task list, which `omg factory check --parent` reads.
      const next = specBody(ids);
      if (normalized(next) !== normalized(spec.body)) {
        tracker.updateItem(specId, { title: spec.title, bodyFile: bodyFile(`spec-${specId}`, next), addLabels: [], removeLabels: [] });
        taskList = 'updated';
      }
    } catch (error) {
      failed = true;
      warnings.push(`write failed (re-run enqueue to finish; it is idempotent): ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      writing = false;
    }
  } finally {
    rmSync(bodyDir, { recursive: true, force: true });
  }
  for (const p of planned) rows.push({ key: p.ticket.key, id: ids.get(p.ticket.key) ?? null, action: p.action, bucket: null, reasons: p.reasons });
  rows.push(...orphanRows);

  // The mark step: `omg factory check --parent <spec> --mark --yes` (the C3 signature covers it).
  let mark: CheckJson['mark'] | null = null;
  if (!failed) {
    const captured: string[] = [];
    try {
      const code = await runFactoryCheck({ ids: [], parent: String(specId), mark: true, yes: true, json: true }, { ...deps, out: (l) => captured.push(l), err: (l) => captured.push(l) });
      const json = JSON.parse(captured.join('\n')) as CheckJson;
      mark = json.mark;
      for (const r of rows) {
        const hit = json.items.find((i) => i.id === r.id);
        if (!hit) continue;
        r.bucket = hit.bucket;
        if (r.action !== 'kept-claimed') r.reasons = hit.reasons;
      }
      if (code !== 0) {
        failed = true;
        warnings.push(`mark step: omg factory check --parent ${specId} --mark exited ${code}`);
      }
    } catch (error) {
      failed = true;
      warnings.push(`mark step failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  report(o, deps, { schemaVersion: ENQUEUE_SCHEMA_VERSION, ok: !failed, dryRun: false, spec: { id: specId, taskList }, items: rows, ignored, mark, warnings });
  return failed ? EXIT_CHECK_FAILED : 0;
}

function report(o: FactoryEnqueueOptions, deps: FactoryCheckDeps, json: EnqueueJson): void {
  if (o.json) {
    deps.out(JSON.stringify({ ...json, warnings: json.warnings.map(plainText) }, null, 2));
    return;
  }
  for (const w of json.warnings) deps.err(chalk.yellow(plainText(w)));
  const rows = json.items.map((r) => [r.key, r.id === null ? '(new)' : `#${r.id}`, r.action, r.bucket ?? '-', r.reasons[0] ?? '']);
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((row) => row[i].length), ['KEY', 'ID', 'ACTION', 'BUCKET'][i].length));
  const pad = (row: string[]) => row.slice(0, 4).map((c, i) => c.padEnd(widths[i])).join('  ');
  deps.out(chalk.bold(`${pad(['KEY', 'ID', 'ACTION', 'BUCKET'])}  REASON`));
  for (const row of rows) deps.out(`${pad(row)}  ${plainText(row[4])}`);
  for (const i of json.ignored) deps.err(chalk.yellow(`ignored #${i.id} (key ${i.key}): ${i.reason}`));
  deps.out(`spec #${json.spec.id} task list: ${json.spec.taskList}`);
  if (json.dryRun) {
    deps.out(chalk.bold('dry run: nothing was written. The writes:'));
    for (const r of json.items.filter((x) => x.planned)) {
      const p = r.planned!;
      const labels = [...p.addLabels.map((l) => `+${l}`), ...p.removeLabels.map((l) => `-${l}`)].join(' ');
      deps.out(`\n== ${r.action === 'created' ? 'create' : `edit #${r.id}`} ${r.key}: ${JSON.stringify(p.title)}${labels ? ` [${labels}]` : ''}`);
      deps.out(p.body);
    }
    if (json.spec.planned) deps.out(`\n== edit spec #${json.spec.id} body:\n${json.spec.planned}`);
  } else if (json.mark) {
    if (json.mark.marked.length > 0) deps.out(chalk.green(`marked ${json.mark.marker}: ${json.mark.marked.map((id) => `#${id}`).join(', ')}`));
  }
}
