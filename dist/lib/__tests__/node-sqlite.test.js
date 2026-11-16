import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDatabaseSync, sqliteErrorCode } from '../node-sqlite.js';
import { closeJobDb, getJob, getJobStats, initJobDb, upsertJob } from '../job-state-db.js';
import { withStateFileMutationLock } from '../mode-state-io.js';
import { getOmcRoot } from '../worktree-paths.js';
const REPO_ROOT = join(__dirname, '..', '..', '..');
// Written by better-sqlite3 12.11.1 (SQLite 3.53.2, journal_mode WAL) before the node:sqlite switch.
const LEGACY_FIXTURES = join(__dirname, 'fixtures', 'better-sqlite3');
const directories = [];
afterEach(() => {
    closeJobDb();
    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});
function tempDir(prefix) {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
}
describe('node:sqlite loader', () => {
    it('loads DatabaseSync', () => {
        const Database = loadDatabaseSync();
        const db = new Database(':memory:');
        try {
            expect(db.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 });
        }
        finally {
            db.close();
        }
    });
    it('loads without printing the SQLite ExperimentalWarning, and keeps other warnings', () => {
        const loaderUrl = pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'node-sqlite.mjs')).href;
        const script = `
      const { loadDatabaseSync } = await import(process.argv[1]);
      new (loadDatabaseSync())(':memory:').close();
      process.emitWarning('kept warning', 'ExperimentalWarning');
    `;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, loaderUrl], { encoding: 'utf8' });
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('SQLite');
        expect(result.stderr).toContain('kept warning');
    });
    it('names SQLITE_BUSY and SQLITE_LOCKED from node:sqlite result codes', () => {
        expect(sqliteErrorCode({ code: 'ERR_SQLITE_ERROR', errcode: 5 })).toBe('SQLITE_BUSY');
        expect(sqliteErrorCode({ code: 'ERR_SQLITE_ERROR', errcode: 517 })).toBe('SQLITE_BUSY'); // SQLITE_BUSY_SNAPSHOT
        expect(sqliteErrorCode({ code: 'ERR_SQLITE_ERROR', errcode: 6 })).toBe('SQLITE_LOCKED');
        expect(sqliteErrorCode({ code: 'ERR_SQLITE_ERROR', errcode: 19 })).toBe('ERR_SQLITE_ERROR');
        expect(sqliteErrorCode({ code: 'EPERM' })).toBe('EPERM');
        expect(sqliteErrorCode(null)).toBeUndefined();
    });
    it('reports a real lock conflict as SQLITE_BUSY', () => {
        const Database = loadDatabaseSync();
        const path = join(tempDir('node-sqlite-busy-'), 'busy.db');
        const first = new Database(path);
        const second = new Database(path);
        try {
            first.exec('PRAGMA journal_mode = WAL');
            second.exec('PRAGMA busy_timeout = 0');
            first.exec('BEGIN IMMEDIATE');
            let caught;
            try {
                second.exec('BEGIN IMMEDIATE');
            }
            catch (error) {
                caught = error;
            }
            expect(sqliteErrorCode(caught)).toBe('SQLITE_BUSY');
            first.exec('ROLLBACK');
        }
        finally {
            first.close();
            second.close();
        }
    });
});
describe('databases written by better-sqlite3', () => {
    it('opens a legacy jobs.db and keeps its rows', async () => {
        const cwd = tempDir('node-sqlite-legacy-jobs-');
        const stateDir = join(getOmcRoot(cwd), 'state');
        mkdirSync(stateDir, { recursive: true });
        copyFileSync(join(LEGACY_FIXTURES, 'jobs.db'), join(stateDir, 'jobs.db'));
        expect(await initJobDb(cwd)).toBe(true);
        expect(getJob('codex', 'legacy01', cwd)).toMatchObject({
            jobId: 'legacy01',
            status: 'completed',
            pid: 4242,
            usedFallback: true,
            fallbackModel: 'gpt-5.2',
            completedAt: '2026-11-01T10:05:00.000Z',
        });
        expect(upsertJob({
            provider: 'gemini', jobId: 'new01', slug: 's', status: 'running', promptFile: 'p', responseFile: 'r',
            model: 'm', agentRole: 'a', spawnedAt: new Date().toISOString(),
        }, cwd)).toBe(true);
        expect(getJobStats(cwd)).toMatchObject({ total: 2, completed: 1, active: 1 });
    });
    it('takes a state mutation lock in a legacy .state-mutation-locks.db', () => {
        const stateDir = join(tempDir('node-sqlite-legacy-locks-'), 'state');
        mkdirSync(stateDir, { recursive: true });
        copyFileSync(join(LEGACY_FIXTURES, 'state-mutation-locks.db'), join(stateDir, '.state-mutation-locks.db'));
        const previousEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'test';
        try {
            expect(withStateFileMutationLock(join(stateDir, 'ralph-state.json'), () => 'locked')).toEqual({ acquired: true, value: 'locked' });
        }
        finally {
            process.env.NODE_ENV = previousEnv;
        }
        const db = new (loadDatabaseSync())(join(stateDir, '.state-mutation-locks.db'));
        try {
            expect(db.prepare('SELECT lock_key FROM state_mutation_locks').all()).toEqual([{ lock_key: '/legacy/unrelated.json.mutation.lock' }]);
        }
        finally {
            db.close();
        }
    });
});
//# sourceMappingURL=node-sqlite.test.js.map