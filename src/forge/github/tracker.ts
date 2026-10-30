/**
 * GitHub issues as the factory tracker (factory forges design §2, PR 2): the
 * engine's `gh issue view` / `gh issue comment` moved verbatim, plus the
 * ForgeTracker reads and label writes. Label writes (progress, `check
 * --mark`) need factory guard shapes that land with PR 7; until then the
 * guard refuses them and these methods report `ok: false`.
 */

import type { Exec, ExecResult } from '../../ship/exec.js';
import { commentTrusted, issueAuthorTrusted, type IssueComment } from '../../factory/run/plan-rules.js';
import type { ForgeItem, ForgeTracker, IntakeSource, ProgressMapping, ProgressStage, ResolvedForgeConfig } from '../types.js';
import { GhCommandError, ghJson } from './gh.js';

/** `gh issue view --json` fields the engine reads (author: whose body `omg-plan:` line counts). */
export const ISSUE_FIELDS = 'title,body,labels,state,url,author,comments';

export interface GhIssue {
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  state?: unknown;
  url?: unknown;
  author?: unknown;
  comments?: IssueComment[];
}

/** `gh issue view <id> --json ISSUE_FIELDS` (the engine's dry run handles the result itself). */
export function ghIssueView(exec: Exec, issue: number, cwd: string): ExecResult {
  return exec('gh', ['issue', 'view', String(issue), '--json', ISSUE_FIELDS], { cwd });
}

/** ghIssueView as an engine step: GhCommandError on failure or no JSON; fields unchecked. */
export function ghIssueJson(exec: Exec, issue: number, cwd: string): GhIssue {
  return ghJson<GhIssue>(exec, ['issue', 'view', String(issue), '--json', ISSUE_FIELDS], cwd);
}

/** `gh issue comment <id> --body-file <file>`; never throws on a gh failure. */
export function ghIssueComment(exec: Exec, issue: number, bodyFile: string, cwd: string): { ok: boolean; stderr: string } {
  const res = exec('gh', ['issue', 'comment', String(issue), '--body-file', bodyFile], { cwd });
  return { ok: res.status === 0, stderr: res.stderr };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const login = (author: unknown): string => str((author as { login?: unknown } | null | undefined)?.login);
const refs = (body: string, re: RegExp): number[] => [...new Set([...body.matchAll(re)].map((m) => Number(m[1])))];

/** `gh issue view` as a ForgeItem; throws GhCommandError when it is not the issue asked for. */
export function ghViewItem(exec: Exec, issue: number, cwd: string): ForgeItem {
  const v = ghIssueJson(exec, issue, cwd);
  const url = str(v?.url);
  const m = /^(https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/issues\/(\d+)$/.exec(url);
  if (!m || Number(m[2]) !== issue) throw new GhCommandError(`gh issue view ${issue} returned no issue url`);
  const body = str(v.body);
  const labels = Array.isArray(v.labels) ? v.labels.map((l) => str((l as { name?: unknown } | null)?.name)).filter(Boolean) : [];
  const comments = Array.isArray(v.comments) ? v.comments : [];
  const size = labels.map((l) => /^size:(\d+)$/i.exec(l)?.[1]).find(Boolean);
  const parent = /^[^\S\r\n]*part of[^\S\r\n]+#(\d+)\b/im.exec(body)?.[1];
  return {
    id: issue,
    url,
    title: str(v.title),
    body,
    open: v.state === 'OPEN',
    rawState: str(v.state),
    authorTrusted: issueAuthorTrusted(v),
    comments: comments.map((c) => ({ body: str(c?.body), author: login(c?.author), trusted: commentTrusted(c ?? {}) })),
    labels,
    ...(size ? { size: Number(size) } : {}),
    dependsOn: refs(body, /^[^\S\r\n]*(?:depends on|blocked by)[^\S\r\n]+#(\d+)\b/gim),
    children: refs(body, /^[^\S\r\n]*[-*][^\S\r\n]+\[[ xX]\][^\S\r\n]+#(\d+)\b/gm),
    ...(parent ? { parent: Number(parent) } : {}),
    repoUrl: m[1],
  };
}

/** Open issue numbers for a label or milestone source; the ADO sources are refused. */
export function ghQueryItems(exec: Exec, source: IntakeSource, limit: number, cwd: string): number[] {
  const filter = source.type === 'label' ? ['--label', source.label] : source.type === 'milestone' ? ['--milestone', source.milestone] : null;
  if (!filter) throw new GhCommandError(`intake source ${source.type} is not a GitHub source`);
  const list = ghJson<unknown>(exec, ['issue', 'list', ...filter, '--state', 'open', '--json', 'number', '--limit', String(limit)], cwd);
  if (!Array.isArray(list)) throw new GhCommandError('gh issue list returned no JSON array');
  return list.map((e) => (e as { number?: unknown } | null)?.number).filter((n): n is number => typeof n === 'number');
}

/** `gh issue edit <id>` with the given label flags; never throws. */
function editLabels(exec: Exec, issue: number, flags: string[], cwd: string): { ok: boolean; stderr: string } {
  try {
    const res = exec('gh', ['issue', 'edit', String(issue), ...flags], { cwd });
    return { ok: res.status === 0, stderr: res.stderr };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A stage's label; the other stages' labels are removed (one label family).
 * GitHub progress is labels only: a column or state mapping is ignored.
 * `cancelled` removes the whole family (design §7).
 */
export function ghSetProgress(exec: Exec, issue: number, stage: ProgressStage, mapping: ProgressMapping, stages: ResolvedForgeConfig['progress']['stages'], cwd: string): { ok: boolean; detail: string } {
  const family = [...new Set(Object.values(stages).map((m) => m?.label).filter((l): l is string => Boolean(l)))];
  if (stage === 'cancelled') {
    if (family.length === 0) return { ok: true, detail: 'no label family' };
    const res = editLabels(exec, issue, family.flatMap((l) => ['--remove-label', l]), cwd);
    return { ok: res.ok, detail: res.ok ? 'label family removed' : res.stderr.trim() };
  }
  if (!mapping.label) return { ok: true, detail: `no label for stage ${stage}` };
  const others = family.filter((l) => l !== mapping.label);
  const res = editLabels(exec, issue, ['--add-label', mapping.label, ...others.flatMap((l) => ['--remove-label', l])], cwd);
  return { ok: res.ok, detail: res.ok ? `label ${mapping.label}` : res.stderr.trim() };
}

export function githubTracker(exec: Exec, cwd: string, config: ResolvedForgeConfig): ForgeTracker {
  return {
    viewItem: (id) => ghViewItem(exec, id, cwd),
    queryItems: (source, limit) => ghQueryItems(exec, source, limit, cwd),
    comment: (id, bodyFile) => ghIssueComment(exec, id, bodyFile, cwd),
    setProgress: (id, stage, mapping) => ghSetProgress(exec, id, stage, mapping, config.progress.stages, cwd),
    addMarker: (id, marker) => editLabels(exec, id, ['--add-label', marker], cwd),
  };
}
