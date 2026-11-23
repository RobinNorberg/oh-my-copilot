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
import { commandLine, gateAction, GATE_ACTIONS, mergeArgv, nextCommands, reminderCommand, suppressedCommands, validRunKey } from '../actions.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..', '..');
const runDir = join(repo, 'src', 'factory', 'run');
const sources = readdirSync(runDir).filter((f) => f.endsWith('.ts')).map((f) => ({ file: f, text: readFileSync(join(runDir, f), 'utf8') }));
const KEBAB = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';

/** `export const X_GATE = 'name'` in every run source. */
function gateConstants(): Map<string, string> {
  const out = new Map<string, string>();
  for (const { text } of sources) for (const m of text.matchAll(new RegExp(`export const ([A-Z_]+_GATE) = '(${KEBAB})'`, 'g'))) out.set(m[1], m[2]);
  return out;
}

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
    // Park objects: { name: 'x', reason } and the `name: 'a' | 'b'` type of such objects.
    for (const m of text.matchAll(new RegExp(`name:\\s*'(${KEBAB})'(?=\\s*(?:,\\s*reason|\\|))`, 'g'))) names.add(m[1]);
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

  it('quote a word with a shell character when printed', () => {
    expect(commandLine(['git', '-C', 'C:/my repo', 'merge'])).toBe("git -C 'C:/my repo' merge");
    expect(commandLine(['a', "it's; x"])).toBe("a 'it'\\''s; x'");
  });
});
