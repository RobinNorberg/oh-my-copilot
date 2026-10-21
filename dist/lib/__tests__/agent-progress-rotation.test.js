import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
/** Runs once before the next renameSync: lets a test play a concurrent writer inside the stat-then-rename window. */
const race = vi.hoisted(() => ({ beforeRename: undefined }));
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        renameSync: (from, to) => {
            const hook = race.beforeRename;
            race.beforeRename = undefined;
            hook?.();
            actual.renameSync(from, to);
        },
    };
});
const { PROGRESS_MAX_BYTES, emitProgress, parseProgressLog } = await import('../agent-progress.js');
describe('emitProgress rotation under a concurrent writer', () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'omg-progress-rot-'));
    });
    afterEach(() => {
        race.beforeRename = undefined;
        rmSync(dir, { recursive: true, force: true });
    });
    it('a writer that lost the rotation race keeps the backup and both new lines', async () => {
        const actual = await vi.importActual('fs');
        const file = join(dir, 'lane.log');
        const full = 'x'.repeat(PROGRESS_MAX_BYTES);
        writeFileSync(file, full);
        // The other writer rotates the full log and appends its own line between our stat and our rename.
        race.beforeRename = () => {
            actual.renameSync(file, `${file}.1`);
            actual.appendFileSync(file, '2026-10-21T10:00:00.000Z phase=a status=start agent=other\n');
        };
        expect(emitProgress({ phase: 'b', status: 'start', agent: 'me', file, at: new Date('2026-10-21T10:00:01.000Z') })).toBe(true);
        expect(readFileSync(`${file}.1`, 'utf8')).toBe(full);
        expect(parseProgressLog(readFileSync(file, 'utf8')).map((e) => e.agent)).toEqual(['other', 'me']);
        expect(readdirSync(dir).sort()).toEqual(['lane.log', 'lane.log.1']);
    });
});
//# sourceMappingURL=agent-progress-rotation.test.js.map