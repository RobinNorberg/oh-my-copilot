import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUltragoalPlan, readUltragoalPlan, startNextUltragoal, UltragoalError } from '../artifacts.js';
import { missingGoalCriteria, omgGoalRecordPath, omgGoalRecordSnapshot, readOmgGoalRecord, recordOmgGoalEvidence, startOmgGoal } from '../goal-record.js';
import { ultragoalCommand } from '../../cli/commands/ultragoal.js';

const ENV_KEYS = ['HOME', 'USERPROFILE', 'OMC_STATE_DIR', 'COPILOT_CLI', 'COPILOT_AGENT_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT'] as const;
let saved: Record<string, string | undefined>;
let cwd: string;
let originalCwd: string;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  cwd = await mkdtemp(join(tmpdir(), 'omg-goal-record-'));
  process.env.HOME = cwd;
  process.env.USERPROFILE = cwd;
  delete process.env.OMC_STATE_DIR;
  delete process.env.COPILOT_CLI;
  delete process.env.COPILOT_AGENT_SESSION_ID;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await rm(cwd, { recursive: true, force: true });
});

async function startedPlan() {
  await createUltragoalPlan(cwd, { brief: 'ship', goals: [{ title: 'Ship', objective: 'Ship the feature' }] });
  return startNextUltragoal(cwd);
}

describe('OMG goal record', () => {
  it('starts with the aggregate objective the guard expects and completes when every criterion has evidence', async () => {
    const { plan } = await startedPlan();
    const record = await startOmgGoal(cwd, { criteria: ['tests pass', 'docs updated'] });

    expect(record.objective).toBe(plan.claudeObjective);
    expect(record.status).toBe('active');
    expect(record.goalId).toBe('G001-ship');
    expect(record.criteria.map((criterion) => criterion.id)).toEqual(['C1', 'C2']);
    expect(omgGoalRecordSnapshot(record)).toMatchObject({ objective: plan.claudeObjective, status: 'active' });

    await recordOmgGoalEvidence(cwd, { criterion: 'c1', evidence: 'npm test green' });
    const done = await recordOmgGoalEvidence(cwd, { criterion: 'C2', evidence: 'README updated' });
    expect(done.status).toBe('complete');
    expect(missingGoalCriteria(done)).toEqual([]);
    expect(omgGoalRecordSnapshot(done).status).toBe('complete');
    expect(JSON.parse(await readFile(omgGoalRecordPath(cwd), 'utf-8')).status).toBe('complete');
  });

  it('keeps evidence for an unchanged criterion when the record is restarted', async () => {
    await startedPlan();
    await startOmgGoal(cwd, { criteria: ['tests pass'] });
    await recordOmgGoalEvidence(cwd, { criterion: 'C1', evidence: 'green' });
    const restarted = await startOmgGoal(cwd, { criteria: ['tests pass', 'lint clean'] });
    expect(restarted.criteria[0]).toMatchObject({ text: 'tests pass', evidence: 'green' });
    expect(restarted.status).toBe('active');
  });

  it('rejects a start without criteria, without a plan or objective, and unknown criteria', async () => {
    await expect(startOmgGoal(cwd, { criteria: [] })).rejects.toThrow(/--criterion/);
    await expect(startOmgGoal(cwd, { criteria: ['x'] })).rejects.toThrow(/No ultragoal plan/);
    await startOmgGoal(cwd, { criteria: ['x'], objective: 'explicit objective' });
    await expect(recordOmgGoalEvidence(cwd, { criterion: 'C9', evidence: 'e' })).rejects.toThrow(/Unknown criterion/);
  });

  it('reports a corrupt record as an UltragoalError and lets goal-start replace it', async () => {
    await startedPlan();
    await writeFile(omgGoalRecordPath(cwd), '{"version": 1, "objective": ');
    const error = await readOmgGoalRecord(cwd).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UltragoalError);
    expect((error as Error).message).toMatch(/Corrupt OMG goal record/);

    const replaced = await startOmgGoal(cwd, { criteria: ['tests pass'] });
    expect((await readOmgGoalRecord(cwd))?.criteria).toEqual(replaced.criteria);
  });

  it('writes the record without leaving temp files behind', async () => {
    await startedPlan();
    await startOmgGoal(cwd, { criteria: ['tests pass'] });
    await recordOmgGoalEvidence(cwd, { criterion: 'C1', evidence: 'green' });
    const dir = join(omgGoalRecordPath(cwd), '..');
    expect((await readdir(dir)).filter((name) => name.includes('omg-goal'))).toEqual(['omg-goal.json']);
  });

  it('drops the record when create-goals recreates the plan', async () => {
    await startedPlan();
    await startOmgGoal(cwd, { criteria: ['tests pass'] });
    await createUltragoalPlan(cwd, { brief: 'again', goals: [{ title: 'Again', objective: 'Ship it again' }], force: true });
    expect(await readOmgGoalRecord(cwd)).toBeNull();
  });
});

describe('omg ultragoal CLI on Copilot', () => {
  it('checkpoints with the goal record as the snapshot when --claude-goal-json is omitted', async () => {
    process.env.COPILOT_CLI = '1';
    process.chdir(cwd);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => { errors.push(line); });
    await createUltragoalPlan(cwd, { brief: 'two', goals: [{ title: 'One', objective: 'first' }, { title: 'Two', objective: 'second' }] });
    await ultragoalCommand(['complete-goals']);
    await ultragoalCommand(['goal-start', '--criterion', 'both stories shipped']);

    // Non-final story in aggregate mode: the active record is the snapshot.
    await ultragoalCommand(['checkpoint', '--goal-id', 'G001-one', '--status', 'complete', '--evidence', 'done']);
    expect(errors).toEqual([]);
    expect((await readUltragoalPlan(cwd)).goals[0]?.status).toBe('complete');
    expect(await readOmgGoalRecord(cwd)).not.toBeNull();
  });

  it('keeps requiring --claude-goal-json on Claude Code', async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.chdir(cwd);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => { errors.push(line); });
    await createUltragoalPlan(cwd, { brief: 'two', goals: [{ title: 'One', objective: 'first' }, { title: 'Two', objective: 'second' }] });
    await ultragoalCommand(['complete-goals']);
    await ultragoalCommand(['goal-start', '--criterion', 'both stories shipped']);

    await ultragoalCommand(['checkpoint', '--goal-id', 'G001-one', '--status', 'complete', '--evidence', 'done']);
    expect(errors.join('\n')).toMatch(/Claude goal snapshot is absent/);
    expect((await readUltragoalPlan(cwd)).goals[0]?.status).toBe('in_progress');
  });

  it('adds the Copilot goal-record handoff to complete-goals on Copilot', async () => {
    process.env.COPILOT_CLI = '1';
    process.chdir(cwd);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    await createUltragoalPlan(cwd, { brief: 'one', goals: [{ title: 'One', objective: 'first' }] });
    await ultragoalCommand(['complete-goals']);
    expect(lines.join('\n')).toContain('omg ultragoal goal-start');
  });
});
