import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const resolution = vi.hoisted(() => ({ resolveHostBinaryLaunch: vi.fn() }));
vi.mock('../../../platform/executable-resolution.js', async (importOriginal) => {
    const actual = await importOriginal();
    resolution.resolveHostBinaryLaunch.mockImplementation(actual.resolveHostBinaryLaunch);
    return { ...actual, resolveHostBinaryLaunch: resolution.resolveHostBinaryLaunch };
});
import { buildSchedulePlan, checkOrCreateHarborLabels, checkTrackerReachable, defaultIntakeRunner, filterCrontabLines, parseSimpleCron, runHeadlessIntake, validateHostBin, } from '../intake.js';
describe('defaultIntakeRunner on win32', () => {
    const realPlatform = process.platform;
    it('launches a .cmd host shim through cmd.exe (CreateProcess cannot exec it directly)', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        try {
            resolution.resolveHostBinaryLaunch.mockReturnValueOnce({ file: 'C:\\npm\\copilot.cmd', viaCmd: true });
            vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: 'ok', stderr: '' });
            const result = defaultIntakeRunner('copilot', ['-p', '/oh-my-copilot:harbor sweep', '--no-ask-user'], { cwd: '.', env: { COPILOT_ALLOW_ALL: 'false' } });
            expect(result.status).toBe(0);
            const [file, args, options] = vi.mocked(spawnSync).mock.calls.at(-1);
            expect(file).toBe(process.env.COMSPEC || 'cmd.exe');
            expect(args).toEqual(['/d', '/s', '/c', '"C:\\npm\\copilot.cmd -p "/oh-my-copilot:harbor sweep" --no-ask-user"']);
            expect(options).toMatchObject({ windowsVerbatimArguments: true });
            expect(options.env.COPILOT_ALLOW_ALL).toBe('false');
        }
        finally {
            Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
        }
    });
    it('spawns a native .exe directly', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        try {
            resolution.resolveHostBinaryLaunch.mockReturnValueOnce({ file: 'C:\\bin\\gh.exe', viaCmd: false });
            vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
            defaultIntakeRunner('gh', ['repo', 'view'], { cwd: '.' });
            const [file, args, options] = vi.mocked(spawnSync).mock.calls.at(-1);
            expect(file).toBe('C:\\bin\\gh.exe');
            expect(args).toEqual(['repo', 'view']);
            expect(options).toMatchObject({ windowsVerbatimArguments: false });
        }
        finally {
            Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
        }
    });
});
function runnerFrom(handler) {
    return (cmd, args) => {
        const r = handler(cmd, args);
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
}
const HARBOR_LABELS_ALL = [
    'harbor:accepted',
    'harbor:need-decision',
    'harbor:need-info',
    'harbor:rejected',
    'harbor:for-maintainer',
    'harbor:needs-exploration',
    'harbor:merge-ready',
    'harbor:changes-requested',
];
function okRunner() {
    return runnerFrom((cmd, args) => {
        if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view')
            return { status: 0, stdout: 'repo' };
        if (cmd === 'gh' && args[0] === 'label' && args[1] === 'list')
            return { status: 0, stdout: JSON.stringify(HARBOR_LABELS_ALL) };
        return { status: 0, stdout: '' };
    });
}
describe('parseSimpleCron', () => {
    it('classifies step-minutes expressions', () => {
        expect(parseSimpleCron('*/30 * * * *')).toEqual({ kind: 'minutes', every: 30 });
        expect(parseSimpleCron('*/15 * * * *')).toEqual({ kind: 'minutes', every: 15 });
    });
    it('classifies daily expressions', () => {
        expect(parseSimpleCron('0 6 * * *')).toEqual({ kind: 'daily', hour: 6, minute: 0 });
        expect(parseSimpleCron('30 23 * * *')).toEqual({ kind: 'daily', hour: 23, minute: 30 });
    });
    it('refuses expressions Task Scheduler cannot express', () => {
        expect(parseSimpleCron('*/7 * * * *').kind).toBe('unsupported');
        expect(parseSimpleCron('0 6 1 * *').kind).toBe('unsupported');
        expect(parseSimpleCron('0 6 * * 1').kind).toBe('unsupported');
        expect(parseSimpleCron('garbage').kind).toBe('unsupported');
    });
});
describe('buildSchedulePlan', () => {
    it('plans a crontab line on unix hosts', () => {
        const plan = buildSchedulePlan('linux', '*/30 * * * *', 'omg intake run --headless');
        expect(plan).toMatchObject({ platform: 'cron' });
        if ('crontabLine' in plan)
            expect(plan.crontabLine).toContain('# omc-intake');
    });
    it('plans schtasks minutes on Windows', () => {
        const plan = buildSchedulePlan('win32', '*/30 * * * *', 'omg intake run --headless');
        if ('schtaskArgs' in plan) {
            expect(plan.schtaskArgs).toContain('/SC');
            expect(plan.schtaskArgs).toContain('MINUTE');
            expect(plan.schtaskArgs).toContain('30');
        }
        else {
            throw new Error('expected schtask plan');
        }
    });
    it('plans schtasks daily on Windows', () => {
        const plan = buildSchedulePlan('win32', '0 6 * * *', 'omg intake run --headless');
        if ('schtaskArgs' in plan) {
            expect(plan.schtaskArgs).toContain('/ST');
            expect(plan.schtaskArgs).toContain('06:00');
        }
        else {
            throw new Error('expected schtask plan');
        }
    });
    it('refuses unsupported expressions on Windows instead of approximating', () => {
        const plan = buildSchedulePlan('win32', '*/7 * * * *', 'omg intake run --headless');
        expect('refused' in plan).toBe(true);
    });
});
describe('filterCrontabLines', () => {
    it('installs one marked line and replaces an existing one', () => {
        const existing = '0 0 * * * other-job\n*/30 * * * * omg intake run --headless --cwd "/old" # omc-intake';
        const updated = filterCrontabLines(existing, false, '*/15 * * * * omg intake run --cwd "/new" # omc-intake');
        expect(updated.split('\n')).toHaveLength(2);
        expect(updated).toContain('*/15');
        expect(updated).not.toContain('/old');
    });
    it('removes marked lines with --off and keeps unrelated jobs', () => {
        const existing = '0 0 * * * other-job\n*/30 * * * * omg intake run # omc-intake';
        const updated = filterCrontabLines(existing, true);
        expect(updated).toBe('0 0 * * * other-job');
    });
});
describe('runHeadlessIntake preconditions', () => {
    it('refuses when the tracker is unreachable', () => {
        const runner = runnerFrom((cmd) => (cmd === 'gh' ? { status: 1, stderr: 'api down' } : { status: 0 }));
        const result = runHeadlessIntake({ allowDocketOnly: true }, runner);
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('tracker unreachable');
    });
    it('refuses when a harbor label cannot be created', () => {
        const runner = runnerFrom((cmd, args) => {
            if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view')
                return { status: 0, stdout: 'repo' };
            if (cmd === 'gh' && args[0] === 'label' && args[1] === 'list')
                return { status: 0, stdout: '[{"name":"other"}]' };
            return { status: 1, stderr: 'permission denied' };
        });
        const result = runHeadlessIntake({ allowDocketOnly: true }, runner);
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('cannot create missing label');
    });
    it('refuses without --allow-docket-only or a verified channel', () => {
        const result = runHeadlessIntake({}, okRunner());
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('--allow-docket-only');
    });
    it('runs the headless copilot session (-p, --no-ask-user) on a Copilot host', () => {
        vi.stubEnv('COPILOT_CLI', '1');
        vi.stubEnv('COPILOT_ALLOW_ALL', 'true');
        let spawnedCommand = '';
        let spawnedArgs = [];
        let spawnedEnv = {};
        const runner = (cmd, args, options) => {
            if (cmd === 'copilot') {
                spawnedCommand = cmd;
                spawnedArgs = args;
                spawnedEnv = (options.env ?? {});
                return { status: 0, stdout: 'sweep output', stderr: '' };
            }
            return okRunner()(cmd, args, { cwd: '.' });
        };
        try {
            const result = runHeadlessIntake({ allowDocketOnly: true, cwd: '.' }, runner);
            expect(result.exitCode).toBe(0);
            expect(spawnedCommand).toBe('copilot');
            expect(spawnedArgs).toEqual(['-p', '/oh-my-copilot:harbor sweep', '--no-ask-user']);
            // The runner merges options.env over process.env, so this overrides an inherited 'true'.
            expect(spawnedEnv.COPILOT_ALLOW_ALL).toBe('false');
        }
        finally {
            vi.unstubAllEnvs();
        }
    });
    it.each(['tools/copilot', '..\\copilot', 'copilot;rm', 'copilot&calc', 'co pilot', 'copilot%X%', ' copilot', ''])('refuses an unsafe --host-bin before running anything: %j', (hostBin) => {
        const calls = [];
        const runner = (cmd, args) => {
            calls.push(cmd);
            return okRunner()(cmd, args, { cwd: '.' });
        };
        const result = runHeadlessIntake({ allowDocketOnly: true, cwd: '.', hostBin }, runner);
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('--host-bin');
        expect(calls).toEqual([]);
    });
    it.each(['copilot', 'claude.cmd', 'C:\\Program Files\\nodejs\\copilot.cmd', '/usr/local/bin/copilot'])('accepts a bare name or absolute --host-bin: %j', (hostBin) => {
        expect(validateHostBin(hostBin)).toBeUndefined();
    });
    it('runs the headless session with guardrails enabled when preconditions hold', () => {
        // Claude-host expectations: pin the host signal.
        vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
        vi.stubEnv('COPILOT_CLI', '');
        vi.stubEnv('COPILOT_AGENT_SESSION_ID', '');
        let spawnedCommand = '';
        let spawnedArgs = [];
        let spawnedEnv = {};
        const runner = (cmd, args, options) => {
            if (cmd === 'claude') {
                spawnedCommand = cmd;
                spawnedArgs = args;
                spawnedEnv = (options.env ?? {});
                return { status: 0, stdout: 'sweep output', stderr: '' };
            }
            return okRunner()(cmd, args, { cwd: '.' });
        };
        try {
            const result = runHeadlessIntake({ allowDocketOnly: true, cwd: '.' }, runner);
            expect(result.exitCode).toBe(0);
            expect(spawnedCommand).toBe('claude');
            expect(spawnedArgs).toEqual(['--print', '/oh-my-copilot:harbor sweep']);
            expect(spawnedEnv.OMC_GIT_GUARDRAILS).toBe('1');
        }
        finally {
            vi.unstubAllEnvs();
        }
    });
});
describe('checkTrackerReachable', () => {
    it('passes through gh failure diagnostics', () => {
        const runner = runnerFrom(() => ({ status: 1, stderr: 'rate limited' }));
        const check = checkTrackerReachable('.', runner);
        expect(check.ok).toBe(false);
        expect(check.reason).toContain('rate limited');
    });
});
describe('checkOrCreateHarborLabels', () => {
    it('creates only the missing labels', () => {
        const created = [];
        const runner = runnerFrom((cmd, args) => {
            if (cmd === 'gh' && args[0] === 'label' && args[1] === 'list') {
                return { status: 0, stdout: JSON.stringify([{ name: 'harbor:accepted' }]) };
            }
            if (cmd === 'gh' && args[0] === 'label' && args[1] === 'create') {
                created.push(args[2]);
                return { status: 0 };
            }
            return { status: 0, stdout: '' };
        });
        const check = checkOrCreateHarborLabels('.', runner);
        expect(check.ok).toBe(true);
        expect(created).toEqual(HARBOR_LABELS_ALL.filter((l) => l !== 'harbor:accepted'));
    });
});
//# sourceMappingURL=intake.test.js.map