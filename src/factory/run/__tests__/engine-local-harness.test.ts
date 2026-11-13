/**
 * The local engine harness runs its engines as under a plain shell, also when
 * the factory runs this suite in its gate env (GIT_CONFIG_NOSYSTEM and
 * GIT_CONFIG_GLOBAL set): with them, a checkout made with Git for Windows'
 * system core.autocrlf=true read as changed and the local gate parked at
 * lane-tampered (run #536).
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = 'gate-home/.gitconfig-empty';
  process.env.GIT_CONFIG_SYSTEM = 'gate-home/none';
});

import { LOCAL_ISSUE } from './engine-local-harness.js';

describe('engine-local-harness', () => {
  it('drops the gate env\'s git config variables on import', () => {
    expect(LOCAL_ISSUE).toBe(7);
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBeUndefined();
    expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(process.env.GIT_CONFIG_SYSTEM).toBeUndefined();
  });
});
