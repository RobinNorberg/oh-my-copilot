import { describe, expect, it } from 'vitest';
import type { ForgeItem } from '../../../forge/types.js';
import type { CheckResult } from '../../check/score.js';
import { DEFAULT_TRIAGE_CONFIG, planItem, resolveTriageConfig, TriageConfigError } from '../rules.js';

const item = (o: Partial<ForgeItem> = {}): ForgeItem => ({
  id: 1, url: 'u', title: 't', body: '', open: true, rawState: 'OPEN', authorTrusted: true, comments: [], labels: [], dependsOn: [], children: [], repoUrl: 'r', ...o,
});
const res = (bucket: CheckResult['bucket'], reason = '', priority: number | null = null): CheckResult =>
  ({ id: 1, title: 't', url: 'u', bucket, reasons: reason ? [reason] : [], detail: '', priority, planSource: null });
const plan = (i: Partial<ForgeItem>, r: CheckResult, kind: 'github' | 'azure-devops' | 'local' = 'github') => planItem(item(i), r, kind, DEFAULT_TRIAGE_CONFIG);

describe('triage rules', () => {
  it('invents no priority by default; defaultPriority is opt-in, and sets the number only off GitHub', () => {
    expect(plan({}, res('runnable')).action).toBe('unchanged');
    expect(plan({}, res('runnable'), 'azure-devops').action).toBe('unchanged');
    const opt = { ...DEFAULT_TRIAGE_CONFIG, defaultPriority: 2 };
    expect(planItem(item(), res('runnable'), 'github', opt)).toMatchObject({ action: 'change', add: ['priority:p2'], priority: null });
    expect(planItem(item(), res('runnable'), 'azure-devops', opt)).toMatchObject({ add: ['priority:p2'], priority: 3 });
  });

  it('GitHub: keeps the label check/score.ts ranks by (the first) and never resolves a conflict upward', () => {
    expect(plan({ labels: ['priority:p3', 'priority:p0'] }, res('runnable', '', 4))).toMatchObject({ remove: ['priority:p0'], add: [], priority: null });
    expect(plan({ labels: ['priority:p0', 'Priority:P3'] }, res('runnable', '', 1))).toMatchObject({ remove: ['Priority:P3'], add: [] });
    expect(plan({ labels: ['priority:p1'] }, res('runnable', '', 2)).action).toBe('unchanged');
  });

  it('ADO: a field set by a human wins over a stale tag; the field is never written from a tag', () => {
    // A human raised Priority to 1 in the ADO UI; the tag still says p3.
    expect(plan({ priority: 1, labels: ['priority:p3'] }, res('runnable', '', 1), 'azure-devops')).toMatchObject({ add: ['priority:p0'], remove: ['priority:p3'], priority: null });
    // The only tag is stale: the plan swaps it, so the tags are never left empty.
    const swap = plan({ priority: 1, labels: ['priority:p3'] }, res('runnable', '', 1), 'azure-devops');
    expect(swap.remove).toEqual(['priority:p3']);
    expect(swap.add).toEqual(['priority:p0']);
    // A p0 tag on a field-4 item does not raise the field.
    expect(plan({ priority: 4, labels: ['priority:p0'] }, res('runnable', '', 4), 'azure-devops')).toMatchObject({ add: ['priority:p3'], remove: ['priority:p0'], priority: null });
    expect(plan({ priority: 2, labels: ['priority:p1'] }, res('runnable', '', 2), 'azure-devops').action).toBe('unchanged');
    // The field is unset: the tag is used and nothing is written to the field.
    expect(plan({ labels: ['priority:p1'] }, res('runnable', '', 2), 'azure-devops').action).toBe('unchanged');
  });

  it('local: the priority frontmatter is authoritative; F55: no priority label is added next to it', () => {
    expect(plan({ priority: 3, labels: ['priority:p0'] }, res('runnable', '', 3), 'local')).toMatchObject({ add: [], remove: ['priority:p0'], priority: null });
  });

  it('local: a frontmatter priority above 4 leaves a held priority label alone', () => {
    const p = plan({ priority: 7, labels: ['priority:p2'] }, res('runnable', '', 7), 'local');
    expect(p).toMatchObject({ add: [], remove: [], priority: null });
    expect(p.why.join('\n')).toMatch(/frontmatter priority 7 is above 4; the priority labels are left alone/);
  });

  it('a field above 4 has no tag to match: the labels are left alone', () => {
    expect(plan({ priority: 7, labels: ['priority:p1'] }, res('runnable', '', 7), 'azure-devops').action).toBe('unchanged');
  });

  it('needs-plan follows the check bucket; a blocked item keeps its labels', () => {
    expect(plan({ labels: ['priority:p1'] }, res('needs-plan', 'no-plan'))).toMatchObject({ add: ['needs-plan'] });
    // Triage only adds needs-plan / needs-split; a human clears them.
    expect(plan({ labels: ['priority:p1', 'needs-plan'] }, res('runnable')).action).toBe('unchanged');
    expect(plan({ labels: ['priority:p1', 'needs-plan'] }, res('blocked', 'depends-on:#9')).action).toBe('unchanged');
  });

  it('needs-split: epics, too-big and size above the threshold, only without children', () => {
    const p1 = { labels: ['priority:p1'] };
    expect(plan(p1, res('blocked', 'needs-split'))).toMatchObject({ add: ['needs-split'] });
    expect(plan({ ...p1, size: 6 }, res('runnable'))).toMatchObject({ add: ['needs-split'] });
    expect(plan({ ...p1, size: 5 }, res('runnable')).action).toBe('unchanged');
    expect(plan({ ...p1, size: 8, children: [2] }, res('blocked', 'needs-split')).add).toEqual([]);
    expect(plan({ labels: ['priority:p1', 'needs-split'], children: [2] }, res('blocked', 'needs-split')).action).toBe('unchanged');
  });

  it('skips closed items, live runs, open PRs and read failures, with the check reason', () => {
    for (const reason of ['closed', 'run-active:implement', 'pr-exists', 'branch-exists', 'run-finished:merged', 'read-failed', 'merged']) {
      expect(plan({}, res('blocked', reason))).toMatchObject({ action: 'skip', skipReason: reason, add: [], remove: [] });
    }
  });

  it('config: defaults, overrides from later layers, and strict validation', () => {
    expect(resolveTriageConfig([undefined, {}])).toEqual(DEFAULT_TRIAGE_CONFIG);
    expect(resolveTriageConfig([{ factory: { triage: { sizeSplitAt: 3, labels: { needsSplit: 'split' } } } }, { factory: { triage: { sizeSplitAt: 8, defaultPriority: 1 } } }]))
      .toEqual({ ...DEFAULT_TRIAGE_CONFIG, needsSplit: 'split', sizeSplitAt: 8, defaultPriority: 1 });
    for (const bad of [{ x: 1 }, { sizeSplitAt: 1.5 }, { defaultPriority: 4 }, { labels: { owner: 'x' } }, { labels: { needsPlan: 'a b' } }, { labels: { needsPlan: 'needs-split' } }, 5]) {
      expect(() => resolveTriageConfig([{ factory: { triage: bad } }])).toThrow(TriageConfigError);
    }
  });
});
