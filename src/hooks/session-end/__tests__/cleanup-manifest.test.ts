import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimSessionEndAction,
  claimSessionEndJob,
  deferSessionEndChain,
  finishSessionEndAction,
  isManifestTerminal,
  markSessionEndActionRunner,
  mutateSessionEndJob,
  prepareCoreManifest,
  readSessionEndJob,
  reapStaleSessionEndOwner,
  rearmUnclaimedSessionEndJob,
  releaseSessionEndJob,
  renewSessionEndLease,
  sealCoreManifest,
  sealWikiManifest,
  sessionEndJobsDirectory,
  takeSessionEndDiscoveryPage,
  sessionEndJobPath,
  updateSessionEndActionPayload,
  updateSessionEndJob,
} from '../cleanup-manifest.js';

// `afterJobRead` runs once, right after the next read of `jobPath` returns, so a
// foreign write can land between a caller's unlocked revision read and its CAS.
// `lockOpens` counts manifest lock acquisitions (one per CAS round-trip).
const fsControl = vi.hoisted(() => ({
  jobPath: undefined as string | undefined,
  afterJobRead: undefined as undefined | (() => void),
  lockOpens: 0,
  failLockOpens: 0,
}));
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: ((file: unknown, ...rest: unknown[]) => {
      const content = (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
      if (file === fsControl.jobPath && fsControl.afterJobRead) {
        const hook = fsControl.afterJobRead;
        fsControl.afterJobRead = undefined;
        hook();
      }
      return content;
    }) as typeof actual.readFileSync,
    openSync: ((file: unknown, ...rest: unknown[]) => {
      if (typeof file === 'string' && file === `${fsControl.jobPath}.lock` && rest[0] === 'wx') {
        fsControl.lockOpens++;
        if (fsControl.failLockOpens > 0) {
          fsControl.failLockOpens--;
          throw Object.assign(new Error('EIO: simulated lock failure'), { code: 'EIO' });
        }
      }
      return (actual.openSync as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.openSync,
  };
});

const directories: string[] = [];
beforeEach(() => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'omc-cleanup-state-'));
  directories.push(stateRoot);
  vi.stubEnv('OMC_STATE_DIR', stateRoot);
});

function project(): string {
  const directory = mkdtempSync(join(tmpdir(), 'omc-cleanup-manifest-'));
  directories.push(directory);
  return directory;
}

function preparedAndSealed(directory: string, sessionId = 'session-a') {
  expect(prepareCoreManifest(directory, sessionId, { transcriptPath: '/tmp/transcript' })).not.toBeNull();
  expect(sealCoreManifest(directory, sessionId)).not.toBeNull();
  expect(sealWikiManifest(directory, sessionId)).not.toBeNull();
  return sessionId;
}

