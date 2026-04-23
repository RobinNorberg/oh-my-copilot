---
name: learner-test-user-scope-leak
description: Learner bridge integration tests leak user-scope skills from ~/.copilot/skills/omc-learned and ~/.omcp/skills; assert on scope='project' subset, never on raw match counts.
triggers:
  - processMessageForSkills
  - matchSkillsForInjection
  - findSkillFiles
  - "expected 6 to be 3"
  - "injected: 6"
  - learner bridge test
  - skills omc-learned
---

# Learner Test User-Scope Leak

## The Insight

`src/hooks/learner/finder.ts#findSkillFiles()` searches **three** directories on every call:
1. `{projectRoot}/.omcp/skills/` (project scope)
2. `~/.omcp/skills/` (GLOBAL_SKILLS_DIR)
3. `~/.copilot/skills/omc-learned/` (USER_SKILLS_DIR)

Tests that construct a sandboxed project root (`tmpdir() + mkdirSync()`) are isolated for **project** scope only. The two **user** scopes are read straight from the developer's real `$HOME`. Any skills the developer has personally learned in that account will silently inflate every `processMessageForSkills` / `matchSkillsForInjection` / `loadAllSkills` call the test makes.

Worse: some older learned-skill files on disk serialize `triggers: [""]` (empty-string element — a known parser edge case in `parseSkillFile` when YAML list items are quoted in ways the regex parser mishandles). Because `findMatchingSkills` uses `messageLower.includes(trigger.toLowerCase())` and `"anything".includes("")` is always `true`, those user skills match **every** test prompt.

## Why This Matters

You'll see non-deterministic test failures shaped like:
```
AssertionError: expected 6 to be 3
```
where the 3 is the number of project skills you planted and the 6 (or N, or N+3, or N+your-own-user-skill-count) is what actually matched. The count depends on how many skills the developer running the test has learned. CI may pass with 3. Your laptop may fail with 9. A reviewer may see 7.

The symptom is especially confusing because:
- `beforeEach` recreates `testProjectRoot` (so the project-scope leak is closed)
- Your skill fixtures look correct
- `findMatchingSkills` filters by `score > 0`, so you'd expect non-matching user skills to drop — but the empty-string trigger bypasses that filter entirely

## Recognition Pattern

You're hitting this when:
- A new learner-bridge test fails with `expected N to be M` where `M < N`
- Same test passes in isolation on a fresh clone, fails after you've run `/learner` a few times locally
- Debug shows matched skills with `scope: 'user'` and triggers you didn't plant
- Extra matches often have unrelated names (e.g., `npm-global-esm-import-resolution`, `powershell-double-dash-passthrough`)

Quick confirmation:
```bash
ls ~/.copilot/skills/omc-learned/ ~/.omcp/skills/ 2>/dev/null
```
If either returns content, you have user-scope skills that may leak.

## The Approach

**For tests**, don't assert on raw match/inject counts. Either:

1. **Filter by scope** (preferred — keeps the test realistic and the behavior under test untouched):
   ```ts
   const projectInjected = result.skills.filter(s => s.scope === 'project');
   expect(projectInjected).toHaveLength(3);
   ```

2. **Override HOME** (heavier — only if you need exact totals):
   ```ts
   beforeEach(() => {
     process.env.HOME = fakeHome;            // Unix
     process.env.USERPROFILE = fakeHome;     // Windows
     process.env.COPILOT_CONFIG_DIR = join(fakeHome, '.copilot');
   });
   ```
   Caveat: constants module reads `homedir()` at import time in some paths; you may need a vitest `vi.resetModules()` to re-read.

**For the latent parser bug** (separate work item, not in scope for the test fix): `parseSkillFile` in `src/hooks/learner/parser.ts` should reject triggers that are empty strings or whitespace-only — either in `parseArrayValue` or by adding `metadata.triggers = metadata.triggers.filter(t => t.trim().length > 0)` before the validity check. Until that's fixed, every `messageLower.includes('')` check is a wildcard match.

## Example

Broken (flaky across developers):
```ts
const result = processMessageForSkills("alpha beta gamma", sessionId, testProjectRoot);
expect(result.injected).toBe(3);  // may be 3, 6, 9, ...
```

Robust:
```ts
const result = processMessageForSkills("alpha beta gamma", sessionId, testProjectRoot);
const projectInjected = result.skills.filter(s => s.scope === 'project');
expect(projectInjected).toHaveLength(3);  // always 3
// Budget/content assertions cover the aggregate behavior:
expect(pending.merged.length).toBeLessThanOrEqual(3000);
```

This is the same pattern used by `src/__tests__/hooks/learner/bridge.test.ts` "registers emitted learner context as compact descriptors within budget" after the c5671d2d port.
