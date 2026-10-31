/**
 * The live acceptance scripts (ADO parity design §6, PR E1): the BACKLOG.md
 * parser, the manifest-scoped cleanup guard, the dry run of every phase, the
 * read-only capture and the fixture scrubber. Nothing here reaches az or git:
 * every spawn is a fake that fails the test when a dry run calls it.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseTicketFile } from '../../../factory/enqueue.js';
import { redactAdoSecrets } from '../redact.js';
import { ADO_ROUTES } from '../routes.js';
import { parseAdoFixture } from './fixtures.js';
// @ts-expect-error Script source is intentionally JavaScript-only.
import { backlogToTicketFile, inlineHtml, parseBacklog } from '../../../../scripts/lib/backlog-to-workitems.mjs';
// @ts-expect-error Script source is intentionally JavaScript-only.
import * as acceptance from '../../../../scripts/ado-acceptance.mjs';
// @ts-expect-error Script source is intentionally JavaScript-only.
import { assertReadOnly, capture, CAPTURE_ROUTES, invokeArgs, redactLocal } from '../../../../scripts/ado-capture.mjs';
// @ts-expect-error Script source is intentionally JavaScript-only.
import { createScrubber, planImport } from '../../../../scripts/ado-fixture-import.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'omg-ado-acceptance-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let dirs = 0;
const freshDir = (name: string) => {
  const dir = join(scratch, `${name}-${++dirs}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** ExcavatorTrek's BACKLOG.md shape: preamble, a waves table between rules, then `## EXC-NNN` tickets. */
const BACKLOG = [
  '# Backlog',
  '',
  'Small, independent tickets. **Ticket zero (done):** the scripted player was extracted.',
  '',
  '---',
  '',
  '## Waves',
  '',
  '| Wave | Tickets |',
  '| ---- | ------- |',
  '| 1    | EXC-001, EXC-007 |',
  '',
  '---',
  '',
  '## EXC-001 Fuel gauge',
  '',
  'Depends on: none.',
  '',
  '- [ ] Add `fuel` (0..`EXCAVATOR.fuelCapacity`) to `ExcavatorState`.',
  '- [x] At zero fuel the excavator cannot drive; delivered >= required & <done>.',
  '- [ ] Tests: drain rate, empty-tank immobility,',
  '      refuel pickup.',
  '',
  '## EXC-006 Camera shake',
  '',
  'Depends on: none. Wave 8: the only call site of `updateCamera` is `src/app.ts`.',
  '',
  '- [ ] `updateCamera` takes the frame\'s events.',
  '',
  '## EXC-009 Best-time tracking',
  '',
  'Depends on: EXC-007 (the `KeyValueStore` in `src/storage.ts`), EXC-001.',
  '',
  '- [ ] On completion store the best time.',
  '',
].join('\r\n');

describe('scripts/lib/backlog-to-workitems.mjs', () => {
  it('parses the ExcavatorTrek shape: tickets, Depends on, checkbox AC with continuation lines', () => {
    const tickets = parseBacklog(BACKLOG);
    expect(tickets.map((t: { key: string }) => t.key)).toEqual(['EXC-001', 'EXC-006', 'EXC-009']);
    expect(tickets[0]).toMatchObject({ title: 'Fuel gauge', dependsOn: [], dependsText: 'none.' });
    expect(tickets[0].acceptance).toEqual([
      { text: 'Add `fuel` (0..`EXCAVATOR.fuelCapacity`) to `ExcavatorState`.', done: false },
      { text: 'At zero fuel the excavator cannot drive; delivered >= required & <done>.', done: true },
      { text: 'Tests: drain rate, empty-tank immobility, refuel pickup.', done: false },
    ]);
    expect(tickets[1].dependsOn).toEqual([]);
    expect(tickets[2].dependsOn).toEqual(['EXC-007', 'EXC-001']);
  });

  it('builds the enqueue ticket file: lower-case keys, blockedBy keys the backlog defines, unknown dependencies reported', () => {
    const { file, unknown } = backlogToTicketFile(BACKLOG, 500);
    expect(file).toMatchObject({ schemaVersion: 1, spec: 500 });
    expect(file.tickets[0]).toEqual({
      key: 'exc-001',
      title: 'EXC-001 Fuel gauge',
      body: 'Depends on: none.',
      acceptance: [
        'Add `fuel` (0..`EXCAVATOR.fuelCapacity`) to `ExcavatorState`.',
        'At zero fuel the excavator cannot drive; delivered >= required & <done>.',
        'Tests: drain rate, empty-tank immobility, refuel pickup.',
      ],
      blockedBy: [],
    });
    expect(file.tickets[2]).toMatchObject({ key: 'exc-009', blockedBy: ['exc-001'] });
    expect(unknown).toEqual(['EXC-009 depends on EXC-007, which BACKLOG.md does not define']);
    expect(inlineHtml('`<script>` & "x"')).toBe('<code>&lt;script&gt;</code> &amp; &quot;x&quot;');
  });

  it('writes a ticket file that omg factory enqueue accepts', () => {
    const { file } = backlogToTicketFile(BACKLOG, 500);
    expect(parseTicketFile(file, 12)).toMatchObject({ spec: 500, tickets: file.tickets });
  });

  it('refuses a duplicate ticket and a ticket without acceptance criteria', () => {
    expect(() => parseBacklog('## EXC-001 A\n- [ ] x\n## EXC-001 B\n- [ ] y\n')).toThrow(/appears twice/);
    expect(() => parseBacklog('## EXC-001 A\nDepends on: none.\n')).toThrow(/no checkbox acceptance criteria/);
  });
});

const ORG = 'https://dev.azure.com/contoso-acc';
const RUN = 'omg-acc-202610291200';
const PROJECT_ID = '6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c';
const ENTRY = { command: 'C:\\CLI2\\python.exe', prefix: ['-IBm', 'azure.cli'], env: { AZ_INSTALLER: 'MSI' } };

function manifest(home: string, over: Record<string, unknown> = {}) {
  const m = {
    schemaVersion: 1, runId: RUN, org: ORG, source: 'C:/src', runDir: join(home, RUN), pool: { kind: 'self-hosted', name: 'Default' },
    project: { name: RUN, id: PROJECT_ID }, repo: { name: RUN, id: 'r', url: 'u' }, pipeline: { id: 7 }, policy: { id: 3 },
    spec: { id: 40, createdBy: 'robin@contoso.example' }, tickets: { 'exc-001': { id: 41, blockedBy: [] }, 'exc-009': { id: 43, blockedBy: ['exc-001'] } }, trustedAuthorsAdded: [],
    ...over,
  };
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, `${RUN}.json`), JSON.stringify(m), 'utf8');
  return m;
}

type Call = { cmd: string; args: string[]; env?: Record<string, string> };
type Extra = { confirm?: (q: string) => boolean; trustedAuthors?: string[] };
/** trustedUserConfigPath() (src/ship/config.ts) on Windows for the account robin. */
const USER_CONFIG = 'C:\\Users\\robin\\AppData\\Roaming\\claude-omc\\config.jsonc';
function context(o: Record<string, unknown>, answer?: (call: Call) => { status: number; stdout: string; stderr?: string }, extra: Extra = {}) {
  const lines: string[] = [];
  const calls: Call[] = [];
  const asked: string[] = [];
  const spawn = (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
    calls.push({ cmd, args, env: opts?.env });
    if (!answer) throw new Error(`spawned in a dry run: ${cmd} ${args.join(' ')}`);
    return { stderr: '', ...answer({ cmd, args }) };
  };
  const confirm = (q: string) => {
    asked.push(q);
    lines.push(`asked: ${q}`);
    if (!extra.confirm) throw new Error(`asked in a dry run: ${q}`);
    return extra.confirm(q);
  };
  const userConfig = { path: USER_CONFIG, trustedAuthors: () => extra.trustedAuthors ?? [] };
  const ctx = acceptance.createContext(o, { spawn, azEntry: ENTRY, log: (l: string) => lines.push(l), now: () => new Date('2026-10-29T12:00:00Z'), env: {}, confirm, userConfig });
  return { ctx, lines, calls, asked };
}
/** An omg call's argv after bin/oh-my-copilot.js. */
const omgArgs = (call: Call) => call.args.slice(1);
const azArgs = (call: Call) => call.args.slice(ENTRY.prefix.length);
/** What azArgv appends to every azure-devops extension command. */
const J = ['--detect', 'false', '--output', 'json'];

