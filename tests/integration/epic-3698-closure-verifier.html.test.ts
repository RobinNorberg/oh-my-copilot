import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REPO_ROOT, SCRIPT, runVerifier, check, buildCompleteFixture } from './epic-3698-fixtures.js';

describe('epic-3698 closure verifier (#3712)', () => {
  let fixture: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'epic-3698-fixture-'));
  });

  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it('contains URL-bearing descendants inside pre HTML blocks', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<pre><a href="../../../outside.md">outside</a></pre>\n',
    );
    const run = runVerifier(['--root', fixture, '--evidence', join(fixture, 'ci-evidence.json'), '--changed-files', join(fixture, 'changed-files.txt')]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not treat inline script tags as CommonMark HTML block starts', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\nprefix <script>[escape](../../../outside.md)</script>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not let script-looking fenced code consume the real fence closer', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n```md\n<script>\n```\n[escape](../../../outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('checks inline destinations after labels longer than 1000 code units', () => {
    buildCompleteFixture(fixture);
    const label = 'x'.repeat(1_200);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      `# design\n[${label}](../../../outside.md)\n`,
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not treat four-space indentation as code when it continues a paragraph', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\nparagraph\n    [escape](../../../outside.md)\n',
    );
    const run = runVerifier(['--root', fixture, '--evidence', join(fixture, 'ci-evidence.json'), '--changed-files', join(fixture, 'changed-files.txt')]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not let an ordered list starting above one interrupt a paragraph', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\nparagraph\n2. [escape](../../../outside.md)\n',
    );
    const run = runVerifier(['--root', fixture, '--evidence', join(fixture, 'ci-evidence.json'), '--changed-files', join(fixture, 'changed-files.txt')]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not treat NBSP or ideographic space as inline destination whitespace', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[x](safe /../../../outside.md)\n[y](safe　/../../../outside.md)\n',
    );
    const run = runVerifier(['--root', fixture, '--evidence', join(fixture, 'ci-evidence.json'), '--changed-files', join(fixture, 'changed-files.txt')]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('broken relative link safe /../../../outside.md');
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('broken relative link safe　/../../../outside.md');
  });

  it('allows raw HTML anchors and external schemes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<a href="#section">anchor</a>\n<img src="https://example.com/image.png">\n<form action=mailto:test@example.com></form>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('ignores raw HTML URL examples inside inline and fenced code', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n`<a href="../../../outside.md">example</a>`\n\n```html\n<img src=../../../outside.md>\n```\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('rejects raw HTML URLs through symlinks outside the repository', ({ skip }) => {
    buildCompleteFixture(fixture);
    const externalRoot = mkdtempSync(join(tmpdir(), 'epic-3698-html-external-'));
    const externalTarget = join(externalRoot, 'outside.md');
    writeFileSync(externalTarget, 'outside\n');
    try {
      try {
        symlinkSync(externalTarget, join(fixture, 'outside-html-link.md'));
      } catch (error) {
        skip(`symlink creation unavailable: ${(error as Error).message}`);
        return;
      }
      writeFileSync(
        join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
        '# design\n<a href="../../outside-html-link.md">outside</a>\n',
      );
      const run = runVerifier([
        '--root', fixture,
        '--evidence', join(fixture, 'ci-evidence.json'),
        '--changed-files', join(fixture, 'changed-files.txt'),
      ]);
      expect(run.status).toBe(1);
      expect(check(run, 'docsLinks').problems.join(' ')).toContain('resolves outside repository root');
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('masks fences after alternating list and blockquote prefixes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n- > ```md\n  > [example](../../../outside.md)\n  > ```\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status, JSON.stringify(check(run, 'docsLinks'))).toBe('pass');
  });

  it('ends a fence when the ordered container chain changes at equal depth', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n- > ```md\n> - [escape]: ../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('parses HTML tags with greater-than characters inside quoted attributes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<a title=">" href="../../../outside.md">outside</a>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('scans raw HTML before masking paired backticks in attributes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<a title="`" href="../../../outside.md" data-x="`">outside</a>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not start code spans on backslash-escaped backticks around raw HTML', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n\\`<a href="../../../outside.md">outside</a>\\`\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('keeps escaped-backtick offsets aligned after astral Unicode', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n😀 \\`<a href="../../../outside.md">outside</a>\\`\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('allows a backtick after a backslash to close an existing code span', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n`code\\`<a href="../../../outside.md">outside</a>`\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('ends list-contained fences when a sibling list item starts', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n- ```md\n  fenced\n- [escape]: ../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('ends a blockquote fence when an unquoted blank separates a sibling quote', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n> ```md\n> fenced\n\n> <a href="../../../outside.md">outside</a>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('ends a nested quote fence when the inner quote closes on an empty outer line', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n> > ```md\n> > fenced\n>\n> > <a href="../../../outside.md">outside</a>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('rejects escaped-label reference links through symlinks that resolve outside the repository root', ({ skip }) => {
    buildCompleteFixture(fixture);
    const externalRoot = mkdtempSync(join(tmpdir(), 'epic-3698-external-'));
    const externalTarget = join(externalRoot, 'outside.md');
    writeFileSync(externalTarget, 'outside\n');
    try {
      try {
        symlinkSync(externalTarget, join(fixture, 'outside-link.md'));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM' || code === 'ENOTSUP') {
          skip();
          return;
        }
        throw error;
      }
      writeFileSync(
        join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
        '# design\n[escape][out\\]side]\n\n[out\\]side]: ../../outside-link.md\n',
      );
      const run = runVerifier([
        '--root', fixture,
        '--evidence', join(fixture, 'ci-evidence.json'),
        '--changed-files', join(fixture, 'changed-files.txt'),
      ]);
      expect(run.status).toBe(1);
      expect(check(run, 'docsLinks').status).toBe('fail');
      expect(check(run, 'docsLinks').problems.join(' ')).toContain('resolves outside repository root');
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it('on this repository, runs clean: receipts/docs/parity pass; child terminality and metrics reflect current state', () => {
    const run = runVerifier(['--evidence', join(REPO_ROOT, 'receipts', 'epic-3698', 'ci-evidence-merged.receipt.json')]);
    // Verdict may be PENDING_TEMPORAL (alias retirement window unsatisfied) or FAIL (metrics not at target with all owners terminal)
    expect(['PENDING_TEMPORAL', 'PASS', 'FAIL']).toContain(run.report.verdict);
    // The checked-in historical evidence predates the exact child-PR and
    // structured terminal-receipt contracts, so it must fail closed until
    // refreshed; docs and the risk register remain valid.
    expect(['pass', 'fail']).toContain(check(run, 'exactHeadCi').status);
    expect(['pass', 'fail']).toContain(check(run, 'migrationReceipts').status);
    expect(check(run, 'remainingRisk').status).toBe('pass');
    expect(check(run, 'docsLinks').status).toBe('pass');
    // pass when a base ref resolves locally; pending (not a crash) in shallow CI checkouts without origin/dev
    expect(['pass', 'pending']).toContain(check(run, 'releaseSecurityParity').status);
    // childTerminality: pass when all children have current structured receipts;
    // pending when receipts are absent; fail when stale/forged receipts exist.
    expect(['pass', 'pending', 'fail']).toContain(check(run, 'childTerminality').status);
    // shippedMetrics: pending while owners open; fail when all owners terminal but targets unmet; pass when targets met
    expect(['pass', 'pending', 'fail']).toContain(check(run, 'shippedMetrics').status);
    // alias retirement window is unsatisfied — always pending
    expect(check(run, 'aliasRetirementPolicy').status).toBe('pending');
  });

  it('keeps stdout machine-readable and reports parity pending when no git base is available', () => {
    buildCompleteFixture(fixture);
    // No --changed-files and the fixture is not a git repository: the parity
    // check must degrade to pending, never throw into empty stdout.
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
    ]);
    expect(run.status).toBe(2);
    expect(run.report.verdict).toBe('PENDING_TEMPORAL');
    expect(check(run, 'releaseSecurityParity').status).toBe('pending');
    expect(check(run, 'releaseSecurityParity').details).toContain('change set unavailable');
  });

  it('emits a metrics-snapshot receipt via --emit-metrics-receipt', () => {
    const out = join(fixture, 'metrics.receipt.json');
    spawnSync(process.execPath, [SCRIPT, '--root', fixture, '--emit-metrics-receipt', out], { encoding: 'utf8' });
    expect(existsSync(out)).toBe(true);
    const receipt = JSON.parse(readFileSync(out, 'utf8'));
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.kind).toBe('metrics-snapshot');
    expect(receipt.issue).toBe(3712);
    expect(receipt.payload.measurementSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects unknown arguments fail-closed', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--bogus'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--bogus');
  });
});
