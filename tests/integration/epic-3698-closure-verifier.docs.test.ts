import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runVerifier, check, writeJson, gitFixture, commitFixture, commitFixtureHead, buildCompleteFixture } from './epic-3698-fixtures.js';

describe('epic-3698 closure verifier (#3712)', () => {
  let fixture: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'epic-3698-fixture-'));
  });

  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it('allows only the exact v5 release smoke skill-path correction', () => {
    buildCompleteFixture(fixture);
    const workflowPath = join(fixture, '.github', 'workflows', 'release.yml');
    writeFileSync(workflowPath, [
      'jobs:',
      '  smoke:',
      '    steps:',
      '      - run: |',
      '          test -s "$SMOKE_PACKAGE_ROOT/skills/omc-reference/SKILL.md"',
      '          test -f "$SMOKE_PACKAGE_ROOT/skills/setup/SKILL.md"',
      '          cmp "$SMOKE_PACKAGE_ROOT/skills/omc-reference/SKILL.md" "$SMOKE_PROJECT/.claude/skills/omc-reference/SKILL.md"',
      '',
    ].join('\n'));
    commitFixture(fixture, 'base release smoke');
    gitFixture(fixture, ['branch', 'base']);
    writeFileSync(workflowPath, [
      'jobs:',
      '  smoke:',
      '    steps:',
      '      - run: |',
      '          test -s "$SMOKE_PACKAGE_ROOT/skills/wiki/SKILL.md"',
      '          cmp "$SMOKE_PACKAGE_ROOT/skills/wiki/SKILL.md" "$SMOKE_PROJECT/.claude/skills/wiki/SKILL.md"',
      '',
    ].join('\n'));
    commitFixtureHead(fixture, 'correct release smoke');
    writeFileSync(join(fixture, 'changed-files.txt'), '.github/workflows/release.yml\n');

    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--base', 'base',
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'releaseSecurityParity').status).toBe('pass');
  });

  it('fails on schema-invalid migration receipts', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'broken.receipt.json'), { schemaVersion: 2, kind: 'nope' });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'migrationReceipts').status).toBe('fail');
  });

  it('reports pending (exit 2) while the alias retirement window is unsatisfied, without authorizing removal', () => {
    buildCompleteFixture(fixture);
    writeJson(join(fixture, 'receipts', 'epic-3698', 'alias-usage.receipt.json'), {
      schemaVersion: 1,
      kind: 'alias-usage',
      issue: 3711,
      createdAt: '2026-08-12T00:00:00Z',
      payload: {
        canonicalShare: 0.8,
        minorReleases: 1,
        daysSinceDeprecation: 30,
        consecutiveReleasesAtThreshold: 0,
        knownCriticalIntegrations: 1,
      },
    });
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(2);
    expect(run.report.verdict).toBe('PENDING_TEMPORAL');
    expect(check(run, 'aliasRetirementPolicy').status).toBe('pending');
    expect(check(run, 'aliasRetirementPolicy').details).toContain('must NOT be removed');
  });

  it('reports pending (exit 2) when children lack terminal evidence', () => {
    buildCompleteFixture(fixture);
    rmSync(join(fixture, 'receipts', 'epic-3698', 'child-3709-terminal.receipt.json'));
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(2);
    expect(check(run, 'childTerminality').status).toBe('pending');
    expect(check(run, 'childTerminality').details).toContain('3709');
  });

  it('fails when the remaining-risk register is missing', () => {
    buildCompleteFixture(fixture);
    rmSync(join(fixture, 'receipts', 'epic-3698', 'remaining-risk.json'));
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'remainingRisk').status).toBe('fail');
  });

  it('detects broken relative links in closure documents', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[missing](../../receipts/epic-3698/NOPE.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').status).toBe('fail');
  });

  it('keeps mandatory closure documents when --docs adds an extra path', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape](../../../outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
      '--docs', 'docs/safe.md',
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('rejects escaped-label reference links that traverse outside the repository root', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape][out\\]side]\n\n[out\\]side]: ../../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').status).toBe('fail');
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('rejects escaped inline-label destinations that traverse outside the repository root', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape\\]label](../../../outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').status).toBe('fail');
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('canonicalizes nested CommonMark labels and percent-escaped destination bytes before containment', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[outer [nested]](%2e%2e/%2e%2e/%2e%2e/outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').status).toBe('fail');
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('canonicalizes CommonMark character references before containment', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape](&#x2e;&#x2e;/&#46;&#46;/&period;&period;/outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('uses the first CommonMark reference definition for containment', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[a]\n\n[a]: ../../../outside.md\n[a]: ../safe.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('uses first-definition precedence for nested escaped labels and percent destinations', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[outer [nested]][DuP\\]]\n\n[dup\\]]: %2e%2e/%2e%2e/%2e%2e/outside.md\n[DUP\\]]: ../safe.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not let a later duplicate definition hide an outside symlink', ({ skip }) => {
    buildCompleteFixture(fixture);
    const externalRoot = mkdtempSync(join(tmpdir(), 'epic-3698-duplicate-external-'));
    const externalTarget = join(externalRoot, 'outside.md');
    writeFileSync(externalTarget, 'outside\n');
    try {
      try {
        symlinkSync(externalTarget, join(fixture, 'outside-link.md'));
      } catch (error) {
        skip(`symlink creation unavailable: ${(error as Error).message}`);
        return;
      }
      writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
      writeFileSync(
        join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
        '# design\n[a]\n\n[a]: ../../outside-link.md\n[A]: ../safe.md\n',
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

  it('finds reference definitions inside block quote containers', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape]\n\n> [escape]: %2e%2e/%2e%2e/%2e%2e/outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('finds reference destinations on the line after the definition colon', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape]\n\n[escape]:\n%2e%2e/%2e%2e/%2e%2e/outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('finds nested escaped reference definitions inside list and block quote containers', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[outer [nested]][EsC\\]]\n\n- > [esc\\]]:\n  > %2e%2e/%2e%2e/%2e%2e/outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('fails closed when a reference definition destination form is unsupported', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape]\n\n> [escape]:\n>\n> unavailable\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('unsupported or missing destination');
  });

  it('finds nested-list continuation and multiline-label reference definitions', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape link]\n\n- outer\n  - inner\n\n    [escape\n      link]: %2e%2e/%2e%2e/%2e%2e/outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('checks every potential definition so fenced text cannot mask a later traversal', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[a]\n\n```md\n[a]: ../safe.md\n```\n\n[a]: ../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not alias escaped punctuation or non-CommonMark label whitespace', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[x][foo\\!]\n[y][foo\fbar]\n\n[foo!]: ../safe.md\n[foo\\!]: ../../../outside.md\n[foo bar]: ../safe.md\n[foo\fbar]: ../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });
});