afterEach(() => {
  fsControl.jobPath = undefined;
  fsControl.afterJobRead = undefined;
  fsControl.lockOpens = 0;
  fsControl.failLockOpens = 0;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('durable SessionEnd cleanup manifest', () => {
  it('seeds actions missing from an older-build manifest (plugin/standalone coexistence)', () => {
    const directory = project();
    const sessionId = 'stale-action-list';
    const jobPath = join(sessionEndJobsDirectory(directory), `${sessionId}.json`);

    // prepared-core manifest written by an older build that lacks spawn-next
    expect(prepareCoreManifest(directory, sessionId, { source: 'core' })).not.toBeNull();
    const stale = JSON.parse(readFileSync(jobPath, 'utf8')) as { actions: Record<string, unknown> };
    delete stale.actions['spawn-next'];
    writeFileSync(jobPath, JSON.stringify(stale));
    expect(prepareCoreManifest(directory, sessionId, { source: 'core', chain: { intentId: 'i-1', includeUserSettings: true } })).not.toBeNull();
    expect(readSessionEndJob(directory, sessionId)?.actions['spawn-next']?.payload).toMatchObject({ chain: { intentId: 'i-1', includeUserSettings: true } });

    // absent-core manifest from an older build: seed + durable payload merge
    const absent = JSON.parse(readFileSync(jobPath, 'utf8')) as { actions: Record<string, unknown>; producers: { core: { state: string } } };
    delete absent.actions['spawn-next'];
    absent.producers.core.state = 'absent';
    writeFileSync(jobPath, JSON.stringify(absent));
    expect(prepareCoreManifest(directory, sessionId, { source: 'core-2', chain: { intentId: 'i-2' } })).not.toBeNull();
    const job = readSessionEndJob(directory, sessionId);
    expect(job?.producers.core.state).toBe('prepared');
    expect(job?.actions['spawn-next']?.payload).toMatchObject({ chain: { intentId: 'i-2' } });
  });

  it('serializes concurrent core/wiki producers and rejects a second worker claim', async () => {
    const directory = project();
    const sessionId = 'concurrent-producers';
    await Promise.all([
      Promise.resolve().then(() => prepareCoreManifest(directory, sessionId, { source: 'core', callback: true })),
      Promise.resolve().then(() => sealWikiManifest(directory, sessionId, { source: 'wiki', capture: true })),
    ]);
    expect(sealCoreManifest(directory, sessionId)).not.toBeNull();

    const before = readSessionEndJob(directory, sessionId);
    expect(before?.producers.core.state).toBe('sealed');
    expect(before?.producers.wiki.state).toBe('sealed');
    expect(before?.actions.callback.payload).toMatchObject({ source: 'core', callback: true });
    expect(before?.actions['wiki-capture'].payload).toMatchObject({ source: 'wiki', capture: true });

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => claimSessionEndJob(directory, sessionId, 'worker-one', 'identity-one', Date.now() + 5_000)),
      Promise.resolve().then(() => claimSessionEndJob(directory, sessionId, 'worker-two', 'identity-two', Date.now() + 5_000)),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(readSessionEndJob(directory, sessionId)?.owner?.nonce).toBe(first?.owner?.nonce ?? second?.owner?.nonce);
  });

  it('uses expected-revision CAS rather than accepting a stale mutation', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'revision-cas');
    const initial = readSessionEndJob(directory, sessionId);
    expect(initial).not.toBeNull();

    const current = mutateSessionEndJob(directory, sessionId, initial!.revision, (job) => {
      job.phase = 'recoverable-failure';
    });
    const stale = mutateSessionEndJob(directory, sessionId, initial!.revision, (job) => {
      job.phase = 'complete';
    });

    expect(current?.revision).toBe(initial!.revision + 1);
    expect(stale).toBeNull();
    expect(readSessionEndJob(directory, sessionId)?.phase).toBe('recoverable-failure');
  });

  it('renews leases and reaps only expired, positively dead or PID-reused owners', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'leases');
    const claimed = claimSessionEndJob(directory, sessionId, 'owner', 'old-start', Date.now() + 5_000);
    expect(claimed?.owner).toMatchObject({ nonce: 'owner', leaseGeneration: 1 });
    const renewed = renewSessionEndLease(directory, sessionId, 'owner', 1, Date.now() + 5_000);
    expect(renewed?.owner?.leaseGeneration).toBe(2);

    // A live owner is never a legal reap result, even after its lease is expired.
    const path = join(sessionEndJobsDirectory(directory), `${sessionId}.json`);
    const expired = JSON.parse(readFileSync(path, 'utf8')) as { owner: { leaseExpiresAt: string } };
    expired.owner.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    writeFileSync(path, JSON.stringify(expired));
    const reap = reapStaleSessionEndOwner as unknown as (
      directory: string, sessionId: string, nonce: string, generation: number, liveness: string,
    ) => unknown;
    expect(reap(directory, sessionId, 'owner', 2, 'live')).toBeNull();
    expect(reapStaleSessionEndOwner(directory, sessionId, 'owner', 2, 'dead')?.owner).toBeNull();

    const again = claimSessionEndJob(directory, sessionId, 'reused-owner', 'reused-start', Date.now() + 5_000);
    const expiresAgain = JSON.parse(readFileSync(path, 'utf8')) as { owner: { leaseExpiresAt: string } };
    expiresAgain.owner.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    writeFileSync(path, JSON.stringify(expiresAgain));
    expect(again?.owner).toBeTruthy();
    expect(reapStaleSessionEndOwner(directory, sessionId, 'reused-owner', 1, 'mismatch')?.owner).toBeNull();
  });

  it('binds payload enrichment to the captured armed runner rather than the current owner', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'payload-authority');
    const owner = claimSessionEndJob(directory, sessionId, 'owner', 'identity', Date.now() + 5_000)!;
    const claimed = claimSessionEndAction(directory, sessionId, 'owner', 'foreground-cleanup', Date.now() + 5_000)!;
    const action = claimed.actions['foreground-cleanup'];
    const authority = { jobId: owner.jobId, actionName: 'foreground-cleanup' as const, attempt: action.attempts, ownerNonce: 'owner', runnerNonce: action.runner!.runnerNonce };
    expect(updateSessionEndActionPayload(directory, sessionId, authority, ['callback'], { proof: 'early' })).toBeNull();
    markSessionEndActionRunner(directory, sessionId, 'owner', 'foreground-cleanup', authority.runnerNonce, 'armed');
    expect(updateSessionEndActionPayload(directory, sessionId, authority, ['callback'], { proof: 'valid' })).not.toBeNull();
    for (const invalid of [{ ...authority, ownerNonce: 'stale-owner' }, { ...authority, runnerNonce: 'stale-runner' }, { ...authority, attempt: authority.attempt + 1 }, { ...authority, jobId: 'foreign-job' }]) {
      expect(updateSessionEndActionPayload(directory, sessionId, invalid, ['callback'], { proof: 'forged' })).toBeNull();
      expect(readSessionEndJob(directory, sessionId)?.actions.callback.payload.proof).toBe('valid');
    }
  });
  it('persists action claim, runner arm, result, and terminality separately from discovery tickets', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'action-transitions');
    const owner = claimSessionEndJob(directory, sessionId, 'owner', 'identity', Date.now() + 5_000)!;
    const claimed = claimSessionEndAction(directory, sessionId, 'owner', 'team-cleanup', Date.now() + 5_000)!;
    const runner = claimed.actions['team-cleanup'].runner!;
    expect(claimed.actions['team-cleanup']).toMatchObject({ status: 'claimed', attempts: 1, runner: { phase: 'reserved' } });
    expect(markSessionEndActionRunner(directory, sessionId, 'owner', 'team-cleanup', runner.runnerNonce, 'started')).not.toBeNull();
    expect(markSessionEndActionRunner(directory, sessionId, 'owner', 'team-cleanup', runner.runnerNonce, 'armed')).not.toBeNull();
    expect(finishSessionEndAction(directory, sessionId, 'owner', 'team-cleanup', runner.runnerNonce, true, 'completed')).not.toBeNull();

    let current = readSessionEndJob(directory, sessionId)!;
    for (const [name] of Object.entries(current.actions)) {
      if (name === 'team-cleanup') continue;
      current = mutateSessionEndJob(directory, sessionId, current.revision, (job) => {
        job.actions[name as keyof typeof job.actions].status = 'completed';
        job.actions[name as keyof typeof job.actions].runner = { attempt: 1, runnerNonce: `${name}-runner`, phase: 'terminal', deadlineAt: new Date().toISOString() };
      })!;
    }
    const released = releaseSessionEndJob(directory, sessionId, 'owner', owner.owner!.leaseGeneration);
    expect(released).not.toBeNull();
    const terminal = readSessionEndJob(directory, sessionId)!;
    expect(isManifestTerminal(terminal)).toBe(true);
    expect(terminal.phase).toBe('complete');

    // A stale ticket cannot make a terminal manifest non-terminal or runnable again.
    writeFileSync(join(sessionEndJobsDirectory(directory), 'discovery.json'), JSON.stringify({
      version: 2,
      cursor: 0,
      tickets: [{ sessionId, attempts: 0, retryAt: new Date(0).toISOString() }],
    }));
    expect(takeSessionEndDiscoveryPage(directory, 1)).toEqual([]);
    expect(isManifestTerminal(readSessionEndJob(directory, sessionId)!)).toBe(true);
  });

  it('keeps more than sixteen queued jobs discoverable through bounded rotating pages', () => {
    const directory = project();
    const sessionIds = Array.from({ length: 21 }, (_, index) => `queued-${index}`);
    for (const sessionId of sessionIds) {
      expect(prepareCoreManifest(directory, sessionId, { sequence: sessionId })).not.toBeNull();
      expect(sealCoreManifest(directory, sessionId)).not.toBeNull();
    }

    const discovered = new Set<string>();
    for (let page = 0; page < 6; page++) for (const sessionId of takeSessionEndDiscoveryPage(directory, 4)) discovered.add(sessionId);
    expect(discovered).toEqual(new Set(sessionIds));
  });

  it('leaves every simulated crash boundary recoverable instead of silently completing work', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'crash-boundaries');
    const owner = claimSessionEndJob(directory, sessionId, 'crashed-owner', 'identity', Date.now() + 5_000)!;
    const action = claimSessionEndAction(directory, sessionId, 'crashed-owner', 'python-cleanup', Date.now() + 5_000)!;
    const runner = action.actions['python-cleanup'].runner!;

    // These snapshots model crashes before/after claim, arm, result, release, completion, and ticket retirement.
    expect(readSessionEndJob(directory, sessionId)?.actions['python-cleanup'].runner?.phase).toBe('reserved');
    expect(markSessionEndActionRunner(directory, sessionId, 'crashed-owner', 'python-cleanup', runner.runnerNonce, 'armed')).not.toBeNull();
    expect(finishSessionEndAction(directory, sessionId, 'crashed-owner', 'python-cleanup', runner.runnerNonce, false, 'simulated-crash')).not.toBeNull();
    expect(readSessionEndJob(directory, sessionId)?.actions['python-cleanup']).toMatchObject({ status: 'retryable', lastOutcomeCode: 'simulated-crash', runner: { phase: 'terminal' } });
    expect(releaseSessionEndJob(directory, sessionId, 'crashed-owner', owner.owner!.leaseGeneration, 'lease-lost-during-python-cleanup')).not.toBeNull();
    expect(readSessionEndJob(directory, sessionId)).toMatchObject({ owner: null, phase: 'recoverable-failure' });
    expect(takeSessionEndDiscoveryPage(directory, 1)).toEqual([sessionId]);
  });

  it('records why a release left the job in recoverable-failure (#4076)', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'release-reason');
    const owner = claimSessionEndJob(directory, sessionId, 'owner', 'identity', Date.now() + 5_000)!;

    expect(releaseSessionEndJob(directory, sessionId, 'owner', owner.owner!.leaseGeneration, 'run-deadline-reached')).toMatchObject({
      phase: 'recoverable-failure',
      recoverableFailure: { reason: 'run-deadline-reached', ownerNonce: 'owner' },
    });
    // The reason must survive on disk: the CI artifact is the only evidence a
    // non-reproducing failure leaves behind.
    const persisted = readSessionEndJob(directory, sessionId)!;
    expect(persisted.recoverableFailure?.reason).toBe('run-deadline-reached');
    expect(Number.isFinite(Date.parse(persisted.recoverableFailure!.releasedAt))).toBe(true);

    // Default reason still names the release path when a caller passes nothing.
    const reclaimed = claimSessionEndJob(directory, sessionId, 'next-owner', 'identity', Date.now() + 5_000)!;
    expect(releaseSessionEndJob(directory, sessionId, 'next-owner', reclaimed.owner!.leaseGeneration)?.recoverableFailure).toMatchObject({
      reason: 'worker-released',
      ownerNonce: 'next-owner',
    });
  });

  it('renews and updates through a foreign same-lock write that bumped the revision', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'revision-drift');
    claimSessionEndJob(directory, sessionId, 'owner', 'identity', Date.now() + 5_000);
    fsControl.jobPath = sessionEndJobPath(directory, sessionId);
    // An action child writing the manifest mid-run, after the owner read its revision.
    const foreignWrite = (proof: string) => () => {
      const latest = readSessionEndJob(directory, sessionId)!;
      expect(mutateSessionEndJob(directory, sessionId, latest.revision, (job) => { job.actions.callback.payload = { ...job.actions.callback.payload, proof }; })).not.toBeNull();
    };

    fsControl.afterJobRead = foreignWrite('during-renew');
    const renewed = renewSessionEndLease(directory, sessionId, 'owner', 1, Date.now() + 5_000);
    expect(fsControl.afterJobRead).toBeUndefined();
    expect(renewed?.owner?.leaseGeneration).toBe(2);
    expect(renewed?.actions.callback.payload.proof).toBe('during-renew');

    fsControl.afterJobRead = foreignWrite('during-update');
    const updated = updateSessionEndJob(directory, sessionId, 'owner', (job) => { job.actions['team-cleanup'].payload = { ...job.actions['team-cleanup'].payload, owned: true }; });
    expect(fsControl.afterJobRead).toBeUndefined();
    expect(updated?.actions['team-cleanup'].payload.owned).toBe(true);
    expect(updated?.actions.callback.payload.proof).toBe('during-update');
  });

  it('defers the chain through a concurrent re-arm of the held job', () => {
    const directory = project();
    const sessionId = 'defer-rearm';
    expect(prepareCoreManifest(directory, sessionId, { transcriptPath: '/tmp/transcript', host: 'copilot' })).not.toBeNull();
    const before = readSessionEndJob(directory, sessionId)!.revision;
    fsControl.jobPath = sessionEndJobPath(directory, sessionId);
    // The previous turn's worker re-arms (every 5 s) between this SessionEnd's revision read and its CAS.
    fsControl.afterJobRead = () => { expect(rearmUnclaimedSessionEndJob(directory, sessionId)).not.toBeNull(); };

    const deferred = deferSessionEndChain(directory, sessionId, { reason: 'complete' });
    expect(fsControl.afterJobRead).toBeUndefined();
    expect(deferred?.revision).toBe(before + 2);
    expect(deferred?.actions['spawn-next'].payload.deferredChain).toEqual({ reason: 'complete' });
  });

  it('undoes a reserved action claim on release so a later worker can run it', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'release-reserved');
    const owner = claimSessionEndJob(directory, sessionId, 'owner', 'identity', Date.now() + 5_000)!;
    expect(readSessionEndJob(directory, sessionId)!.actions['team-cleanup']).toMatchObject({ status: 'pending', attempts: 0 });
    expect(claimSessionEndAction(directory, sessionId, 'owner', 'team-cleanup', Date.now() + 5_000)!.actions['team-cleanup']).toMatchObject({ status: 'claimed', attempts: 1, runner: { phase: 'reserved' } });

    const released = releaseSessionEndJob(directory, sessionId, 'owner', owner.owner!.leaseGeneration)!;
    const action = released.actions['team-cleanup'];
    expect(action).toMatchObject({ status: 'pending', attempts: 0 });
    expect(action.claimantNonce).toBeUndefined();
    expect(action.runner).toBeUndefined();

    claimSessionEndJob(directory, sessionId, 'next-owner', 'identity', Date.now() + 5_000);
    expect(claimSessionEndAction(directory, sessionId, 'next-owner', 'team-cleanup', Date.now() + 5_000)?.actions['team-cleanup']).toMatchObject({ status: 'claimed', attempts: 1, claimantNonce: 'next-owner' });
  });

  it('keeps an action claim whose runner already started across a release', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'release-started');
    const owner = claimSessionEndJob(directory, sessionId, 'owner', 'identity', Date.now() + 5_000)!;
    const runner = claimSessionEndAction(directory, sessionId, 'owner', 'team-cleanup', Date.now() + 5_000)!.actions['team-cleanup'].runner!;
    expect(markSessionEndActionRunner(directory, sessionId, 'owner', 'team-cleanup', runner.runnerNonce, 'started')).not.toBeNull();

    const released = releaseSessionEndJob(directory, sessionId, 'owner', owner.owner!.leaseGeneration)!;
    expect(released.actions['team-cleanup']).toMatchObject({ status: 'claimed', attempts: 1, claimantNonce: 'owner', runner: { runnerNonce: runner.runnerNonce, phase: 'started' } });
  });

  it('fails a lost lease on the first lock round-trip without retrying', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'lost-lease');
    const owner = claimSessionEndJob(directory, sessionId, 'owner', 'identity', Date.now() + 5_000)!;
    expect(mutateSessionEndJob(directory, sessionId, owner.revision, (job) => { job.owner = { ...job.owner!, nonce: 'other-owner' }; })).not.toBeNull();
    fsControl.jobPath = sessionEndJobPath(directory, sessionId);

    for (const attempt of [
      () => renewSessionEndLease(directory, sessionId, 'owner', 1, Date.now() + 5_000),
      () => updateSessionEndJob(directory, sessionId, 'owner', () => {}),
      () => releaseSessionEndJob(directory, sessionId, 'owner', 1),
    ]) {
      fsControl.lockOpens = 0;
      expect(attempt()).toBeNull();
      expect(fsControl.lockOpens).toBe(1);
    }
    expect(readSessionEndJob(directory, sessionId)?.owner?.nonce).toBe('other-owner');
  });

  it('keeps retrying a pre-existing caller through a failed lock, unlike the lease path', () => {
    const directory = project();
    const sessionId = 'seal-retry';
    expect(prepareCoreManifest(directory, sessionId, { transcriptPath: '/tmp/transcript' })).not.toBeNull();
    fsControl.jobPath = sessionEndJobPath(directory, sessionId);

    fsControl.failLockOpens = 2;
    expect(sealCoreManifest(directory, sessionId)?.producers.core.state).toBe('sealed');
    expect(fsControl.lockOpens).toBe(3);

    sealWikiManifest(directory, sessionId);
    const owner = claimSessionEndJob(directory, sessionId, 'owner', 'identity', Date.now() + 5_000)!;
    fsControl.lockOpens = 0;
    fsControl.failLockOpens = 1;
    expect(renewSessionEndLease(directory, sessionId, 'owner', owner.owner!.leaseGeneration, Date.now() + 5_000)).toBeNull();
    expect(fsControl.lockOpens).toBe(1);
  });

  it('bounds required failures and never retries a failed remote delivery attempt', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'bounded-failures');
    let owner = claimSessionEndJob(directory, sessionId, 'owner-1', 'identity', Date.now() + 5_000)!;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = claimSessionEndAction(directory, sessionId, owner.owner!.nonce, 'team-cleanup', Date.now() + 5_000)!;
      const runner = claimed.actions['team-cleanup'].runner!;
      expect(finishSessionEndAction(directory, sessionId, owner.owner!.nonce, 'team-cleanup', runner.runnerNonce, false, `failure-${attempt}`)).not.toBeNull();
      expect(releaseSessionEndJob(directory, sessionId, owner.owner!.nonce, owner.owner!.leaseGeneration)).not.toBeNull();
      owner = claimSessionEndJob(directory, sessionId, `owner-${attempt + 1}`, 'identity', Date.now() + 5_000)!;
    }
    expect(claimSessionEndAction(directory, sessionId, owner.owner!.nonce, 'team-cleanup', Date.now() + 5_000)?.actions['team-cleanup']).toMatchObject({
      status: 'expired', attempts: 3, lastOutcomeCode: 'required-attempt-limit',
    });

    for (const name of ['callback', 'notification', 'openclaw'] as const) {
      const claimed = claimSessionEndAction(directory, sessionId, owner.owner!.nonce, name, Date.now() + 5_000)!;
      const runner = claimed.actions[name].runner!;
      expect(finishSessionEndAction(directory, sessionId, owner.owner!.nonce, name, runner.runnerNonce, false, 'response-lost')).not.toBeNull();
      expect(readSessionEndJob(directory, sessionId)?.actions[name]).toMatchObject({ status: 'expired', attempts: 1, lastOutcomeCode: 'response-lost' });
      expect(claimSessionEndAction(directory, sessionId, owner.owner!.nonce, name, Date.now() + 5_000)).toBeNull();
    }
  });

  it('does not requeue a best-effort action after its owner dies with delivery uncertain', () => {
    const directory = project();
    const sessionId = preparedAndSealed(directory, 'reaped-delivery');
    const owner = claimSessionEndJob(directory, sessionId, 'owner', 'identity', Date.now() + 5_000)!;
    expect(claimSessionEndAction(directory, sessionId, 'owner', 'callback', Date.now() - 1)).not.toBeNull();
    const manifestPath = join(sessionEndJobsDirectory(directory), `${sessionId}.json`);
    const expired = JSON.parse(readFileSync(manifestPath, 'utf8')) as { owner: { leaseExpiresAt: string } };
    expired.owner.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    writeFileSync(manifestPath, JSON.stringify(expired));

    expect(reapStaleSessionEndOwner(directory, sessionId, 'owner', owner.owner!.leaseGeneration, 'dead')?.actions.callback).toMatchObject({
      status: 'expired', lastOutcomeCode: 'delivery-uncertain-owner-reaped', runner: { phase: 'terminal' },
    });
    const replacement = claimSessionEndJob(directory, sessionId, 'replacement', 'identity', Date.now() + 5_000)!;
    expect(claimSessionEndAction(directory, sessionId, replacement.owner!.nonce, 'callback', Date.now() + 5_000)).toBeNull();
  });
});
