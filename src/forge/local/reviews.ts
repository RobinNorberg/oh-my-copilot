/**
 * The local forge's PRs (offline forge plan §1.1): numbers and states in the
 * engine-owned JSON store, heads and bases read from the bare mirror's refs.
 * A PR turns MERGED when its head is an ancestor of the mirror's base (the
 * human merged it and the next run/poll synced the base). Bodies and
 * comments are written for the human under `.omg/factory/local/prs/<n>/`.
 * There are no review threads (listThreads is omitted).
 */

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Exec } from '../../ship/exec.js';
import type { ForgePr, ForgeReviews } from '../types.js';
import { isLocalBranchName, mergedArgs, readMirrorRef } from './mirror.js';
import { readPrStore, updatePrStore, writeAtomic, type LocalPr } from './store.js';

/** ship's TRUSTED_READ_ENV, by value (importing ship/exec.ts would load child_process into src/forge). */
const TRUSTED_READ_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_NO_REPLACE_OBJECTS: '1' });

export interface LocalReviewsContext {
  exec: Exec;
  /** The user's checkout (the merge happens there). */
  root: string;
  /** The bare mirror. */
  mirror: string;
  /** The PR store file. */
  storePath: string;
  /** `<root>/.omg/factory/local`: bodies and comments for the human. */
  humanDir: string;
}

export const localPrUrl = (pr: number): string => `omg-local://pr/${pr}`;

/** true/false from `git merge-base --is-ancestor`; undefined when git could not tell (a missing object). */
function isAncestor(ctx: LocalReviewsContext, head: string, base: string): boolean | undefined {
  const r = ctx.exec('git', mergedArgs(head, base), { cwd: ctx.root, env: TRUSTED_READ_ENV });
  return r.status === 0 ? true : r.status === 1 ? false : undefined;
}

export function localReviews(ctx: LocalReviewsContext): ForgeReviews {
  const ref = (branch: string): string | undefined => readMirrorRef(ctx.mirror, branch);

  /** The PR with its state brought up to date (OPEN -> MERGED once the base contains the head). */
  const refresh = (pr: LocalPr): LocalPr => {
    if (pr.state !== 'OPEN') return pr;
    const head = ref(pr.head);
    const base = ref(pr.base);
    if (!head || !base || head === base || isAncestor(ctx, head, base) !== true) return pr;
    return updatePrStore(ctx.storePath, (store) => {
      const p = store.prs.find((x) => x.number === pr.number)!;
      if (p.state === 'OPEN') Object.assign(p, { state: 'MERGED', mergedHead: head, mergedAt: new Date().toISOString() });
      return { ...p };
    });
  };
  const find = (pr: number): LocalPr => {
    const p = readPrStore(ctx.storePath).prs.find((x) => x.number === pr);
    if (!p) throw new Error(`local PR #${pr} does not exist`);
    return refresh(p);
  };
  const view = (pr: number): ForgePr => {
    const p = find(pr);
    const head = p.state === 'MERGED' ? (p.mergedHead ?? ref(p.head)) : ref(p.head);
    const base = ref(p.base);
    if (!head) throw new Error(`local PR #${pr}: branch ${p.head} is not in the mirror`);
    if (!base) throw new Error(`local PR #${pr}: base ${p.base} is not in the mirror`);
    return { number: p.number, state: p.state, isDraft: p.isDraft, baseRefName: p.base, baseRefOid: base, headRefName: p.head, headRefOid: head, url: localPrUrl(p.number) };
  };
  const humanFile = (pr: number, name: string): string => join(ctx.humanDir, 'prs', String(pr), name);

  return {
    findOpenPrForBranch(branch: string): number | undefined {
      return readPrStore(ctx.storePath).prs.filter((p) => p.head === branch && p.state === 'OPEN').map(refresh).find((p) => p.state === 'OPEN')?.number;
    },
    findMergedPrForBranch(branch: string, base: string): number | undefined {
      return readPrStore(ctx.storePath).prs.filter((p) => p.head === branch && p.base === base).map(refresh).find((p) => p.state === 'MERGED')?.number;
    },
    createDraftPr(o: { base: string; head: string; title: string; bodyFile: string; itemId?: number }): number {
      if (!isLocalBranchName(o.head) || !isLocalBranchName(o.base)) throw new Error(`local PR: ${o.head} -> ${o.base} is not a pair of plain branch names`);
      const head = ref(o.head);
      const base = ref(o.base);
      if (!head) throw new Error(`local PR: branch ${o.head} is not in the mirror (push it first)`);
      if (!base) throw new Error(`local PR: base ${o.base} is not in the mirror`);
      if (head === base || isAncestor(ctx, head, base) === true) throw new Error(`local PR: no commits between ${o.base} and ${o.head}`);
      const body = readFileSync(o.bodyFile, 'utf8');
      const number = updatePrStore(ctx.storePath, (store) => {
        const open = store.prs.find((p) => p.head === o.head && p.base === o.base && p.state === 'OPEN');
        if (open) throw new Error(`local PR: #${open.number} is already open for ${o.head}`);
        const n = store.next++;
        store.prs.push({ number: n, head: o.head, base: o.base, title: o.title, state: 'OPEN', isDraft: true, ...(o.itemId === undefined ? {} : { itemId: o.itemId }), createdAt: new Date().toISOString() });
        return n;
      });
      writeAtomic(humanFile(number, 'body.md'), `# ${o.title}\n\n${body}`);
      return number;
    },
    viewPr: view,
    prHead(pr: number): { headRefOid: string; state: string } {
      const v = view(pr);
      return { headRefOid: v.headRefOid, state: v.state };
    },
    markReady(pr: number): void {
      updatePrStore(ctx.storePath, (store) => {
        const p = store.prs.find((x) => x.number === pr);
        if (!p) throw new Error(`local PR #${pr} does not exist`);
        p.isDraft = false;
      });
    },
    commentPr(pr: number, bodyFile: string): { ok: boolean; stderr: string } {
      try {
        if (!readPrStore(ctx.storePath).prs.some((x) => x.number === pr)) return { ok: false, stderr: `local PR #${pr} does not exist` };
        const file = humanFile(pr, 'comments.md');
        mkdirSync(join(file, '..'), { recursive: true });
        appendFileSync(file, `\n<!-- ${new Date().toISOString()} -->\n${readFileSync(bodyFile, 'utf8').replace(/\n*$/, '\n')}`);
        return { ok: true, stderr: '' };
      } catch (err) {
        return { ok: false, stderr: (err as Error).message };
      }
    },
  };
}
