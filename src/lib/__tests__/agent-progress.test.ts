import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PROGRESS_AGENT_ENV,
  PROGRESS_FILE_ENV,
  PROGRESS_MAX_BYTES,
  PROGRESS_MAX_NOTE,
  PROGRESS_MAX_VALUE,
  classifyProgress,
  emitProgress,
  formatProgressDuration,
  formatProgressEvent,
  parseProgressDuration,
  parseProgressLine,
  parseProgressLog,
  progressAgentFileName,
  resolveProgressFile,
  summarizeProgress,
  type ProgressEvent,
} from '../agent-progress.js';

const T0 = '2026-10-21T10:00:00.000Z';
const ev = (over: Partial<ProgressEvent>): ProgressEvent => ({ ts: T0, phase: 'build', status: 'start', fields: {}, ...over });
const at = (minutes: number): Date => new Date(Date.parse(T0) + minutes * 60_000);

describe('agent progress line format', () => {
  it('writes bare values bare and the canonical key order', () => {
    expect(formatProgressEvent({ ts: T0, phase: 'build', status: 'ok', note: 'tsc-clean', agent: 'lane-1', fields: { pr: '42' } }))
      .toBe(`${T0} phase=build status=ok note=tsc-clean agent=lane-1 pr=42`);
  });

  it('round-trips quotes, backslashes, newlines, tabs, equals, empty and non-ASCII values', () => {
    const note = 'said "hi" \\ path C:\\x\nnext\tline a=b';
    const event = ev({ status: 'blocked', note, agent: 'lane two', fields: { empty: '', city: 'Göteborg' } });
    const line = formatProgressEvent(event);
    expect(line).not.toContain('\n');
    expect(line).toContain('note="said \\"hi\\" \\\\ path C:\\\\x\\nnext\\tline a=b"');
    expect(line).toContain('empty=""');
    expect(parseProgressLine(line)).toEqual(event);
  });

  it('accepts the hand-written informal form and CRLF endings', () => {
    expect(parseProgressLine('2026-10-21T10:00:00Z phase=explore status=start note=lane-progress-events\r')).toEqual({
      ts: '2026-10-21T10:00:00Z', phase: 'explore', status: 'start', note: 'lane-progress-events', fields: {},
    });
  });

  it('rejects malformed lines', () => {
    for (const line of [
      '',
      'not-a-date phase=a status=ok',
      `${T0} status=ok`,
      `${T0} phase=a`,
      `${T0} phase=a status=finished`,
      `${T0} phase=a status=ok note="unterminated`,
      `${T0} phase=a status=ok stray`,
      '12345 phase=a status=ok',
      'Mon phase=a status=ok',
      `${T0} phase=a status=ok note="x"y`,
      `${T0} phase=a status=ok note="x"phase=b`,
    ]) {
      expect(parseProgressLine(line), line).toBeNull();
    }
  });

  it('parses a log, skipping garbage, and keeps the synthesized stalled status readable', () => {
    const text = [`${T0} phase=a status=start`, 'garbage', `${T0} phase=a status=stalled agent=x idle=12m`, ''].join('\n');
    expect(parseProgressLog(text).map((e) => e.status)).toEqual(['start', 'stalled']);
  });

  it('drops reserved and invalid extra keys when formatting', () => {
    const line = formatProgressEvent(ev({ fields: { phase: 'x', '1bad': 'y', good: 'z' } }));
    expect(line).toBe(`${T0} phase=build status=start good=z`);
  });
});

