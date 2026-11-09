/**
 * The local forge's tracker (offline forge plan §1.1): the backlog directory.
 * A run reads items at the verified base commit (`git ls-tree` + `git show`
 * through the caller's guarded Exec), so they are authorTrusted. With
 * `workingTree` (check, board, enqueue) it also reads the files on disk: an
 * item that is missing from, or differs at, the base commit is `uncommitted`
 * and untrusted. Comments and progress are written for the human under
 * `.omg/factory/local/items/<id>/`; enqueue writes backlog files that the
 * human commits.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { Exec } from '../../ship/exec.js';
import {
  shipyardKeys,
  type ForgeItem,
  type ForgeItemDraft,
  type ForgeItemUpdate,
  type ForgePeek,
  type ForgeTracker,
  type ForgeTriageChange,
  type IntakeSource,
  type LocalTrackerOptions,
  type ProgressMapping,
  type ProgressStage,
} from '../types.js';
import { acceptanceSectionOf, backlogFileId, backlogSlug, BacklogParseError, parseBacklogFile, renderBacklogFile, type BacklogItem } from './backlog.js';
import { backlogListArgs, backlogShowArgs, lastStateChangeArgs, mergedArgs } from './mirror.js';
import { appendNoFollow, noLinkPath, writeAtomic } from './store.js';

const TRUSTED_READ_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_NO_REPLACE_OBJECTS: '1' });
const HEX40 = /^[0-9a-f]{40}$/;
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

export interface LocalTrackerContext {
  exec: Exec;
  root: string;
  /** factory.forge.local.backlogDir (repo-relative, `/`-separated). */
  backlogDir: string;
  /** ForgeItem.repoUrl (the mirror). */
  repoUrl: string;
  /** `<omgRoot>/factory/local` (ForgeOptions.local.omgRoot). */
  humanDir: string;
  options: LocalTrackerOptions;
  /** enqueue's body directory: createItem/updateItem read a body file only directly in it. */
  trackerBodyDir?: string;
  /**
   * F31: the item's merged local PR in the engine-owned PR store, if any. An
   * item whose PR merged reads as closed (as a GitHub issue closes at the
   * merge), while its backlog file still says `state: open` until the human
   * commits the change; a warning names the file. `mergedHead` is the PR
   * head the merge was detected at: a later commit on the base that changes
   * the file's `state:` line (a reopen) wins over the merge; other edits do not.
   * The pickaxe (`-G^state:`) also matches a body line that starts with `state:`, so a hit counts only when the parsed
   * `state` differs between the hit and its parent.
   */
  mergedPr?: (id: number) => { number: number; mergedHead?: string } | undefined;
}

interface Entry {
  item: BacklogItem;
  trusted: boolean;
  uncommitted: boolean;
  /** The working-tree file, when there is one. */
  file?: string;
}

/** Index items by id; two files with one id is an error naming both. */
function byId(items: BacklogItem[]): Map<number, BacklogItem> {
  const map = new Map<number, BacklogItem>();
  for (const item of items) {
    const prior = map.get(item.id);
    if (prior) throw new BacklogParseError(item.path, `id ${item.id} is also used by ${prior.path}`);
    map.set(item.id, item);
  }
  return map;
}

