---
name: upstream-port-conflict-patterns
description: Recognize and resolve recurring conflict patterns when cherry-picking upstream commits into oh-my-copilot — duplicate-region conflicts, dist/bridge artifact noise, Windows test failures, ESM duplicate declarations, output-shape divergence, obsolete tests, CRLF/LF mismatches
triggers:
  - "cherry-pick conflict"
  - "huge conflict block"
  - "duplicate test conflict"
  - "dist conflict cherry-pick"
  - "bridge/cli.cjs conflict"
  - "boot_id readLinuxBootId"
  - "spawn sh status null"
  - "vitest no error detail"
  - "POSIX shell test windows"
  - "TS1117 already declared"
  - "Identifier already declared"
  - "duplicate companyContext"
  - "duplicate function implementation"
  - "permissionDecisionReason undefined"
  - "hookSpecificOutput permissionDecision"
  - "M missions/demo/mission.md"
  - "autoresearch_reset_requires_clean_worktree"
  - "wholesale theirs cherry-pick"
  - "obsolete SKILL.md test"
---

# Upstream Port — Recurring Conflict Patterns

## The Insight

When cherry-picking upstream commits into `oh-my-copilot`, seven classes of conflict / post-merge breakage recur and have non-obvious resolutions:

1. **Mostly-duplicate conflict regions** — A 400-line conflict where 95% is content already ported in earlier piecemeal cherry-picks. Resolution is *deletion-heavy*, not *content-merging*.
2. **dist/bridge artifact noise** — Cherry-picked commits include rebuilt artifacts that conflict with our prior rebuilds. These conflicts mean nothing; we rebuild ourselves anyway.
3. **Windows-specific test failures** — Upstream tests assume Linux primitives (POSIX `sh`, `/proc/sys/kernel/random/boot_id`, forward-slash path separators, sub-second real-git fixtures, LF line endings). They fail on the maintainer's Windows + Defender ASR machine.
4. **Wholesale-theirs produces silent duplicate declarations** — When you take `--theirs` for a file that fork already had a similar version of, git's 3-way auto-merge produces concatenated source with **duplicate function/const/type declarations**. TypeScript catches some (TS1117); ESM at runtime catches others (`Identifier 'X' has already been declared`). Build success ≠ runtime safety.
5. **Fork-vs-upstream output-shape divergence in hooks** — Fork's hook scripts may return a different JSON envelope than upstream tests expect (e.g. flat `{permissionDecision, ...}` vs wrapped `{hookSpecificOutput: {permissionDecision, ...}}`). New upstream tests assert on the wrapped shape; fork tests need shape-adjustment, not source change.
6. **Obsolete-by-wholesale-refresh tests** — A previous wholesale refresh (e.g. PR #81's skill catalog refresh) brought in *current* upstream SKILL.md content. Later cherry-picks of *older* upstream commits include tests that assert on the *older* SKILL.md text. The cherry-picked tests are obsolete the moment they land — skip with a comment.
7. **CRLF/LF spurious modified-tracked files in real-git fixtures** — On Windows with `core.autocrlf=true`, fixtures that `git worktree add HEAD` then `writeFile(..., 'utf-8')` (LF) onto tracked files cause git status to report `M` (worktree modified) even though logical content is identical. Tests calling `assertResetSafeWorktree` fail with `M missions/demo/mission.md`. Skip the test, not the source.

Without recognizing these classes, you waste time hand-resolving content that should be deleted, chasing test failures that need platform skips, or worse — pushing branches whose dist/cli.cjs has runtime-broken duplicate declarations that pass typecheck but crash on first import.

## Why This Matters

Real examples from PR #75 (cluster A, SessionStart cleanup) and PR #76 (cluster C/D, post-tool-verifier + HUD cache):

- **`bridge-routing.test.ts` conflict region was 397 lines** containing only 4 genuinely new SessionStart tests. The other 393 lines were duplicate ralplan/keyword-detector/workflow-slot tests already in the fork from earlier port branches. Hand-merging would have produced 393 lines of broken duplicate test names.
- **`bridge/cli.cjs` and `dist/team/*.js.map` conflicts** appeared on 4 of 12 auto-merge cherry-picks. Each blocked the cherry-pick. Resolution: `git checkout HEAD -- bridge/ dist/ && git add src/` and skip — we rebuild at the end of the port branch.
- **`hud-cache-wrapper.test.ts` had 7/7 failures** with `result.status === null` and no error message. Cause: `spawnSync('sh', ...)` cannot find `sh.exe` on the test PATH. The wrapper itself is POSIX-only and never invoked on Windows in production. Fix: skip the `describe` block on win32.
- **`bridge-routing.test.ts` reconcile test failed** because `hasDurableAbandonmentEvidence` reads `/proc/sys/kernel/random/boot_id` which doesn't exist on Windows. Cleanup never triggers. Fix: `it.skipIf(process.platform === 'win32')`.

## Recognition Pattern

### Pattern 1: Mostly-duplicate conflict region

**Signs:**
- Conflict region is hundreds of lines
- Test names in the upstream-side appear with line numbers that DON'T conflict — meaning the same tests already exist elsewhere in our HEAD with the same names
- The few genuinely-new items are clustered (e.g. 4 new SessionStart tests at the end of a 397-line block)

**Diagnostic:** `grep -n "^\s*it(" <file>` outside the conflict region. If a test name appearing inside the conflict also appears outside, it's a duplicate.

### Pattern 2: dist/bridge artifact conflicts

**Signs:**
- Conflicting files: any path under `dist/`, `bridge/cli.cjs`, `bridge/team.js`, `bridge/runtime-cli.cjs`, `bridge/mcp-server.cjs`
- The src-side merge succeeded cleanly; only artifacts conflict

**Diagnostic:** `git status --short | grep -E '^(UU|DU) (bridge|dist)/'`. If all conflicts are under `bridge/` or `dist/`, it's pure artifact noise.

### Pattern 3: Windows test failures after a clean cherry-pick

**Signs:**
- `spawnSync('sh', ...).status === null` (sh.exe not found)
- AssertionError on path comparisons that include backslashes vs forward slashes
- Boot-id / `readLinuxBootId` returns `undefined` so cleanup logic never triggers
- Real-git fixture tests time out at 5-second per-merge thresholds
- Any test that constructs `path.join(tempDir, '/literal/forward/slashes')` then asserts `.toContain` against the result

**Diagnostic:** `process.platform === 'win32'` + the test exercises a POSIX primitive (sh, /proc, sub-second timing).

## The Approach

### Approach to Pattern 1 — Surgical extraction

Don't merge the conflict block. **Extract only the new content:**

```bash
# 1. Identify conflict boundary line numbers
grep -n "<<<<<<<\|>>>>>>>" <file>
# Example: 634:<<<<<<< HEAD, 1031:>>>>>>>

# 2. Identify the truly new tests inside the conflict region
sed -n '<conflict-start>,<conflict-end>p' <file> | grep "it(" 

# 3. Cross-reference against the file outside the conflict
grep "<test-name>" <file>
# If found at a different line outside the conflict, it's a duplicate

# 4. Extract only the genuinely-new lines (e.g. lines 869-1010 in the e.g. above)
sed -n '<new-start>,<new-end>p' <file> > /tmp/new-tests.txt

# 5. Apply fork rename map (.omc → .omcp, CLAUDE_CONFIG_DIR → COPILOT_CONFIG_DIR, etc.) via sed
sed -i "s|'.omc'|'.omcp'|g; s|.omc/state|.omcp/state|g" /tmp/new-tests.txt

# 6. Rebuild file: pre-conflict + new tests + post-conflict
awk 'NR<<conflict-start>' <file> > /tmp/merged.txt
cat /tmp/new-tests.txt >> /tmp/merged.txt
awk 'NR>=<conflict-end>+1' <file> >> /tmp/merged.txt
cp /tmp/merged.txt <file>
```

This is the workflow that cut PR #75's bridge-routing.test.ts conflict resolution from "merge 397 lines of mostly-duplicates" to "extract 142 lines of new tests."

### Approach to Pattern 2 — Discard during cherry-pick

When the only conflicts are under `bridge/` and `dist/`:

```bash
git checkout HEAD -- bridge/ dist/
git add src/  # or whatever non-artifact paths the commit touched
# If the commit only deleted artifacts and they're now back in the index:
git rm $(git status --short | grep '^DU' | awk '{print $2}')
git -c core.editor=true cherry-pick --continue
```

You rebuild dist/bridge once, at the end of the port branch, before the version-bump commit. Don't try to keep upstream's intermediate rebuilds — they'll just conflict with each subsequent cherry-pick.

### Approach to Pattern 3 — Skip on Windows, document why

When a test exercises POSIX-only or Linux-kernel primitives:

```typescript
// Whole describe block:
const describeIfNotWin = process.platform === 'win32' ? describe.skip : describe;
describeIfNotWin('HUD cached statusLine launcher', () => { ... });

// Single test:
it.skipIf(process.platform === 'win32')('reconciles a prior session...', async () => { ... });
```

**Always** add a comment immediately above the skip explaining:
- What platform primitive is missing (sh.exe, /proc/sys/kernel/random/boot_id)
- Where the production code path ALSO branches on platform (so the skip doesn't hide a real fork bug)
- Whether other tests cover the same code path on Windows

Without the comment, future maintainers can't tell whether the skip is "POSIX-only by design" vs "broken on Windows we should fix."

### Pattern 4 — Vitest hides errors with summary reporters

When a test failure summary shows `1 failed | 88 passed` but no AssertionError detail:

```bash
# Bad: tail -10 truncates the failure block
npx vitest run <file> 2>&1 | tail -10

# Good: capture full output, then read the failure-blocks region
npx vitest run <file> --reporter=verbose 2>&1 > /tmp/test.log
grep -B 2 -A 12 "AssertionError\|Error: " /tmp/test.log

# Or filter to the failed tests section
grep -A 20 "Failed Tests" /tmp/test.log
```

`--reporter=verbose` includes the full stack and assertion diff per failure. The default reporter compresses these into a 4-line summary that disappears when you pipe through `tail`.

## Example — Synthesizing all three patterns on PR #75

```bash
# Cherry-pick attempt
git cherry-pick 3e2a8164
# CONFLICT: src/hooks/__tests__/bridge-routing.test.ts (397-line block)

# Pattern 1: extract only the 4 new SessionStart tests
sed -n '869,1010p' src/hooks/__tests__/bridge-routing.test.ts > /tmp/new.txt
sed -i "s|'.omc'|'.omcp'|g; s|.omc/state|.omcp/state|g" /tmp/new.txt
awk 'NR<=633' src/hooks/__tests__/bridge-routing.test.ts > /tmp/m.txt
cat /tmp/new.txt >> /tmp/m.txt
awk 'NR>=1032' src/hooks/__tests__/bridge-routing.test.ts >> /tmp/m.txt
cp /tmp/m.txt src/hooks/__tests__/bridge-routing.test.ts

# Continue cherry-pick
git add -A && git -c core.editor=true cherry-pick --continue

# Pattern 2: next cherry-pick conflicts only on dist/
git cherry-pick 60a881ca
# CONFLICT: 5 files, all under bridge/ or dist/
git checkout HEAD -- bridge/ dist/
git add src/
git -c core.editor=true cherry-pick --continue

# Pattern 3: build clean, but bridge-routing.reconcile test fails on Windows
# Diagnosis: hasDurableAbandonmentEvidence reads /proc/sys/kernel/random/boot_id
# Fix: skip on win32 with comment
```

### Pattern 4: ESM/TS duplicate declarations after wholesale-theirs

**Signs:**
- `git checkout --theirs <file>` (or zero-conflict auto-merge of similar code) on a file fork already had a version of
- Build error `TS1117: An object literal cannot have multiple properties with the same name`
- Or `TS2393: Duplicate function implementation`
- Or runtime `SyntaxError: Identifier 'X' has already been declared` on first import of the script
- Two visually-identical or near-identical blocks of code adjacent in the source

**Real cases (PRs #83, #84, #87):**
- `src/hooks/persistent-mode/index.ts`: duplicate `interface AutoresearchStopState`, `function getAutoresearchDeadlineMs`, `async function checkAutoresearch` (autoresearch port)
- `src/config/loader.ts`: duplicate `companyContext` property in `DEFAULT_CONFIG` (line 80) and again at line 83; also duplicate in `CONFIG_SCHEMA` (lines 850, 866) — TS1117
- `templates/hooks/pre-tool-use.mjs`: duplicate `const SESSION_ID_ALLOWLIST`, `function clearAwaitingConfirmationFlag`, `function confirmSkillModeStates` — Node ESM crashes immediately

**Diagnostic:**
```bash
grep -n "^function\|^const\|^export function\|^async function\|^interface" <file> | awk '{name=$2; gsub(/[\(=].*/,"",name); count[name]++} END {for (n in count) if (count[n]>1) print n": "count[n]}'
```

**Critical:** TypeScript `tsc --noEmit` catches duplicate property keys (TS1117) and duplicate function signatures (TS2393) but **misses** duplicate const/var declarations in `.mjs` files until runtime. After every wholesale-theirs cherry-pick, do `node templates/hooks/pre-tool-use.mjs < /dev/null 2>&1 | head -5` (or equivalent runtime smoke) before claiming success.

### Pattern 5: Output-shape divergence in hooks

**Signs:**
- Test asserts `output.hookSpecificOutput.permissionDecisionReason` and gets `Cannot read properties of undefined`
- The hook script *does* produce the expected text — `echo input | node script.mjs` shows the right `permissionDecisionReason`
- But the wrapper is missing or different from upstream's

**Real case (PR #88):** Fork's `scripts/pre-tool-enforcer.mjs` deny path returns flat `{permissionDecision, permissionDecisionReason}` (no envelope). Upstream's deny path (and tests) wrap in `{hookSpecificOutput: {permissionDecision, permissionDecisionReason}}`. The `additionalContext` success path uses `hookSpecificOutput`; the deny path doesn't.

**Approach:** Don't change the hook source. Update the imported test to use the fork shape:

```typescript
// Was (upstream-style):
const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
expect(hookOutput.permissionDecisionReason).toContain('...');

// Now (fork-flat):
const hookOutput = output as Record<string, unknown>;
expect(hookOutput.permissionDecisionReason).toContain('...');
```

If you change the source instead, you'll break other fork tests that already assert on the flat shape.

### Pattern 6: Obsolete-by-wholesale-refresh tests

**Signs:**
- Cherry-picking an *older* upstream commit lands a test that asserts on SKILL.md text
- The assertion text is very specific (e.g. `expect(skill.template).toContain('Stateful single-mission improvement loop')`)
- The current SKILL.md content is materially different (e.g. starts with `<Purpose>\nAutoresearch is...`)
- A previous PR (look for "wholesale refresh" in commit messages) replaced this skill's body

**Real case (PR #83):** The autoresearch-migration commit `5c5835a26` (Apr 17) added 9 tests asserting on Apr-17-vintage SKILL.md text. PR #81's wholesale skill refresh (Apr 28) had since replaced all SKILL.md bodies with Apr-28-vintage upstream content. Tests landed already-broken.

**Approach:** Skip with a tracking comment, don't try to fix the assertions:

```typescript
// PR #X port intentionally skipped — assertion targets pre-PR-#81 SKILL.md vintage.
// PR #81 wholesale-refreshed all SKILL.md from upstream; this test's expected text
// is from an earlier upstream state and is no longer present in the current SKILL.md.
it.skip('should retrieve the autoresearch skill by name', () => { ... });
```

Do NOT delete the test — leaving it skipped preserves intent if upstream eventually re-aligns SKILL.md to a body that satisfies the assertion.

### Pattern 7: CRLF/LF spurious M-status in real-git fixtures (Windows)

**Signs:**
- Test creates a fixture with `git init` + `git commit` of a tracked file
- Test then writes new content with `writeFile(path, content, 'utf-8')`
- `assertResetSafeWorktree` or similar git-clean-state check throws with `M missions/demo/mission.md`
- Only fails on Windows; Linux CI passes

**Why:** Windows git with `core.autocrlf=true` (default) checks out files with CRLF in the working tree. `writeFile(..., 'utf-8')` writes LF. Even when the logical content matches HEAD, the byte-level mismatch makes git report `M`.

**Approach:** Skip on Windows — the fixture's CRLF/LF mismatch is a Windows-test-environment limitation, not a real bug in the production code:

```typescript
it.skipIf(process.platform === 'win32')(
  'prepares runtime artifacts and persists autoresearch mode state',
  async () => { ... },
);
```

The 3 autoresearch runtime tests (`prepares runtime artifacts`, `materializes canonical mission artifacts`, `keeps improved candidates`) all hit this. Don't try to normalize CRLF in the fixture — it's brittle and the underlying logic is already verified by other tests on the same describe block.

## When to Update This Skill

Update if you discover an 8th recurring class of port conflicts. The seven patterns above cover all conflict-resolution and post-merge-breakage work observed across PRs #74-#88. If a new pattern recurs across 2+ ports, add it here.
