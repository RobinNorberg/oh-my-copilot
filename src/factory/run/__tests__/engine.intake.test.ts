import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { readShipState } from '../../../ship/state.js';
import { EXIT_AWAITING_HUMAN, type FactoryEngineOptions } from '../engine.js';
import { readFactoryState } from '../state.js';
import { commitFile, gitIn, ISSUE, PR, review } from './fake-lanes.js';
import { h, useEngineHarness, limits, run } from './engine-harness.js';

useEngineHarness();

describe('omg factory run engine (fake lanes, real git, scripted gh)', () => {
  describe('secret-shaped content in the issue text', () => {
    // Built at runtime so the test file itself carries no key shape.
    const key = `AKIA${'ABCDEFGHIJKLMNOP'}`;

    it('parks at intake before any lane, naming the kind and never the value; a rerun after the edit runs the lanes', async () => {
      const body = h.gh.issue.body;
      h.gh.issue.body = `The deploy script needs ${key} in the code.\n\n${body}`;
      const first = run([commitFile('src/config.ts', `export const K = '${key}';\n`), review('approve')]);
      const out = await first.done;
      expect(out.gate?.name).toBe('secret-shaped-content');
      expect(first.lanes.started).toEqual([]);
      const parked = readFactoryState(h.root, ISSUE)!;
      expect(parked.phase).toBe('intake');
      expect(parked.gate?.reason).toContain('issue text itself (title or body) holds secret-shaped content (aws-access-key)');
      expect(JSON.stringify(parked)).not.toContain(key);
      expect(out.message ?? '').not.toContain(key);

      h.gh.issue.body = body;
      const second = run([commitFile('src/greet.ts', 'x\n'), review('approve')]);
      expect((await second.done).gate?.name).toBe('merge');
      expect(second.lanes.started[0].prompt).not.toContain(key);
    });

    it('a key in the title parks the same way', async () => {
      h.gh.issue.title = `Rotate ${key}`;
      const { lanes, done } = run([commitFile('src/greet.ts', 'x\n'), review('approve')]);
      expect((await done).gate?.name).toBe('secret-shaped-content');
      expect(lanes.started).toEqual([]);
    });

    it('a key in the linked omg-plan file parks at plan before any lane, naming the kind and the file, never the value', async () => {
      writeFileSync(join(h.root, 'docs', 'plan.md'), `# Plan\n\nUse ${key} for deploys.\n`);
      gitIn(h.root, 'add', '.');
      gitIn(h.root, 'commit', '-q', '-m', 'plan with a key');
      gitIn(h.root, 'push', '-q', 'origin', 'dev');
      h.gh.issue.body = 'see plan';
      h.gh.issue.comments = [{ body: 'omg-plan: docs/plan.md', authorAssociation: 'MEMBER' }];
      const { lanes, done } = run([commitFile('src/greet.ts', 'x\n'), review('approve')]);
      const out = await done;
      expect(out.gate?.name).toBe('secret-shaped-content');
      expect(lanes.started).toEqual([]);
      const parked = readFactoryState(h.root, ISSUE)!;
      expect(parked.phase).toBe('plan');
      expect(parked.plan).toBeUndefined();
      expect(parked.gate?.reason).toContain('linked plan file docs/plan.md holds secret-shaped content (aws-access-key)');
      expect(JSON.stringify(parked)).not.toContain(key);
      expect(out.message ?? '').not.toContain(key);
    });

    it('--dry-run predicts the intake park, kinds only', async () => {
      h.gh.issue.body = `Needs ${key}.\n\n## Acceptance criteria\n\n- greet() returns hi\n`;
      const out = await run([], { dryRun: true }).done;
      expect(out.exitCode).toBe(0);
      expect(out.plan).toMatchObject({ next: 'awaiting-human', reason: 'secret-shaped-content' });
      expect(out.message).toContain('(aws-access-key)');
      expect(out.message).not.toContain(key);
      expect(readFactoryState(h.root, ISSUE)).toBeNull();
    });
  });

  describe('repository guide files in the implement prompt', () => {
    it('names only the guide files the base has, and none when it has none', async () => {
      const bare = run([commitFile('src/greet.ts', 'x\n'), review('approve')]);
      await bare.done;
      expect(bare.lanes.started[0].prompt).toContain('following the repository\'s standards.\n');
      expect(bare.lanes.started[0].prompt).not.toContain('read its');
    });

    it('a CONTRIBUTING.md on the base is named; the missing AGENTS.md and CLAUDE.md are not', async () => {
      writeFileSync(join(h.root, 'CONTRIBUTING.md'), '# Contributing\n');
      gitIn(h.root, 'add', '.');
      gitIn(h.root, 'commit', '-q', '-m', 'contributing');
      gitIn(h.root, 'push', '-q', 'origin', 'dev');
      const { lanes, done } = run([commitFile('src/greet.ts', 'x\n'), review('approve')]);
      await done;
      expect(lanes.started[0].prompt).toContain('following the repository\'s standards (read its CONTRIBUTING.md).');
    });
  });

  describe('two-axis review', () => {
    const withStandards = () => {
      mkdirSync(join(h.root, 'docs', 'standards'));
      writeFileSync(join(h.root, 'docs', 'standards', 'code.md'), '# Code\n\nNo default exports.\n');
      gitIn(h.root, 'add', '.');
      gitIn(h.root, 'commit', '-q', '-m', 'standards');
      gitIn(h.root, 'push', '-q', 'origin', 'dev');
    };

    it('no docs/standards/ on the base: the single-axis prompt', async () => {
      const { lanes, done } = run([commitFile('src/greet.ts', 'export const greet = () => "hi";\n'), review('approve')]);
      expect((await done).gate?.name).toBe('merge');
      expect(lanes.started[1].prompt).toContain('against the plan. Diff first');
      expect(lanes.started[1].prompt).not.toContain('axis');
    });

    it('docs/standards/ on the base: both axes, and a standards-axis blocker fails an approve', async () => {
      withStandards();
      const finding = { severity: 'blocker', axis: 'standards', summary: 'default export', file: 'src/greet.ts' };
      const { lanes, done } = run([commitFile('src/greet.ts', 'export default 1;\n'), review('approve', [finding])], { limits: limits({ maxFixRounds: 0 }) });
      const out = await done;
      expect(out.gate?.name).toBe('fix-rounds-spent');
      expect(lanes.started[1].prompt).toContain('on two axes');
      expect(lanes.started[1].prompt).toContain('- docs/standards/code.md');
      const state = readFactoryState(h.root, ISSUE)!;
      expect(state.lanes[1].verdict).toBe('changes-requested');
      expect(state.findings).toEqual([finding]);
      expect(readShipState(h.root, PR)!.verdicts[0].verdict).toBe('changes-requested');
    });

    it('docs/standards/ on the base: a finding without an axis is an invalid review', async () => {
      withStandards();
      const { done } = run([commitFile('src/greet.ts', 'x\n'), review('approve', [{ severity: 'nit', summary: 'no axis' }]), review('approve', [{ severity: 'nit', summary: 'no axis' }])]);
      const out = await done;
      expect(out.gate?.name).toBe('review-invalid');
      expect(readFactoryState(h.root, ISSUE)!.lanes[1]).toMatchObject({ verdict: 'invalid', note: expect.stringContaining('axis is not one of spec, standards') });
    });
  });

  it('no Acceptance criteria and no omg-plan link parks at needs-plan without a lane', async () => {
    h.gh.issue.body = 'please add greet';
    const { lanes, done } = run([]);
    const out = await done;
    expect(out.gate?.name).toBe('needs-plan');
    expect(lanes.started).toHaveLength(0);
  });

  describe('blocked-by intake gate (shipyard ↔ factory design §3.5)', () => {
    const DEP = 3;
    const MERGED_LOOKUP = `gh pr list --head factory/issue-${DEP} --base dev --state merged --json number`;
    /** #3: open unless closed; its factory PR into dev merged when `merged`. */
    const dep = { state: 'OPEN', merged: false };
    const depExec = (): FactoryEngineOptions['exec'] => (cmd, args, o) => {
      const key = `${cmd} ${args.join(' ')}`;
      if (key.startsWith(`gh issue view ${DEP} --json`)) {
        h.calls.push(key);
        return { status: 0, stdout: JSON.stringify({ title: 'A', body: '', state: dep.state, labels: [], comments: [], url: `https://github.com/o/r/issues/${DEP}` }), stderr: '' };
      }
      if (key === MERGED_LOOKUP) {
        h.calls.push(key);
        return { status: 0, stdout: JSON.stringify(dep.merged ? [{ number: 90 }] : []), stderr: '' };
      }
      return h.exec(cmd, args, o);
    };

    beforeEach(() => {
      dep.state = 'OPEN';
      dep.merged = false;
      h.gh.issue.body = `Blocked by #${DEP}\n\n## Acceptance criteria\n\n- greet() returns hi\n`;
    });

    it('B with an open A parks at blocked-by naming A, without a lane; a rerun proceeds once A\'s factory PR merged (A still open)', async () => {
      const first = await run([], { exec: depExec() }).done;
      expect(first.exitCode).toBe(EXIT_AWAITING_HUMAN);
      expect(first.gate?.name).toBe('blocked-by');
      expect(first.gate?.reason).toContain(`#${DEP}`);
      expect(first.phase).toBe('intake');
      expect(h.calls).toContain(MERGED_LOOKUP);
      expect(h.calls.some((c) => c.startsWith('gh pr create'))).toBe(false);
      expect(readFactoryState(h.root, ISSUE)).toMatchObject({ phase: 'intake', gate: { name: 'blocked-by' } });

      // Still unsatisfied: the rerun parks again, still no lane.
      const again = await run([], { exec: depExec() }).done;
      expect(again.gate?.name).toBe('blocked-by');

      dep.merged = true;
      const { lanes, done } = run([commitFile('a.ts'), review('approve')], { exec: depExec() });
      const out = await done;
      expect(out.exitCode, out.message).toBe(0);
      expect(out.gate?.name).toBe('merge');
      expect(lanes.started).toHaveLength(2);
    });

    it('a self-dependency parks at blocked-by naming blocked-by:self, without reading any dependency', async () => {
      h.gh.issue.body = `Blocked by #${ISSUE}\n\n## Acceptance criteria\n\n- greet() returns hi\n`;
      const out = await run([], { exec: depExec() }).done;
      expect(out.gate?.name).toBe('blocked-by');
      expect(out.gate?.reason).toContain('blocked-by:self');
      expect(h.calls.some((c) => c.includes(`factory/issue-${ISSUE} --base`))).toBe(false);
    });

    it('a closed dependency is satisfied: the run starts at once', async () => {
      dep.state = 'CLOSED';
      const out = await run([commitFile('a.ts'), review('approve')], { exec: depExec() }).done;
      expect(out.exitCode, out.message).toBe(0);
      expect(out.gate?.name).toBe('merge');
      expect(h.calls).not.toContain(MERGED_LOOKUP);
    });
  });
});
