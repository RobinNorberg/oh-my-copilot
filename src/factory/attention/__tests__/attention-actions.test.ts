/**
 * The gate -> action table is complete: every gate name the engine can park
 * at, extracted from src/factory/run/*.ts and docs/REFERENCE.md "Human
 * gates", has an entry (exact or pattern). A new park name with no entry, or
 * a new dynamic gate expression nobody reviewed, fails here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cancelCommand, resumeCommand } from '../../run/engine.js';
import { commandLine, commandText, gateAction, GATE_ACTIONS, mergeArgv, nextCommands, reminderCommand, suppressedCommands, validRunKey } from '../actions.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..', '..');
const runDir = join(repo, 'src', 'factory', 'run');
/** Every engine source under src/factory/run/, recursively (tests left out). */
function runSources(dir: string, rel = ''): Array<{ file: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === '__tests__' ? [] : runSources(join(dir, e.name), `${rel}${e.name}/`);
    return e.name.endsWith('.ts') ? [{ file: `${rel}${e.name}`, text: readFileSync(join(dir, e.name), 'utf8') }] : [];
  });
}
const sources = runSources(runDir);
const KEBAB = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';

/** `export const X_GATE = 'name'` in every run source. */
function gateConstants(): Map<string, string> {
  const out = new Map<string, string>();
  for (const { text } of sources) for (const m of text.matchAll(new RegExp(`export const ([A-Z_]+_GATE) = '(${KEBAB})'`, 'g'))) out.set(m[1], m[2]);
  return out;
}

/**
 * The `name` values of every brace-free object literal that also has a
 * `reason` key (a park object), in either key order: `{ name: X, reason }`,
 * `{ reason, name: X }`, `{ name: 'x' as const, reason: ... }`. Type
 * literals (`;`-separated) are read by the type pattern in extract().
 */