describe('scripts/ado-acceptance.mjs cleanup guard', () => {
  const m = { runId: RUN, project: { name: RUN, id: PROJECT_ID } };

  it('returns the manifest id, and refuses an id the manifest does not record', () => {
    expect(acceptance.assertCleanupAllowed(m)).toBe(PROJECT_ID);
    expect(acceptance.assertCleanupAllowed(m, { requestedId: PROJECT_ID.toUpperCase(), shown: { id: PROJECT_ID, name: RUN } })).toBe(PROJECT_ID);
    expect(() => acceptance.assertCleanupAllowed(m, { requestedId: '3411ebc1-d5aa-464f-9615-0b527bc66719' })).toThrow(/not the project id in the manifest/);
    expect(() => acceptance.assertCleanupAllowed({ ...m, project: { name: RUN } })).toThrow(/records no project id/);
    expect(() => acceptance.assertCleanupAllowed(undefined)).toThrow(/no manifest/);
  });

  it('refuses a name without the omg-acc- prefix or other than the run id, and a shown project that differs', () => {
    expect(() => acceptance.assertCleanupAllowed({ runId: 'Web', project: { name: 'Web', id: PROJECT_ID } })).toThrow(/not this run's omg-acc-/);
    expect(() => acceptance.assertCleanupAllowed({ ...m, project: { name: 'omg-acc-202610291201', id: PROJECT_ID } })).toThrow(/not this run's/);
    expect(() => acceptance.assertCleanupAllowed(m, { shown: { id: PROJECT_ID, name: 'Production' } })).toThrow(/is named "Production"/);
    expect(() => acceptance.assertCleanupAllowed(m, { shown: { id: '3411ebc1-d5aa-464f-9615-0b527bc66719', name: RUN } })).toThrow(/another project/);
  });

  it('deletes exactly the manifest project after az devops project show confirms it, then removes only the clone', () => {
    const home = freshDir('home');
    manifest(home);
    mkdirSync(join(home, RUN, 'repo', 'src'), { recursive: true });
    mkdirSync(join(home, RUN, 'recorded'), { recursive: true });
    const o = acceptance.parseAcceptanceArgs(['--org', ORG, '--phase', 'cleanup', '--run', RUN, '--home', home]);
    const { ctx, calls } = context(o, (c) => (azArgs(c)[2] === 'show' ? { status: 0, stdout: JSON.stringify({ id: PROJECT_ID, name: RUN }) } : { status: 0, stdout: '' }));
    acceptance.runPhases(ctx);
    expect(calls.map(azArgs)).toEqual([
      ['devops', 'project', 'show', '--project', PROJECT_ID, '--org', ORG, ...J],
      ['devops', 'project', 'delete', '--id', PROJECT_ID, '--org', ORG, '--yes', ...J],
    ]);
    expect(existsSync(join(home, RUN, 'repo'))).toBe(false);
    expect(existsSync(join(home, RUN, 'recorded'))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, `${RUN}.json`), 'utf8')).deletedAt).toBe('2026-10-29T12:00:00.000Z');
  });

  it('never deletes when the shown project is another one, or the manifest name lacks the prefix', () => {
    const home = freshDir('home');
    manifest(home);
    const o = acceptance.parseAcceptanceArgs(['--org', ORG, '--phase', 'cleanup', '--run', RUN, '--home', home]);
    const shownOther = context(o, () => ({ status: 0, stdout: JSON.stringify({ id: PROJECT_ID, name: 'Web' }) }));
    expect(() => acceptance.runPhases(shownOther.ctx)).toThrow(/is named "Web"/);
    expect(shownOther.calls.map((c) => azArgs(c)[2])).toEqual(['show']);

    const bad = freshDir('home');
    manifest(bad, { project: { name: 'Web', id: PROJECT_ID } });
    const noPrefix = context(acceptance.parseAcceptanceArgs(['--org', ORG, '--phase', 'cleanup', '--run', RUN, '--home', bad]), () => ({ status: 0, stdout: '{}' }));
    expect(() => acceptance.runPhases(noPrefix.ctx)).toThrow(/not this run's omg-acc-/);
    expect(noPrefix.calls).toEqual([]);

    const other = context(acceptance.parseAcceptanceArgs(['--org', ORG, '--phase', 'cleanup', '--run', RUN, '--home', home, '--project-id', '3411ebc1-d5aa-464f-9615-0b527bc66719']), () => ({ status: 0, stdout: '{}' }));
    expect(() => acceptance.runPhases(other.ctx)).toThrow(/not the project id in the manifest/);
    expect(other.calls).toEqual([]);
  });
});

describe('scripts/ado-acceptance.mjs az output and cleanup hardening', () => {
  it('asks every az call for JSON, and the extension commands for --detect false', () => {
    expect(acceptance.azArgv(['--version'])).toEqual(['--version']);
    expect(acceptance.azArgv(['account', 'show'])).toEqual(['account', 'show', '--output', 'json']);
    expect(acceptance.azArgv(['extension', 'show', '--name', 'azure-devops'])).toEqual(['extension', 'show', '--name', 'azure-devops', '--output', 'json']);
    for (const group of ['devops', 'repos', 'boards', 'pipelines']) expect(acceptance.azArgv([group, 'x'])).toEqual([group, 'x', ...J]);
  });

  it('refuses to delete when az devops project show prints no JSON (a table output default)', () => {
    const home = freshDir('home');
    manifest(home, { project: { name: RUN, id: '3411ebc1-d5aa-464f-9615-0b527bc66719' } });
    const o = acceptance.parseAcceptanceArgs(['--org', ORG, '--phase', 'cleanup', '--run', RUN, '--home', home]);
    const table = context(o, () => ({ status: 0, stdout: `ID                                    Name\n------------------------------------  ----\n${PROJECT_ID}  Production\n` }));
    expect(() => acceptance.runPhases(table.ctx)).toThrow(/no readable project/);
    expect(table.calls.map((c) => azArgs(c)[2])).toEqual(['show']);
    expect(() => acceptance.assertCleanupAllowed({ runId: RUN, project: { name: RUN, id: PROJECT_ID } }, { shown: null })).toThrow(/no readable project/);
  });

  it('needs --org for cleanup and refuses a manifest of another org', () => {
    expect(() => acceptance.parseAcceptanceArgs(['--phase', 'cleanup', '--run', RUN])).toThrow(/--org is required/);
    const home = freshDir('home');
    manifest(home);
    const other = context(acceptance.parseAcceptanceArgs(['--org', 'https://dev.azure.com/other-org', '--phase', 'cleanup', '--run', RUN, '--home', home]), () => ({ status: 0, stdout: '{}' }));
    expect(() => acceptance.runPhases(other.ctx)).toThrow(/is in https:\/\/dev\.azure\.com\/contoso-acc, not https:\/\/dev\.azure\.com\/other-org/);
    expect(other.calls).toEqual([]);
  });

  it('refuses before any az call when <home>/<runId> is a junction or symlink, and leaves its target alone', () => {
    const home = freshDir('home');
    manifest(home);
    const target = freshDir('not-ours');
    mkdirSync(join(target, 'repo', 'src'), { recursive: true });
    writeFileSync(join(target, 'repo', 'src', 'keep.txt'), 'keep', 'utf8');
    symlinkSync(target, join(home, RUN), process.platform === 'win32' ? 'junction' : 'dir');
    const o = acceptance.parseAcceptanceArgs(['--org', ORG, '--phase', 'cleanup', '--run', RUN, '--home', home]);
    const linked = context(o, () => ({ status: 0, stdout: JSON.stringify({ id: PROJECT_ID, name: RUN }) }));
    expect(() => acceptance.runPhases(linked.ctx)).toThrow(/refusing to remove .* is a link/);
    expect(linked.calls).toEqual([]);
    expect(readFileSync(join(target, 'repo', 'src', 'keep.txt'), 'utf8')).toBe('keep');
  });
});

