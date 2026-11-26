/**
 * Test helper: record every run state on disk in the engine ledger, as the
 * engine records its own writes. The board and poll show a state the ledger
 * does not hold as "not verified"; tests of trusted output call this after
 * planting their states. A state that fails its seal stays untrusted.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { EngineLedger } from '../../run/ledger.js';
import { factoryStateDir, type FactoryRunKey } from '../../run/state.js';

export function engineWroteAll(root: string, ledgerDir: string): void {
  let names: string[];
  try {
    names = readdirSync(factoryStateDir(root));
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^run-(\d+|heal-[0-9a-f]{8})\.json$/.exec(name);
    if (!m) continue;
    const key: FactoryRunKey = /^\d+$/.test(m[1]) ? Number(m[1]) : (m[1] as `heal-${string}`);
    const path = join(factoryStateDir(root), name);
    EngineLedger.open(ledgerDir, root, key).record(path, readFileSync(path, 'utf8'));
  }
}
