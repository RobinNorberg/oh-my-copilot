/**
 * Engine test helpers for FactoryGate.next: the argv lists a park seals, and
 * the check that the outcome's gate is the sealed one (the state file the
 * read surfaces verify), with its merge step equal to the outcome's merge
 * command.
 */
import { expect } from 'vitest';
import type { FactoryRunOutcome } from '../engine.js';
import { humanCommand } from '../gate-next.js';
import { readFactoryState, type FactoryRunKey } from '../state.js';

const sig = (key: FactoryRunKey): string => String(key).slice('heal-'.length);

/** The fixed steps of a run key, as argv. */
export function steps(key: FactoryRunKey) {
  const heal = typeof key === 'string';
  return {
    status: heal ? ['omg', 'factory', 'heal', 'status', sig(key)] : ['omg', 'factory', 'run', 'status', String(key)],
    resume: heal ? ['omg', 'factory', 'heal', 'approve', sig(key)] : ['omg', 'factory', 'run', String(key)],
    cancel: heal ? ['omg', 'factory', 'heal', 'cancel', sig(key)] : ['omg', 'factory', 'run', 'cancel', String(key)],
    close: ['omg', 'factory', 'heal', 'close', sig(key)],
    release: ['omg', 'factory', 'run', 'release', '--tamper'],
    flag: (f: string) => ['omg', 'factory', 'run', String(key), f],
  };
}

/**
 * The argv list of the park `out` stopped at, after checking that the state
 * file seals the same gate.next and, at the merge gate, that the merge step, as shown, is
 * the outcome's merge command.
 */
export function sealedNext(root: string, key: FactoryRunKey, out: FactoryRunOutcome): string[][] {
  const next = out.gate?.next;
  expect(next, `${out.gate?.name ?? 'no gate'}: no gate.next`).toBeDefined();
  expect(readFactoryState(root, key)?.gate?.next).toEqual(next);
  if (out.gate?.name === 'merge' && out.mergeCommand && next![0].argv[0] !== 'omg') expect(humanCommand(next![0].argv)).toBe(out.mergeCommand);
  return next!.map((n) => n.argv);
}