describe('scripts/ado-acceptance.mjs heal-drill', () => {
  const SHA = 'a'.repeat(40);
  const drill = (withLanes: boolean, healRunStatus = 0, completedPrs = '[]') => {
    const home = freshDir('home');
    manifest(home);
    mkdirSync(join(home, RUN, 'repo'), { recursive: true });
    const o = acceptance.parseAcceptanceArgs(['--org', ORG, '--phase', 'heal-drill', '--run', RUN, '--home', home, ...(withLanes ? ['--with-lanes'] : [])]);
    const { ctx, calls } = context(o, (c) => {
      if (c.cmd === 'git') return { status: 0, stdout: c.args.includes('rev-parse') ? `${SHA}\n` : '' };
      if (c.cmd === ENTRY.command) {
        if (azArgs(c)[0] === 'pipelines') return { status: 0, stdout: JSON.stringify([{ id: 9, sourceVersion: SHA, status: 'completed', result: 'failed' }]) };
        if (azArgs(c).slice(0, 3).join(' ') === 'repos pr list') return { status: 0, stdout: completedPrs };
        return { status: 0, stdout: '{}' };
      }
      const omg = c.args.slice(1).join(' ');
      if (omg === 'factory heal scan --json') return { status: 0, stdout: JSON.stringify({ entries: [{ sig8: 'abcdef12' }] }) };
      if (omg === 'factory heal run abcdef12') return { status: healRunStatus, stdout: '' };
      return { status: 0, stdout: '{}' };
    });
    acceptance.runPhases(ctx);
    return calls.map((c) => (c.cmd === 'git' ? `git ${c.args.slice(2).join(' ')}` : c.cmd === ENTRY.command ? `az ${azArgs(c).join(' ')}` : `omg ${c.args.slice(1).join(' ')}`));
  };
  const policy = (enabled: string) => `az repos policy build update --id 3 --enabled ${enabled} --project ${RUN} --org ${ORG} ${J.join(' ')}`;

  it('switches the blocking policy off around each push to main and on again right after', () => {
    const seq = drill(false).filter((l) => l.startsWith('git push') || l.includes('policy build update'));
    expect(seq).toEqual([policy('false'), 'git push origin main', policy('true'), policy('false'), 'git push origin main', policy('true')]);
  });

  it('runs the billed heal run before approve with --with-lanes, and never approves without lanes or after a failed run', () => {
    const heal = (seq: string[]) => seq.filter((l) => l.startsWith('omg factory heal run') || l.startsWith('omg factory heal approve'));
    expect(heal(drill(true))).toEqual(['omg factory heal run abcdef12 --dry-run', 'omg factory heal run abcdef12', 'omg factory heal approve abcdef12']);
    expect(heal(drill(false))).toEqual(['omg factory heal run abcdef12 --dry-run']);
    expect(() => drill(true, 1)).toThrow(/heal-drill: 1 of/);
  });

  it('asks az for completed PRs of the run and fails when there is one (the factory never merges)', () => {
    expect(() => drill(true, 0, JSON.stringify([{ pullRequestId: 12, status: 'completed' }]))).toThrow(/heal-drill: 1 of/);
    expect(drill(true).filter((l) => l.startsWith('az repos pr list'))).toEqual([`az repos pr list --status completed --repository ${RUN} --project ${RUN} --org ${ORG} ${J.join(' ')}`]);
  });
});

