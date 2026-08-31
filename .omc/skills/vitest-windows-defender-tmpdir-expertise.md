---
name: vitest-windows-defender-tmpdir
description: Shared tmp dir per file beats per-test mkdtemp/rmSync on Windows by 2-3× for fs-backed tests
triggers:
  - "slow autopilot tests"
  - "slow test dev loop"
  - "test file wallclock"
  - "mkdtempSync slow"
  - "rmSync recursive slow"
  - "vitest wallclock Windows"
  - "Defender real-time scanning"
  - "tmpdir per test"
  - "pool threads chdir"
  - "process.chdir not supported in workers"
---

# Vitest Per-Test Tmp Dir Overhead on Windows with Defender

## The Insight

On Windows with Defender real-time scanning enabled, each `mkdtempSync(join(tmpdir(), ...))` + `rmSync(..., { recursive: true, force: true })` cycle costs **~1.5s** because Defender scans every file create and delete under `%TEMP%`. When 40 tests in one file each create and destroy their own temp directory via `beforeEach`/`afterEach`, that's ~60s of pure filesystem overhead — regardless of how trivial the tests themselves are.

The fix is structural, not configurational: **share one tmp dir per file** (`beforeAll`/`afterAll`) and clear only the mutable state subtree between tests. This preserves per-test isolation while amortizing the Defender-scanned mkdtemp/rmSync pair to once per file.

## Why This Matters

- `src/hooks/autopilot/__tests__/validation.test.ts` had 47 tests totalling 0.7s of actual test work but took **80.3s wallclock** — 79.6s was pure `mkdtemp + rmSync` overhead.
- Developers iterating on one file see slow feedback (`npx vitest run <file>`) even when their logic is fast.
- Full-suite wallclock (`npm test`) often does NOT improve from per-file fixes: 8 workers saturate Defender globally, so single-file savings get reabsorbed into other workers' wait time. This is **dev-loop perf**, not CI perf. Don't chase full-suite numbers.

## Recognition Pattern

Look for:
- Per-test durations of 1–3s in a file with simple pure-logic tests
- `beforeEach` that calls `mkdtempSync` under `os.tmpdir()`
- `afterEach` with `rmSync(testDir, { recursive: true, force: true })`
- Tests that operate on filesystem-backed state (JSON state files, lockfiles, SQLite, directory-scoped config)
- File wallclock >> sum of per-test `duration` fields in vitest's JSON reporter

In OMC specifically, the pattern lives in:
- `src/hooks/autopilot/__tests__/validation.test.ts`
- `src/hooks/autopilot/__tests__/cancel.test.ts`
- `src/hooks/autopilot/__tests__/transitions.test.ts`
- `src/hooks/persistent-mode/stop-hook-blocking.test.ts`

## The Approach

Replace this:

```ts
describe('X', () => {
  let testDir: string;
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'x-test-'));
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });
  // ...
});
```

With this:

```ts
describe('X', () => {
  let testDir: string;
  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), 'x-test-'));
  });
  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    // Clear BOTH subtrees — OMC state can live under .omc or .omcp
    // depending on the module-under-test and env. Clearing both is cheap
    // and prevents "expected no state" tests from seeing residue.
    rmSync(join(testDir, '.omc'), { recursive: true, force: true });
    rmSync(join(testDir, '.omcp'), { recursive: true, force: true });
  });
});
```

Measured in this codebase: `validation.test.ts` dropped 80.3s → 31.2s (**2.6×**) standalone.

## Dead Ends That Look Tempting

- `pool: 'threads'` in `vitest.config.ts` — breaks **79 tests** across 8 files with `TypeError: process.chdir() is not supported in workers`. Node worker threads don't support `process.chdir()`. Stay on default `pool: 'forks'` (or `poolMatchGlobs` to only thread-safe files, but that's usually not worth the complexity).
- `isolate: false` on threads pool — breaks fs-backed tests via shared worker state (`rmSync` in one test deletes setup from a concurrent test). Dozens of failures.
- Bumping `maxThreads`/`maxForks` above the physical core count — on Windows this usually makes things slower because Defender serializes on the single scan queue.
- Moving `%TEMP%` out of Defender's scan path — not a code change; out of scope for the repo.

## Also-Encountered Unrelated Gotcha

`vitest.config.ts` in upstream oh-my-claudecode shipped with a hardcoded Linux alias path:

```ts
resolve: { alias: { '@': '/home/bellman/Workspace/oh-my-copilot/src' } }
```

This alias silently does nothing on Windows and macOS dev boxes. Replace with:

```ts
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const projectRoot = dirname(fileURLToPath(import.meta.url));
// ...
resolve: { alias: { '@': resolve(projectRoot, 'src') } }
```

## Example — Validating the Win

```bash
# Before:
time npx vitest run src/hooks/autopilot/__tests__/validation.test.ts
# 80.3s wallclock

# After (shared tmp dir, clear subtree in beforeEach):
time npx vitest run src/hooks/autopilot/__tests__/validation.test.ts
# 31.2s wallclock — 2.6x faster
```

Profile per-file wallclock via JSON reporter:

```bash
npm test -- --run --reporter=json --outputFile=.test-results.json
node -e "
const d = JSON.parse(require('fs').readFileSync('.test-results.json','utf8'));
d.testResults
  .map(r => ({ n: r.name, w: (r.endTime - r.startTime) / 1000 }))
  .sort((a, b) => b.w - a.w)
  .slice(0, 15)
  .forEach(f => console.log(f.w.toFixed(1).padStart(7) + 's  ' + f.n));
"
```

The single-file wallclock sets the parallelism floor for the full suite on an 8-core box. Any file over ~40s is worth investigating with the pattern above.
