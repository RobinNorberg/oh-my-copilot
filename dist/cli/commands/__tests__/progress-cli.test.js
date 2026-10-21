import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { progressCommand } from '../progress.js';
import { PROGRESS_AGENT_ENV, PROGRESS_FILE_ENV, parseProgressLine, parseProgressLog } from '../../../lib/agent-progress.js';
const T0 = Date.parse('2026-10-21T10:00:00.000Z');
const iso = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
describe('omg progress CLI', () => {
    let dir;
    let out;
    let err;
    let clock;
    /** Runs between watch polls: lets a test append lines as time passes. */
    let onSleep;
    let polls;
    const savedFile = process.env[PROGRESS_FILE_ENV];
    const savedAgent = process.env[PROGRESS_AGENT_ENV];
    const deps = () => ({
        now: () => new Date(clock),
        sleep: async () => {
            polls++;
            if (polls > 50)
                throw new Error('watch did not exit');
            clock += 60_000;
            onSleep(polls);
        },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        cwd: () => dir,
    });
    async function run(...argv) {
        process.exitCode = undefined;
        await progressCommand(deps()).parseAsync(argv, { from: 'user' });
        const code = Number(process.exitCode ?? 0);
        process.exitCode = undefined;
        return code;
    }
    const write = (name, ...lines) => {
        const file = join(dir, name);
        writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
        return file;
    };
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'omg-progress-cli-'));
        out = [];
        err = [];
        clock = T0;
        polls = 0;
        onSleep = () => { };
        delete process.env[PROGRESS_FILE_ENV];
        delete process.env[PROGRESS_AGENT_ENV];
    });
    afterEach(() => {
        if (savedFile === undefined)
            delete process.env[PROGRESS_FILE_ENV];
        else
            process.env[PROGRESS_FILE_ENV] = savedFile;
        if (savedAgent === undefined)
            delete process.env[PROGRESS_AGENT_ENV];
        else
            process.env[PROGRESS_AGENT_ENV] = savedAgent;
        rmSync(dir, { recursive: true, force: true });
    });
    describe('emit', () => {
        it('appends the event with note, agent and fields', async () => {
            const file = join(dir, 'lane.log');
            expect(await run('emit', 'build', 'ok', '--note', 'tsc clean', '--agent', 'lane-1', '--file', file, '--field', 'pr=42', '--field', 'sha=abc')).toBe(0);
            expect(parseProgressLog(readFileSync(file, 'utf8'))).toEqual([
                { ts: iso(0), phase: 'build', status: 'ok', note: 'tsc clean', agent: 'lane-1', fields: { pr: '42', sha: 'abc' } },
            ]);
        });
        it('rejects an unknown status, an empty phase and a bad --field with exit 2', async () => {
            const file = join(dir, 'lane.log');
            expect(await run('emit', 'build', 'stalled', '--file', file)).toBe(2);
            expect(await run('emit', ' ', 'ok', '--file', file)).toBe(2);
            expect(await run('emit', 'build', 'ok', '--file', file, '--field', 'novalue')).toBe(2);
            expect(await run('emit', 'build', 'ok', '--file', file, '--field', 'status=x')).toBe(2);
            expect(err.join('\n')).toMatch(/status must be one of/);
        });
        it('warns but exits 0 when the log cannot be written', async () => {
            const blocker = write('blocker');
            expect(await run('emit', 'build', 'start', '--file', join(blocker, 'lane.log'))).toBe(0);
            expect(err.join('\n')).toMatch(/could not write/);
        });
        it('defaults to <state root>/progress/<agent>.log under cwd', async () => {
            // A real repo: a non-git dir would anchor state under the home directory.
            execFileSync('git', ['init', '-q'], { cwd: dir });
            const savedStateDir = process.env.OMC_STATE_DIR;
            delete process.env.OMC_STATE_DIR;
            try {
                expect(await run('emit', 'build', 'start', '--agent', 'lane-x')).toBe(0);
            }
            finally {
                if (savedStateDir !== undefined)
                    process.env.OMC_STATE_DIR = savedStateDir;
            }
            expect(readFileSync(join(dir, '.omg', 'progress', 'lane-x.log'), 'utf8')).toMatch(/phase=build status=start agent=lane-x/);
        });
    });
    describe('watch --once', () => {
        it('reports only failed, blocked and stalled agents from existing logs', async () => {
            write('a.log', `${iso(-30)} phase=build status=start`);
            write('b.log', `${iso(-1)} phase=test status=blocked note="need approval"`);
            write('c.log', `${iso(-2)} phase=lint status=fail`);
            write('d.log', `${iso(-60)} phase=x status=start`, `${iso(-59)} phase=x status=done`);
            write('e.log', `${iso(-1)} phase=y status=heartbeat`);
            expect(await run('watch', '--dir', dir, '--once', '--stall', '10m')).toBe(0);
            expect(out.map((l) => parseProgressLine(l)).map((e) => `${e?.agent}:${e?.status}`)).toEqual(['a:stalled', 'b:blocked', 'c:fail']);
            expect(out[0]).toBe(`${iso(0)} phase=build status=stalled note="no event for 30m after status=start" agent=a idle=30m last_ts=${iso(-30)}`);
        });
        it('--replay prints every existing event with the agent filled in', async () => {
            const file = write('lane.log', `${iso(-2)} phase=a status=start`, 'garbage line', `${iso(-1)} phase=a status=ok note="x y"`);
            expect(await run('watch', '--file', file, '--once', '--replay')).toBe(0);
            expect(out).toEqual([
                `${iso(-2)} phase=a status=start agent=lane`,
                `${iso(-1)} phase=a status=ok note="x y" agent=lane`,
            ]);
        });
        it('reads a final line without a trailing newline', async () => {
            const file = join(dir, 'lane.log');
            writeFileSync(file, `${iso(0)} phase=a status=done`);
            expect(await run('watch', '--file', file, '--once', '--replay')).toBe(0);
            expect(out).toEqual([`${iso(0)} phase=a status=done agent=lane`]);
        });
        it('rejects a bad --stall or --interval with exit 2', async () => {
            expect(await run('watch', '--dir', dir, '--once', '--stall', 'soon')).toBe(2);
            expect(await run('watch', '--dir', dir, '--once', '--interval', '1')).toBe(2);
        });
    });
    describe('watch (streaming)', () => {
        it('streams new lines, synthesizes one stalled line per stall, and exits when every agent is done', async () => {
            const a = write('a.log', `${iso(0)} phase=old status=ok`);
            const b = join(dir, 'b.log');
            onSleep = (n) => {
                clock = T0 + n * 60_000;
                if (n === 1)
                    appendFileSync(a, `${iso(1)} phase=build status=start\n`);
                if (n === 2)
                    appendFileSync(b, `${iso(2)} phase=test status=start\n`); // file appears later
                if (n === 3)
                    appendFileSync(a, `${iso(3)} phase=build status=ok\n${iso(3)} phase=build status=done\n`);
                if (n === 9)
                    appendFileSync(b, `${iso(9)} phase=test status=heartbeat\n`);
                if (n === 12)
                    appendFileSync(b, `${iso(12)} phase=test status=done\n`);
            };
            expect(await run('watch', '--file', a, '--file', b, '--stall', '5m')).toBe(0);
            const seen = out.map((l) => parseProgressLine(l)).map((e) => `${e.agent}:${e.phase}:${e.status}@${(Date.parse(e.ts) - T0) / 60_000}`);
            expect(seen).toEqual([
                'a:build:start@1',
                'b:test:start@2',
                'a:build:ok@3',
                'a:build:done@3',
                'b:test:stalled@8',
                'b:test:heartbeat@9',
                'b:test:done@12',
            ]);
            expect(polls).toBe(12);
        });
        it('in directory mode picks up new files and does not exit on old finished logs alone', async () => {
            write('old.log', `${iso(-90)} phase=x status=done`);
            onSleep = (n) => {
                if (n === 2)
                    write('new.log', `${iso(2)} phase=y status=start`);
                if (n === 3)
                    appendFileSync(join(dir, 'new.log'), `${iso(3)} phase=y status=done\n`);
            };
            expect(await run('watch', '--dir', dir)).toBe(0);
            expect(out).toEqual([`${iso(2)} phase=y status=start agent=new`, `${iso(3)} phase=y status=done agent=new`]);
        });
        it('in directory mode a stale unfinished log is reported once but does not keep the watch open', async () => {
            write('crashed.log', `${iso(-90)} phase=x status=start`);
            onSleep = (n) => {
                if (n === 1)
                    write('new.log', `${iso(1)} phase=y status=start`);
                if (n === 2)
                    appendFileSync(join(dir, 'new.log'), `${iso(2)} phase=y status=done\n`);
            };
            expect(await run('watch', '--dir', dir)).toBe(0);
            expect(out.map((l) => parseProgressLine(l)).map((e) => `${e.agent}:${e.status}`)).toEqual(['crashed:stalled', 'new:start', 'new:done']);
            expect(polls).toBe(2);
        });
        it('a lane that fails and is recycled ends the watch with a final done, or with --until settled', async () => {
            onSleep = (n) => {
                if (n === 1)
                    write('lane.log', `${iso(1)} phase=build status=fail`);
                if (n === 2)
                    appendFileSync(join(dir, 'lane.log'), `${iso(2)} phase=report status=done\n`);
            };
            expect(await run('watch', '--dir', dir)).toBe(0);
            expect(polls).toBe(2);
            rmSync(join(dir, 'lane.log'));
            polls = 0;
            expect(await run('watch', '--dir', dir, '--until', 'settled')).toBe(0);
            expect(polls).toBe(1);
        });
        it('--since counts existing events as new', async () => {
            write('lane.log', `${iso(-5)} phase=a status=start`, `${iso(-4)} phase=a status=done`);
            expect(await run('watch', '--dir', dir, '--since', '10m')).toBe(0);
            expect(polls).toBe(0);
            expect(await run('watch', '--dir', dir, '--since', iso(-6))).toBe(0);
            expect(polls).toBe(0);
        });
        it('a reused --file ending in done needs a new event before the watch can exit', async () => {
            const file = write('lane.log', `${iso(-60)} phase=old status=done`);
            onSleep = (n) => {
                if (n === 2)
                    appendFileSync(file, `${iso(2)} phase=a status=start\n`);
                if (n === 3)
                    appendFileSync(file, `${iso(3)} phase=a status=done\n`);
            };
            expect(await run('watch', '--file', file)).toBe(0);
            expect(polls).toBe(3);
            expect(out).toEqual([`${iso(2)} phase=a status=start agent=lane`, `${iso(3)} phase=a status=done agent=lane`]);
        });
        it('--agents waits for slower lanes and reports one without a log as stalled', async () => {
            onSleep = (n) => {
                if (n === 1)
                    write('a.log', `${iso(1)} phase=x status=start`, `${iso(1)} phase=x status=done`);
                if (n === 4)
                    write('b.log', `${iso(4)} phase=y status=start`);
                if (n === 5)
                    appendFileSync(join(dir, 'b.log'), `${iso(5)} phase=y status=done\n`);
            };
            expect(await run('watch', '--dir', dir, '--agents', 'a, b', '--stall', '2m')).toBe(0);
            expect(polls).toBe(5);
            expect(out).toEqual([
                `${iso(1)} phase=x status=start agent=a`,
                `${iso(1)} phase=x status=done agent=a`,
                `${iso(3)} phase=pending status=stalled note="no event for 3m since the watch started" agent=b idle=3m`,
                `${iso(4)} phase=y status=start agent=b`,
                `${iso(5)} phase=y status=done agent=b`,
            ]);
        });
        it('rejects a bad --until, --since or --agents with exit 2', async () => {
            expect(await run('watch', '--dir', dir, '--until', 'never')).toBe(2);
            expect(await run('watch', '--dir', dir, '--since', 'yesterday')).toBe(2);
            expect(await run('watch', '--dir', dir, '--agents', ' , ')).toBe(2);
        });
        it('finishes a rotated file from <file>.1 before reading a new file that already regrew', async () => {
            const file = write('lane.log', `${iso(0)} phase=a status=start`);
            onSleep = (n) => {
                if (n === 1) {
                    appendFileSync(file, `${iso(1)} phase=a status=ok\n`);
                    renameSync(file, `${file}.1`);
                    write('lane.log', `${iso(1)} phase=b status=done note=${'x'.repeat(200)}`);
                }
            };
            expect(await run('watch', '--file', file)).toBe(0);
            expect(out.map((l) => parseProgressLine(l)).map((e) => `${e.phase}:${e.status}`)).toEqual(['a:ok', 'b:done']);
        });
        it('rereads a rotated (shrunken) file from the start', async () => {
            const file = write('lane.log', `${iso(0)} phase=a status=start note=${'x'.repeat(200)}`);
            onSleep = (n) => {
                if (n === 1)
                    writeFileSync(file, `${iso(1)} phase=a status=done\n`);
            };
            expect(await run('watch', '--file', file)).toBe(0);
            expect(out).toEqual([`${iso(1)} phase=a status=done agent=lane`]);
        });
    });
    describe('status', () => {
        it('prints a table of the latest event per agent', async () => {
            write('a.log', `${iso(-30)} phase=build status=start`);
            write('b.log', `${iso(-1)} phase=test status=done note="all green"`);
            expect(await run('status', '--dir', dir)).toBe(0);
            expect(out[0]).toMatch(/^AGENT\s+STATE\s+PHASE\s+STATUS\s+IDLE\s+NOTE$/);
            expect(out[1]).toMatch(/^a\s+stalled\s+build\s+start\s+30m$/);
            expect(out[2]).toMatch(/^b\s+done\s+test\s+done\s+1m\s+all green$/);
        });
        it('--json emits the summaries; OMG_PROGRESS_FILE is the default source', async () => {
            process.env[PROGRESS_FILE_ENV] = write('env.log', `${iso(0)} phase=p status=fail agent=lane-z`);
            expect(await run('status', '--json')).toBe(0);
            expect(JSON.parse(out.join('\n'))).toMatchObject([{ agent: 'lane-z', state: 'failed', idleMs: 0, last: { phase: 'p' } }]);
        });
        it('says so when there are no events', async () => {
            expect(await run('status', '--dir', join(dir, 'missing'))).toBe(0);
            expect(out).toEqual(['no progress events']);
        });
    });
});
//# sourceMappingURL=progress-cli.test.js.map