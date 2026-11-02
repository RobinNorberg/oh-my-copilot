import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runVerifier, check, buildCompleteFixture } from './epic-3698-fixtures.js';

describe('epic-3698 closure verifier (#3712)', () => {
  let fixture: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'epic-3698-fixture-'));
  });

  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it('handles CR-only definitions and encoded hash path bytes as local containment input', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\r[escape]\r[escape]: %23/../../../../outside.md\r',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('case-folds sharp-S labels while still checking every definition target', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[x][SS]\n\n[ẞ]: ../safe.md\n[SS]: ../../../outside.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('recognizes ordered-list continuation reference definitions', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n10. item\n\n    [escape]: %2e%2e/%2e%2e/%2e%2e/outside.md\n\n[escape]\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('ignores fenced pseudo-definitions while honoring the later real definition', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[a]\n\n```md\n[a]: ../../../outside.md\n```\n\n[a]: ../safe.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('does not treat a backtick-bearing info string as a valid fence opener', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n``` info `\n\n[escape]: ../../../outside.md\n\n[escape]\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('decodes named percent entities before containment', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[escape](&percnt;2e&percnt;2e/&percnt;2e&percnt;2e/&percnt;2e&percnt;2e/outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('resolves safe multiline, ordered-list, and blockquote definitions', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[a][safe label]\n[b][ordered]\n[c][quoted]\n\n[safe\n label]: ../safe.md\n\n10. item\n\n    [ordered]: ../safe.md\n\n> [quoted]:\n> ../safe.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status, JSON.stringify(check(run, 'docsLinks'))).toBe('pass');
  });

  it('ignores inline and fenced code link examples', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n`[inline](../../../outside.md)`\n\n```md\n[fenced](../../../outside.md)\n```\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('unwinds nested lists to recognize an ancestor continuation definition', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n10. outer\n    - inner\n\n    [escape]: ../../../outside.md\n\n[escape]\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('ends a fenced block when its block quote container ends', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n> ```\n> code\n\n[escape]: ../../../outside.md\n\n[escape]\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('ignores tab-indented code pseudo-definitions', () => {
    buildCompleteFixture(fixture);
    writeFileSync(join(fixture, 'docs', 'safe.md'), 'safe\n');
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n[a]\n\n\t[a]: ../../../outside.md\n\n[a]: ../safe.md\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('ends list-contained fences when the list container closes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n- ```\n  code\n\n[escape]: ../../../outside.md\n\n[escape]\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('keeps an invalid trailing-text fence closer inside the code block', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n```\ncode\n``` not-a-closer\n[example](../../../outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('checks quoted, unquoted, mixed-case, and srcset raw HTML URL attributes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<A HREF="&percnt;2e&percnt;2e/&percnt;2e&percnt;2e/&percnt;2e&percnt;2e/outside.md">x</A>\n<img SRC=../../../outside.md>\n<img srcset="../safe.md 1x, ../../../outside.md 2x">\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('contains namespaced SVG xlink:href destinations', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<svg><use XLINK:HREF="%2e%2e/%2e%2e/%2e%2e/outside.svg"></use></svg>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('contains legacy background URL attributes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<table background="../../../outside.png"></table>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not mask Markdown inside malformed non-CommonMark HTML', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<a title=` [escape](../../../outside.md)>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('treats a backslash-escaped less-than sign as literal text, not raw HTML', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n\\<a href="../../../outside.md">literal</a>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(check(run, 'docsLinks').status).toBe('pass');
  });

  it('rejects Unicode whitespace that is not CommonMark raw-tag whitespace', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<a title=x [escape](../../../outside.md)>\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('does not let fence-looking script content mask later active Markdown', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n<script>\n```md\n</script>\n[escape](../../../outside.md)\n',
    );
    const run = runVerifier([
      '--root', fixture,
      '--evidence', join(fixture, 'ci-evidence.json'),
      '--changed-files', join(fixture, 'changed-files.txt'),
    ]);
    expect(run.status).toBe(1);
    expect(check(run, 'docsLinks').problems.join(' ')).toContain('escapes repository root');
  });

  it('ends an unterminated HTML block when its blockquote container closes', () => {
    buildCompleteFixture(fixture);
    writeFileSync(
      join(fixture, 'docs', 'design', 'ISSUE-3712-RELEASE-VERIFICATION.md'),
      '# design\n> <script>\n> inert\n[escape](../../../outside.md)\n',
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
