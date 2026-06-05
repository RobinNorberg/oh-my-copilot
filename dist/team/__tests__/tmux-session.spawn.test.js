import { beforeEach, describe, expect, it, vi } from 'vitest';
const mockedCalls = vi.hoisted(() => ({
    tmuxArgs: [],
    paneCapture: '',
    paneStatus: '0 zsh\n',
    echoOnLiteralSend: true,
    wrapLiteralCapture: false,
}));
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        tmuxExec: vi.fn((args) => {
            mockedCalls.tmuxArgs.push(args);
            return '';
        }),
        tmuxExecAsync: vi.fn(async (args) => {
            mockedCalls.tmuxArgs.push(args);
            if (args[0] === 'capture-pane') {
                const stdout = args.includes('-J')
                    ? mockedCalls.paneCapture.replace(/\n/g, '')
                    : mockedCalls.paneCapture;
                return { stdout, stderr: '' };
            }
            if (args[0] === 'send-keys' && args.includes('-l') && mockedCalls.echoOnLiteralSend) {
                const literal = args[args.length - 1] ?? '';
                mockedCalls.paneCapture = mockedCalls.wrapLiteralCapture
                    ? `${literal.slice(0, 80)}\n${literal.slice(80)}`
                    : literal;
            }
            return { stdout: '', stderr: '' };
        }),
        tmuxCmdAsync: vi.fn(async (args) => {
            mockedCalls.tmuxArgs.push(args);
            if (args[0] === 'display-message' && args.includes('#{pane_dead} #{pane_current_command}')) {
                return { stdout: mockedCalls.paneStatus, stderr: '' };
            }
            return { stdout: '', stderr: '' };
        }),
    };
});
import { spawnBridgeInSession, spawnWorkerInPane } from '../tmux-session.js';
describe('spawnWorkerInPane', () => {
    beforeEach(() => {
        mockedCalls.tmuxArgs = [];
        mockedCalls.paneCapture = '';
        mockedCalls.paneStatus = '0 zsh\n';
        mockedCalls.echoOnLiteralSend = true;
        mockedCalls.wrapLiteralCapture = false;
        vi.unstubAllEnvs();
    });
    it('uses argv-style launch with literal tmux send-keys', async () => {
        await spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto', '--model', 'gpt-5;touch /tmp/pwn'],
            cwd: '/tmp',
        });
        const literalSend = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys' && args.includes('-l'));
        expect(literalSend).toBeDefined();
        const launchLine = literalSend?.[literalSend.length - 1] ?? '';
        expect(launchLine).toContain('exec "$@"');
        expect(launchLine).toContain("'--'");
        expect(launchLine).toContain("'gpt-5;touch /tmp/pwn'");
        expect(launchLine).not.toContain('exec codex --full-auto');
    });
    it('uses current JS runtime when launching bridge-entry helpers', () => {
        spawnBridgeInSession('session:0', '/tmp/bridge-entry.js', '/tmp/bridge-config.json');
        const sendKeys = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys');
        expect(sendKeys).toBeDefined();
        const launchLine = sendKeys?.[3] ?? '';
        expect(launchLine).toContain(process.execPath);
        expect(launchLine).toContain('/tmp/bridge-entry.js');
        expect(launchLine).toContain('--config');
        expect(launchLine).not.toMatch(/^node\s/);
    });
    it('fails before Enter when tmux does not echo the delivered start command', async () => {
        mockedCalls.paneCapture = '';
        mockedCalls.echoOnLiteralSend = false;
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        })).rejects.toThrow(/worker_start_delivery_unverified:worker-1:%2:/);
        const enterSend = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter');
        expect(enterSend).toBeUndefined();
    });
    it('verifies wrapped worker start commands with joined tmux capture before Enter', async () => {
        mockedCalls.wrapLiteralCapture = true;
        await spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
                OMC_TEAM_LONG_VALUE: 'x'.repeat(160),
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto', '--model', 'gpt-5.5', '--reasoning-effort', 'high'],
            cwd: '/tmp',
        });
        expect(mockedCalls.tmuxArgs).toContainEqual(['capture-pane', '-J', '-t', '%2', '-p', '-S', '-80']);
        const enterSend = mockedCalls.tmuxArgs.find((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter');
        expect(enterSend).toBeDefined();
    });
    it('fails before send-keys when the target pane shell never becomes ready', async () => {
        mockedCalls.paneStatus = '1 zsh\n';
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: {
                OMC_TEAM_NAME: 'safe-team',
                OMC_TEAM_WORKER: 'safe-team/worker-1',
            },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        })).rejects.toThrow(/worker_start_shell_not_ready:worker-1:%2:/);
        expect(mockedCalls.tmuxArgs.some((args) => args[0] === 'send-keys' && args.includes('-l'))).toBe(false);
    });
    it('rejects invalid team names before command construction', async () => {
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'Bad-Team',
            workerName: 'worker-1',
            envVars: { OMC_TEAM_NAME: 'Bad-Team' },
            launchBinary: 'codex',
            launchArgs: ['--full-auto'],
            cwd: '/tmp',
        })).rejects.toThrow('Invalid team name');
    });
    it('rejects invalid environment keys', async () => {
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: { 'BAD-KEY': 'x' },
            launchBinary: 'codex',
            cwd: '/tmp',
        })).rejects.toThrow('Invalid environment key');
    });
    it('rejects unsafe launchBinary values', async () => {
        await expect(spawnWorkerInPane('session:0', '%2', {
            teamName: 'safe-team',
            workerName: 'worker-1',
            envVars: { OMC_TEAM_NAME: 'safe-team' },
            launchBinary: 'codex;touch /tmp/pwn',
            cwd: '/tmp',
        })).rejects.toThrow('Invalid launchBinary');
    });
});
//# sourceMappingURL=tmux-session.spawn.test.js.map