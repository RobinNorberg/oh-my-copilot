import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// fork deviation: the split path must discard the private pane env file when the
// guarded split is known not to have run or throws (upstream dropped the discard).
const state = vi.hoisted(() => ({
    envRoot: '',
    runtimeThrows: false,
    envDirsSeenAtCall: -1,
    ifShellCalls: 0,
}));
function paneEnvDirs() {
    return readdirSync(state.envRoot).filter(name => name.startsWith('omc-pane-env-'));
}
vi.mock('../runtime-owner-client.js', async (importOriginal) => ({
    ...await importOriginal(),
    resolveRuntimeCliPath: () => {
        state.envDirsSeenAtCall = paneEnvDirs().length;
        if (state.runtimeThrows)
            throw new Error('runtime unavailable');
        return fileURLToPath(import.meta.url);
    },
}));
vi.mock('../../cli/tmux-utils.js', async (importOriginal) => ({
    ...await importOriginal(),
    tmuxCmdAsync: async (args) => {
        const failure = args.join(' ').match(/OMC_TMUX_GUARD_FAIL_[A-Za-z0-9_]+/)?.[0];
        if (args.includes('if-shell') && failure) {
            state.ifShellCalls += 1;
            return { stdout: `${failure}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
    },
}));
import { splitTeamWorkerPaneWithEvidence } from '../tmux-session.js';
const identity = {
    socket_path: '/tmp/omc-split-pane-env.sock',
    server_pid: 4242,
    process_started_at: 'linux:boot-1:1',
};
const matchingServer = {
    processObservation: () => 'matching',
    processIdentity: () => identity.process_started_at,
    tmuxQuery: async () => ({ stdout: `${identity.server_pid}\n`, stderr: '' }),
};
describe('splitTeamWorkerPaneWithEvidence pane env file cleanup', () => {
    beforeEach(() => {
        state.envRoot = mkdtempSync(join(tmpdir(), 'omc-split-env-root-'));
        state.runtimeThrows = false;
        state.envDirsSeenAtCall = -1;
        state.ifShellCalls = 0;
        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        vi.stubEnv('TMPDIR', state.envRoot);
        vi.stubEnv('TEMP', state.envRoot);
        vi.stubEnv('TMP', state.envRoot);
        vi.stubEnv('SHELL', '/bin/bash');
        vi.stubEnv('MSYSTEM', '');
        vi.stubEnv('MINGW_PREFIX', '');
        vi.stubEnv('OMC_TEAM_WORKER_ENV_PASSTHROUGH', 'OMC_SPLIT_ENV_TOKEN');
        vi.stubEnv('OMC_SPLIT_ENV_TOKEN', 'split-env-secret');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        rmSync(state.envRoot, { recursive: true, force: true });
    });
    it('discards the env file when the server guard reports the split did not run', async () => {
        const evidence = await splitTeamWorkerPaneWithEvidence('%1', 'right', '/tmp', 'tmux', identity, matchingServer);
        expect(state.envDirsSeenAtCall).toBe(1);
        expect(state.ifShellCalls).toBe(1);
        expect(evidence.commandSucceeded).toBe(false);
        expect(paneEnvDirs()).toEqual([]);
    });
    it('discards the env file when the guarded split throws', async () => {
        state.runtimeThrows = true;
        const evidence = await splitTeamWorkerPaneWithEvidence('%1', 'down', '/tmp', 'tmux', identity, matchingServer);
        expect(state.envDirsSeenAtCall).toBe(1);
        expect(state.ifShellCalls).toBe(0);
        expect(evidence).toMatchObject({ commandSucceeded: false, paneId: null });
        expect(evidence.stderr).toContain('tmux_server_guard_runtime_path_unavailable');
        expect(paneEnvDirs()).toEqual([]);
    });
});
//# sourceMappingURL=tmux-session.split-pane-env.test.js.map