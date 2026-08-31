# Fork Porting with Multi-Agent Teams

## The Insight

When delegating upstream port work to parallel agents, **shared infrastructure files are the blast radius multiplier**. An agent that "fixes" a core utility to satisfy its local tests will break dozens of tests in other domains. The safe pattern is: constrain each agent to its domain files, explicitly forbid touching shared infrastructure, and fix cross-cutting issues yourself after agents complete.

## Why This Matters

In our v4.10.2 merge prep, 4 parallel agents were given test-fix tasks. One agent changed `worktree-paths.ts` (`.omcp` to `.omc`), another changed `config-dir.ts`, another changed `hooks.json` and `persistent-mode/index.ts`. Each agent verified its own tests passed. But combined, test failures jumped from 78 to 189 - a 2.4x regression. The revert-and-retry cost 2+ hours.

## Recognition Pattern

You're about to delegate code changes to multiple parallel agents, and the codebase has:
- Shared path utilities (`worktree-paths`, `config-dir`)
- Shared configuration files (`hooks.json`, `settings.json`)
- Core hook/middleware infrastructure used by many features
- State management modules referenced across domains

## The Approach

1. **Identify the blast-radius files first.** Before spawning agents, list the files that are imported by 10+ other files. These are off-limits for agents.

2. **Explicit deny-list in every agent prompt.** Don't just say "focus on X" - say "NEVER modify `worktree-paths.ts`, `config-dir.ts`, `hooks.json`". Agents interpret scope loosely; they interpret constraints literally.

3. **Domain-scoped agents, not problem-scoped.** "Fix all wiki files" is safe. "Fix all test failures" is dangerous because it invites touching shared infrastructure to satisfy local tests.

4. **Revert-first recovery.** When agents introduce cascading regressions, don't try to fix the regressions. `git checkout -- .` everything, then selectively re-apply only the safe changes file by file.

5. **Cross-cutting fixes go last.** After all domain agents complete, handle shared infrastructure yourself with full test suite visibility.

## Example

Bad agent prompt:
> "Fix all failing tests. The test expects `.omc` but gets `.omcp` - fix the source."

Good agent prompt:
> "Fix wiki tests in `src/hooks/wiki/`. NEVER modify `src/lib/worktree-paths.ts` - that file's `.omcp` naming is intentional. If wiki storage needs `.omc`, use a local path in the wiki module instead."