describe('scripts/ado-acceptance.mjs --dry-run', () => {
  const source = freshDir('source');
  writeFileSync(join(source, 'BACKLOG.md'), BACKLOG, 'utf8');
  const dryLines = (argv: string[], home: string) => {
    const { ctx, lines, calls } = context(acceptance.parseAcceptanceArgs([...argv, '--dry-run', '--home', home]));
    acceptance.runPhases(ctx);
    expect(calls).toEqual([]);
    return lines;
  };

  it.each(['preflight', 'create', 'enqueue', 'exercise', 'heal-drill', 'capture', 'cleanup', 'all'])('--phase %s prints argv, spawns nothing and writes nothing', (phase) => {
    const home = join(freshDir('dry'), 'acceptance');
    const lines = dryLines(['--org', ORG, '--source', source, '--phase', phase, '--with-lanes'], home);
    expect(lines.some((l) => l.startsWith('[dry-run] '))).toBe(true);
    expect(existsSync(home)).toBe(false);
  });

  it('prints the exact az argv of the create phase, with the Windows python entry', () => {
    const lines = dryLines(['--org', ORG, '--source', source, '--phase', 'create'], join(freshDir('dry'), 'acceptance'));
    const az = (args: string[]) => `[dry-run] az: ${JSON.stringify([ENTRY.command, ...ENTRY.prefix, ...args])} (env AZ_INSTALLER=MSI)`;
    expect(lines).toContain(az(['devops', 'project', 'create', '--name', RUN, '--org', ORG, '--process', 'Agile', '--visibility', 'private', '--source-control', 'git', ...J]));
    expect(lines).toContain(az(['pipelines', 'create', '--name', 'ci', '--repository', RUN, '--repository-type', 'tfsgit', '--branch', 'main', '--yml-path', 'azure-pipelines.yml', '--skip-first-run', 'true', '--project', RUN, '--org', ORG, ...J]));
    expect(lines).toContain(az([
      'boards', 'work-item', 'create', '--type', 'Feature', '--title', `${RUN} spec: the BACKLOG.md tickets`,
      '--description', '<p>omg live acceptance spec: the <code>BACKLOG.md</code> tickets of the test repository, enqueued as its children with <code>omg factory enqueue</code>.</p>',
      '--project', RUN, '--org', ORG, ...J,
    ]));
    // The tickets are enqueue's job: create makes no other work item and no link.
    expect(lines.filter((l) => l.includes('"work-item"'))).toHaveLength(1);
    // The manifest is written before each create.
    const firstWrite = lines.findIndex((l) => l.startsWith('[dry-run] write') && l.includes(`${RUN}.json`));
    expect(firstWrite).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeLessThan(lines.findIndex((l) => l.includes('"project","create"')));
  });

  it('prints the delete argv of the manifest id and leaves the manifest and clone in place', () => {
    const home = freshDir('home');
    manifest(home);
    mkdirSync(join(home, RUN, 'repo'), { recursive: true });
    const before = readFileSync(join(home, `${RUN}.json`), 'utf8');
    const lines = dryLines(['--org', ORG, '--phase', 'cleanup', '--run', RUN], home);
    expect(lines).toContain(`[dry-run] az: ${JSON.stringify([ENTRY.command, ...ENTRY.prefix, 'devops', 'project', 'delete', '--id', PROJECT_ID, '--org', ORG, '--yes', ...J])} (env AZ_INSTALLER=MSI)`);
    expect(readFileSync(join(home, `${RUN}.json`), 'utf8')).toBe(before);
    expect(existsSync(join(home, RUN, 'repo'))).toBe(true);
  });

  it('spends no Copilot credits without --with-lanes: no factory run without --dry-run, no heal approve', () => {
    const home = join(freshDir('dry'), 'acceptance');
    const lines = [...dryLines(['--org', ORG, '--phase', 'exercise'], home), ...dryLines(['--org', ORG, '--phase', 'heal-drill'], home)];
    const omg = lines.filter((l) => l.startsWith('[dry-run] omg: ')).map((l) => JSON.parse(l.slice('[dry-run] omg: '.length).replace(/ \(cwd .*$/, '')).slice(2) as string[]);
    expect(omg).toContainEqual(['factory', 'run', '--next', '--parent', '<specId>', '--dry-run', '--json']);
    expect(omg.filter((a) => a[1] === 'run' && !a.includes('--dry-run'))).toEqual([]);
    expect(omg.some((a) => a.includes('approve') || a.includes('poll'))).toBe(false);
  });

  it('prints the enqueue flow in order: the user-config write, enqueue --dry-run, the signature, enqueue, the re-run', () => {
    const home = join(freshDir('dry'), 'acceptance');
    const lines = dryLines(['--org', ORG, '--source', source, '--phase', 'enqueue'], home);
    const tickets = join(home, `${acceptance.RUN_PREFIX}000000000000`, 'tickets.json');
    const at = (pred: (l: string) => boolean) => lines.findIndex(pred);
    const write = at((l) => l.startsWith(`user-scope write: ${USER_CONFIG}\n  factory.forge.azureDevOps.trustedAuthors: [] -> ["<spec creator uniqueName>"]`));
    const ask = at((l) => l.startsWith('[dry-run] would ask: Add <spec creator uniqueName> to factory.forge.azureDevOps.trustedAuthors'));
    const setup = at((l) => l.includes('"--trusted-author","<spec creator uniqueName>","--scope","user","--yes","--json"'));
    const dry = at((l) => l.includes(JSON.stringify(['factory', 'enqueue', '--spec', '<specId>', '--file', tickets, '--dry-run', '--json']).slice(1, -1)));
    const sign = at((l) => l.startsWith('[dry-run] would ask: Signature (launch C3): enqueue these 3 tickets as children of spec #<specId>?'));
    const real = at((l) => l.includes(JSON.stringify(['factory', 'enqueue', '--spec', '<specId>', '--file', tickets, '--json']).slice(1, -1)));
    expect([write, ask, setup, dry, sign, real].every((i) => i >= 0)).toBe(true);
    expect(write < ask && ask < setup && setup < dry && dry < sign && sign < real).toBe(true);
    expect(lines.slice(real + 1).some((l) => l.includes('"--dry-run","--json"') && l.includes('"enqueue"'))).toBe(true);
    expect(lines.some((l) => l.startsWith(`[dry-run] write ${tickets} (`))).toBe(true);
    // Without --source there is no BACKLOG.md to read: the dry run says so and still prints every argv.
    const bare = dryLines(['--org', ORG, '--phase', 'enqueue'], join(freshDir('dry'), 'acceptance'));
    expect(bare.some((l) => l.includes('pass --source to preview the ticket file'))).toBe(true);
    expect(bare.filter((l) => l.includes('"enqueue","--spec"'))).toHaveLength(3);
  });
});

describe('scripts/ado-acceptance.mjs create', () => {
  it('writes the manifest before the project create and records every created id', () => {
    const source = freshDir('source');
    writeFileSync(join(source, 'BACKLOG.md'), BACKLOG, 'utf8');
    const home = join(freshDir('live'), 'acceptance');
    const manifestFile = join(home, `${RUN}.json`);
    let pendingAtCreate: unknown;
    let pendingAtSpec: unknown;
    let nextId = 100;
    const o = acceptance.parseAcceptanceArgs(['--org', ORG, '--source', source, '--phase', 'create', '--home', home]);
    const { ctx, calls } = context(o, (c) => {
      if (c.cmd === 'git') {
        if (c.args[0] === 'clone') {
          mkdirSync(c.args[3], { recursive: true });
          writeFileSync(join(c.args[3], 'BACKLOG.md'), BACKLOG, 'utf8');
        }
        return { status: 0, stdout: c.args.includes('for-each-ref') ? 'HEAD\nmain\nfix/v1-review\n' : '' };
      }
      if (c.cmd !== ENTRY.command) return { status: 0, stdout: '{}' };
      const a = azArgs(c);
      const cmd = a.slice(0, 4).join(' ');
      if (cmd === 'devops project create --name') {
        pendingAtCreate = JSON.parse(readFileSync(manifestFile, 'utf8')).pending;
        return { status: 0, stdout: JSON.stringify({ id: PROJECT_ID, name: RUN }) };
      }
      if (cmd.startsWith('repos show')) return { status: 0, stdout: JSON.stringify({ id: 'b7a1c1a4-0000-4000-8000-000000000001', remoteUrl: `https://contoso-acc@dev.azure.com/contoso-acc/${RUN}/_git/${RUN}` }) };
      if (cmd === 'boards work-item create --type') {
        pendingAtSpec = JSON.parse(readFileSync(manifestFile, 'utf8')).pending;
        return { status: 0, stdout: JSON.stringify({ id: nextId++, fields: { 'System.CreatedBy': { displayName: 'Robin', uniqueName: 'robin@contoso.example' } } }) };
      }
      return { status: 0, stdout: JSON.stringify({ id: nextId++ }) };
    });
    acceptance.runPhases(ctx);
    expect(pendingAtCreate).toBe('project');
    expect(pendingAtSpec).toBe('spec');
    const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
    expect(m).toMatchObject({ runId: RUN, project: { name: RUN, id: PROJECT_ID }, pipeline: { id: 100 }, spec: { id: 101, createdBy: 'robin@contoso.example' }, policy: { id: 102 }, tickets: {}, trustedAuthorsAdded: [], pending: null, createdDone: true });
    const git = calls.filter((c) => c.cmd === 'git').map((c) => c.args.slice(2).join(' '));
    expect(git).toContain('push origin refs/remotes/origin/fix/v1-review:refs/heads/fix/v1-review');
    expect(git.every((g) => !/--force|\s-f\b|\+refs/.test(g))).toBe(true);
    // A blocking policy on main refuses direct pushes: it comes after the last one.
    const lastPush = calls.map((c) => c.cmd === 'git' && c.args.includes('push')).lastIndexOf(true);
    const policyAt = calls.findIndex((c) => c.cmd === ENTRY.command && azArgs(c).slice(0, 4).join(' ') === 'repos policy build create');
    expect(policyAt).toBeGreaterThan(lastPush);
    expect(readFileSync(join(home, RUN, 'repo', 'azure-pipelines.yml'), 'utf8')).toContain('pool:\n  name: Default\n');
    const omg = calls.find((c) => c.cmd === process.execPath);
    expect(omg?.args.slice(1)).toEqual(['factory', 'setup', '--forge', 'azure-devops', '--org', 'contoso-acc', '--project', RUN, '--repo', RUN, '--intake', `area-tag:${RUN}#factory`, '--progress', join(home, RUN, 'progress.json'), '--yes', '--json']);
  });
});

describe('scripts/ado-acceptance.mjs enqueue', () => {
  const ROWS = (action: string, ids: Array<number | null>) => ['exc-001', 'exc-006', 'exc-009'].map((key, i) => ({ key, id: ids[i], action, bucket: null, reasons: [], markCandidate: true }));
  const setupRun = (over: Record<string, unknown> = {}) => {
    const home = freshDir('home');
    manifest(home, { tickets: {}, ...over });
    mkdirSync(join(home, RUN, 'repo'), { recursive: true });
    writeFileSync(join(home, RUN, 'repo', 'BACKLOG.md'), BACKLOG, 'utf8');
    return home;
  };
  const run = (home: string, extra: Extra, enqueueAnswer?: (args: string[]) => { status: number; stdout: string } | undefined, more: string[] = []) => {
    const manifests: unknown[] = [];
    let dryRuns = 0;
    const o = acceptance.parseAcceptanceArgs(['--org', ORG, '--phase', 'enqueue', '--run', RUN, '--home', home, ...more]);
    const t = context(o, (c) => {
      const a = omgArgs(c);
      manifests.push(JSON.parse(readFileSync(join(home, `${RUN}.json`), 'utf8')));
      const custom = enqueueAnswer?.(a);
      if (custom) return custom;
      if (a[1] === 'setup') return { status: 0, stdout: '{}' };
      if (a.includes('--dry-run')) {
        dryRuns += 1;
        return { status: 0, stdout: JSON.stringify({ ok: true, dryRun: true, items: dryRuns === 1 ? ROWS('created', [null, null, null]) : ROWS('unchanged', [41, 42, 43]) }) };
      }
      return { status: 0, stdout: JSON.stringify({ ok: true, dryRun: false, items: ROWS('created', [41, 42, 43]), mark: { marker: 'factory-ready', marked: [41, 42], alreadyMarked: [], failed: [] } }) };
    }, extra);
    return { ...t, manifests, run: () => acceptance.runPhases(t.ctx) };
  };
  const tickets = (home: string) => join(home, RUN, 'tickets.json');

  it('prints and confirms the trustedAuthors write, records it first, then enqueues: --dry-run, the signature, enqueue, a re-run', () => {
    const home = setupRun();
    const r = run(home, { confirm: () => true, trustedAuthors: ['alice@contoso.example'] });
    r.run();
    const enqueue = ['factory', 'enqueue', '--spec', '40', '--file', tickets(home)];
    expect(r.calls.map(omgArgs)).toEqual([
      ['factory', 'setup', '--forge', 'azure-devops', '--org', 'contoso-acc', '--project', RUN, '--repo', RUN, '--intake', `area-tag:${RUN}#factory`, '--progress', join(home, RUN, 'progress.json'),
        '--trusted-author', 'alice@contoso.example,robin@contoso.example', '--scope', 'user', '--yes', '--json'],
      [...enqueue, '--dry-run', '--json'],
      [...enqueue, '--json'],
      [...enqueue, '--dry-run', '--json'],
    ]);
    expect(r.asked).toEqual([
      `Add robin@contoso.example to factory.forge.azureDevOps.trustedAuthors in ${USER_CONFIG}?`,
      'Signature (launch C3): enqueue these 3 tickets as children of spec #40?',
    ]);
    const shown = r.lines.findIndex((l) => l === `user-scope write: ${USER_CONFIG}\n  factory.forge.azureDevOps.trustedAuthors: ["alice@contoso.example"] -> ["alice@contoso.example","robin@contoso.example"]\n  robin@contoso.example created spec #40; enqueue trusts only these uniqueNames. Cleanup lists what this run added; it never removes it.`);
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(shown).toBeLessThan(r.lines.findIndex((l) => l.startsWith('asked: Add')));
    // The manifest names the author as pending before the user config is written, and the pending enqueue before the real one.
    expect(r.manifests[0]).toMatchObject({ trustPending: 'robin@contoso.example', trustedAuthorsAdded: [] });
    expect(r.manifests[1]).toMatchObject({ trustPending: null, trustedAuthorsAdded: ['robin@contoso.example'] });
    expect(r.manifests[2]).toMatchObject({ pending: 'enqueue' });
    // enqueue records into its own directory, never into the recording exercise reads.
    expect(r.calls.map((c) => c.env?.OMG_ADO_RECORD_DIR)).toEqual(Array(4).fill(join(home, RUN, 'recorded-enqueue')));
    expect(JSON.parse(readFileSync(tickets(home), 'utf8'))).toEqual(backlogToTicketFile(BACKLOG, 40).file);
    expect(JSON.parse(readFileSync(join(home, `${RUN}.json`), 'utf8'))).toMatchObject({
      pending: null, trustedAuthorsAdded: ['robin@contoso.example'],
      tickets: { 'exc-001': { id: 41, blockedBy: [] }, 'exc-006': { id: 42, blockedBy: [] }, 'exc-009': { id: 43, blockedBy: ['exc-001'] } },
    });
    expect(r.lines.filter((l) => l.startsWith('PASS'))).toHaveLength(4);
  });

  it('writes nothing to the user config and enqueues nothing when the trust is declined', () => {
    const home = setupRun();
    const r = run(home, { confirm: () => false });
    expect(r.run).toThrow(/not confirmed: .* is unchanged/);
    expect(r.calls).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, `${RUN}.json`), 'utf8')).trustedAuthorsAdded).toEqual([]);
  });

  it('skips the user-config write when the creator is already trusted (uniqueNames fold case)', () => {
    const home = setupRun();
    const r = run(home, { confirm: () => true, trustedAuthors: ['ROBIN@contoso.example'] });
    r.run();
    expect(r.calls.map((c) => omgArgs(c)[1])).toEqual(['enqueue', 'enqueue', 'enqueue']);
    expect(r.asked).toEqual(['Signature (launch C3): enqueue these 3 tickets as children of spec #40?']);
    expect(JSON.parse(readFileSync(join(home, `${RUN}.json`), 'utf8')).trustedAuthorsAdded).toEqual([]);
  });

  it('runs only the dry run when the signature is declined', () => {
    const home = setupRun();
    const r = run(home, { confirm: (q) => q.startsWith('Add ') });
    expect(r.run).toThrow(/enqueue not signed: nothing written/);
    expect(r.calls.map(omgArgs).map((a) => `${a[1]}${a.includes('--dry-run') ? ' --dry-run' : ''}`)).toEqual(['setup', 'enqueue --dry-run']);
  });

  it('stops on an enqueue refusal with enqueue\'s own error', () => {
    const home = setupRun();
    const r = run(home, { confirm: () => true, trustedAuthors: ['robin@contoso.example'] }, (a) => (a[1] === 'enqueue' ? { status: 2, stdout: JSON.stringify({ ok: false, error: 'ticket file: duplicate key exc-001' }) } : undefined));
    expect(r.run).toThrow(/omg factory enqueue --dry-run exited 2: ticket file: duplicate key exc-001/);
    expect(r.asked).toEqual([]);
  });

  it('keeps a failed real enqueue\'s warnings, records the ids it made, and says a rerun is idempotent', () => {
    const home = setupRun();
    const failed = { ok: false, dryRun: false, items: [{ key: 'exc-001', id: 41, action: 'created' }, { key: 'exc-006', id: null, action: 'created' }], warnings: ['exc-006: az exited 1: TF401019'] };
    const r = run(home, { confirm: () => true, trustedAuthors: ['robin@contoso.example'] }, (a) => (a[1] === 'enqueue' && !a.includes('--dry-run') ? { status: 1, stdout: JSON.stringify(failed) } : undefined));
    expect(r.run).toThrow(/omg factory enqueue exited 1: exc-006: az exited 1: TF401019; the manifest records ids #41; rerunning --phase enqueue is idempotent/);
    expect(JSON.parse(readFileSync(join(home, `${RUN}.json`), 'utf8'))).toMatchObject({ pending: 'enqueue', enqueuedBeforeFailure: { 'exc-001': 41 } });
  });

  it('keeps the author pending when setup fails, and cleanup says it may have been added', () => {
    const home = setupRun();
    const r = run(home, { confirm: () => true }, (a) => (a[1] === 'setup' ? { status: 1, stdout: '' } : undefined));
    expect(r.run).toThrow(/exit 1 from omg/);
    const m = JSON.parse(readFileSync(join(home, `${RUN}.json`), 'utf8'));
    expect(m).toMatchObject({ trustPending: 'robin@contoso.example', trustedAuthorsAdded: [] });
    const o = acceptance.parseAcceptanceArgs(['--org', ORG, '--phase', 'cleanup', '--run', RUN, '--home', home]);
    const { ctx, lines } = context(o, (c) => (azArgs(c)[2] === 'show' ? { status: 0, stdout: JSON.stringify({ id: PROJECT_ID, name: RUN }) } : { status: 0, stdout: '' }));
    acceptance.runPhases(ctx);
    expect(lines).toContain('no trustedAuthors were added by this run.');
    expect(lines).toContain(`robin@contoso.example may have been added to factory.forge.azureDevOps.trustedAuthors in ${USER_CONFIG}: the setup that adds it did not finish; check there yourself.`);
  });

  it('--yes gives both confirmations without asking and logs each one', () => {
    const home = setupRun();
    const r = run(home, {}, undefined, ['--yes']);
    r.run();
    expect(r.asked).toEqual([]);
    expect(r.lines).toContain(`Add robin@contoso.example to factory.forge.azureDevOps.trustedAuthors in ${USER_CONFIG}? yes (--yes)`);
    expect(r.lines).toContain('Signature (launch C3): enqueue these 3 tickets as children of spec #40? yes (--yes)');
    expect(r.calls.map((c) => omgArgs(c)[1])).toEqual(['setup', 'enqueue', 'enqueue', 'enqueue']);
  });

  it('refuses a run made before the enqueue flow (no spec work item)', () => {
    const home = setupRun({ spec: undefined });
    expect(run(home, { confirm: () => true }).run).toThrow(/has no spec work item/);
  });

  it('cleanup lists the trustedAuthors this run added and the user config they are in', () => {
    const home = freshDir('home');
    manifest(home, { trustedAuthorsAdded: ['robin@contoso.example'] });
    const o = acceptance.parseAcceptanceArgs(['--org', ORG, '--phase', 'cleanup', '--run', RUN, '--home', home]);
    const { ctx, lines } = context(o, (c) => (azArgs(c)[2] === 'show' ? { status: 0, stdout: JSON.stringify({ id: PROJECT_ID, name: RUN }) } : { status: 0, stdout: '' }));
    acceptance.runPhases(ctx);
    expect(lines).toContain(`this run added robin@contoso.example to factory.forge.azureDevOps.trustedAuthors in ${USER_CONFIG}; cleanup never edits the user config, so remove them there yourself if they should not stay trusted.`);
  });
});