function parkObjectNames(text: string): string[] {
  const OPEN = '([{';
  const CLOSE = ')]}';
  const out: string[] = [];
  for (const m of text.matchAll(/[{,]\s*name\s*:\s*/g)) {
    // The value: up to the next `,`, `;` or closing bracket at its own depth.
    let i = m.index + m[0].length;
    const start = i;
    for (let d = 0; i < text.length; i++) {
      const c = text[i];
      if (OPEN.includes(c)) d++;
      else if (CLOSE.includes(c)) { if (d === 0) break; d--; } else if ((c === ',' || c === ';') && d === 0) break;
    }
    const value = text.slice(start, i).trim();
    // The enclosing object: back to its unmatched `{`, then its top-level text.
    let j = m.index;
    if (text[j] !== '{') {
      for (let d = 0, k = j - 1; k >= 0; k--) {
        const c = text[k];
        if (CLOSE.includes(c)) d++;
        else if (OPEN.includes(c)) { if (d === 0) { j = k; break; } d--; }
      }
    }
    if (text[j] !== '{') continue;
    let top = '';
    for (let d = 0, k = j + 1; k < text.length; k++) {
      const c = text[k];
      if (OPEN.includes(c)) d++;
      else if (CLOSE.includes(c)) { if (d === 0) break; d--; } else if (d === 0) top += c;
    }
    // A type literal (`;`-separated) is read by the type pattern; only an object with a `reason` key is a park.
    if (top.includes(';') || !/(?:^|,)\s*reason\s*(?::|,|$)/.test(top)) continue;
    out.push(value.replace(/\s+as\s+const$/, '').trim());
  }
  return out;
}

describe('the park-object scanner', () => {
  it('reads the name of a park object in any key order and form', () => {
    expect(parkObjectNames("x = { name: 'a-b', reason }; y = { reason: `r ${z}`, name: 'c' as const }; w = { name: GATE_X, reason: f(1, 2) };")).toEqual(["'a-b'", "'c'", 'GATE_X']);
    expect(parkObjectNames("t: { name: 'a' | 'b'; reason: string }; o = { name: 'n', other: 1 }; p = { name: v.name, detail, reason: r }")).toEqual(['v.name']);
  });

  it('finds the engine\'s park objects (sanity: the scan is not empty)', () => {
    const found = sources.flatMap((s) => parkObjectNames(s.text));
    expect(found.length).toBeGreaterThan(10);
    expect(found).toContain("'sandbox-unavailable'");
  });
});

/**
 * The gate expressions whose value is computed, each reviewed: a park
 * object's name (its literal names are extracted below), the lane-kind
 * patterns, and laneFailed's parameter.
 */
const REVIEWED_DYNAMIC = new Set([
  '`${kind}-declined`', 'gateName', 'out.park.name', 'sandbox.name', 'install.name', 'park.name', 'ran.park.name', 'steps.name', 'next.name', 'switched.name', 'ppark.name',
]);

function extract(): { names: Set<string>; dynamic: string[] } {
  const constants = gateConstants();
  const names = new Set<string>(constants.values());
  // Any exported kebab constant a park object may name (a non-exported one is not resolved: it must be reviewed).
  const exported = new Map<string, string>();
  for (const { text } of sources) for (const m of text.matchAll(new RegExp(`export const ([A-Z][A-Z0-9_]*) = '(${KEBAB})'`, 'g'))) exported.set(m[1], m[2]);
  const dynamic: string[] = [];
  for (const { file, text } of sources) {
    // this.gate(<first argument>, ...
    for (const m of text.matchAll(/this\.gate\(\s*([^,]+?)\s*,/g)) {
      const arg = m[1];
      const lit = new RegExp(`^'(${KEBAB})'$`).exec(arg);
      if (lit) names.add(lit[1]);
      else if (constants.has(arg)) names.add(constants.get(arg)!);
      else dynamic.push(`${file}: ${arg}`);
    }
    // setGate(state, 'name', reason...) calls (not the definition): the literal before the reason.
    for (const m of text.matchAll(/(?<!function )setGate\(/g)) {
      // The first literal followed by the reason, a nested moveTo's phase left out (setGate(moveTo(x, 'review', ...), 'review-tampered', ...)).
      const call = text.slice(m.index, m.index + 1_500).replace(new RegExp(`moveTo\\([^,]+,\\s*'${KEBAB}'`, 'g'), '');
      const lit = new RegExp(`'(${KEBAB})',\\s*(?:reason\\b|\`)`).exec(call)?.[1];
      if (lit) names.add(lit);
      // The definition, and this.gate()'s own body (its callers are read above).
      else if (!/^setGate\((?:state: |s, name, )/.test(call)) dynamic.push(`${file}: setGate without a literal name`);
    }
    // Park objects ({ name: X, reason }, any key order): a literal, an exported constant, or a reviewed expression.
    for (const v of parkObjectNames(text)) {
      const lit = new RegExp(`^'(${KEBAB})'$`).exec(v);
      if (lit) names.add(lit[1]);
      else if (exported.has(v)) names.add(exported.get(v)!);
      else dynamic.push(`${file}: name: ${v}`);
    }
    // The `name: 'a' | 'b'` type of such objects.
    for (const m of text.matchAll(new RegExp(`name:\\s*'(${KEBAB})'(?=\\s*\\|)`, 'g'))) names.add(m[1]);
    for (const m of text.matchAll(new RegExp(`\\|\\s*'(${KEBAB})';\\s*reason`, 'g'))) names.add(m[1]);
    // laneFailed(..., 'gate-name')
    for (const m of text.matchAll(new RegExp(`laneFailed\\([^;]*?,\\s*'(${KEBAB})'\\)`, 'g'))) names.add(m[1]);
  }
  // docs/REFERENCE.md "Human gates": the backticked names of the table's first column.
  const doc = readFileSync(join(repo, 'docs', 'REFERENCE.md'), 'utf8');
  const start = doc.indexOf('##### Human gates');
  const section = doc.slice(start, doc.indexOf('##### The merge gate', start));
  for (const row of section.split('\n').filter((l) => l.startsWith('| `'))) {
    const first = row.split('|')[1];
    for (const m of first.matchAll(new RegExp(`\`(${KEBAB})\``, 'g'))) names.add(m[1]);
  }
  return { names, dynamic };
}

describe('attention gate table', () => {
  const { names, dynamic } = extract();

  it('finds the engine\'s gate names (sanity: the extraction is not empty)', () => {
    for (const n of ['merge', 'merge-refused', 'budget', 'state-tampered', 'gate-install-needed', 'coding-agent-wait', 'heal-approve', 'parallel-needs-private', 'gate-container-unavailable', 'review-invalid', 'sandbox-unavailable', 'blocked-by']) {
      expect(names, n).toContain(n);
    }
    expect(names.size).toBeGreaterThan(50);
  });

  it('has an entry for every gate name the engine or the reference names', () => {
    const missing = [...names].filter((n) => !gateAction(n).known);
    expect(missing).toEqual([]);
  });

  it('every dynamic gate expression was reviewed', () => {
    const unreviewed = dynamic.filter((d) => !REVIEWED_DYNAMIC.has(d.slice(d.indexOf(': ') + 2)));
    expect(unreviewed).toEqual([]);
  });

  it('covers the lane-kind patterns and falls back for an unknown name', () => {
    for (const k of ['implement', 'fix', 'ci-fix', 'conflict-fix', 'coding-agent']) {
      expect(gateAction(`${k}-failed`)).toMatchObject({ known: true, group: 'fix' });
      expect(gateAction(`${k}-declined`)).toMatchObject({ known: true, group: 'fix' });
    }
    expect(gateAction('evil-failed').known).toBe(false);
    expect(gateAction('__proto__').known).toBe(false);
    expect(gateAction('constructor')).toMatchObject({ known: false, group: 'fix', steps: ['resume', 'status'] });
  });

  it('every table entry is a gate the source or the reference names (no stale entries)', () => {
    expect(Object.keys(GATE_ACTIONS).filter((n) => !names.has(n))).toEqual([]);
  });
});

describe('attention commands', () => {
  it('reuse the engine\'s resume and cancel commands', () => {
    for (const key of [12, 'heal-0123abcd' as const]) {
      const next = nextCommands(key, ['resume', 'cancel']);
      expect(next.map((n) => n.argv.join(' '))).toEqual([resumeCommand(key), cancelCommand(key)]);
    }
    expect(reminderCommand(3, 'decisions-rewritten')).toBe(cancelCommand(3));
    expect(reminderCommand(3, 'merge')).toBe(resumeCommand(3));
  });

  it('validate the key, and drop flag steps on a heal run', () => {
    expect(validRunKey(0)).toBe(false);
    expect(validRunKey(-1)).toBe(false);
    expect(validRunKey(1.5)).toBe(false);
    expect(validRunKey('heal-xyz')).toBe(false);
    expect(validRunKey('12; rm -rf /')).toBe(false);
    expect(nextCommands('12; rm -rf /' as never, ['resume'])).toEqual([]);
    expect(suppressedCommands('heal-zz' as never)).toEqual([]);
    expect(nextCommands(4, ['allow-gate-change']).map((n) => n.argv)).toEqual([['omg', 'factory', 'run', '4', '--allow-gate-change']]);
    expect(nextCommands('heal-0123abcd', ['allow-unsandboxed-gates', 'status']).map((n) => n.argv)).toEqual([['omg', 'factory', 'heal', 'status', '0123abcd']]);
  });

  it('compose the merge command only from a PR number and a 40-hex head', () => {
    const head = 'c'.repeat(40);
    expect(mergeArgv({ forge: 'github', root: '/r', pr: 5, head })).toEqual(['gh', 'pr', 'merge', '5', '--admin', '--merge', '--match-head-commit', head]);
    expect(mergeArgv({ forge: 'local', root: '/my repo', pr: 5, head })).toEqual(['git', '-C', '/my repo', 'merge', '--no-ff', '--no-edit', head]);
    expect(mergeArgv({ forge: 'azure-devops', root: '/r', pr: 5, head })).toBeNull();
    expect(mergeArgv({ forge: 'github', root: '/r', pr: 5, head: `${'c'.repeat(39)};` })).toBeNull();
    expect(mergeArgv({ forge: 'github', root: '/r', pr: 0, head })).toBeNull();
  });

  it('mark every command that can start lanes as billed', () => {
    const steps = ['resume', 'cancel', 'status', 'merge', 'allow-gate-change', 'allow-unsandboxed-gates', 'allow-secret-shapes'] as const;
    const issue = nextCommands(4, steps, { forge: 'github', root: '/r', pr: 5, head: 'c'.repeat(40) });
    expect(issue.map((n) => [n.argv.slice(0, 4).join(' '), n.billed])).toEqual([
      ['omg factory run 4', true], ['omg factory run cancel', false], ['omg factory run status', false], ['gh pr merge 5', false],
      ['omg factory run 4', true], ['omg factory run 4', true], ['omg factory run 4', true],
    ]);
    const heal = nextCommands('heal-0123abcd', ['status', 'resume', 'heal-close', 'heal-run']);
    expect(heal.map((n) => [n.argv.slice(0, 4).join(' '), n.billed])).toEqual([
      ['omg factory heal status', false], ['omg factory heal approve', true], ['omg factory heal close', false], ['omg factory heal run', true],
    ]);
    expect(suppressedCommands(3).every((n) => !n.billed)).toBe(true);
  });

  it('quote for the shell family: double quotes for the strict set, else the shell\'s own single quotes', () => {
    const head = 'c'.repeat(40);
    const merge = (root: string) => ['git', '-C', root, 'merge', '--no-ff', '--no-edit', head];
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      // A space: double quotes read the same in PowerShell, cmd.exe and POSIX shells.
      expect(commandLine(merge('C:/my repo'), platform)).toBe(`git -C "C:/my repo" merge --no-ff --no-edit ${head}`);
      expect(commandText(merge('/home/u/my repo'), platform)).toEqual({ line: `git -C "/home/u/my repo" merge --no-ff --no-edit ${head}`, inRoot: false });
      expect(commandText(merge('C:/Code/repo'), platform)).toEqual({ line: `git -C C:/Code/repo merge --no-ff --no-edit ${head}`, inRoot: false });
    }
    // POSIX: single quotes, a quote written '\''.
    expect(commandLine(['a', "it's; x"], 'linux')).toBe("a 'it'\\''s; x'");
    expect(commandText(merge("/x/O'Brien;id;#"), 'linux').line).toBe(`git -C '/x/O'\\''Brien;id;#' merge --no-ff --no-edit ${head}`);
    expect(commandText(merge('/x/a&calc&/r'), 'linux').line).toBe(`git -C '/x/a&calc&/r' merge --no-ff --no-edit ${head}`);
    expect(commandText(merge('/x/$(id)'), 'linux').line).toBe(`git -C '/x/$(id)' merge --no-ff --no-edit ${head}`);
    // PowerShell's '' doubling for a word outside the strict set.
    expect(commandLine(['a', "it's; x"], 'win32')).toBe("a 'it''s; x'");
    // Windows: cmd.exe reads no single quotes, so the -C <root> form is withheld for any root outside the strict set.
    for (const root of ["C:/x/O'Brien;Write-Output INJECTED;#", 'C:/a&calc&/repo', 'C:/x/$(id)', 'C:/x/%PATH%', 'C:/x/a,b', 'C:/my repo\\sub']) {
      expect(commandText(merge(root), 'win32'), root).toEqual({ line: `git merge --no-ff --no-edit ${head}`, inRoot: true });
    }
    // Anything a terminal cannot show (a newline, a filler) is withheld on every platform.
    for (const platform of ['win32', 'linux'] as const) {
      for (const root of ['/tmp/a\nb $(id) `id`', '/tmp/a\u3164b', '/tmp/a\u200bb']) expect(commandText(merge(root), platform).inRoot, JSON.stringify(root)).toBe(true);
    }
    // Bare words stay bare; a backslash is quoted on POSIX, where it escapes.
    expect(commandLine(['omg', 'factory', 'run', '12', '--allow-gate-change'], 'win32')).toBe('omg factory run 12 --allow-gate-change');
    expect(commandLine(['C:\\x'], 'win32')).toBe('C:\\x');
    expect(commandLine(['C:\\x'], 'linux')).toBe("'C:\\x'");
  });
});
