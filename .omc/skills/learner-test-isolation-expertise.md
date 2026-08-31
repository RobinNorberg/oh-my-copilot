# Skill Loader Tests — User-Level Skill Leakage

## The Insight

`findSkillFiles()` with default `scope: 'all'` scans both project-level (`.omcp/skills/`) AND user-level (`~/.copilot/skills/omc-learned/`, `~/.omcp/skills/`) directories. Tests that create project skills in a temp directory but call `loadAllSkills()` or `findMatchingSkills()` without scope restriction will pick up **real user-level skills** from the developer's home directory, causing non-deterministic failures.

## Why This Matters

The symptom is subtle: tests pass on machines with no user-level skills (fresh CI runners) but fail locally when the developer has learned skills. The test `findMatchingSkills('How do I use Rust?')` expected 0 matches but got 3 — because user-level skills with broad triggers like "react", "component", "test" matched.

## Recognition Pattern

- `loader.test.ts` or `finder.test.ts` failures with unexpected match counts
- Tests pass in CI but fail locally (or vice versa — depends on which machine has user skills)
- `loadAllSkills()` returns more skills than the test created
- `findMatchingSkills()` returns matches from skills the test never created

## The Approach

Mock `findSkillFiles` to restrict scope to project-only in test files:

```typescript
vi.mock('../../hooks/learner/finder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/learner/finder.js')>();
  return {
    ...actual,
    findSkillFiles: (projectRoot: string | null, options?: { scope?: string }) =>
      actual.findSkillFiles(projectRoot, { ...options, scope: 'project' }),
  };
});
```

This preserves the real `findSkillFiles` logic (symlink checks, deduplication) while preventing user-level skill contamination. The mock delegates to the real implementation with a scope override — no brittle reimplementation needed.

## Files

- `src/hooks/learner/finder.ts` — `findSkillFiles()` with `scope` option
- `src/hooks/learner/constants.ts` — `USER_SKILLS_DIR`, `GLOBAL_SKILLS_DIR` paths
- `src/__tests__/mnemosyne/loader.test.ts` — where the fix was applied
