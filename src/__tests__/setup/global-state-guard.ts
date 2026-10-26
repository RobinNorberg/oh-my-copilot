// Fails the run when a test wrote fixture session state into the checkout's own
// .omg / .omc state. State and hook code resolve their root from process.cwd(), so a
// test that does not isolate cwd (src/__tests__/helpers/isolated-cwd.ts) or set
// OMC_STATE_DIR pollutes the real project: its fake sessions then show up in state_list_active
// and slow every per-session scan. Real sessions have UUID ids and are ignored, so a live
// session in the same checkout does not trip the guard.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_ROOTS = ['.omg', '.omc'];

/** Session-id keyed entries under a state root, without UUID (real) sessions: name -> signature. */
function fixtureSessions(root: string, name: string): Map<string, string> {
  const found = new Map<string, string>();
  const add = (label: string, path: string): void => {
    const signature = (function sign(p: string): string {
      let files = 0;
      let newest = 0;
      const stack = [p];
      while (stack.length > 0) {
        const current = stack.pop()!;
        let stat;
        try {
          stat = statSync(current);
        } catch {
          continue;
        }
        newest = Math.max(newest, stat.mtimeMs);
        if (stat.isDirectory()) {
          for (const entry of readdirSync(current)) stack.push(join(current, entry));
        } else {
          files++;
        }
      }
      return `${files}:${newest}`;
    })(path);
    found.set(label, signature);
  };
  const scan = (dir: string, label: string, stem: boolean, keyed: (entry: string) => boolean = () => true): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (!keyed(entry)) continue;
      const id = stem ? entry.replace(/\.json$/, '') : entry;
      if (UUID.test(id)) continue;
      add(`${label}/${entry}`, join(dir, entry));
    }
  };
  scan(join(root, 'state', 'sessions'), `${name}/state/sessions`, false);
  scan(join(root, 'sessions'), `${name}/sessions`, true);
  // Only the <session id>.json job files are session keyed: runs/<job uuid>/ (action-runner.ts),
  // discovery.json and the *.lock / *.reclaim files beside the jobs are not.
  scan(join(root, 'state', 'session-end-jobs'), `${name}/state/session-end-jobs`, true, (entry) => entry.endsWith('.json') && entry !== 'discovery.json');
  return found;
}

/** Fixture session entries under the repository's .omg / .omc: label -> file count and newest mtime. */
export function snapshot(repo: string): Map<string, string> {
  const all = new Map<string, string>();
  for (const root of STATE_ROOTS) {
    for (const [label, signature] of fixtureSessions(join(repo, root), root)) all.set(label, signature);
  }
  return all;
}

export default function setup(): () => void {
  const repo = process.cwd();
  const before = snapshot(repo);
  return () => {
    const leaked = [...snapshot(repo)].filter(([label, signature]) => before.get(label) !== signature).map(([label]) => label);
    if (leaked.length > 0) {
      throw new Error(
        `tests wrote fixture session state into the repository's own state dir (${leaked.length}):\n  ${leaked.join('\n  ')}\n` +
        'Run the test from a temp repo (useIsolatedCwd in src/__tests__/helpers/isolated-cwd.ts) or point OMC_STATE_DIR at a temp dir.',
      );
    }
  };
}
