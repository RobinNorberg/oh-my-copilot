import { describe, expect, it } from 'vitest';
import { prRepoUrl, remoteRepoMismatch, repoIdentity, sameRepo } from '../config.js';
describe('repoIdentity', () => {
    // Every identity string a GitHub or local remote produced before Azure DevOps support: pinned unchanged.
    const GITHUB = [
        ['https://github.com/o/r', 'gh:github.com/o/r'],
        ['https://github.com/o/r.git', 'gh:github.com/o/r'],
        ['https://github.com/O/R/', 'gh:github.com/o/r'],
        ['http://github.com/o/r', 'gh:github.com/o/r'],
        ['https://user@github.com/o/r.git', 'gh:github.com/o/r'],
        ['https://x-access-token:tok@github.com/o/r', 'gh:github.com/o/r'],
        ['ssh://git@github.com/o/r.git', 'gh:github.com/o/r'],
        ['ssh://git@github.com:22/o/r', 'gh:github.com/o/r'],
        ['git://github.com/o/r', 'gh:github.com/o/r'],
        ['git@github.com:o/r.git', 'gh:github.com/o/r'],
        ['github.com:o/r', 'gh:github.com/o/r'],
        ['  https://github.com/RobinNorberg/oh-my-copilot.git\n', 'gh:github.com/robinnorberg/oh-my-copilot'],
        ['https://ghe.example.com/o/r', 'gh:ghe.example.com/o/r'],
        ['git@ghe.example.com:team/repo', 'gh:ghe.example.com/team/repo'],
        ['C:\\repos\\r', 'path:c:/repos/r'],
        ['/tmp/remote.git', 'path:/tmp/remote'],
        ['../remote', 'path:../remote'],
        ['https://github.com/o/r/extra', 'path:https://github.com/o/r/extra'],
        ['https://dev.azure.com/o/r', 'gh:dev.azure.com/o/r'],
    ];
    it.each(GITHUB)('%s -> %s (unchanged)', (url, identity) => {
        expect(repoIdentity(url)).toBe(identity);
    });
    const ADO = [
        'https://dev.azure.com/contoso/Web/_git/web-app',
        'https://contoso@dev.azure.com/contoso/Web/_git/web-app',
        'https://dev.azure.com/contoso/Web/_git/web-app/',
        'HTTPS://DEV.AZURE.COM/Contoso/WEB/_git/Web-App',
        'git@ssh.dev.azure.com:v3/contoso/Web/web-app',
        'ssh://git@ssh.dev.azure.com/v3/contoso/Web/web-app',
        'ssh://git@ssh.dev.azure.com:22/v3/contoso/Web/web-app',
        'https://contoso.visualstudio.com/Web/_git/web-app',
        'https://contoso.visualstudio.com/DefaultCollection/Web/_git/web-app',
        'https://user@contoso.visualstudio.com/Web/_git/web-app',
        'contoso@vs-ssh.visualstudio.com:v3/contoso/Web/web-app',
    ];
    it.each(ADO)('%s is ado:contoso/web/web-app', (url) => {
        expect(repoIdentity(url)).toBe('ado:contoso/web/web-app');
    });
    it('decodes %20 and compares case-insensitively', () => {
        expect(repoIdentity('https://dev.azure.com/contoso/My%20Project/_git/web%20app')).toBe('ado:contoso/my project/web app');
        expect(repoIdentity('git@ssh.dev.azure.com:v3/Contoso/My%20Project/Web%20App')).toBe('ado:contoso/my project/web app');
        expect(repoIdentity('https://dev.azure.com/contoso/My Project/_git/web app')).toBe('ado:contoso/my project/web app');
    });
    it('another org, project or repository is another identity, never a GitHub or local one', () => {
        const id = repoIdentity('https://dev.azure.com/contoso/Web/_git/web-app');
        for (const other of ['https://dev.azure.com/fabrikam/Web/_git/web-app', 'https://dev.azure.com/contoso/Api/_git/web-app', 'https://dev.azure.com/contoso/Web/_git/api', 'https://github.com/contoso/web-app', '/tmp/contoso/Web/web-app']) {
            expect(repoIdentity(other)).not.toBe(id);
        }
        expect(repoIdentity('https://evil.example/dev.azure.com/contoso/Web/_git/web-app')).not.toBe(id);
    });
    // git / curl connect to the WHATWG host: attacker.example, not the host a regex reads after the `@`.
    const AMBIGUOUS = [
        'https://attacker.example#@dev.azure.com/victim/proj/_git/repo',
        'https://attacker.example?@dev.azure.com/victim/proj/_git/repo',
        'https://attacker.example#@contoso.visualstudio.com/Web/_git/web-app',
        'https://attacker.example#@github.com/o/r',
        'https://attacker.example?x@github.com/o/r',
        'https://a b@github.com/o/r',
        'https://[::1]@github.com/o/r',
        'ssh://attacker.example#@github.com/o/r',
        'https://git%68ub.com/o/r',
    ];
    it.each(AMBIGUOUS)('%s is invalid, never a hosted identity', (url) => {
        expect(repoIdentity(url)).toMatch(/^invalid:/);
        expect(repoIdentity(url)).not.toBe(repoIdentity('https://dev.azure.com/victim/proj/_git/repo'));
        expect(repoIdentity(url)).not.toBe(repoIdentity('https://github.com/o/r'));
    });
    it('refuses a decoded segment holding a / so a%2Fb/c and a/b%2Fc never collide', () => {
        const one = repoIdentity('https://dev.azure.com/a%2Fb/c/_git/r');
        const two = repoIdentity('https://dev.azure.com/a/b%2Fc/_git/r');
        expect(one).toMatch(/^invalid:/);
        expect(two).toMatch(/^invalid:/);
        expect(one).not.toBe(two);
        expect(repoIdentity('git@ssh.dev.azure.com:v3/a/b%5Cc/r')).toMatch(/^invalid:/);
    });
});
describe('remoteRepoMismatch on Azure DevOps', () => {
    const exec = (fetchUrl, pushUrls) => (_cmd, args) => (args.includes('--push')
        ? { status: 0, stdout: `${pushUrls.join('\n')}\n`, stderr: '' }
        : { status: 0, stdout: `${fetchUrl}\n`, stderr: '' });
    const repoUrl = 'https://dev.azure.com/contoso/Web/_git/web-app';
    it('accepts an ssh origin of the run repository and refuses a planted push URL', () => {
        expect(remoteRepoMismatch(exec('git@ssh.dev.azure.com:v3/contoso/Web/web-app', ['https://contoso@dev.azure.com/contoso/Web/_git/web-app']), '.', 'origin', repoUrl)).toBeNull();
        expect(remoteRepoMismatch(exec(repoUrl, ['https://dev.azure.com/contoso/Web/_git/other']), '.', 'origin', repoUrl)).toMatch(/pushes to/);
        expect(remoteRepoMismatch(exec('https://dev.azure.com/fabrikam/Web/_git/web-app', [repoUrl]), '.', 'origin', repoUrl)).toMatch(/points at/);
    });
    it('refuses a userinfo pushurl or fetch URL that connects to another host', () => {
        const attacker = 'https://attacker.example#@dev.azure.com/contoso/Web/_git/web-app';
        expect(remoteRepoMismatch(exec(repoUrl, [attacker]), '.', 'origin', repoUrl)).toMatch(/pushes to https:\/\/attacker\.example/);
        expect(remoteRepoMismatch(exec(attacker, [repoUrl]), '.', 'origin', repoUrl)).toMatch(/points at/);
        const gh = 'https://github.com/o/r';
        expect(remoteRepoMismatch(exec(gh, ['https://attacker.example#@github.com/o/r']), '.', 'origin', gh)).toMatch(/pushes to/);
    });
    it('an invalid identity matches nothing, itself included', () => {
        const attacker = 'https://attacker.example#@dev.azure.com/contoso/Web/_git/web-app';
        expect(repoIdentity(attacker)).toBe(repoIdentity(attacker));
        expect(sameRepo(attacker, attacker)).toBe(false);
        expect(sameRepo(repoUrl, repoUrl)).toBe(true);
        expect(remoteRepoMismatch(exec(attacker, [attacker]), '.', 'origin', attacker)).toMatch(/points at/);
    });
});
describe('prRepoUrl', () => {
    it('keeps the GitHub forms unchanged', () => {
        expect(prRepoUrl('https://github.com/o/r/pull/12')).toBe('https://github.com/o/r');
        expect(prRepoUrl('https://ghe.example.com/o/r/pull/3')).toBe('https://ghe.example.com/o/r');
        expect(prRepoUrl('https://github.com/o/r/pull/12/files')).toBeUndefined();
        expect(prRepoUrl('https://github.com/o/r')).toBeUndefined();
        expect(prRepoUrl(undefined)).toBeUndefined();
        expect(prRepoUrl(12)).toBeUndefined();
    });
    it('learns the Azure DevOps PR URLs', () => {
        expect(prRepoUrl('https://dev.azure.com/contoso/Web/_git/web-app/pullrequest/17')).toBe('https://dev.azure.com/contoso/Web/_git/web-app');
        expect(prRepoUrl('https://contoso.visualstudio.com/Web/_git/web-app/pullrequest/17')).toBe('https://contoso.visualstudio.com/Web/_git/web-app');
        expect(prRepoUrl('https://evil.example/a/b/c/pullrequest/17')).toBeUndefined();
        expect(prRepoUrl('https://dev.azure.com/contoso/Web/_git/web-app/pullrequest/x')).toBeUndefined();
    });
});
//# sourceMappingURL=repo-identity.test.js.map