import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertFactoryCommand, FactorySafetyError, factoryGuardExec } from '../../../factory/run/exec.js';
import { guardExec, scrubShipEnv, ShipSafetyError } from '../../../ship/exec.js';
import { HEAD, POSIX_ENTRY, REPO, WINDOWS_ENTRY } from './world.js';
const scratch = mkdtempSync(join(tmpdir(), 'omg-ado-guard-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const file = (body) => {
    const path = join(scratch, `b${n++}.json`);
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    return path;
};
const CTX = { repo: REPO, entry: POSIX_ENTRY };
const WIN = { repo: REPO, entry: WINDOWS_ENTRY };
const ORG = ['--org', 'https://dev.azure.com/contoso', '--detect', 'false', '--output', 'json'];
const invoke = (area, resource, method, version, rp, extra = []) => [
    'devops', 'invoke', '--area', area, '--resource', resource, '--route-parameters', ...rp, '--http-method', method, '--api-version', version, ...extra, ...ORG,
];
const PR_GET = invoke('git', 'pullRequests', 'GET', '7.1', ['project=Web', 'repositoryId=web-app', 'pullRequestId=17']);
const prPatch = (body) => invoke('git', 'pullRequests', 'PATCH', '7.1', ['project=Web', 'repositoryId=web-app', 'pullRequestId=17'], ['--in-file', file(body)]);
const prPost = (body) => invoke('git', 'pullRequests', 'POST', '7.1', ['project=Web', 'repositoryId=web-app'], ['--in-file', file(body)]);
const DRAFT = { sourceRefName: 'refs/heads/factory/issue-42', targetRefName: 'refs/heads/main', title: 'factory: issue 42', isDraft: true };
/** `ctx` null = no ADO forge for the run. */
const factory = (cmd, args, ctx = CTX, env) => () => assertFactoryCommand(cmd, args, [], env, ctx ?? undefined);
describe('az guard: what it allows', () => {
    it('a routes.ts read, as the POSIX az entry', () => {
        expect(factory('az', PR_GET)).not.toThrow();
    });
    it('the Windows entry only: the resolved python.exe, -IBm azure.cli, AZ_INSTALLER=MSI', () => {
        expect(factory(WINDOWS_ENTRY.command, ['-IBm', 'azure.cli', ...PR_GET], WIN, { AZ_INSTALLER: 'MSI' })).not.toThrow();
        // Path case does not matter on Windows.
        expect(factory(WINDOWS_ENTRY.command.toUpperCase(), ['-IBm', 'azure.cli', ...PR_GET], WIN, { AZ_INSTALLER: 'MSI' })).not.toThrow();
    });
    it('a valid write body', () => {
        expect(factory('az', prPatch({ isDraft: false }))).not.toThrow();
        expect(factory('az', prPost(DRAFT))).not.toThrow();
    });
});
describe('az guard: refusals', () => {
    const refused = (fn, reason) => expect(fn).toThrow(reason);
    it('refuses every .cmd / .bat shim', () => {
        for (const cmd of ['az.cmd', 'C:\\CLI2\\wbin\\az.cmd', 'AZ.CMD', 'az.bat'])
            refused(factory(cmd, PR_GET), /cmd\.exe shim/);
        refused(factory('C:\\CLI2\\wbin\\az.cmd', PR_GET, WIN, { AZ_INSTALLER: 'MSI' }), /cmd\.exe shim/);
    });
    it('refuses --debug and --verbose anywhere', () => {
        refused(factory('az', [...PR_GET, '--debug']), /--debug and --verbose/);
        refused(factory('az', ['--verbose', ...PR_GET]), /--debug and --verbose/);
        refused(factory('az', [...PR_GET, '--debug=true']), /--debug and --verbose/);
    });
    it('refuses az repos pr update and az repos pr create --auto-complete', () => {
        refused(factory('az', ['repos', 'pr', 'update', '--id', '17', '--status', 'completed']), /merge is a human step/);
        refused(factory('az', ['repos', 'pr', 'update', '--id', '17', '--draft', 'false']), /merge is a human step/);
        refused(factory('az', ['repos', 'pr', 'create', '--draft', '--auto-complete', 'true']), /merges without a human/);
        refused(factory('az', ['repos', 'pr', 'create', '--draft']), /only `az devops invoke`/);
        refused(factory('az', ['account', 'show']), /only `az devops invoke`/);
    });
    it('refuses python anywhere but the resolved path, and without -IBm azure.cli', () => {
        const env = { AZ_INSTALLER: 'MSI' };
        refused(factory('C:\\Users\\me\\repo\\python.exe', ['-IBm', 'azure.cli', ...PR_GET], WIN, env), /az runs only as/);
        refused(factory('python', ['-IBm', 'azure.cli', ...PR_GET], WIN, env), /az runs only as/);
        refused(factory(WINDOWS_ENTRY.command, ['-m', 'azure.cli', ...PR_GET], WIN, env), /runs only with -IBm azure\.cli/);
        refused(factory(WINDOWS_ENTRY.command, ['-IBm', 'azure.cli', ...PR_GET], WIN), /needs the entry environment/);
        refused(factory(WINDOWS_ENTRY.command, ['-IBm', 'azure.cli', ...PR_GET], WIN, { AZ_INSTALLER: 'MSI', AZURE_DEVOPS_EXT_PAT: 'x' }), /only .* is allowed on az/);
        // The POSIX entry is `az`; a python is not it.
        refused(factory('/usr/bin/python3', PR_GET), /az runs only as az/);
        refused(factory('/opt/az/bin/az', PR_GET), /az runs only as az/);
    });
    it('refuses az without an Azure DevOps forge for the run', () => {
        refused(factory('az', PR_GET, null), /no Azure DevOps forge is configured/);
        expect(() => factoryGuardExec(() => ({ status: 0, stdout: '{}', stderr: '' }))('az', PR_GET)).toThrow(FactorySafetyError);
    });
    it('refuses every (area, resource, method) tuple outside routes.ts', () => {
        const rp = ['project=Web', 'repositoryId=web-app'];
        for (const [area, resource, method] of [['git', 'pushes', 'POST'], ['git', 'refs', 'POST'], ['policy', 'configurations', 'POST'], ['policy', 'configurations', 'PATCH'], ['git', 'pullRequests', 'DELETE'], ['git', 'pullRequestThreads', 'PATCH'], ['wit', 'workItems', 'DELETE']]) {
            refused(factory('az', invoke(area, resource, method, '7.1', rp)), /is not an allowed Azure DevOps route/);
        }
    });
    it('refuses another api-version, a missing method, --detect true, another output', () => {
        refused(factory('az', invoke('git', 'pullRequests', 'GET', '7.0', ['project=Web', 'repositoryId=web-app'])), /--api-version must be 7\.1/);
        refused(factory('az', invoke('wit', 'comments', 'GET', '7.1', ['project=Web', 'workItemId=42'])), /must be 7\.1-preview\.4/);
        refused(factory('az', PR_GET.filter((a, i) => a !== '--http-method' && PR_GET[i - 1] !== '--http-method')), /--http-method is required/);
        refused(factory('az', PR_GET.map((a, i) => (PR_GET[i - 1] === '--detect' ? 'true' : a))), /--detect must be false/);
        refused(factory('az', PR_GET.map((a, i) => (PR_GET[i - 1] === '--output' ? 'table' : a))), /--output must be json/);
    });
    it('refuses another org, project, projectId or repository than the forge repo', () => {
        refused(factory('az', PR_GET.map((a) => (a === 'https://dev.azure.com/contoso' ? 'https://dev.azure.com/fabrikam' : a))), /--org must be/);
        refused(factory('az', PR_GET.map((a) => (a === 'project=Web' ? 'project=Other' : a))), /project must be the forge project/);
        refused(factory('az', PR_GET.map((a) => (a === 'repositoryId=web-app' ? 'repositoryId=other-repo' : a))), /repositoryId must be the forge repository/);
        refused(factory('az', invoke('core', 'projects', 'GET', '7.1', ['projectId=Other'])), /projectId must be the forge project/);
        refused(factory('az', PR_GET.filter((a) => a !== 'project=Web')), /project route parameter is required/);
        // Case and %20 escapes do not matter (design §8.3).
        expect(factory('az', PR_GET.map((a) => (a === 'project=Web' ? 'project=WEB' : a === 'https://dev.azure.com/contoso' ? 'https://dev.azure.com/Contoso' : a)))).not.toThrow();
    });
    it('refuses unlisted --route-parameters and --query-parameters, duplicates, and refused values', () => {
        refused(factory('az', invoke('git', 'pullRequests', 'GET', '7.1', ['project=Web', 'repositoryId=web-app'], ['--query-parameters', 'searchCriteria.creatorId=x'])), /searchCriteria\.creatorId is not allowed/);
        refused(factory('az', invoke('git', 'pullRequests', 'GET', '7.1', ['project=Web', 'repositoryId=web-app', 'commitId=abc'])), /commitId is not allowed/);
        refused(factory('az', invoke('git', 'pullRequests', 'GET', '7.1', ['project=Web', 'project=Web', 'repositoryId=web-app'])), /given twice/);
        refused(factory('az', invoke('git', 'pullRequests', 'GET', '7.1', ['project=Web', 'repositoryId=web-app', 'pullRequestId=17;x'])), /pullRequestId has a refused value/);
        refused(factory('az', invoke('policy', 'evaluations', 'GET', '7.1-preview.1', ['project=Web'], ['--query-parameters', 'artifactId=vstfs:///Other/1'])), /artifactId has a refused value/);
        refused(factory('az', invoke('build', 'builds', 'GET', '7.1', ['project=Web'], ['--query-parameters', 'branchName=refs/heads/main'])), /branchName has a refused value/);
    });
    it('refuses unknown flags: --out-file, --query, --subscription, positionals', () => {
        refused(factory('az', [...PR_GET, '--out-file', 'C:\\x']), /--out-file.* is not an allowed/);
        refused(factory('az', [...PR_GET, '--query', 'value']), /--query.* is not an allowed/);
        refused(factory('az', [...PR_GET, 'stray']), /stray.* is not an allowed/);
        refused(factory('az', [...PR_GET, '--org', 'https://dev.azure.com/contoso']), /--org is given twice/);
    });
    it('refuses a merge-shaped PR PATCH body (status, completionOptions, autoCompleteSetBy) and the wrong isDraft', () => {
        refused(factory('az', prPatch({ status: 'completed', lastMergeSourceCommit: { commitId: HEAD } })), /body\.status is not allowed/);
        refused(factory('az', prPatch({ isDraft: false, completionOptions: { mergeStrategy: 'squash' } })), /body\.completionOptions is not allowed/);
        refused(factory('az', prPatch({ isDraft: false, autoCompleteSetBy: { id: 'x' } })), /body\.autoCompleteSetBy is not allowed/);
        refused(factory('az', prPatch({ isDraft: true })), /body\.isDraft must be false/);
        refused(factory('az', prPost({ ...DRAFT, isDraft: false })), /body\.isDraft must be true/);
        refused(factory('az', prPost({ ...DRAFT, autoCompleteSetBy: { id: 'x' } })), /autoCompleteSetBy is not allowed/);
        refused(factory('az', prPost({ ...DRAFT, completionOptions: {} })), /completionOptions is not allowed/);
    });
    it('applies the TEXT control-character rule to the PR title and description', () => {
        refused(factory('az', prPost({ ...DRAFT, title: 'evil\u001b[31m' })), /body\.title has a refused value/);
        refused(factory('az', prPost({ ...DRAFT, description: 'a\u0000b' })), /body\.description has a refused value/);
        expect(factory('az', prPost({ ...DRAFT, description: 'line 1\nline 2\ttab' }))).not.toThrow();
    });
    it('reads the JSON as JSON.parse does: a duplicate key cannot hide a second value', () => {
        refused(factory('az', prPatch('{"isDraft":false,"isDraft":true}')), /isDraft must be false/);
        refused(factory('az', prPatch('{"isDraft":false')), /not JSON/);
    });
    it('needs --in-file exactly on body routes, as an absolute path', () => {
        refused(factory('az', invoke('git', 'pullRequests', 'PATCH', '7.1', ['project=Web', 'repositoryId=web-app', 'pullRequestId=17'])), /needs --in-file/);
        refused(factory('az', [...PR_GET, '--in-file', file({})]), /takes no --in-file/);
        refused(factory('az', invoke('policy', 'evaluations', 'PATCH', '7.1-preview.1', ['project=Web', 'evaluationId=e1a2b3c4-0000-4000-8000-000000000001'], ['--in-file', file({})])), /takes no --in-file/);
        refused(factory('az', invoke('git', 'pullRequests', 'PATCH', '7.1', ['project=Web', 'repositoryId=web-app', 'pullRequestId=17'], ['--in-file', 'body.json'])), /absolute path/);
        refused(factory('az', invoke('git', 'pullRequests', 'PATCH', '7.1', ['project=Web', 'repositoryId=web-app', 'pullRequestId=17'], ['--in-file', join(scratch, 'none.json')])), /cannot read --in-file/);
    });
    it('refuses the json-patch media type on another route, and requires it on the work item PATCH', () => {
        const wi = (extra) => invoke('wit', 'workItems', 'PATCH', '7.1', ['project=Web', 'id=42'], ['--in-file', file([{ op: 'test', path: '/rev', value: 1 }]), ...extra]);
        expect(factory('az', wi(['--media-type', 'application/json-patch+json']))).not.toThrow();
        refused(factory('az', wi([])), /--media-type must be application\/json-patch\+json/);
        refused(factory('az', [...PR_GET, '--media-type', 'text/plain']), /--media-type is not allowed/);
        const remove = invoke('wit', 'workItems', 'PATCH', '7.1', ['project=Web', 'id=42'], ['--in-file', file([{ op: 'remove', path: '/fields/System.Tags' }]), '--media-type', 'application/json-patch+json']);
        refused(factory('az', remove), /op must be one of test, add/);
    });
});
describe('az guard: the TOCTOU fix', () => {
    it('az gets the guard\'s own copy of the validated bytes, never the caller\'s file, and the copy is removed', () => {
        const args = prPatch({ isDraft: false });
        const callerFile = args[args.indexOf('--in-file') + 1];
        const seen = [];
        const inner = (_cmd, a) => {
            const path = a[a.indexOf('--in-file') + 1];
            // The caller rewrites its file after the check: az must not see it.
            writeFileSync(callerFile, JSON.stringify({ status: 'completed' }), 'utf8');
            seen.push({ path, bytes: readFileSync(path, 'utf8') });
            return { status: 0, stdout: '{}', stderr: '' };
        };
        factoryGuardExec(inner, () => [], () => CTX)('az', args);
        expect(seen).toHaveLength(1);
        expect(seen[0].path).not.toBe(callerFile);
        expect(JSON.parse(seen[0].bytes)).toEqual({ isDraft: false });
        expect(existsSync(seen[0].path)).toBe(false);
    });
    it('removes the copy when az throws too', () => {
        let path = '';
        const inner = (_cmd, a) => {
            path = a[a.indexOf('--in-file') + 1];
            throw new Error('spawn failed');
        };
        expect(() => factoryGuardExec(inner, () => [], () => CTX)('az', prPatch({ isDraft: false }))).toThrow('spawn failed');
        expect(path).not.toBe('');
        expect(existsSync(path)).toBe(false);
    });
});
describe('scrubShipEnv and the Azure DevOps CLI defaults', () => {
    it('drops the org/project redirects in any case and keeps the engine\'s own auth', () => {
        const env = scrubShipEnv({
            AZURE_DEVOPS_EXT_DEFAULTS_ORGANIZATION: 'https://dev.azure.com/evil',
            azure_devops_ext_defaults_project: 'Evil',
            AZURE_DEVOPS_DEFAULTS_ORGANIZATION: 'x',
            Azure_DevOps_Defaults_Project: 'y',
            AZURE_DEVOPS_EXT_PAT: 'pat',
            AZURE_CONFIG_DIR: 'C:\\az',
            GH_TOKEN: 't',
        });
        expect(Object.keys(env).filter((k) => /DEFAULTS/i.test(k))).toEqual([]);
        expect(env).toMatchObject({ AZURE_DEVOPS_EXT_PAT: 'pat', AZURE_CONFIG_DIR: 'C:\\az', GH_TOKEN: 't' });
    });
});
describe('az guard: the ship policy', () => {
    const ok = () => ({ status: 0, stdout: '{}', stderr: '' });
    const ship = guardExec(ok, () => [], () => CTX);
    it('allows reads and the build-evaluation requeue', () => {
        expect(ship('az', PR_GET).status).toBe(0);
        expect(ship('az', invoke('policy', 'evaluations', 'PATCH', '7.1-preview.1', ['project=Web', 'evaluationId=e1a2b3c4-0000-4000-8000-000000000001'])).status).toBe(0);
    });
    it('refuses every other write, and az without a forge', () => {
        expect(() => ship('az', prPatch({ isDraft: false }))).toThrow(ShipSafetyError);
        expect(() => ship('az', prPatch({ isDraft: false }))).toThrow(/omg ship refuses .*git\.pullRequests\.PATCH is not a route omg ship runs/);
        expect(() => ship('az', prPost(DRAFT))).toThrow(/not a route omg ship runs/);
        expect(() => guardExec(ok)('az', PR_GET)).toThrow(/no Azure DevOps forge is configured/);
        expect(() => ship('az.cmd', PR_GET)).toThrow(/cmd\.exe shim/);
    });
    it('git and gh still go through the unchanged ship allowlist', () => {
        expect(ship('gh', ['pr', 'view', '17', '--json', 'headRefOid']).status).toBe(0);
        expect(() => ship('gh', ['api', 'repos/o/r'])).toThrow(/not one of the command shapes the ship engine runs/);
    });
});
//# sourceMappingURL=guard.test.js.map