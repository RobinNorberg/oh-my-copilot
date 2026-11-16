/**
 * budget-guard.mjs and verify-deliverables.mjs join the stdin session id into
 * a `state/sessions/<id>/` path. Only an id on the validateSessionId()
 * allowlist may reach that path; anything else behaves as with no session id
 * (legacy state only).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const NODE = process.execPath;
const tempDirs = [];
function makeTempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    // A git root anchors the state root at <dir>/.omg (a non-git dir resolves to ~/.omg).
    execFileSync('git', ['init', '-q'], { cwd: dir });
    tempDirs.push(dir);
    return dir;
}
function hookEnv(extra = {}) {
    const env = { ...process.env, NODE_ENV: 'test', ...extra };
    delete env.CLAUDE_PLUGIN_ROOT;
    delete env.OMC_STATE_DIR;
    return env;
}
afterEach(() => {
    for (const dir of tempDirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});
describe('budget-guard.mjs session id allowlist', () => {
    const SCRIPT = join(process.cwd(), 'scripts', 'budget-guard.mjs');
    function runGuard(projectDir, sessionId) {
        const transcript = join(projectDir, 'transcript.jsonl');
        writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 500, output_tokens: 500 } } })}\n`);
        return spawnSync(NODE, [SCRIPT], {
            cwd: projectDir,
            encoding: 'utf-8',
            input: JSON.stringify({ hook_event_name: 'Stop', cwd: projectDir, session_id: sessionId, transcript_path: transcript }),
            env: hookEnv({ OMC_BUDGET_ENFORCE: 'active', OMC_RUN_BUDGET_TOKENS: '100' }),
            timeout: 15000,
        });
    }
    it('reads session-scoped mode state for an allowlisted id (control)', () => {
        const projectDir = makeTempDir('budget-guard-sid-');
        const sessionDir = join(projectDir, '.omg', 'state', 'sessions', 'sess-ok');
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(join(sessionDir, 'ralph-state.json'), JSON.stringify({ active: true }));
        const result = runGuard(projectDir, 'sess-ok');
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('Run budget exhausted');
    });
    it('never reads mode state through a traversal session id', () => {
        const projectDir = makeTempDir('budget-guard-sid-');
        // state/sessions/../../../escaped resolves to <project>/escaped
        const escaped = join(projectDir, 'escaped');
        mkdirSync(escaped, { recursive: true });
        writeFileSync(join(escaped, 'ralph-state.json'), JSON.stringify({ active: true }));
        mkdirSync(join(projectDir, '.omg', 'state'), { recursive: true });
        const result = runGuard(projectDir, '../../../escaped');
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('Run budget exhausted');
    });
});
describe('verify-deliverables.mjs session id allowlist', () => {
    const SCRIPT = join(process.cwd(), 'scripts', 'verify-deliverables.mjs');
    it('never probes a path built from a traversal session id', () => {
        const projectDir = makeTempDir('verify-deliverables-sid-');
        const omcRoot = join(projectDir, '.omg');
        mkdirSync(join(omcRoot, 'state'), { recursive: true });
        writeFileSync(join(omcRoot, 'deliverables.json'), JSON.stringify({ 'team-plan': { files: ['DESIGN.md'], minSize: 10 } }));
        writeFileSync(join(omcRoot, 'state', 'team-state.json'), JSON.stringify({ current_phase: 'team-plan' }));
        // Record every path the hook probes or reads.
        const probeLog = join(projectDir, 'probes.log');
        const preload = join(projectDir, 'probe.cjs');
        writeFileSync(preload, `
const fs = require('fs');
const { syncBuiltinESMExports } = require('module');
const log = ${JSON.stringify(probeLog)};
const appendFileSync = fs.appendFileSync;
for (const name of ['existsSync', 'readFileSync']) {
  const original = fs[name];
  fs[name] = function (path, ...rest) {
    if (typeof path === 'string' && path !== log) appendFileSync(log, path + '\\n');
    return original.call(this, path, ...rest);
  };
}
syncBuiltinESMExports();
`);
        const result = spawnSync(NODE, ['--require', preload, SCRIPT], {
            cwd: projectDir,
            encoding: 'utf-8',
            input: JSON.stringify({ hook_event_name: 'SubagentStop', cwd: projectDir, session_id: '../../../escaped' }),
            env: hookEnv(),
            timeout: 15000,
        });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toEqual({ continue: true, suppressOutput: true });
        const probes = existsSync(probeLog) ? readFileSync(probeLog, 'utf-8').split('\n').filter(Boolean) : [];
        // The legacy team state was read, so the hook got as far as stage detection.
        expect(probes).toContain(join(omcRoot, 'state', 'team-state.json'));
        expect(probes.filter((p) => p.includes('escaped'))).toEqual([]);
    });
});
//# sourceMappingURL=hook-session-id-allowlist.test.js.map