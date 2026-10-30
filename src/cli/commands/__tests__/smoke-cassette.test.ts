import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { cassetteOptionsError, runCopilotSmoke, type SmokeReport } from '../../../smoke/copilot-smoke.js';
import { CASSETTE_FORMAT, CASSETTE_VERSION, readCassette, writeCassette, type Cassette } from '../../../smoke/replay/cassette.js';
import { digest } from '../../../smoke/replay/normalize.js';
import { platformTag } from '../../../smoke/replay/run.js';
import { expandHome, toSmokeOptions, verifyCassettes } from '../smoke.js';

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function cassette(scenario: string, model = 'gpt-5-mini'): Cassette {
  return {
    manifest: {
      format: CASSETTE_FORMAT,
      version: CASSETTE_VERSION,
      scenario,
      recordedAt: '2026-10-30T00:00:00.000Z',
      omg: { version: '0.0.0' },
      sdk: { version: '1.0.16' },
      platform: process.platform,
      arch: process.arch,
      model,
      redaction: { rules: 1, hits: {} },
      streams: [{ id: 's1-root', promptDigest: digest('prompt'), session: 1, agent: 'root', interactions: 1 }],
    },
    interactions: [{
      stream: 's1-root',
      seq: 1,
      req: { method: 'POST', path: '/chat/completions', transport: 'http', headers: {}, deltaDigest: digest('delta') },
      res: { status: 200, headers: { 'content-type': 'application/json' }, kind: 'json', body: { ok: true } },
    }],
  };
}

/** A cassette root holding `scenarios` for this machine. */
function cassetteRoot(scenarios: string[], model?: string): string {
  const root = tempDir('omg-cassettes-');
  for (const s of scenarios) writeCassette(join(root, platformTag(), s), cassette(s, model));
  return root;
}

