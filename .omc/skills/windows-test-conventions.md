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

The skip helpers return true when the test must skip, and the reason sits in the call or the test
title. A gate must not hide a Linux run: check that the condition is false on Linux, because CI
only runs Linux.

## Known Windows product gaps

Gated tests below hide a real product gap, not a host limit. Remove the gate when the gap is fixed.

- **Deferred cleanup retry never schedules on a loaded Windows host.** The session-start hook
  probes lock-owner liveness with PowerShell, which needs 1-5 s under load. That exceeds the
  bounded probe budget, so the holder reads as "unverifiable" instead of "contended" and no
  deferred retry is scheduled. Gated: `retries deferred cleanup after its own lock wait expires` in
  `src/__tests__/session-start-script-context.test.ts` and
  `src/installer/__tests__/session-start-template.test.ts`.
  Fix options: (1) raise the probe budget on win32 so the PowerShell probe completes;
  (2) schedule the deferred retry when the holder is unverifiable, with a bounded retry count.
