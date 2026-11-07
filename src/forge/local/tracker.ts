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

import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { Exec } from '../../ship/exec.js';
import {
  shipyardKeys,
  type ForgeItem,
  type ForgeItemDraft,
  type ForgeItemUpdate,
  type ForgePeek,
  type ForgeTracker,
  type IntakeSource,
  type LocalTrackerOptions,
  type ProgressMapping,
  type ProgressStage,
} from '../types.js';
import { acceptanceSectionOf, backlogFileId, backlogSlug, BacklogParseError, parseBacklogFile, renderBacklogFile, type BacklogItem } from './backlog.js';
import { backlogListArgs, backlogShowArgs } from './mirror.js';
import { writeAtomic } from './store.js';

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
      items.push(parseBacklogFile(path, body));
    }
    const result = { items: byId(items), text };
    committedCache.set(sha, result);
    return result;
  };

  const dirOnDisk = (): string => join(ctx.root, ...ctx.backlogDir.split('/'));

  /** The working-tree items (regular files only; a symlink is never followed). */
  const working = (): Array<{ item: BacklogItem; text: string; file: string }> => {
    const dir = dirOnDisk();
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return [];
    const out: Array<{ item: BacklogItem; text: string; file: string }> = [];
    for (const name of readdirSync(dir).sort()) {
      if (backlogFileId(name) === undefined) continue;
      const file = join(dir, name);
      if (!lstatSync(file).isFile()) continue;
      const text = readFileSync(file, 'utf8');
      out.push({ item: parseBacklogFile(`${ctx.backlogDir}/${name}`, text), text: lf(text), file });
    }
    return out;
  };

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

  const toForgeItem = (e: Entry, all: Map<number, Entry>): ForgeItem => ({
    id: e.item.id,
    url: e.item.path,
    title: e.item.title,
    body: e.item.body,
    ...(e.item.acceptance ? { acceptance: e.item.acceptance } : {}),
    open: e.item.state === 'open',
    rawState: e.item.state,
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
  });

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
        .filter((e) => e.item.state === 'open' && (want === undefined || e.item.labels.some((l) => l.toLowerCase() === want)))
        .map((e) => e.item.id)
        .sort((a, b) => a - b)
        .slice(0, Math.max(0, limit));
    },
    comment(id: number, bodyFile: string): { ok: boolean; stderr: string } {
      try {
        const dir = itemDir(id);
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'comments.md'), `\n<!-- ${new Date().toISOString()} -->\n${readFileSync(bodyFile, 'utf8').replace(/\n*$/, '\n')}`);
        return { ok: true, stderr: '' };
      } catch (err) {
        return { ok: false, stderr: (err as Error).message };
      }
    },
    setProgress(id: number, stage: ProgressStage, _mapping: ProgressMapping): { ok: boolean; detail: string } {
      try {
        writeAtomic(join(itemDir(id), 'progress.json'), `${JSON.stringify({ id, stage, updatedAt: new Date().toISOString() }, null, 2)}\n`);
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
        writeFileSync(file, renderBacklogFile({ ...fields, labels: [...fields.labels, marker] }, entry.item.body));
        return { ok: true, stderr: '' };
      } catch (err) {
        return { ok: false, stderr: (err as Error).message };
      }
    },
    findByKey(spec: number): Array<{ key: string; item: ForgeItem }> {
      const all = entries();
      return [...all.values()].flatMap((e) => shipyardKeys(e.item.body).filter(([s]) => s === spec).map(([, key]) => ({ key, item: toForgeItem(e, all) })));
    },
    createItem(draft: ForgeItemDraft): number {
      const body = withAcceptance(readBody(draft.bodyFile), draft.acceptance);
      const all = entries();
      const onDisk = working().map((d) => d.item.id);
      const id = Math.max(0, ...all.keys(), ...onDisk) + 1;
      const name = `${id}-${backlogSlug(draft.title)}.md`;
      const dir = dirOnDisk();
      mkdirSync(dir, { recursive: true });
      const text = renderBacklogFile({ title: draft.title, state: 'open', labels: [...new Set(draft.labels)], dependsOn: [], ...(draft.priority === undefined ? {} : { priority: draft.priority }) }, body);
      writeFileSync(join(dir, name), text, { flag: 'wx' });
      return id;
    },
    updateItem(id: number, update: ForgeItemUpdate): void {
      const { entry, file } = fileFor(id);
      const fields = entry.item.fields;
      const remove = new Set(update.removeLabels);
      const labels = [...new Set([...fields.labels.filter((l) => !remove.has(l)), ...update.addLabels])];
      const body = withAcceptance(readBody(update.bodyFile), update.acceptance);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, renderBacklogFile({ ...fields, title: update.title, labels, ...(update.priority === undefined ? {} : { priority: update.priority }) }, body));
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