describe('scripts/ado-acceptance.mjs exercise', () => {
  const ITEMS_BEFORE = [{ id: 41, bucket: 'runnable', reasons: [] }, { id: 43, bucket: 'blocked', reasons: ['depends-on:#41'] }];
  const ITEMS_AFTER = [{ id: 41, bucket: 'blocked', reasons: ['run-active:merge'] }, { id: 43, bucket: 'blocked', reasons: ['depends-on:#41'] }];
  const RECORDED = [
    { route: 'git.pullRequests.POST', exitCode: 0, requestBody: { isDraft: true, workItemRefs: [{ id: '41' }] }, stdout: {} },
    { route: 'policy.evaluations.GET', exitCode: 0, stdout: { value: [] } },
    { route: 'git.pullRequests.GET', exitCode: 0, stdout: { status: 'active' } },
    { route: 'wit.workItems.PATCH', exitCode: 0, routeParameters: { id: '41' }, requestBody: [{ op: 'add', path: '/fields/System.State', value: 'Resolved' }], stdout: {} },
    { route: 'wit.comments.POST', exitCode: 0, routeParameters: { workItemId: '41' }, requestBody: { text: 'Factory run for #41 is awaiting a human: **merge** (phase merge).' }, stdout: {} },
    { route: 'wit.comments.POST', exitCode: 0, routeParameters: { workItemId: '40' }, requestBody: { text: '- #41 ready to merge: https://dev.azure.com/contoso-acc/x/_git/x/pullrequest/5\n\n<!-- omg-factory-rollup: #41 ready-to-merge 0123456789ab -->\n' }, stdout: {} },
  ];
  /** What enqueue records: relation and mark PATCHes, here on the other tickets. */
  const ENQUEUE_PATCHES = [
    { route: 'wit.workItems.PATCH', exitCode: 0, routeParameters: { id: '42' }, requestBody: [{ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'x/40' } }], stdout: {} },
    { route: 'wit.workItems.PATCH', exitCode: 0, routeParameters: { id: '43' }, requestBody: [{ op: 'add', path: '/fields/System.Tags', value: 'factory-ready' }], stdout: {} },
  ];
  const exercise = (withLanes: boolean, recorded: object[] = RECORDED, completed = '[]') => {
    const home = freshDir('home');
    manifest(home);
    mkdirSync(join(home, RUN, 'recorded'), { recursive: true });
    recorded.forEach((f, i) => writeFileSync(join(home, RUN, 'recorded', `${i}.json`), JSON.stringify(f), 'utf8'));
    let parentChecks = 0;
    const o = acceptance.parseAcceptanceArgs(['--org', ORG, '--phase', 'exercise', '--run', RUN, '--home', home, ...(withLanes ? ['--with-lanes'] : [])]);
    const t = context(o, (c) => {
      if (c.cmd === ENTRY.command) return { status: 0, stdout: completed };
      const a = omgArgs(c).join(' ');
      if (a === 'factory check --parent 40 --json') return { status: 0, stdout: JSON.stringify({ items: parentChecks++ === 0 ? ITEMS_BEFORE : ITEMS_AFTER }) };
      if (a === 'factory run --next --parent 40 --dry-run --json') return { status: 0, stdout: JSON.stringify({ ok: true, next: 41, message: 'dry run' }) };
      if (a === 'factory run --next --parent 40 --json') return { status: 0, stdout: JSON.stringify({ ok: true, next: 41, message: 'awaiting-human: merge: ready. Resume with omg factory run 41.' }) };
      return { status: 0, stdout: '{}' };
    });
    return { ...t, run: () => acceptance.runPhases(t.ctx) };
  };

  it('checks the spec, picks with run --next --parent, and asserts ordering, write-back and no completed PR', () => {
    const r = exercise(true);
    r.run();
    expect(r.calls.filter((c) => c.cmd !== ENTRY.command).map((c) => omgArgs(c).join(' '))).toEqual([
      'factory check --json',
      'factory check --parent 40 --json',
      'factory board --json',
      'factory run --next --parent 40 --dry-run --json',
      'factory run --next --parent 40 --json',
      'factory poll --once --json',
      'factory check --parent 40 --json',
    ]);
    expect(r.calls.filter((c) => c.cmd === ENTRY.command).map(azArgs)).toEqual([['repos', 'pr', 'list', '--status', 'completed', '--repository', RUN, '--project', RUN, '--org', ORG, ...J]]);
    expect(r.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(r.lines).toEqual(expect.arrayContaining([
      'PASS  the 1 ticket(s) with a predecessor are blocked by it (depends-on)',
      'PASS  run --next picked #41, a runnable ticket without an open predecessor',
      'PASS  the spec #40 got the rollup line "- #41 ready to merge"',
      'PASS  #41 is no longer runnable while its PR waits for the human merge',
      'PASS  no PR of the run reached completed (the factory never merges)',
    ]));
  });

  it('runs no real factory run without --with-lanes, and still asserts the ordering', () => {
    const r = exercise(false);
    r.run();
    const omg = r.calls.filter((c) => c.cmd !== ENTRY.command).map((c) => omgArgs(c).join(' '));
    expect(omg.filter((a) => a.startsWith('factory run'))).toEqual(['factory run --next --parent 40 --dry-run --json']);
    expect(r.lines).toContain('PASS  run --next picked #41, a runnable ticket without an open predecessor');
  });

  it('fails when a PR of the run is completed or the rollup line is missing', () => {
    expect(exercise(true, RECORDED, JSON.stringify([{ pullRequestId: 5 }])).run).toThrow(/exercise: 1 of/);
    expect(exercise(true, RECORDED.slice(0, -1)).run).toThrow(/exercise: 1 of/);
  });

  it('fails the progress check when the recording holds only enqueue-style PATCHes on other ids, or no State op on the item', () => {
    const noProgress = [...RECORDED.filter((f) => f.route !== 'wit.workItems.PATCH'), ...ENQUEUE_PATCHES];
    const r = exercise(true, noProgress);
    expect(r.run).toThrow(/exercise: 1 of/);
    expect(r.lines).toContain('FAIL  progress moved #41 (a System.State PATCH)');
    const tagOnly = [...noProgress, { route: 'wit.workItems.PATCH', exitCode: 0, routeParameters: { id: '41' }, requestBody: [{ op: 'add', path: '/fields/System.Tags', value: 'x' }], stdout: {} }];
    expect(exercise(true, tagOnly).run).toThrow(/exercise: 1 of/);
    const moved = exercise(true, [...RECORDED, ...ENQUEUE_PATCHES]);
    moved.run();
    expect(moved.lines).toContain('PASS  progress moved #41 (a System.State PATCH)');
  });
});