export function localTracker(ctx: LocalTrackerContext): ForgeTracker {
  const committedCache = new Map<string, { items: Map<number, BacklogItem>; text: Map<string, string> }>();
  /** Committed backlog files that did not parse (skipped, so one bad file does not block intake). */
  const warnings: string[] = [];
  /** The runtime root (`humanDir` is `<omgRoot>/factory/local`): no link below it is followed. */
  const omgRoot = join(ctx.humanDir, '..', '..');
  const git = (args: string[]): string => {
    const r = ctx.exec('git', args, { cwd: ctx.root, env: TRUSTED_READ_ENV });
    if (r.status !== 0) throw new Error(`local backlog: git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
  };

  /** The items committed at `sha`, with each file's text (cached per sha). */
  const committed = (sha: string) => {
    const cached = committedCache.get(sha);
    if (cached) return cached;
    const text = new Map<string, string>();
    const items: BacklogItem[] = [];
    for (const path of git(backlogListArgs(sha, ctx.backlogDir)).split('\0').filter(Boolean)) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (path !== `${ctx.backlogDir}/${name}` || backlogFileId(name) === undefined) continue;
      const body = git(backlogShowArgs(sha, path));
      text.set(path, lf(body));
      try {
        items.push(parseBacklogFile(path, body));
      } catch (err) {
        if (!(err instanceof BacklogParseError)) throw err;
        warnings.push(`local backlog: skipped ${err.message}`);
      }
    }
    const result = { items: byId(items), text };
    committedCache.set(sha, result);
    return result;
  };

  const dirOnDisk = (): string => join(ctx.root, ...ctx.backlogDir.split('/'));

  /** The working-tree items (regular files only; a symlink is never followed, at any level below the root). */
  const scanWorking = (): { out: Array<{ item: BacklogItem; text: string; file: string }>; skipped: Map<number, string> } => {
    const dir = dirOnDisk();
    const out: Array<{ item: BacklogItem; text: string; file: string }> = [];
    const skipped = new Map<number, string>();
    if (!noLinkPath(ctx.root, dir, false, true) || !existsSync(dir) || !lstatSync(dir).isDirectory()) return { out, skipped };
    for (const name of readdirSync(dir).sort()) {
      if (backlogFileId(name) === undefined) continue;
      const file = join(dir, name);
      if (!lstatSync(file).isFile()) continue;
      const text = readFileSync(file, 'utf8');
      try {
        out.push({ item: parseBacklogFile(`${ctx.backlogDir}/${name}`, text), text: lf(text), file });
      } catch (err) {
        // As for a committed file: one malformed file does not block the rest of the backlog.
        if (!(err instanceof BacklogParseError)) throw err;
        // The id of a skipped file stays taken: the file is never rewritten and its id never handed out again.
        skipped.set(backlogFileId(name) as number, name);
        const warning = `local backlog: skipped ${err.message}`;
        if (!warnings.includes(warning)) warnings.push(warning);
      }
    }
    return { out, skipped };
  };
  const working = (): Array<{ item: BacklogItem; text: string; file: string }> => scanWorking().out;

  const baseSha = (): string | undefined => {
    const sha = ctx.options.baseSha?.();
    if (sha !== undefined && !HEX40.test(sha)) throw new Error(`local backlog: base commit ${JSON.stringify(sha)} is not a 40-hex sha`);
    return sha;
  };

  /** Every item, per the options: committed (trusted) and, with workingTree, the files on disk. */
  const entries = (): Map<number, Entry> => {
    const sha = baseSha();
    if (!sha && !ctx.options.workingTree) throw new Error('local backlog: the base commit is not known yet, so committed items cannot be read');
    const base = sha ? committed(sha) : undefined;
    const out = new Map<number, Entry>();
    for (const item of base?.items.values() ?? []) out.set(item.id, { item, trusted: true, uncommitted: false });
    if (ctx.options.workingTree) {
      const disk = working();
      byId(disk.map((d) => d.item));
      for (const d of disk) {
        const same = base?.text.get(d.item.path) === d.text;
        const prior = out.get(d.item.id);
        if (same && prior) {
          out.set(d.item.id, { ...prior, file: d.file });
        } else {
          out.set(d.item.id, { item: d.item, trusted: false, uncommitted: true, file: d.file });
        }
      }
    }
    return out;
  };

  /**
   * Whether the base reopened `path` after the merge of `mergedHead`: the
   * last commit on the base whose own diff changed the file's `state:` line
   * descends from the merged head. Any other edit of the file after the merge
   * (body, labels, a merge commit), a state change on the base before the
   * merge, or one of the PR's own commits keeps the merge. Unknown (no base
   * commit, no head, git cannot tell) keeps the merge too.
   */
  const changedAfter = new Map<string, boolean>();
  const changedAfterMerge = (path: string, mergedHead: string | undefined): boolean => {
    const sha = baseSha();
    if (!sha || !mergedHead || !HEX40.test(mergedHead)) return false;
    const key = `${sha}:${mergedHead}:${path}`;
    const known = changedAfter.get(key);
    if (known !== undefined) return known;
    // The pickaxe also matches a body line starting with `state:` and (defensively) a merge: only a single-parent
    // commit whose own parsed `state` differs from its parent's is a reopen. A body-line hit says nothing about
    // earlier commits, so the search resumes from its parent (the same log shape) until the merged head is reached.
    const stateAt = (commit: string): string | undefined => {
      const r = ctx.exec('git', backlogShowArgs(commit, path), { cwd: ctx.root, env: TRUSTED_READ_ENV });
      if (r.status !== 0) return undefined;
      try {
        return parseBacklogFile(path, r.stdout).state;
      } catch {
        return undefined;
      }
    };
    let after = false;
    let from = sha;
    for (let i = 0; i < 50 && !after; i++) {
      const [last = '', ...parents] = git(lastStateChangeArgs(from, path)).trim().split(/\s+/);
      if (!HEX40.test(last) || last === mergedHead || ctx.exec('git', mergedArgs(mergedHead, last), { cwd: ctx.root, env: TRUSTED_READ_ENV }).status !== 0) break;
      if (parents.length !== 1 || !HEX40.test(parents[0])) break;
      if (stateAt(last) !== stateAt(parents[0])) after = true;
      else from = parents[0];
    }
    changedAfter.set(key, after);
    return after;
  };

  /** The merged local PR of an item whose file still says open (F31), with a warning naming the file to change. */
  const mergedOpen = (item: BacklogItem): number | undefined => {
    if (item.state !== 'open') return undefined;
    const merged = ctx.mergedPr?.(item.id);
    const pr = merged === undefined || changedAfterMerge(item.path, merged.mergedHead) ? undefined : merged.number;
    const warning = pr === undefined ? undefined : `local backlog: #${item.id} is merged (local PR #${pr}) but ${item.path} still says state: open; set state: closed there and commit it on the base branch (to reopen #${item.id} later, commit state: open again after that: only a change of the state: line after the merge reopens it)`;
    if (warning !== undefined && !warnings.includes(warning)) warnings.push(warning);
    return pr;
  };

  const toForgeItem = (e: Entry, all: Map<number, Entry>): ForgeItem => {
    const merged = mergedOpen(e.item);
    return {
      id: e.item.id,
      url: e.item.path,
      title: e.item.title,
      body: e.item.body,
      ...(e.item.acceptance ? { acceptance: e.item.acceptance } : {}),
      open: e.item.state === 'open' && merged === undefined,
      rawState: merged === undefined ? e.item.state : `merged (local PR #${merged})`,
      authorTrusted: e.trusted,
      comments: [],
      labels: e.item.labels,
      ...(e.item.priority === undefined ? {} : { priority: e.item.priority }),
      ...(e.item.size === undefined ? {} : { size: e.item.size }),
      dependsOn: e.item.dependsOn,
      children: [...all.values()].filter((c) => c.item.parent === e.item.id).map((c) => c.item.id).sort((a, b) => a - b),
      ...(e.item.parent === undefined ? {} : { parent: e.item.parent }),
      repoUrl: ctx.repoUrl,
      ...(e.uncommitted ? { uncommitted: true as const } : {}),
    };
  };

  const view = (id: number): ForgeItem => {
    const all = entries();
    const e = all.get(id);
    if (!e) throw new Error(`local backlog item #${id} is not in ${ctx.backlogDir}${ctx.options.workingTree ? '' : ` at ${baseSha()}`}`);
    return toForgeItem(e, all);
  };

  const itemDir = (id: number): string => join(ctx.humanDir, 'items', String(id));

  /** A body file enqueue wrote: directly in trackerBodyDir when that is set. */
  const readBody = (bodyFile: string): string => {
    if (ctx.trackerBodyDir !== undefined && resolve(dirname(bodyFile)) !== resolve(ctx.trackerBodyDir)) {
      throw new Error(`local backlog: body file ${bodyFile} is not in ${ctx.trackerBodyDir}`);
    }
    return readFileSync(bodyFile, 'utf8');
  };

  const withAcceptance = (body: string, acceptance?: string[]): string =>
    acceptance && acceptance.length > 0 && acceptanceSectionOf(body) === undefined
      ? `${body.replace(/\n*$/, '')}\n\n## Acceptance\n${acceptance.map((a) => `- [ ] ${a}`).join('\n')}\n`
      : body;

  /** The working-tree file for `id` (a committed item without one is written at its committed path). */
  const fileFor = (id: number): { entry: Entry; file: string } => {
    const e = entries().get(id);
    if (!e) throw new Error(`local backlog item #${id} is not in ${ctx.backlogDir}`);
    if (e.file === undefined && scanWorking().skipped.has(id)) {
      throw new Error(`local backlog: the working-tree file for #${id} (${scanWorking().skipped.get(id)}) is malformed and was skipped; fix or remove it by hand (it is not overwritten)`);
    }
    const file = e.file ?? join(ctx.root, ...e.item.path.split('/'));
    if (existsSync(file) && !lstatSync(file).isFile()) throw new Error(`local backlog: ${file} is not a regular file`);
    return { entry: e, file };
  };

  return {
    viewItem: view,
    queryItems(source: IntakeSource, limit: number): number[] {
      if (source.type !== 'local-backlog') throw new Error(`the local forge reads intake source local-backlog, not ${source.type}`);
      const want = source.label?.toLowerCase();
      return [...entries().values()]
        .filter((e) => e.item.state === 'open' && (want === undefined || e.item.labels.some((l) => l.toLowerCase() === want)) && mergedOpen(e.item) === undefined)
        .map((e) => e.item.id)
        .sort((a, b) => a - b)
        .slice(0, Math.max(0, limit));
    },
    comment(id: number, bodyFile: string): { ok: boolean; stderr: string } {
      try {
        appendNoFollow(omgRoot, join(itemDir(id), 'comments.md'), `\n<!-- ${new Date().toISOString()} -->\n${readFileSync(bodyFile, 'utf8').replace(/\n*$/, '\n')}`);
        return { ok: true, stderr: '' };
      } catch (err) {
        return { ok: false, stderr: (err as Error).message };
      }
    },
    setProgress(id: number, stage: ProgressStage, _mapping: ProgressMapping): { ok: boolean; detail: string } {
      try {
        writeAtomic(join(itemDir(id), 'progress.json'), `${JSON.stringify({ id, stage, updatedAt: new Date().toISOString() }, null, 2)}\n`, omgRoot);
        return { ok: true, detail: `local item #${id}: ${stage}` };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
    addMarker(id: number, marker: string): { ok: boolean; stderr: string } {
      try {
        const { entry, file } = fileFor(id);
        const fields = entry.item.fields;
        if (fields.labels.includes(marker)) return { ok: true, stderr: '' };
        writeAtomic(file, renderBacklogFile({ ...fields, labels: [...fields.labels, marker] }, entry.item.body), ctx.root, true);
        return { ok: true, stderr: '' };
      } catch (err) {
        return { ok: false, stderr: (err as Error).message };
      }
    },
    setTriage(id: number, change: ForgeTriageChange): { ok: boolean; detail: string } {
      if (change.assignee !== undefined) return { ok: false, detail: 'assignee is not a triage write yet' };
      try {
        const { entry, file } = fileFor(id);
        const fields = entry.item.fields;
        const drop = new Set(change.remove.map((l) => l.toLowerCase()));
        const kept = fields.labels.filter((l) => !drop.has(l.toLowerCase()));
        const labels = [...kept, ...change.add.filter((a) => !kept.some((l) => l.toLowerCase() === a.toLowerCase()))];
        const priority = change.priority ?? fields.priority;
        if (labels.length === fields.labels.length && labels.every((l, i) => l === fields.labels[i]) && priority === fields.priority) return { ok: true, detail: 'nothing to change' };
        writeAtomic(file, renderBacklogFile({ ...fields, labels, ...(priority === undefined ? {} : { priority }) }, entry.item.body), ctx.root);
        return { ok: true, detail: `${file} edited in the working tree; commit it on the base branch` };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
    findByKey(spec: number): Array<{ key: string; item: ForgeItem }> {
      const all = entries();
      return [...all.values()].flatMap((e) => shipyardKeys(e.item.body).filter(([s]) => s === spec).map(([, key]) => ({ key, item: toForgeItem(e, all) })));
    },
    createItem(draft: ForgeItemDraft): number {
      const body = withAcceptance(readBody(draft.bodyFile), draft.acceptance);
      const all = entries();
      const scan = scanWorking();
      const id = Math.max(0, ...all.keys(), ...scan.out.map((d) => d.item.id), ...scan.skipped.keys()) + 1;
      const name = `${id}-${backlogSlug(draft.title)}.md`;
      const file = join(dirOnDisk(), name);
      noLinkPath(ctx.root, file, true, true);
      const text = renderBacklogFile({ title: draft.title, state: 'open', labels: [...new Set(draft.labels)], dependsOn: [], ...(draft.priority === undefined ? {} : { priority: draft.priority }) }, body);
      writeFileSync(file, text, { flag: 'wx' });
      return id;
    },
    updateItem(id: number, update: ForgeItemUpdate): void {
      const { entry, file } = fileFor(id);
      const fields = entry.item.fields;
      const remove = new Set(update.removeLabels);
      const labels = [...new Set([...fields.labels.filter((l) => !remove.has(l)), ...update.addLabels])];
      const body = withAcceptance(readBody(update.bodyFile), update.acceptance);
      writeAtomic(file, renderBacklogFile({ ...fields, title: update.title, labels, ...(update.priority === undefined ? {} : { priority: update.priority }) }, body), ctx.root, true);
    },
    warnings(): string[] {
      return [...warnings];
    },
    peekItems(ids: readonly number[]): Map<number, ForgePeek> {
      const all = entries();
      const out = new Map<number, ForgePeek>();
      for (const id of ids) {
        const e = all.get(id);
        if (e) out.set(id, { title: e.item.title, url: e.item.path, state: e.item.state, labels: e.item.labels });
      }
      return out;
    },
  };
}
