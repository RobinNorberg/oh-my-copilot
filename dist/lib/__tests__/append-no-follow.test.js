import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileNoFollow, openAppendExclusive } from '../append-no-follow.js';
/** Plants a file symlink at `link`; false where the host lacks the privilege (Windows without Developer Mode). */
function trySymlink(target, link) {
    try {
        symlinkSync(target, link, 'file');
        return true;
    }
    catch (err) {
        if (process.platform === 'win32' && err.code === 'EPERM')
            return false;
        throw err;
    }
}
/** Whether this host can plant a file symlink at all: the symlink-only cases run only then (the junction cases cover Windows). */
const canSymlink = (() => {
    const probe = mkdtempSync(join(tmpdir(), 'omg-nofollow-probe-'));
    try {
        return trySymlink(join(probe, 'target'), join(probe, 'link'));
    }
    finally {
        rmSync(probe, { recursive: true, force: true });
    }
})();
// The POSIX branch needs O_NOFOLLOW, which Windows lacks; the lstat branch runs everywhere.
const branches = process.platform === 'win32' ? ['win32'] : [process.platform, 'win32'];
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omg-nofollow-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
describe.each(branches)('appendFileNoFollow (%s branch)', (platform) => {
    it('creates the file, then appends to it', () => {
        const log = join(dir, 'debug.log');
        expect(appendFileNoFollow(log, 'one\n', platform)).toBe(true);
        expect(appendFileNoFollow(log, 'two\n', platform)).toBe(true);
        expect(readFileSync(log, 'utf8')).toBe('one\ntwo\n');
    });
    it('refuses a symlink (or, where file symlinks need privileges, a junction) planted at the path', () => {
        const victim = join(dir, 'victim');
        writeFileSync(victim, 'keep\n');
        const log = join(dir, 'recovery-debug.log');
        try {
            symlinkSync(victim, log, 'file');
        }
        catch {
            // Windows without symlink rights: a junction is the link a lane can always make.
            mkdirSync(join(dir, 'target'));
            symlinkSync(join(dir, 'target'), log, 'junction');
        }
        expect(appendFileNoFollow(log, 'pwned\n', platform)).toBe(false);
        expect(readFileSync(victim, 'utf8')).toBe('keep\n');
    });
    it('refuses a hard link to another file', () => {
        const victim = join(dir, 'victim');
        writeFileSync(victim, 'keep\n');
        const log = join(dir, 'comment-checker-debug.log');
        linkSync(victim, log);
        expect(appendFileNoFollow(log, 'pwned\n', platform)).toBe(false);
        expect(readFileSync(victim, 'utf8')).toBe('keep\n');
    });
});
describe('appendFileNoFollow (POSIX open flags)', () => {
    it.runIf(process.platform !== 'win32')('refuses a planted FIFO without blocking on it', () => {
        const log = join(dir, 'preemptive-compaction-debug.log');
        execFileSync('mkfifo', [log]);
        expect(appendFileNoFollow(log, 'x\n')).toBe(false);
    });
});
describe('openAppendExclusive', () => {
    it('creates the file and appends through the fd', () => {
        const file = join(dir, 'events.jsonl');
        const fd = openAppendExclusive(file);
        try {
            writeSync(fd, 'one\n');
            writeSync(fd, 'two\n');
        }
        finally {
            closeSync(fd);
        }
        expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
    });
    it('refuses a name that already exists', () => {
        const file = join(dir, 'events.jsonl');
        writeFileSync(file, 'old\n');
        expect(() => openAppendExclusive(file)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
        expect(readFileSync(file, 'utf8')).toBe('old\n');
    });
    // Windows without the symlink privilege: the junction test below covers the link a lane can always make.
    it.runIf(canSymlink)('refuses a planted symlink, live or dangling, and never writes or creates its target', () => {
        const victim = join(dir, 'bashrc');
        writeFileSync(victim, 'keep\n');
        const live = join(dir, 'events.jsonl');
        const dangling = join(dir, 'events2.jsonl');
        const missing = join(dir, 'created-through-link');
        symlinkSync(victim, live, 'file');
        symlinkSync(missing, dangling, 'file');
        expect(() => openAppendExclusive(live)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
        expect(() => openAppendExclusive(dangling)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
        expect(readFileSync(victim, 'utf8')).toBe('keep\n');
        expect(existsSync(missing)).toBe(false);
    });
    it('refuses a planted junction or directory', () => {
        mkdirSync(join(dir, 'target'));
        const file = join(dir, 'events.jsonl');
        symlinkSync(join(dir, 'target'), file, 'junction');
        expect(() => openAppendExclusive(file)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    });
    it('keeps writing the opened file after its name is renamed and replaced by a link', () => {
        const victim = join(dir, 'bashrc');
        writeFileSync(victim, 'keep\n');
        const file = join(dir, 'events.jsonl');
        const moved = join(dir, 'moved.jsonl');
        const fd = openAppendExclusive(file);
        try {
            writeSync(fd, 'before\n');
            renameSync(file, moved);
            if (!trySymlink(victim, file))
                writeFileSync(file, '');
            writeSync(fd, 'after\n');
        }
        finally {
            closeSync(fd);
        }
        expect(readFileSync(moved, 'utf8')).toBe('before\nafter\n');
        expect(readFileSync(victim, 'utf8')).toBe('keep\n');
    });
});
describe('hook debug logs', () => {
    // The hooks whose debug log lives in the lane-writable TEMP: each must append through the helper.
    const hooks = [
        'src/hooks/recovery/context-window.ts',
        'src/hooks/recovery/session-recovery.ts',
        'src/hooks/comment-checker/index.ts',
        'src/hooks/preemptive-compaction/index.ts',
        'src/hooks/empty-message-sanitizer/index.ts',
    ];
    it.each(hooks)('%s writes DEBUG_FILE only through appendFileNoFollow', (rel) => {
        const src = readFileSync(resolve(fileURLToPath(new URL('../../..', import.meta.url)), rel), 'utf8');
        expect(src).toContain("from '../../lib/append-no-follow.js'");
        expect(src).toMatch(/appendFileNoFollow\(DEBUG_FILE,/);
        expect(src).not.toMatch(/\bappendFile(Sync)?\b|\bcreateWriteStream\b|\b(?:writeFileSync|openSync)\(\s*DEBUG_FILE\b/);
    });
});
//# sourceMappingURL=append-no-follow.test.js.map