describe('scripts/ado-acceptance.mjs flow assertions', () => {
  const TICKETS = { 'exc-001': { id: 41, blockedBy: [] }, 'exc-007': { id: 42, blockedBy: [] }, 'exc-009': { id: 43, blockedBy: ['exc-007', 'exc-001'] } };
  const what = (results: Array<{ what: string; ok: boolean }>) => results.filter((r) => !r.ok).map((r) => r.what);

  it('orderingAssertions: a ticket must be blocked by each of its predecessors, and --next must pick a runnable one', () => {
    const rows = [{ id: 41, bucket: 'runnable', reasons: [] }, { id: 42, bucket: 'runnable', reasons: [] }, { id: 43, bucket: 'blocked', reasons: ['depends-on:#42,#41'] }];
    expect(what(acceptance.orderingAssertions({ items: rows }, TICKETS, 41))).toEqual([]);
    expect(what(acceptance.orderingAssertions({ items: rows }, TICKETS, 43))).toEqual(['run --next picked #43, a runnable ticket without an open predecessor']);
    expect(what(acceptance.orderingAssertions({ items: [rows[0], rows[1], { id: 43, bucket: 'blocked', reasons: ['depends-on:#42'] }] }, TICKETS))).toEqual(['the 1 ticket(s) with a predecessor are blocked by it (depends-on)']);
    expect(what(acceptance.orderingAssertions({ items: [rows[0], rows[1], { id: 43, bucket: 'runnable', reasons: [] }] }, TICKETS))).toEqual(['the 1 ticket(s) with a predecessor are blocked by it (depends-on)']);
    expect(what(acceptance.orderingAssertions({ items: rows.slice(1) }, TICKETS))).toEqual(['check --parent lists all 3 tickets']);
    expect(what(acceptance.orderingAssertions({ items: rows }, TICKETS, null))).toEqual(['run --next picked #null, a runnable ticket without an open predecessor']);
  });

  it('enqueueAssertions: planned, ids, marked, and an unchanged re-run', () => {
    const file = { tickets: [{ key: 'exc-001' }, { key: 'exc-009' }] };
    const dry = { ok: true, dryRun: true, items: [{ key: 'exc-001', id: null, action: 'created' }, { key: 'exc-009', id: null, action: 'created' }] };
    const real = { ok: true, dryRun: false, items: [{ key: 'exc-001', id: 41, action: 'created' }, { key: 'exc-009', id: 43, action: 'created' }], mark: { marked: [41], alreadyMarked: [], failed: [] } };
    const again = { ok: true, dryRun: true, items: [{ key: 'exc-001', id: 41, action: 'unchanged' }, { key: 'exc-009', id: 43, action: 'unchanged' }] };
    expect(what(acceptance.enqueueAssertions(file, dry, real, again))).toEqual([]);
    const changed = { ...again, items: [again.items[0], { ...again.items[1], action: 'updated' }] };
    expect(what(acceptance.enqueueAssertions(file, dry, { ...real, mark: { marked: [], alreadyMarked: [], failed: [{ id: 41, error: 'x' }] } }, changed))).toEqual([
      'the mark step marked the runnable tickets', 'an enqueue re-run (--dry-run) finds every ticket unchanged',
    ]);
  });

  it('outcomeAssertions: the merge gate comment, the rollup line on the spec, and no spec edit', () => {
    const posts = [
      { route: 'wit.comments.POST', exitCode: 0, routeParameters: { workItemId: '41' }, requestBody: { text: 'Factory run for #41 is awaiting a human: **merge** (phase merge).' } },
      { route: 'wit.comments.POST', exitCode: 0, routeParameters: { workItemId: '40' }, requestBody: { text: '- #41 ready to merge: https://x/pr/5' } },
    ];
    expect(what(acceptance.outcomeAssertions(posts, '40', 41))).toEqual([]);
    expect(what(acceptance.outcomeAssertions([{ ...posts[0], exitCode: 1 }, posts[1], { route: 'wit.workItems.PATCH', exitCode: 0, routeParameters: { id: '40' } }], '40', 41))).toEqual([
      '#41 got the merge gate comment', 'the spec #40 itself is never edited',
    ]);
  });
});

describe('scripts/ado-acceptance.mjs options and assertions', () => {
  it('defaults to the self-hosted pool Default and selects Microsoft-hosted with --hosted', () => {
    const base = ['--org', ORG, '--source', 'C:/src'];
    expect(acceptance.parseAcceptanceArgs(base).pool).toEqual({ kind: 'self-hosted', name: 'Default' });
    expect(acceptance.parseAcceptanceArgs([...base, '--pool', 'Robin PC']).pool).toEqual({ kind: 'self-hosted', name: 'Robin PC' });
    expect(acceptance.parseAcceptanceArgs([...base, '--hosted']).pool).toEqual({ kind: 'microsoft', vmImage: 'ubuntu-latest' });
    expect(() => acceptance.parseAcceptanceArgs([...base, '--hosted', '--pool', 'x'])).toThrow(/pass one/);
    expect(acceptance.pipelineYaml({ kind: 'microsoft', vmImage: 'ubuntu-latest' })).toContain('pool:\n  vmImage: ubuntu-latest\n');
    expect(acceptance.poolAdvice({ kind: 'self-hosted', name: 'Default' }, [{ name: 'Azure Pipelines' }])).toMatch(/no pool named "Default"/);
    expect(() => acceptance.parseAcceptanceArgs(['--org', 'https://evil.example/x', '--source', 'C:/src'])).toThrow(/--org must be/);
    expect(() => acceptance.parseAcceptanceArgs(['--phase', 'cleanup', '--run', 'Web'])).toThrow(/--run must be/);
  });

  it('checks the exercise outcome from the recording: draft PR linked, gates read, parked, never completed', () => {
    const recorded = [
      { route: 'git.pullRequests.POST', exitCode: 0, requestBody: { isDraft: true, workItemRefs: [{ id: '102' }] }, stdout: {} },
      { route: 'policy.evaluations.GET', exitCode: 0, stdout: { value: [] } },
      { route: 'git.pullRequests.GET', exitCode: 0, stdout: { status: 'active' } },
      { route: 'git.pullRequests.PATCH', exitCode: 0, requestBody: { isDraft: false }, stdout: {} },
      { route: 'wit.workItems.PATCH', exitCode: 0, routeParameters: { id: '102' }, requestBody: [{ op: 'add', path: '/fields/System.State', value: 'Active' }], stdout: {} },
    ];
    expect(acceptance.exerciseAssertions(recorded, 'issue 102: awaiting-human: merge', '102').every((r: { ok: boolean }) => r.ok)).toBe(true);
    const merged = [...recorded, { route: 'git.pullRequests.GET', exitCode: 0, stdout: { value: [{ status: 'completed' }] } }];
    expect(acceptance.exerciseAssertions(merged, 'awaiting-human: merge', '102').find((r: { what: string }) => r.what.includes('never completed')).ok).toBe(false);
  });
});

