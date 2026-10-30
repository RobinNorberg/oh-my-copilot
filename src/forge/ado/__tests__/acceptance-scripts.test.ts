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
import { redactAdoSecrets } from '../redact.js';
import { ADO_ROUTES } from '../routes.js';
import { parseAdoFixture } from './fixtures.js';
// @ts-expect-error Script source is intentionally JavaScript-only.
import { backlogToWorkItems, inlineHtml, parseBacklog } from '../../../../scripts/lib/backlog-to-workitems.mjs';
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

  it('builds escaped HTML fields and reports dependencies the backlog does not define', () => {
    const { items, unknown } = backlogToWorkItems(BACKLOG);
    expect(items[0]).toMatchObject({
      key: 'EXC-001',
      title: 'EXC-001 Fuel gauge',
      descriptionHtml: '<p>Depends on: none.</p>',
    });
    expect(items[0].acceptanceHtml).toBe(
      '<ul><li>Add <code>fuel</code> (0..<code>EXCAVATOR.fuelCapacity</code>) to <code>ExcavatorState</code>.</li>'
      + '<li>At zero fuel the excavator cannot drive; delivered &gt;= required &amp; &lt;done&gt;.</li>'
      + '<li>Tests: drain rate, empty-tank immobility, refuel pickup.</li></ul>',
    );
    expect(unknown).toEqual(['EXC-009 depends on EXC-007, which BACKLOG.md does not define']);
    expect(inlineHtml('`<script>` & "x"')).toBe('<code>&lt;script&gt;</code> &amp; &quot;x&quot;');
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
    project: { name: RUN, id: PROJECT_ID }, repo: { name: RUN, id: 'r', url: 'u' }, pipeline: { id: 7 }, policy: { id: 3 }, workItems: { 'EXC-001': 41 }, trustedAuthorsAdded: [],
    ...over,
  };
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, `${RUN}.json`), JSON.stringify(m), 'utf8');
  return m;
}

type Call = { cmd: string; args: string[] };
function context(o: Record<string, unknown>, answer?: (call: Call) => { status: number; stdout: string; stderr?: string }) {
  const lines: string[] = [];
  const calls: Call[] = [];
  const spawn = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (!answer) throw new Error(`spawned in a dry run: ${cmd} ${args.join(' ')}`);
    return { stderr: '', ...answer({ cmd, args }) };
  };
  const ctx = acceptance.createContext(o, { spawn, azEntry: ENTRY, log: (l: string) => lines.push(l), now: () => new Date('2026-10-29T12:00:00Z'), env: {} });
  return { ctx, lines, calls };
}
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
  const drill = (withLanes: boolean, healRunStatus = 0) => {
    const home = freshDir('home');
    manifest(home);
    mkdirSync(join(home, RUN, 'repo'), { recursive: true });
    const o = acceptance.parseAcceptanceArgs(['--org', ORG, '--phase', 'heal-drill', '--run', RUN, '--home', home, ...(withLanes ? ['--with-lanes'] : [])]);
    const { ctx, calls } = context(o, (c) => {
      if (c.cmd === 'git') return { status: 0, stdout: c.args.includes('rev-parse') ? `${SHA}\n` : '' };
      if (c.cmd === ENTRY.command) {
        if (azArgs(c)[0] === 'pipelines') return { status: 0, stdout: JSON.stringify([{ id: 9, sourceVersion: SHA, status: 'completed', result: 'failed' }]) };
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

  it.each(['preflight', 'create', 'exercise', 'heal-drill', 'capture', 'cleanup', 'all'])('--phase %s prints argv, spawns nothing and writes nothing', (phase) => {
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
      'boards', 'work-item', 'create', '--type', 'User Story', '--title', 'EXC-006 Camera shake',
      '--description', '<p>Depends on: none. Wave 8: the only call site of <code>updateCamera</code> is <code>src/app.ts</code>.</p>',
      '--fields', 'Microsoft.VSTS.Common.AcceptanceCriteria=<ul><li><code>updateCamera</code> takes the frame\'s events.</li></ul>', 'System.Tags=factory', '--project', RUN, '--org', ORG, ...J,
    ]));
    expect(lines).toContain(az(['boards', 'work-item', 'relation', 'add', '--id', '<wi:EXC-009>', '--relation-type', 'predecessor', '--target-id', '<wi:EXC-001>', '--org', ORG, ...J]));
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
    const omg = lines.filter((l) => l.startsWith('[dry-run] omg: '));
    expect(omg.some((l) => l.includes('"factory","run","<first runnable id>","--dry-run"'))).toBe(true);
    expect(omg.some((l) => /"factory","run","[^"]+"\]/.test(l))).toBe(false);
    expect(omg.some((l) => l.includes('"approve"') || l.includes('"poll"'))).toBe(false);
    expect(omg.some((l) => /"heal","run","[^"]+"]/.test(l))).toBe(false);
  });
});

describe('scripts/ado-acceptance.mjs create', () => {
  it('writes the manifest before the project create and records every created id', () => {
    const source = freshDir('source');
    writeFileSync(join(source, 'BACKLOG.md'), BACKLOG, 'utf8');
    const home = join(freshDir('live'), 'acceptance');
    const manifestFile = join(home, `${RUN}.json`);
    let pendingAtCreate: unknown;
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
      if (cmd.startsWith('boards work-item relation list-type')) return { status: 0, stdout: JSON.stringify([{ name: 'Parent' }, { name: 'Predecessor' }]) };
      return { status: 0, stdout: JSON.stringify({ id: nextId++ }) };
    });
    acceptance.runPhases(ctx);
    expect(pendingAtCreate).toBe('project');
    const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
    expect(m).toMatchObject({ runId: RUN, project: { name: RUN, id: PROJECT_ID }, pipeline: { id: 100 }, policy: { id: 105 }, workItems: { 'EXC-001': 101, 'EXC-006': 102, 'EXC-009': 103 }, pending: null, createdDone: true });
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
      { route: 'wit.workItems.PATCH', exitCode: 0, stdout: {} },
    ];
    expect(acceptance.exerciseAssertions(recorded, 'issue 102: awaiting-human: merge', '102').every((r: { ok: boolean }) => r.ok)).toBe(true);
    const merged = [...recorded, { route: 'git.pullRequests.GET', exitCode: 0, stdout: { value: [{ status: 'completed' }] } }];
    expect(acceptance.exerciseAssertions(merged, 'awaiting-human: merge', '102').find((r: { what: string }) => r.what.includes('never completed')).ok).toBe(false);
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
