---
name: upstream-port-conflict-triage
description: Recurring playbook for resolving cherry-pick conflicts when porting oh-my-claudecode commits into oh-my-copilot
triggers:
  - "cherry-pick conflict"
  - "port upstream"
  - "oh-my-claudecode → oh-my-copilot"
  - ".omc/ .omcp/ rebrand"
  - "DU file in cherry-pick"
  - "expected 'block' received undefined"
  - "Array.isArray(skills) is false"
  - "symlinkSync requires admin on Windows"
---

# Upstream Port Conflict Triage

## The Insight

Cherry-picking from `upstream/dev` (oh-my-claudecode) into `oh-my-copilot` is not "resolve each conflict on its own merits" — it is a **classification problem** with a small set of well-known categories. Once you classify a conflict, the resolution is mechanical. Treating every conflict as a fresh problem wastes time and risks taking the wrong side on patterns you've already settled.

## Why This Matters

In a normal repo, a merge conflict means two contributors edited the same code with different intent. In a fork-port context, a conflict usually means **OMC has already made a deliberate divergence decision** that upstream is unaware of. Taking `--theirs` blindly silently reverts that decision (often only visible when CI catches it days later — example: `expected 'block', received undefined` because state was read from `.omcp/` but a ported test wrote to `.omc/`).

## Recognition Pattern

These six categories cover ~95% of conflicts when porting an upstream PR:

1. **State path divergence** — file has `.omc/state/sessions/` (upstream) but OMC stores state under `.omcp/state/sessions/`. Symptom: tests pass on Linux upstream but assertions read `undefined` in CI logs.
2. **Skill prefix divergence** — strings like `Skill("oh-my-claudecode:plan")` need to become `Skill("oh-my-copilot:plan")`. Frontmatter `name:` values stay (e.g. `name: omc-plan`).
3. **NPM package rename** — upstream renamed to `oh-my-copilot`; OMC publishes as `oh-my-copilot`. Affects doctor SKILL.md and `npm view` invocations.
4. **Config-dir rebrand** — `CLAUDE_CONFIG_DIR`/`.claude` (upstream) ↔ `COPILOT_CONFIG_DIR`/`.copilot` (OMC); `CLAUDE-omc.md` ↔ `copilot-instructions-omc.md`.
5. **Deleted-in-fork files (`DU` git status)** — files OMC removed intentionally (`setup-contracts-regression.test.ts`, `plugin-dir-capture.test.ts`, etc.). Always `git rm -f`.
6. **Upstream tests encoding OMC-inverted design choices** — `plugin-skill-budget.test.ts` (OMC kept glob), `Commands directory removed (#582)` (OMC re-added commands/), `deep-interview-provider-options.test.ts` (parser not wired in OMC's loader), Korean cross-script tests (OMC is English-only). Always `it.skip` or `describe.skip` with a comment explaining the divergence.

## The Approach

When cherry-pick hits a conflict, **classify first**, then resolve:

1. **Run `git --no-pager diff --name-only --diff-filter=U > /tmp/u.txt && cat /tmp/u.txt`** to list unmerged paths. Don't open editors until the full list is known.

2. **For each unmerged path, ask "what category?"**:
   - dist/, bridge/, *.map → take `--theirs`, rebuild later. These regenerate from source.
   - test file with `.omc/state/` pattern → sed-rebrand to `.omcp/state/` (category 1).
   - source/test with `Skill("oh-my-claudecode:...")` → rebrand prefix (category 2).
   - test referencing config-dir / CLAUDE.md filenames → rebrand (category 4).
   - file with `DU` status → `git rm -f` (category 5).
   - new test asserting design choice OMC inverted → skip with comment (category 6).
   - else → real merge, read both sides carefully.

3. **Sed-rebrand patterns that hit multiple times in this session**:
   ```bash
   sed -i 's|join(tempDir, "\.omc", "state"|join(tempDir, ".omcp", "state"|g' <file>
   sed -i "s|join(tempDir, '\.omc',|join(tempDir, '.omcp',|g" <file>
   sed -i 's|oh-my-claudecode:|oh-my-copilot:|g' <file>
   ```

4. **Platform-gate symlink tests**: upstream tests like "mirrors Linux credential file as a symlink" pass on Linux CI but fail locally on Windows because `symlinkSync` needs admin. Wrap with `it.skipIf(process.platform === 'win32')(...)`.

5. **Always rebuild after conflict resolution**: `npm run build` regenerates dist/bridge from source. Then commit dist/bridge alongside the resolved source — the plugin is git-distributed.

6. **PR body should call out which category each non-trivial resolution fell into**, so future port reviewers can see the OMC divergence decision being preserved, not silently overwritten.

## Example

A typical resolution sequence for one upstream PR's worth of conflicts (real, from session 2026-05-08):

```
git cherry-pick <sha>
# CONFLICT in src/hooks/persistent-mode/__tests__/oversize-tool-result-redirect.test.ts
# (test setup writes to .omc/state/)

# Category 1 — state path divergence:
sed -i "s|join(tempDir, '\.omc',|join(tempDir, '.omcp',|g' src/hooks/persistent-mode/__tests__/oversize-tool-result-redirect.test.ts

# CONFLICT in dist/hooks/persistent-mode/index.js (and .map siblings)
# Category 0 — generated artifacts:
git checkout --theirs dist/hooks/persistent-mode/index.js dist/hooks/persistent-mode/index.js.map
git add dist/

# DU on src/__tests__/setup-contracts-regression.test.ts
# Category 5 — deleted in fork:
git rm -f src/__tests__/setup-contracts-regression.test.ts

git -c core.editor=true cherry-pick --continue
npm run build           # regenerate dist/bridge
npm run test:run -- <touched-file>   # verify
```

That sequence works for ~9 out of 10 upstream-port conflicts in this fork. Stop and think only when none of the six categories fit.
