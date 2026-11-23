/**
 * FactoryGate.next on the local forge with a repository root that needs
 * quoting (a space, a single quote and `&`): the sealed argv keeps the root
 * exactly, and every printed form (park reason, outcome merge command, PR
 * comment) is the quoted one for this host's shell family, or withholds the
 * `-C <root>` form where no quoting fits every shell (Windows).
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runFactoryEngine } from '../engine.js';
import { humanCommand } from '../gate-next.js';
import { readFactoryState } from '../state.js';
import { commitFile, review } from './fake-lanes.js';
import { lanesFor, LOCAL_ISSUE, localOpts, localWorld, type LocalWorld } from './engine-local-harness.js';
import { sealedNext, steps } from './gate-next-expect.js';

let w: LocalWorld;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

describe('a local-forge root with a space, a single quote and &', () => {
  it('seals the exact root in gate.next and prints the merge command quoted (or withheld) everywhere', async () => {
    w = localWorld(['node', '--test'], "my repo & 'x'");
    const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')])));
    expect(out.exitCode, out.message).toBe(0);
    expect(out.gate?.name).toBe('merge');
    const head = readFactoryState(w.root, LOCAL_ISSUE)!.head!;
    const argv = ['git', '-C', w.root, 'merge', '--no-ff', '--no-edit', head];
    expect(sealedNext(w.root, LOCAL_ISSUE, out)).toEqual([argv, steps(LOCAL_ISSUE).resume, steps(LOCAL_ISSUE).status]);

    const shown = process.platform === 'win32'
      ? `in the repository root: git merge --no-ff --no-edit ${head}`
      : `git -C '${w.root.replace(/'/g, "'\\''")}' merge --no-ff --no-edit ${head}`;
    expect(humanCommand(argv)).toBe(shown);
    expect(out.mergeCommand).toBe(shown);
    expect(out.gate?.reason).toContain(`: run ${shown}, then omg factory run ${LOCAL_ISSUE}`);
    // The unquoted form is never printed.
    expect(out.message).not.toContain(`-C ${w.root} `);
    const comments = readFileSync(join(w.root, '.omg', 'factory', 'local', 'prs', '1', 'comments.md'), 'utf8');
    expect(comments).not.toContain(`-C ${w.root} `);
    expect(comments).toContain(process.platform === 'win32' ? `git merge --no-ff --no-edit ${head}` : shown);
    if (process.platform === 'win32') expect(comments).toContain('run this in the repository root:');
  }, 300_000);
});
