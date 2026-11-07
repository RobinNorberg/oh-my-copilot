import { afterEach, describe, expect, it, vi } from 'vitest';
import { factoryBoardCommand } from '../../../cli/commands/factory-board.js';
import { localForgeLimitations } from '../../../forge/local/index.js';
import { EXIT_CHECK_INCOMPATIBLE } from '../../check/cli.js';
import { backlogItem, checkDeps, commitAll, localRepo, programs, writeFile } from '../../check/__tests__/local-repo.js';
import { runFactoryBoard, type BoardJson } from '../collect.js';

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
});

describe('omg factory board on the local (offline) forge', () => {
  it('reads the backlog with no origin, flags an uncommitted item and prints the limitations', async () => {
    const repo = localRepo();
    writeFile(repo, '.copilot/backlog/1-add-remove.md', backlogItem('Add remove'));
    commitAll(repo);
    writeFile(repo, '.copilot/backlog/2-draft.md', backlogItem('Draft'));

    expect(await runFactoryBoard({}, checkDeps(repo))).toBe(0);
    const text = repo.out.join('\n');
    for (const line of localForgeLimitations('main')) expect(text).toContain(line);
    expect(repo.err.join('\n')).toMatch(/#2 \(\.copilot\/backlog\/2-draft\.md\) is uncommitted: untrusted until it is committed on main/);
    expect(repo.err.join('\n')).not.toMatch(/#1 .*uncommitted/);
    expect(programs(repo)).toEqual(['git']);
  });

  it('--json carries the limitations, both rows and the tracker warnings', async () => {
    const repo = localRepo();
    writeFile(repo, '.copilot/backlog/1-add-remove.md', backlogItem('Add remove'));
    writeFile(repo, '.copilot/backlog/4-broken.md', 'not a backlog item\n');
    commitAll(repo);
    writeFile(repo, '.copilot/backlog/2-draft.md', backlogItem('Draft'));

    expect(await runFactoryBoard({ json: true }, checkDeps(repo))).toBe(0);
    const json = JSON.parse(repo.out.join('\n')) as BoardJson;
    expect(json.forge).toBe('local');
    expect(json.limitations).toEqual(localForgeLimitations('main'));
    const rows = json.columns.flatMap((c) => c.items);
    expect(rows.map((r) => [r.id, r.check?.bucket, r.check?.reasons[0] ?? ''])).toEqual([[1, 'runnable', ''], [2, 'blocked', 'uncommitted']]);
    expect(json.warnings.some((w) => /local backlog: skipped .*4-broken\.md/.test(w))).toBe(true);
  });

  it('no origin and no local forge config: exit 5 with the --forge local hint', async () => {
    const repo = localRepo();
    await factoryBoardCommand(checkDeps(repo, undefined)).parseAsync([], { from: 'user' });
    expect(process.exitCode).toBe(EXIT_CHECK_INCOMPATIBLE);
    expect(repo.err.join('\n')).toMatch(/unsupported forge: .*omg factory setup --forge local/);
  });
});
