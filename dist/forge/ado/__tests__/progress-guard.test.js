/**
 * Critic amendments §A.14 on the ADO adapter: Kanban column writes are held
 * to the configured progress columns, progress.enabled false allows no state
 * or column write, and the human merge body is printed with its SHA-256 from
 * a directory whose permissions were checked.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { factoryGuardExec } from '../../../factory/run/exec.js';
import { adoGuardContext, progressColumns, progressStates } from '../index.js';
import { mergeBodyDirProblem, writeAdoMergeBody } from '../merge.js';
import { adoRouteById, validateAdoBody } from '../routes.js';
import { adoConfig, adoWorld, HEAD, POSIX_ENTRY, REPO } from './world.js';
const PATCH = adoRouteById('wit.workItems.PATCH');
const COLUMN = '/fields/WEF_6CB513B6E70E43499D9FC94E5BBFB784_Kanban.Column';
const patch = (path, value) => [{ op: 'test', path: '/rev', value: 7 }, { op: 'add', path, value }];
describe('progress writes through the az guard', () => {
    it('a Kanban column write must be a configured progress column', () => {
        const config = adoConfig();
        expect(progressColumns(config)).toEqual(['Code Review']);
        const ctx = { allowedStates: progressStates(config), allowedColumns: progressColumns(config) };
        expect(validateAdoBody(PATCH, patch(COLUMN, 'Code Review'), ctx)).toBeUndefined();
        expect(validateAdoBody(PATCH, patch(COLUMN, 'Done'), ctx)).toMatch(/not a configured progress column \(Code Review\)/);
        expect(validateAdoBody(PATCH, patch(COLUMN, 'Code Review'), { allowedColumns: [] })).toMatch(/none configured/);
    });
    it('progress.enabled false allows no state and no column', () => {
        const config = adoConfig();
        const off = { ...config, progress: { ...config.progress, enabled: false } };
        expect(progressStates(config)).toEqual(['Closed']);
        expect(progressStates(off)).toEqual([]);
        expect(progressColumns(off)).toEqual([]);
        const guard = adoGuardContext(off, POSIX_ENTRY);
        expect(guard).toMatchObject({ allowedStates: [], allowedColumns: [] });
    });
    it('the guard refuses an unconfigured column move before az runs', () => {
        const config = adoConfig();
        const ran = [];
        const exec = factoryGuardExec((_c, args) => { ran.push(args); return { status: 0, stdout: '{}', stderr: '' }; }, () => [], () => adoGuardContext(config, POSIX_ENTRY));
        const dir = mkdtempSync(join(tmpdir(), 'omg-ado-col-'));
        try {
            const file = join(dir, 'body.json');
            writeFileSync(file, JSON.stringify(patch(COLUMN, 'Done')));
            const args = ['devops', 'invoke', '--area', 'wit', '--resource', 'workItems', '--route-parameters', 'project=Web', 'id=42', '--http-method', 'PATCH', '--api-version', '7.1',
                '--media-type', 'application/json-patch+json', '--in-file', file, '--org', 'https://dev.azure.com/contoso', '--detect', 'false', '--output', 'json'];
            expect(() => exec('az', args)).toThrow(/not a configured progress column/);
            expect(ran).toEqual([]);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe('the human merge body', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omg-ado-mergebody-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
    it('humanMerge returns the command, its body file and that file\'s SHA-256', () => {
        const { forge } = adoWorld();
        const m = forge.merge.humanMerge(17, HEAD);
        expect(m.command).toEqual(forge.merge.humanMergeCommand(17, HEAD));
        expect(m.command[m.command.indexOf('--in-file') + 1]).toBe(m.bodyFile);
        expect(createHash('sha256').update(readFileSync(m.bodyFile)).digest('hex')).toBe(m.bodySha256);
        expect(m.bodyFile).toContain(`ado-merge-${REPO.owner}-${REPO.project}-${REPO.name}-pr-17`);
    });
    it('checks the directory permissions on POSIX; Windows modes carry no ACLs', () => {
        expect(mergeBodyDirProblem(dir, 'win32')).toBeUndefined();
        const file = join(dir, 'f');
        writeFileSync(file, '');
        expect(mergeBodyDirProblem(file, 'linux')).toMatch(/not a directory/);
        if (process.platform !== 'win32') {
            chmodSync(dir, 0o700);
            expect(mergeBodyDirProblem(dir)).toBeUndefined();
            chmodSync(dir, 0o777);
            expect(mergeBodyDirProblem(dir)).toMatch(/writable by group or others/);
            const shared = join(dir, 'shared');
            mkdirSync(shared, { mode: 0o777 });
            chmodSync(shared, 0o777);
            expect(() => writeAdoMergeBody({ repo: REPO }, { stateDir: shared, untrustedRoots: [] }, 17, HEAD)).toThrow(/writable by group or others/);
        }
        else {
            expect(mergeBodyDirProblem(dir)).toBeUndefined();
        }
    });
});
//# sourceMappingURL=progress-guard.test.js.map