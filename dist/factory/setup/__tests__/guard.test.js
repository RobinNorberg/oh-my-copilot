import { describe, expect, it } from 'vitest';
import { detectForgeRepo } from '../../../forge/config.js';
import { adoInvokeArgs, assertSetupCommand, safeStderr, SetupSafetyError } from '../guard.js';
const gh = detectForgeRepo('https://github.com/acme/widgets.git');
const ado = detectForgeRepo('https://dev.azure.com/contoso/Web/_git/web-app');
const az = { command: 'az', prefix: [], env: {} };
const winAz = { command: 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\python.exe', prefix: ['-IBm', 'azure.cli'], env: { AZ_INSTALLER: 'MSI' } };
const ok = (cmd, args, repo = gh, entry, env) => () => assertSetupCommand(cmd, args, repo, entry, env);
describe('setup guard', () => {
    it('allows exactly the wizard shapes', () => {
        expect(ok('git', ['remote', 'get-url', 'origin'])).not.toThrow();
        expect(ok('git', ['rev-parse', '--show-toplevel'])).not.toThrow();
        expect(ok('gh', ['auth', 'status', '--hostname', 'github.com'])).not.toThrow();
        expect(ok('gh', ['label', 'list', '--json', 'name', '--limit', '1000'])).not.toThrow();
        expect(ok('gh', ['label', 'create', 'factory:queued', '--color', '7c7c7c'])).not.toThrow();
        expect(ok('gh', ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/acme/widgets/milestones?state=open&per_page=100'])).not.toThrow();
        expect(ok('az', ['extension', 'show', '--name', 'azure-devops', '--output', 'json'], ado, az)).not.toThrow();
        expect(ok('az', adoInvokeArgs(ado, 'wit.queries.GET', { project: 'Web' }, { $depth: '2', $expand: 'wiql' }), ado, az)).not.toThrow();
        expect(ok(winAz.command, [...winAz.prefix, ...adoInvokeArgs(ado, 'core.projects.GET', { projectId: 'web' })], ado, winAz, winAz.env)).not.toThrow();
    });
    it.each([
        ['gh api on another repo', 'gh', ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/evil/x/milestones?state=open&per_page=100']],
        ['gh api write', 'gh', ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/acme/widgets/milestones?state=open&per_page=100']],
        ['gh -R', 'gh', ['-R', 'evil/x', 'label', 'list', '--json', 'name', '--limit', '1000']],
        ['label create with another color', 'gh', ['label', 'create', 'x', '--color', 'ff0000']],
        ['option-shaped label', 'gh', ['label', 'create', '--force', '--color', '7c7c7c']],
        ['issue edit', 'gh', ['issue', 'edit', '1', '--add-label', 'x']],
        ['gh.cmd shim', 'gh.cmd', ['auth', 'status', '--hostname', 'github.com']],
        ['git push', 'git', ['push', 'origin', 'main']],
    ])('refuses %s', (_name, cmd, args) => {
        expect(ok(cmd, args)).toThrow(SetupSafetyError);
    });
    it.each([
        ['a write route', [...adoInvokeArgs(ado, 'wit.wiql.GET', { project: 'Web', id: 'x' })].map((a) => (a === 'GET' ? 'POST' : a))],
        ['--in-file', [...adoInvokeArgs(ado, 'core.projects.GET', { projectId: 'Web' }), '--in-file', 'body.json']],
        ['--debug', [...adoInvokeArgs(ado, 'core.projects.GET', { projectId: 'Web' }), '--debug']],
        ['another org', adoInvokeArgs(ado, 'core.projects.GET', { projectId: 'Web' }).map((a) => a.replace('contoso', 'evil'))],
        ['another project', adoInvokeArgs(ado, 'core.projects.GET', { projectId: 'Other' })],
        ['another repository', adoInvokeArgs(ado, 'git.repositories.GET', { project: 'Web', repositoryId: 'other' })],
        ['an unlisted query parameter', [...adoInvokeArgs(ado, 'wit.queries.GET', { project: 'Web' }, { $depth: '2' })].map((a) => (a === '$depth=2' ? 'evil=1' : a))],
        ['another api version', adoInvokeArgs(ado, 'core.projects.GET', { projectId: 'Web' }).map((a) => (a === '7.1' ? '6.0' : a))],
        ['detect true', adoInvokeArgs(ado, 'core.projects.GET', { projectId: 'Web' }).map((a) => (a === 'false' ? 'true' : a))],
        ...['Web/../Other', 'Web?x=1', 'Web#x', '..', '@team.txt', 'a/b'].map((v) => [`route value ${v}`, adoInvokeArgs(ado, 'work.boards.GET', { project: 'Web', team: v })]),
        ['an @file query value', adoInvokeArgs(ado, 'wit.queries.GET', { project: 'Web' }, { $depth: '@depth.txt' })],
        ['az repos pr update', ['repos', 'pr', 'update', '--id', '1', '--status', 'completed']],
    ])('refuses az %s', (_name, args) => {
        expect(ok('az', args, ado, az)).toThrow(SetupSafetyError);
    });
    it('refuses env on anything but az, and az through cmd.exe', () => {
        expect(ok('gh', ['auth', 'status', '--hostname', 'github.com'], gh, undefined, { GH_HOST: 'evil' })).toThrow(SetupSafetyError);
        expect(ok('C:\\az\\wbin\\az.cmd', ['extension', 'show', '--name', 'azure-devops', '--output', 'json'], ado, { command: 'C:\\az\\wbin\\az.cmd', prefix: [], env: {} })).toThrow(SetupSafetyError);
        // python without the -IBm azure.cli prefix is not az.
        expect(ok(winAz.command, ['-c', 'print(1)'], ado, winAz)).toThrow(SetupSafetyError);
    });
    it('redacts token-shaped runs from stderr', () => {
        const line = safeStderr('ERROR: Authorization: Basic OnRva2VuLXZhbHVlLWlzLWhlcmUtYW5kLWl0LWlzLWxvbmc= rejected abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst');
        expect(line).not.toMatch(/OnRva2Vu|abcdefghijklmnopqrstuvwxyz234567/);
    });
});
//# sourceMappingURL=guard.test.js.map