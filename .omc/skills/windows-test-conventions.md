---
name: windows-test-conventions
description: When a vitest failure on Windows gets a src fix, a test fix, or a platform gate, and the shared helper API for each
triggers:
  - "windows test failure"
  - "fails on win32"
  - "skipIf windows"
  - "symlink EPERM test"
  - "0o600 on windows"
  - "posix path in test"
---

# Windows test conventions

Shared helpers live in `src/__tests__/helpers/platform.ts`. Import them; do not write file-local probes.

## Decide: fix src, fix test, or gate

1. **The product path is meant to work on Windows** (state paths, locks, team I/O, config lookup, URIs):
   fix `src/`. A failing test there is a Windows bug. Never gate it.
2. **The product is right, the test assumes POSIX** (`/tmp/...` literals, `/` separators,
   `/proc/<pid>/stat`, `XDG_CONFIG_HOME` without `APPDATA`, `which`): fix the test. Build expected
   paths with `path.join`, compare with `toPosix()`, use the product's own helper
   (for example `getProcessStartIdentitySync`) instead of re-deriving platform data.
3. **The host cannot do it** (POSIX mode bits, symlinks without Developer Mode, a missing binary,
   a feature that is unavailable on win32 by design): gate with a helper below. Gate the smallest
   unit: split a mode assertion out of a test that also checks content, rather than skipping both.

## Helper API

| Helper | Use |
|---|---|
| `IS_WIN` | Branch expected values, not skips. |
| `posixOnly(reason)` | `it.skipIf(posixOnly('NTFS has no POSIX mode bits'))(...)`. True on win32. |
| `requiresSymlinks()` / `canCreateSymlinks()` | `it.skipIf(requiresSymlinks())(...)`. Cached probe for file and dir symlinks. |
| `canCreateJunctions()` | Junctions need no privilege on Windows; prefer them in fixtures that only need a linked dir. |
| `requiresExecutable(name)` / `hasExecutable(name)` | PATH + PATHEXT lookup without a shell. The WindowsApps `python`/`python3` Store stub counts as absent. |
| `toFileUrl(p)` | `pathToFileURL(p).href` for ESM imports of temp files. |
| `toPosix(p)` | Separator-agnostic path assertions. |
| `removeTempDir(p)` | Async teardown of a temp tree that a just-exiting or detached child may still hold (cwd or open handle). Node 25 `rmSync` throws EPERM at once despite `maxRetries`; this uses `fs.promises.rm`, which retries. |
| `scaleTiming(ms)` / `TIMING_SCALE` | Wall-clock ceilings tuned on Linux (`toBeLessThan(scaleTiming(500))`). 4x on win32, identity elsewhere. Keep a ceiling that guards a known stall (a 500ms spin) below that stall instead. |

The skip helpers return true when the test must skip, and the reason sits in the call or the test
title. A gate must not hide a Linux run: check that the condition is false on Linux, because CI
only runs Linux.

## Known Windows product gaps

Gated tests below hide a real product gap, not a host limit. Remove the gate when the gap is fixed.
None are open. List each new one here with the gated test names and the fix options.

## Win32 traps already fixed in product code

- `stat.ino` as a Number collides on NTFS: file IDs exceed 2^53, so adjacent directories round to
  one value. Key visited sets on `statSync(p, { bigint: true })` as `${dev}:${ino}`.
- A lock holder whose PowerShell owner probe outlasts a bounded budget reads "unverifiable", not
  "contended". Callers that can retry later must treat it as pending (session-start deferred
  cleanup does, with a bounded chain).