describe('scripts/ado-acceptance.mjs confirmOnTty', () => {
  const ask = (isTerminal: boolean, chunks: Array<string | Error>) => {
    const out: string[] = [];
    const read = (buf: Buffer) => {
      const next = chunks.shift();
      if (next === undefined) return 0;
      if (next instanceof Error) throw next;
      return buf.write(next);
    };
    return { answer: acceptance.confirmOnTty('Proceed?', { isTerminal: () => isTerminal, read, out: (s: string) => out.push(s) }), out: out.join('') };
  };

  it('says no without a terminal, never reading', () => {
    const r = ask(false, [new Error('read without a terminal')]);
    expect(r.answer).toBe(false);
    expect(r.out).toContain('no: stdin is not a terminal (pass --yes to confirm)');
  });

  it('reads y as yes and an empty line as no, across chunks and CRLF', () => {
    expect(ask(true, ['y\r\n']).answer).toBe(true);
    expect(ask(true, ['Y', 'es\r\n']).answer).toBe(true);
    expect(ask(true, ['\r\n']).answer).toBe(false);
    expect(ask(true, ['n\n']).answer).toBe(false);
  });

  it('says no with the reason on a read error (EAGAIN)', () => {
    const r = ask(true, [Object.assign(new Error('resource temporarily unavailable'), { code: 'EAGAIN' })]);
    expect(r.answer).toBe(false);
    expect(r.out).toContain('no: could not read the answer (EAGAIN); pass --yes to confirm');
  });
});

