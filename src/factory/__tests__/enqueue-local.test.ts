import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBacklogFile } from '../../forge/local/index.js';
import { backlogItem, checkDeps, commitAll, localRepo, programs, writeFile, type LocalRepo } from '../check/__tests__/local-repo.js';
import { runFactoryEnqueue, type EnqueueJson } from '../enqueue.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const ticket = (key: string, blockedBy: string[] = []) => ({
  key,
  title: `Do ${key}`,
  body: `## Context\n${key} context.\n`,
  acceptance: [`\`${key}()\` returns 0`],
  blockedBy,
});

function ticketFile(repo: LocalRepo, tickets: unknown[]): string {
  const path = join(repo.home, 'tickets.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, spec: 1, tickets }));
  return path;
}

async function enqueue(repo: LocalRepo, tickets: unknown[], dryRun = false): Promise<{ code: number; json: EnqueueJson }> {
  repo.out.length = 0;
  const code = await runFactoryEnqueue({ spec: '1', file: ticketFile(repo, tickets), json: true, dryRun }, checkDeps(repo));
  return { code, json: JSON.parse(repo.out.join('\n')) as EnqueueJson };
}

const backlogDir = (repo: LocalRepo): string => join(repo.root, '.copilot', 'backlog');

describe('omg factory enqueue on the local (offline) forge', () => {
  it('writes the tickets as backlog files in the working tree (no origin, git only) and is idempotent before the commit', async () => {
    const repo = localRepo();
    writeFile(repo, '.copilot/backlog/1-spec.md', backlogItem('The spec'));
    commitAll(repo);

    const dry = await enqueue(repo, [ticket('store'), ticket('refresh', ['store'])], true);
    expect(dry.code).toBe(0);
    expect(dry.json.items.map((i) => i.action)).toEqual(['created', 'created']);
    expect(readdirSync(backlogDir(repo))).toEqual(['1-spec.md']);
    // F25: a dry run does not claim files are uncommitted (nothing was written); the spec has no task list offline.
    expect(dry.json.warnings.some((w) => /^after enqueue writes them, commit the new and changed backlog files on main/.test(w))).toBe(true);
    expect(dry.json.warnings.some((w) => /are uncommitted/.test(w))).toBe(false);
    expect(dry.json.spec.taskList).toBe('not-used');

    const first = await enqueue(repo, [ticket('store'), ticket('refresh', ['store'])]);
    expect(first.code).toBe(0);
    expect(first.json.items.map((i) => [i.key, i.id, i.action])).toEqual([['store', 2, 'created'], ['refresh', 3, 'created']]);
    // New files are uncommitted: untrusted, so check blocks them and marks nothing.
    expect(first.json.items.map((i) => i.reasons[0])).toEqual(['uncommitted', 'uncommitted']);
    expect(first.json.warnings.some((w) => /uncommitted: commit them on main/.test(w))).toBe(true);
    expect(first.json.spec.taskList).toBe('not-used');
    const third = readdirSync(backlogDir(repo)).find((n) => n.startsWith('3-'))!;
    const item = parseBacklogFile(`.copilot/backlog/${third}`, readFileSync(join(backlogDir(repo), third), 'utf8'));
    expect(item).toMatchObject({ id: 3, title: 'Do refresh', state: 'open', parent: 1, dependsOn: [2] });
    // The committed spec file is never rewritten.
    expect(readFileSync(join(backlogDir(repo), '1-spec.md'), 'utf8')).toBe(backlogItem('The spec'));

    const again = await enqueue(repo, [ticket('store'), ticket('refresh', ['store'])]);
    expect(again.code).toBe(0);
    expect(again.json.items.map((i) => [i.id, i.action])).toEqual([[2, 'unchanged'], [3, 'unchanged']]);
    expect(readdirSync(backlogDir(repo)).length).toBe(3);
    expect(programs(repo)).toEqual(['git']);
  });

  it('refuses an uncommitted spec', async () => {
    const repo = localRepo();
    writeFile(repo, '.copilot/backlog/1-spec.md', backlogItem('The spec'));
    await expect(enqueue(repo, [ticket('store')])).rejects.toThrow(/spec #1 \(\.copilot\/backlog\/1-spec\.md\) is not committed on main/);
    expect(existsSync(join(backlogDir(repo), '2-do-store.md'))).toBe(false);
  });
});
