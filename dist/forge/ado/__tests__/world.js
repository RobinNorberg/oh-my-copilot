/**
 * The fixture world the ADO adapter tests share: org contoso, project Web,
 * repository web-app, PR 17 at head 1111…, work item 42. The adapter runs
 * through the real factory guard (src/factory/run/exec.ts) over the fixture
 * Exec, so every call a test makes was also allowed by the guard, and each
 * write's body is the guard's validated copy.
 */
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { factoryGuardExec } from '../../../factory/run/exec.js';
import { AZ_PYTHON_PREFIX } from '../az-binary.js';
import { adoGuardContext, createAzureDevOpsForge } from '../index.js';
import { adoFixtureExec, loadAdoFixtures } from './fixtures.js';
export const HEAD = '1111111111111111111111111111111111111111';
export const OLD_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const MERGE_COMMIT = '3333333333333333333333333333333333333333';
export const POSIX_ENTRY = { command: 'az', prefix: [], env: {} };
export const WINDOWS_ENTRY = { command: 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\python.exe', prefix: AZ_PYTHON_PREFIX, env: { AZ_INSTALLER: 'MSI' } };
/** The checkout (an untrusted root) and the engine-owned state dir outside it. */
export const CHECKOUT = join(tmpdir(), 'omg-ado-world-checkout');
export const STATE_DIR = join(tmpdir(), 'omg-ado-world-state');
export const REPO = { kind: 'azure-devops', host: 'dev.azure.com', owner: 'contoso', project: 'Web', name: 'web-app', url: 'https://dev.azure.com/contoso/Web/_git/web-app' };
export function adoConfig(source) {
    return {
        kind: 'azure-devops',
        repo: REPO,
        azureDevOps: { org: 'contoso', project: 'Web', repo: 'web-app', workItemProject: 'Web', team: 'Web Team', apiVersion: '7.1', trustedAuthors: ['Owner@Example.com'] },
        intake: { source, itemTypes: ['User Story', 'Bug'], limit: 50, marker: 'factory-ready' },
        check: { maxAcceptanceItems: 12, maxSize: 8, maxBodyChars: 20_000 },
        progress: { enabled: true, stages: { reviewing: { column: 'Code Review' }, done: { state: 'Closed' } } },
    };
}
/** The fixtures with `name`'s stdout replaced (a scenario variant, synthetic by construction). */
export function variant(fixtures, name, edit) {
    if (!fixtures.some((f) => f.name === name))
        throw new Error(`no fixture ${name}`);
    return fixtures.map((f) => (f.name === name ? { ...f, provenance: `synthetic: variant of ${name}`, stdout: edit(structuredClone(f.stdout)) } : f));
}
/** A forge over the fixtures, behind the factory guard; `calls` records what reached the fixture Exec. */
/** `writes`: the tracker write context `omg factory enqueue` sets (none = the engine and check). */
export function adoWorld(o = {}) {
    const fixtures = o.fixtures ?? loadAdoFixtures();
    const entry = o.entry ?? POSIX_ENTRY;
    const inner = adoFixtureExec(fixtures);
    const calls = [];
    const recording = (cmd, args, opts) => {
        const at = args.indexOf('--in-file');
        const inFile = at >= 0 ? args[at + 1] : undefined;
        calls.push({ cmd, args: [...args], ...(inFile ? { inFile, body: JSON.parse(readFileSync(inFile, 'utf8')) } : {}) });
        return inner(cmd, args, opts);
    };
    const config = adoConfig(o.source);
    const guard = adoGuardContext(config, entry);
    const exec = factoryGuardExec(recording, () => [], () => guard, () => o.writes);
    const forge = createAzureDevOpsForge(exec, CHECKOUT, config, { entry, env: {}, untrustedRoots: [CHECKOUT], stateDir: STATE_DIR });
    const routeOf = (c) => {
        const a = c.args;
        const v = (f) => a[a.indexOf(f) + 1];
        return `${v('--area')}.${v('--resource')}.${v('--http-method')}`;
    };
    return { forge, calls, guard, routes: () => calls.map(routeOf) };
}
//# sourceMappingURL=world.js.map