describe('scripts/ado-capture.mjs', () => {
  it('runs GETs only', () => {
    expect(() => assertReadOnly(['devops', 'invoke', '--area', 'git', '--http-method', 'GET'])).not.toThrow();
    expect(() => assertReadOnly(['--version'])).not.toThrow();
    expect(() => assertReadOnly(['devops', 'invoke', '--area', 'git', '--http-method', 'POST'])).toThrow(/GETs only/);
    expect(() => assertReadOnly(['devops', 'invoke', '--area', 'git', '--http-method', 'patch'])).toThrow(/GETs only/);
    expect(() => assertReadOnly(['devops', 'invoke', '--area', 'git', '--in-file', 'x'])).toThrow(/never sends a body/);
    expect(() => assertReadOnly(['devops', 'project', 'delete', '--id', 'x'])).toThrow(/GETs only/);
    expect(() => assertReadOnly(['repos', 'create', '--name', 'x'])).toThrow(/GETs only/);
    expect(() => assertReadOnly(['devops', 'invoke', '--area', 'git', '--http-method=POST'])).toThrow(/GETs only/);
    expect(() => assertReadOnly(['devops', 'invoke', '--area', 'git', '--http-method=get'])).not.toThrow();
    expect(() => assertReadOnly(['devops', 'invoke', '--area', 'git', '--http-method', 'GET', '--http-method', 'DELETE'])).toThrow(/GETs only/);
    expect(() => assertReadOnly(['devops', 'invoke', '--area', 'git', '--http-meth', 'GET'])).toThrow(/GETs only/);
    expect(() => assertReadOnly(['devops', 'invoke', '--area', 'git', '--in-file=x'])).toThrow(/never sends a body/);
    expect(() => assertReadOnly(['devops', 'invoke', '--area', 'git', '--in-f', 'x'])).toThrow(/never sends a body/);
  });

  it('pins the same area, resource and api-version as routes.ts for every shared route', () => {
    for (const [id, r] of Object.entries(CAPTURE_ROUTES) as Array<[string, { area: string; resource: string; apiVersion: string }]>) {
      const route = ADO_ROUTES.find((x) => x.id === id);
      if (route) expect({ area: route.area, resource: route.resource, apiVersion: route.apiVersion }, id).toEqual(r);
    }
  });

  it('masks secrets like redactAdoSecrets', () => {
    const classic = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
    const azdo = `${'A1'.repeat(38)}AZDOx9y8`;
    for (const s of [`token ${classic} end`, `pat=${azdo}`, 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Bearer abc.def-ghi_jkl', 'plain text']) expect(redactLocal(s)).toBe(redactAdoSecrets(s));
  });

  it('captures a world of GET fixtures that parse with the fixture loader', () => {
    const out = freshDir('capture');
    const written = new Map<string, string>();
    const seen: string[][] = [];
    const answers: Record<string, unknown> = {
      'core/projects': { id: PROJECT_ID, name: RUN },
      'git/repositories': { id: '3411ebc1-d5aa-464f-9615-0b527bc66719', name: RUN },
      'git/pullRequests': { value: [{ pullRequestId: 5, sourceRefName: 'refs/heads/factory/issue-41' }] },
      'build/builds': { value: [{ id: 9, result: 'failed' }] },
      'build/timeline': { records: [{ type: 'Task', result: 'failed', log: { id: 4 } }] },
    };
    const az = (args: string[]) => {
      seen.push(args);
      const area = args[args.indexOf('--area') + 1];
      const resource = args[args.indexOf('--resource') + 1];
      const byId = args.some((a) => a.startsWith('pullRequestId='));
      const body = byId ? { pullRequestId: 5, sourceRefName: 'refs/heads/factory/issue-41', status: 'active' } : answers[`${area}/${resource}`] ?? { value: [] };
      return { status: 0, stdout: JSON.stringify(body), stderr: '' };
    };
    const result = capture({ org: ORG, project: RUN, repo: RUN, moment: 'draft', out, workItems: ['41'], prs: [], builds: [], dryRun: false }, {
      az, write: (p: string, t: string) => written.set(p, t), readText: () => `log ${'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst'}`, now: () => new Date('2026-10-29T12:00:00Z'),
    });
    expect(result).toEqual({ dir: join(out, 'draft'), prs: ['5'], builds: ['9'] });
    for (const args of seen) expect(() => assertReadOnly(args)).not.toThrow();
    const textLogs = seen.filter((a) => a.includes('--accept-media-type'));
    expect(textLogs).toHaveLength(1);
    expect(textLogs[0]).toEqual(invokeArgs(ORG, 'build.logs.GET', { project: RUN, buildId: '9', logId: '4' }, {}, textLogs[0][textLogs[0].indexOf('--out-file') + 1]));
    expect(textLogs[0][textLogs[0].indexOf('--out-file') + 1]).toMatch(/build-9-log-4\.txt$/);
    expect([...written].find(([p]) => p.endsWith('build-9-log-4.txt'))?.[1]).toBe('log ***');
    const fixtures = [...written].filter(([p]) => p.endsWith('.json') && !p.includes('env'));
    const routes = new Set(fixtures.map(([, t]) => JSON.parse(t).route));
    expect([...routes].sort()).toEqual([
      'build.builds.GET', 'build.definitions.GET', 'build.logs.GET', 'build.timeline.GET', 'core.projects.GET', 'git.pullRequestIterations.GET', 'git.pullRequestStatuses.GET',
      'git.pullRequestThreads.GET', 'git.pullRequests.GET', 'git.repositories.GET', 'policy.evaluations.GET', 'wit.comments.GET', 'wit.workItems.GET',
    ]);
    for (const [name, text] of fixtures) {
      if (!ADO_ROUTES.some((r) => r.id === JSON.parse(text).route)) continue;
      expect(() => parseAdoFixture(name, text)).not.toThrow();
    }
    const evaluation = fixtures.map(([, t]) => JSON.parse(t)).find((f) => f.route === 'policy.evaluations.GET');
    expect(evaluation.queryParameters).toEqual({ artifactId: `vstfs:///CodeReview/CodeReviewId/${PROJECT_ID}/5` });
  });
});

describe('scripts/ado-fixture-import.mjs', () => {
  const PAT = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
  const REPO_GUID = '3411ebc1-d5aa-464f-9615-0b527bc66719';
  const live = (over: Record<string, unknown> = {}) => ({
    provenance: 'recorded live-capture 2026-10-29T12:00:00.000Z moment draft',
    route: 'git.pullRequests.GET',
    routeParameters: { project: RUN, repositoryId: RUN, pullRequestId: '5' },
    queryParameters: {},
    exitCode: 0,
    stdout: {
      repository: { id: REPO_GUID, name: RUN, url: `https://dev.azure.com/contoso-acc/_apis/git/repositories/${REPO_GUID}`, project: { id: PROJECT_ID, name: RUN } },
      createdBy: { displayName: 'Robin Example', uniqueName: 'robin@platypus.example', id: 'd6245f20-2af8-44f4-9451-8107cb2767db', imageUrl: 'https://dev.azure.com/contoso-acc/_apis/GraphProfile/MemberAvatars/aad.OGI1ZTlmZjQtZjM5MS03ZTI2' },
      description: `Robin Example wrote this; mail robin@platypus.example. Build policy 0609b952-1397-4640-95ec-e00a01b2c241. token ${PAT}`,
      remoteUrl: `https://contoso-acc@dev.azure.com/contoso-acc/${RUN}/_git/${RUN}`,
      reviewers: [{ uniqueName: 'ROBIN@platypus.example', displayName: 'Robin Example' }],
    },
    stderr: '',
    ...over,
  });
  const writeCapture = (files: Record<string, unknown>) => {
    const dir = freshDir('import');
    for (const [rel, value] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
    }
    return dir;
  };
  const options = (into: string) => ({ org: 'contoso-acc', project: RUN, repo: RUN, redact: redactAdoSecrets, routes: ADO_ROUTES, into });

  it('scrubs PATs, people, emails, names and GUIDs consistently, and keeps the GUID shape and policy type ids', () => {
    const dir = writeCapture({ 'draft/git.pullRequests.GET.a.json': live(), 'draft/env/az-version.txt': 'azure-cli 2.79', 'manifest.json': { org: ORG } });
    const into = join(freshDir('into'), 'live');
    const plan = planImport(dir, options(into));
    expect(plan.writes.map((w: { path: string }) => w.path)).toEqual([join(into, 'draft', 'git.pullRequests.GET.a.json')]);
    const text = plan.writes[0].text;
    const f = JSON.parse(text);
    for (const leak of [PAT, 'platypus', 'Robin', 'contoso-acc', RUN, REPO_GUID, PROJECT_ID, 'OGI1ZTlm']) expect(text).not.toContain(leak);
    expect(f.routeParameters).toEqual({ project: 'Web', repositoryId: 'web-app', pullRequestId: '5' });
    expect(f.stdout.repository).toMatchObject({ name: 'web-app', project: { name: 'Web' } });
    expect(f.stdout.createdBy.uniqueName).toBe('user1@example.com');
    expect(f.stdout.reviewers[0]).toEqual({ uniqueName: 'user1@example.com', displayName: 'User 1' });
    expect(f.stdout.description).toBe('User 1 wrote this; mail user1@example.com. Build policy 0609b952-1397-4640-95ec-e00a01b2c241. token ***');
    expect(f.stdout.remoteUrl).toBe('https://contoso@dev.azure.com/contoso/Web/_git/web-app');
    expect(f.stdout.createdBy.imageUrl).toBe('https://dev.azure.com/contoso/_apis/GraphProfile/MemberAvatars/aad.descriptor1');
    expect(f.stdout.repository.id).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
    expect(f.stdout.repository.url).toContain(f.stdout.repository.id);
    expect(f.stdout.repository.project.id).not.toBe(f.stdout.repository.id);
    expect(() => parseAdoFixture('live.json', text)).not.toThrow();
  });

  it('scrubs self-hosted agent details: agent and machine names, profile paths and the agent _work path', () => {
    const timeline = live({
      route: 'build.timeline.GET',
      routeParameters: { project: RUN, buildId: '9' },
      stdout: { records: [{ name: 'npm run check', workerName: 'ROBIN-DESKTOP' }], note: 'ran on ROBIN-DESKTOP in C:\\Users\\robin\\agent\\_work\\1\\s' },
    });
    const dir = writeCapture({
      'm/build.timeline.GET.a.json': timeline,
      'm/logs-text/build-9-log-1.txt': [
        "Agent name: 'robin-agent'",
        "Agent machine name: 'ROBIN-DESKTOP'",
        'Working directory C:\\Users\\robin\\agent\\_work\\1\\s and D:\\agents\\a1\\_work\\_temp',
        'npm cache /home/robin/.npm, tool /Users/robin/bin, COMPUTERNAME=ROBIN-DESKTOP',
      ].join('\n'),
    });
    const into = join(freshDir('into'), 'live');
    const plan = planImport(dir, options(into));
    const text = plan.writes.map((w: { text: string }) => w.text).join('\n');
    for (const leak of ['ROBIN-DESKTOP', 'robin-agent', 'robin', 'agents\\a1']) expect(text).not.toContain(leak);
    const log = plan.writes.find((w: { path: string }) => w.path.endsWith('.txt')).text;
    expect(log).toContain("Agent machine name: 'agent");
    expect(log).toContain('Working directory C:\\agent\\_work\\1\\s and C:\\agent\\_work\\_temp');
    expect(log).toContain('npm cache /home/user/.npm, tool /Users/user/bin, COMPUTERNAME=agent');
    const timelineFile = plan.writes.find((w: { path: string }) => w.path.endsWith('.json'));
    expect(JSON.parse(timelineFile.text).stdout).toEqual({ records: [{ name: 'npm run check', workerName: 'agent1' }], note: 'ran on agent1 in C:\\agent\\_work\\1\\s' });
  });

  it('refuses a file whose agent details survive scrubbing', () => {
    const scrub = createScrubber({ org: 'contoso-acc', project: RUN, repo: RUN, redact: (s: string) => s });
    expect(scrub.problem("Agent name: 'robin-agent'")).toMatch(/agent or machine/);
    expect(scrub.problem('at C:\\Users\\robin\\x')).toMatch(/user profile path/);
    expect(scrub.problem(JSON.stringify({ p: 'C:\\Users\\robin\\x' }))).toMatch(/user profile path/);
    expect(scrub.problem('at D:\\a1\\_work\\1')).toMatch(/_work path/);
    expect(scrub.problem(JSON.stringify({ p: 'C:\\agent\\_work\\1', u: 'C:\\Users\\user\\x', a: "Agent name: 'agent1'" }))).toBeUndefined();
    scrub.learn({ workerName: 'ROBIN-DESKTOP' });
    expect(scrub.problem('built on ROBIN-DESKTOP')).toMatch(/agent or machine/);
  });

  it('maps one GUID to one replacement across files', () => {
    const scrub = createScrubber({ org: 'contoso-acc', project: RUN, repo: RUN, redact: redactAdoSecrets });
    const a = scrub.text(`x ${REPO_GUID} y ${PROJECT_ID}`);
    const b = scrub.text(`${PROJECT_ID.toUpperCase()} ${REPO_GUID}`);
    const [ga, pa] = a.split(' ').filter((s: string) => s.includes('-'));
    expect(b).toBe(`${pa.toUpperCase()} ${ga}`);
  });

  it('refuses the whole import when a file is still unsafe after scrubbing, and writes nothing', () => {
    const into = join(freshDir('into'), 'live');
    const dirty = writeCapture({ 'a/git.pullRequests.GET.a.json': live(), 'a/git.pullRequests.GET.b.json': live({ stderr: 'header X-AZDO-Token leaked' }) });
    expect(() => planImport(dirty, options(into))).toThrow(/git\.pullRequests\.GET\.b\.json: refused after scrubbing, it contains AZDO/);
    expect(existsSync(into)).toBe(false);
  });

  it('leaves out fixtures for routes this build lacks and never replaces an existing file', () => {
    const into = join(freshDir('into'), 'live');
    const dir = writeCapture({
      'm/build.definitions.GET.a.json': live({ route: 'build.definitions.GET', routeParameters: { project: RUN } }),
      'm/git.pullRequests.GET.a.json': live({ queryParameters: { notAParam: '1' } }),
      'm/logs-text/build-9-log-4.txt': `2026-10-29T12:00:00Z ##[error] ${PAT} in omg-acc-202610291200`,
    });
    const plan = planImport(dir, options(into));
    expect(plan.skipped.map((s: { rel: string; why: string }) => s.why).sort()).toEqual([
      'queryParameters.notAParam is not allowed by git.pullRequests.GET',
      ...(ADO_ROUTES.some((r) => r.id === 'build.definitions.GET') ? [] : ["route build.definitions.GET is not in this build's route table"]),
    ].sort());
    expect(plan.writes.find((w: { path: string }) => w.path.endsWith('.txt')).text).toBe('2026-10-29T12:00:00Z ##[error] *** in Web');
    mkdirSync(join(into, 'm', 'logs-text'), { recursive: true });
    writeFileSync(join(into, 'm', 'logs-text', 'build-9-log-4.txt'), 'old', 'utf8');
    expect(() => planImport(dir, options(into))).toThrow(/exists; imports add files and never replace them/);
    expect(readdirSync(join(into, 'm', 'logs-text'))).toEqual(['build-9-log-4.txt']);
  });
});
