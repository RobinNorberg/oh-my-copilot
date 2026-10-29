import { describe, expect, it } from 'vitest';
import { prRepoUrl, remoteRepoMismatch, repoIdentity } from '../config.js';
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