describe('emitProgress', () => {
  let dir: string;
  const savedFile = process.env[PROGRESS_FILE_ENV];
  const savedAgent = process.env[PROGRESS_AGENT_ENV];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omg-progress-'));
    delete process.env[PROGRESS_FILE_ENV];
    delete process.env[PROGRESS_AGENT_ENV];
  });

  afterEach(() => {
    if (savedFile === undefined) delete process.env[PROGRESS_FILE_ENV];
    else process.env[PROGRESS_FILE_ENV] = savedFile;
    if (savedAgent === undefined) delete process.env[PROGRESS_AGENT_ENV];
    else process.env[PROGRESS_AGENT_ENV] = savedAgent;
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends one parseable line per call, creating parent directories', () => {
    const file = join(dir, 'nested', 'lane.log');
    expect(emitProgress({ phase: 'build', status: 'start', agent: 'lane', file, at: new Date(T0) })).toBe(true);
    expect(emitProgress({ phase: 'build', status: 'ok', note: 'all green', agent: 'lane', file, fields: { tests: 12 }, at: at(1) })).toBe(true);
    const events = parseProgressLog(readFileSync(file, 'utf8'));
    expect(events).toEqual([
      ev({ agent: 'lane' }),
      ev({ ts: at(1).toISOString(), status: 'ok', note: 'all green', agent: 'lane', fields: { tests: '12' } }),
    ]);
  });

  it('uses OMG_PROGRESS_FILE and OMG_PROGRESS_AGENT when no file or agent is passed', () => {
    const file = join(dir, 'env.log');
    process.env[PROGRESS_FILE_ENV] = file;
    process.env[PROGRESS_AGENT_ENV] = 'env-agent';
    expect(emitProgress({ phase: 'p', status: 'heartbeat' })).toBe(true);
    expect(parseProgressLog(readFileSync(file, 'utf8'))[0]).toMatchObject({ agent: 'env-agent', status: 'heartbeat' });
  });

  it('defaults to <state root>/progress/<agent>.log', () => {
    expect(resolveProgressFile('a/b c', undefined, dir)).toMatch(/[\\/]progress[\\/]a_b_c\.log$/);
    expect(progressAgentFileName('..')).toBe('_.log');
  });

  it('never throws and returns false for an unwritable path or invalid input', () => {
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    expect(emitProgress({ phase: 'p', status: 'start', file: join(blocker, 'lane.log') })).toBe(false);
    expect(emitProgress({ phase: '', status: 'start', file: join(dir, 'x.log') })).toBe(false);
    expect(emitProgress({ phase: 'p', status: 'stalled' as never, file: join(dir, 'x.log') })).toBe(false);
    expect(emitProgress(undefined as never)).toBe(false);
    expect(existsSync(join(dir, 'x.log'))).toBe(false);
  });

  it('truncates long notes and rotates a full log to .1', () => {
    const file = join(dir, 'big.log');
    writeFileSync(file, 'x'.repeat(PROGRESS_MAX_BYTES));
    expect(emitProgress({ phase: 'p', status: 'ok', note: 'n'.repeat(PROGRESS_MAX_NOTE + 50), file })).toBe(true);
    expect(readFileSync(`${file}.1`, 'utf8').length).toBe(PROGRESS_MAX_BYTES);
    const [event] = parseProgressLog(readFileSync(file, 'utf8'));
    expect(event.note).toHaveLength(PROGRESS_MAX_NOTE);
  });

  it('caps phase and field values, and cuts by code points so no surrogate pair is split', () => {
    const file = join(dir, 'cap.log');
    const note = `${'n'.repeat(PROGRESS_MAX_NOTE - 1)}😀😀`;
    expect(emitProgress({ phase: 'p'.repeat(PROGRESS_MAX_VALUE + 5), status: 'ok', note, file, fields: { long: 'v'.repeat(PROGRESS_MAX_VALUE + 5) } })).toBe(true);
    const [event] = parseProgressLog(readFileSync(file, 'utf8'));
    expect(event.phase).toHaveLength(PROGRESS_MAX_VALUE);
    expect(event.fields.long).toHaveLength(PROGRESS_MAX_VALUE);
    expect(event.note).toBe(`${'n'.repeat(PROGRESS_MAX_NOTE - 1)}😀`);
  });
});

describe('stall detection', () => {
  const opts = { stallMs: 10 * 60_000 };

  it('start / heartbeat / ok go stalled only after the threshold', () => {
    for (const status of ['start', 'heartbeat', 'ok'] as const) {
      expect(classifyProgress(ev({ status }), at(10), opts).state, status).toBe('running');
      expect(classifyProgress(ev({ status }), at(10.01), opts).state, status).toBe('stalled');
    }
  });

  it('fail and blocked surface at once; done never stalls', () => {
    expect(classifyProgress(ev({ status: 'fail' }), at(0), opts).state).toBe('failed');
    expect(classifyProgress(ev({ status: 'blocked' }), at(0), opts).state).toBe('blocked');
    expect(classifyProgress(ev({ status: 'done' }), at(600), opts).state).toBe('done');
  });

  it('clamps clock skew (event in the future) to zero idle time', () => {
    expect(classifyProgress(ev({}), at(-5), opts)).toEqual({ state: 'running', idleMs: 0 });
  });

  it('summarizes the latest event per agent, using the file name when lines carry no agent', () => {
    const summaries = summarizeProgress([
      { ...ev({ status: 'start' }), source: join('x', 'lane-a.log') },
      { ...ev({ ts: at(3).toISOString(), status: 'heartbeat' }), source: join('x', 'lane-a.log') },
      ev({ agent: 'lane-b', status: 'done', ts: at(1).toISOString() }),
      ev({ agent: 'lane-b', status: 'start' }),
      ev({ agent: 'lane-c', status: 'stalled', ts: at(20).toISOString() }),
    ], at(14), opts);
    expect(summaries.map((s) => [s.agent, s.state, s.last.status])).toEqual([
      ['lane-a', 'stalled', 'heartbeat'],
      ['lane-b', 'done', 'done'],
    ]);
    expect(summaries[0].idleMs).toBe(11 * 60_000);
  });

  it('a later line wins a timestamp tie', () => {
    const [s] = summarizeProgress([ev({ agent: 'a', status: 'start' }), ev({ agent: 'a', status: 'done' })], at(0), opts);
    expect(s.state).toBe('done');
  });
});

describe('durations', () => {
  it('parses units and bare numbers in the default unit', () => {
    expect(parseProgressDuration('10m')).toBe(600_000);
    expect(parseProgressDuration('90s')).toBe(90_000);
    expect(parseProgressDuration('1h')).toBe(3_600_000);
    expect(parseProgressDuration('250ms')).toBe(250);
    expect(parseProgressDuration('5')).toBe(300_000);
    expect(parseProgressDuration('5', 'ms')).toBe(5);
    expect(parseProgressDuration('ten')).toBeNull();
    expect(parseProgressDuration('-1m')).toBeNull();
  });

  it('formats idle time compactly', () => {
    expect(formatProgressDuration(45_000)).toBe('45s');
    expect(formatProgressDuration(12 * 60_000)).toBe('12m');
    expect(formatProgressDuration(185 * 60_000)).toBe('3h5m');
    expect(formatProgressDuration(120 * 60_000)).toBe('2h');
  });
});