describe('omg smoke copilot --record / --replay flag validation', () => {
  const noCi = {};

  it('maps the flags to tier 2 options', () => {
    expect(toSmokeOptions({ scenario: 'smoke,factory-run', model: 'm', record: 'out' }, noCi))
      .toMatchObject({ tier: 2, scenarios: ['smoke', 'factory-run'], model: 'm', record: 'out' });
    expect(toSmokeOptions({ scenario: 'team', record: 'out', model: 'm', recordOverwrite: true }, noCi)).toMatchObject({ recordOverwrite: true });
    expect(toSmokeOptions({ scenario: 'team', replay: 'fx', replayStrict: true }, noCi)).toMatchObject({ tier: 2, replay: 'fx', replayStrict: true });
    // --replay alone implies tier 2 with the default scenarios.
    expect(toSmokeOptions({ replay: 'fx' }, noCi)).toMatchObject({ tier: 2, replay: 'fx' });
    // `~` is expanded (PowerShell passes it unexpanded).
    expect(toSmokeOptions({ scenario: 'smoke', model: 'm', record: '~/omg-cassettes' }, noCi).record).toBe(join(homedir(), 'omg-cassettes'));
    expect(expandHome('~\\x')).toBe(join(homedir(), 'x'));
    expect(expandHome('a/~')).toBe('a/~');
  });

  it('refuses --record with --replay, a dangling sub-flag, tier 1 and no scenario', () => {
    expect(() => toSmokeOptions({ scenario: 'smoke', model: 'm', record: 'a', replay: 'b' }, noCi)).toThrow(/cannot be combined/);
    expect(() => toSmokeOptions({ scenario: 'smoke', recordOverwrite: true }, noCi)).toThrow(/--record-overwrite needs --record/);
    expect(() => toSmokeOptions({ scenario: 'smoke', replayStrict: true }, noCi)).toThrow(/--replay-strict needs --replay/);
    expect(() => toSmokeOptions({ tier: '1', replay: 'fx' }, noCi)).toThrow(/need --tier 2/);
    expect(cassetteOptionsError({ tier: 1, replay: 'fx' }, noCi)).toMatch(/--replay needs --tier 2/);
    expect(() => toSmokeOptions({ sdkStatic: true, replay: 'fx' }, noCi)).toThrow(/needs at least one scenario/);
  });

  it('refuses --record under CI and without a pinned model', () => {
    expect(() => toSmokeOptions({ scenario: 'smoke', model: 'm', record: 'out' }, { CI: 'true' })).toThrow(/refused under CI/);
    expect(toSmokeOptions({ scenario: 'smoke', model: 'm', record: 'out' }, { CI: 'false' })).toMatchObject({ record: 'out' });
    expect(() => toSmokeOptions({ scenario: 'smoke', record: 'out' }, noCi)).toThrow(/--record needs --model/);
    // --replay under CI is the point of it.
    expect(toSmokeOptions({ scenario: 'smoke', replay: 'fx' }, { CI: 'true' })).toMatchObject({ replay: 'fx' });
  });

  it('refuses the copilot -p scenarios by name in both modes', () => {
    for (const name of ['chain', 'continuation', 'prompt-context', 'events', 'ultragoal']) {
      expect(() => toSmokeOptions({ scenario: `smoke,${name}`, replay: 'fx' }, noCi))
        .toThrow(`replay: scenario ${name} runs copilot -p, which has no replay seam`);
      expect(() => toSmokeOptions({ scenario: name, model: 'm', record: 'out' }, noCi)).toThrow(/^record: scenario .* has no replay seam/);
    }
    expect(toSmokeOptions({ scenario: 'smoke,guardrail,factory-run,factory-run-fix,team,sandbox-lane', replay: 'fx' }, noCi)).toMatchObject({ replay: 'fx' });
  });

  it('runCopilotSmoke checks the cassettes before spending anything', async () => {
    const root = cassetteRoot(['smoke']);
    // An existing recording is not overwritten silently.
    await expect(runCopilotSmoke({ tier: 2, scenarios: ['smoke'], model: 'm', record: root, env: {} }))
      .rejects.toThrow(/already holds a recording; pass --record-overwrite/);
    // Recording into the repo's fixtures is refused (record elsewhere, then import).
    await expect(runCopilotSmoke({ tier: 2, scenarios: ['smoke'], model: 'm', record: join(tempDir('repo-'), 'src', 'smoke', '__tests__', 'fixtures', 'cassettes'), env: {} }))
      .rejects.toThrow(/refusing to record into the fixtures dir/);
    // Replay pins the recorded model.
    await expect(runCopilotSmoke({ tier: 2, scenarios: ['smoke'], model: 'other', replay: root, env: {} }))
      .rejects.toThrow(/--model other differs from the cassettes' recorded model gpt-5-mini/);
    const mixed = cassetteRoot(['smoke']);
    writeCassette(join(mixed, platformTag(), 'guardrail'), cassette('guardrail', 'claude-x'));
    await expect(runCopilotSmoke({ tier: 2, scenarios: ['smoke', 'guardrail'], replay: mixed, env: {} }))
      .rejects.toThrow(/recorded on different models/);
  });
});

describe('omg smoke cassette verify', () => {
  const report = (over: Partial<SmokeReport>): SmokeReport => ({
    ok: true, tier: 2, pluginRoot: '/r', pluginVersion: '1', copilot: { bin: '/c', version: '1' }, checks: [], artifacts: {}, durationMs: 1, ...over,
  });

  it('gates every cassette, replays this platform\'s cassettes and records selfVerify', async () => {
    const root = cassetteRoot(['smoke', 'team']);
    writeCassette(join(root, 'other-arch', 'smoke'), { ...cassette('smoke'), manifest: { ...cassette('smoke').manifest, arch: 'other' } });
    const runSmoke = vi.fn(async () => report({ replay: { smoke: { ok: true, misses: 0, drift: 1 }, team: { ok: false, misses: 2, drift: 0 } }, ok: false }));
    const result = await verifyCassettes(root, { runSmoke });
    expect(runSmoke).toHaveBeenCalledWith({ tier: 2, scenarios: ['smoke', 'team'], replay: root });
    expect(result.ok).toBe(false);
    expect(readCassette(join(root, platformTag(), 'smoke')).manifest.selfVerify).toEqual({ ok: true, misses: 0, drift: 1 });
    expect(readCassette(join(root, platformTag(), 'team')).manifest.selfVerify).toEqual({ ok: false, misses: 2, drift: 0 });
  });

  it('a gate failure fails verify and that cassette is not replayed; --gate-only never replays', async () => {
    const root = cassetteRoot(['smoke', 'team']);
    writeFileSync(join(root, platformTag(), 'team', 'interactions.jsonl'), `${JSON.stringify({ ...cassette('team').interactions[0], res: { status: 200, headers: {}, kind: 'text', body: `ghp_${'b'.repeat(36)}` } })}\n`);
    const runSmoke = vi.fn(async () => report({ replay: { smoke: { ok: true, misses: 0, drift: 0 } } }));
    const result = await verifyCassettes(root, { runSmoke });
    expect(result.ok).toBe(false);
    expect(runSmoke).toHaveBeenCalledWith(expect.objectContaining({ scenarios: ['smoke'] }));
    expect(result.lines.join('\n')).toMatch(/gate .*team\n.*ghp_/);

    runSmoke.mockClear();
    expect((await verifyCassettes(cassetteRoot(['smoke']), { runSmoke, gateOnly: true })).ok).toBe(true);
    expect(runSmoke).not.toHaveBeenCalled();
  });

  it('an empty root fails', async () => {
    expect((await verifyCassettes(tempDir('empty-'))).ok).toBe(false);
  });
});
