---
name: sticky-installer-contract-test
description: Installer fixes for opaque downstream CLIs need a test guard, otherwise refactors silently revert them
triggers:
  - statusLine regression
  - installer rewrite reverted
  - config.json experimental
  - Copilot CLI HUD silent
  - PR #10 regression
  - silently downstream
  - settings.json statusLine
---

# Sticky Installer Contract Test

## The Insight
When the installer writes a config file consumed by a CLI we don't control (Copilot CLI's `~/.copilot/config.json`, Claude Code's `~/.claude/settings.json`), the contract is invisible at the type level. A subsequent refactor — especially one that "cleans up" or "unifies" the install path — has no compiler signal warning that it's writing to the wrong file or dropping a required flag. The CLI silently ignores the new output and the user-visible feature breaks without a single test failure.

The fix isn't "be more careful in refactors." The fix is: **every contract bullet that the downstream CLI requires must be asserted by a test that runs in CI.** The test is the only thing that makes the contract sticky across rewrites by people (or agents) who don't remember the original PR.

## Why This Matters
PR #10 originally fixed Copilot CLI HUD: write to `config.json`, set `experimental: true`, emit a `.cmd` wrapper on Windows. That fix had no installer test asserting any of those three facts. Months later, an installer rewrite (AI-slop cleanup pass + Claude-Code-style unification) reverted all three back to writing `statusLine` into `settings.json`. The HUD silently stopped rendering for every Copilot CLI user. We only caught it because the user asked for a manual audit before cutting v4.13.2 — not because anything failed.

The lost-time cost is asymmetric: the test is ~30 minutes to write; the regression cycle is hours of audit + re-port + new PR + re-release.

## Recognition Pattern
- A bug fix touches an installer/config writer and the consumer is an external CLI (Copilot CLI, Claude Code, VS Code, etc.)
- The consumer reads from a path that's not obvious from the writer's perspective (different file than `settings.json`, requires a sibling flag)
- The fix lives in `src/installer/index.ts` (or similar) and the only "test" is "I ran it locally and it worked"
- A grep across `src/installer/__tests__/` for the file path or flag name returns zero hits

If all four are true, the next refactor will revert this. Add the test now.

## The Approach
For any installer write that satisfies an external CLI contract, ask: **what would I assert in a test to prove the contract is still satisfied?** Usually three things:

1. **Target file**: the write hits `~/.copilot/config.json`, not `~/.copilot/settings.json` (mock fs, assert the path)
2. **Required adjacent flags**: `experimental: true` is present (assert the JSON shape, not just `statusLine`)
3. **Platform-conditional wrapper**: on Windows, the command points at a `.cmd` file that exists and contains `@echo off` + node invocation

Then add a fourth assertion that's specific to *this* class of regression:

4. **Legacy cleanup**: if the OMC-owned statusLine was previously written to the wrong file, the installer removes it from there after migrating

The fourth one matters because partial-revert is the common shape of these regressions: the new code writes the right thing AND leaves the old wrong thing in place, and the CLI picks the wrong one.

For the test itself, prefer integration over unit — drive `runInstaller(...)` against a temp `COPILOT_CONFIG_DIR`, then read both files back and assert their JSON shapes. Mocking `writeFileSync` per-call is brittle; a real fs round-trip is what catches the "writing to the wrong file" class of regression.

## Example
The test that *should* have existed before the AI-slop refactor:

```ts
it('writes statusLine to config.json with experimental:true, not settings.json', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'omcp-installer-'));
  process.env.COPILOT_CONFIG_DIR = tmp;

  await runInstaller({ force: false });

  const config = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf-8'));
  expect(config.experimental).toBe(true);
  expect(config.statusLine).toMatchObject({
    type: 'command',
    command: expect.stringMatching(/copilot-hud\.cmd$|hud-script\.mjs$/),
  });

  const settings = existsSync(join(tmp, 'settings.json'))
    ? JSON.parse(readFileSync(join(tmp, 'settings.json'), 'utf-8'))
    : {};
  expect(settings.statusLine).toBeUndefined(); // no leakage to settings.json
});

it('on Windows, statusLine command points at a .cmd wrapper that invokes node', async () => {
  if (process.platform !== 'win32') return;
  // ... assert the .cmd file exists and contains @echo off + node + hud path
});
```

Without these, a future refactor with a clean `npm test` will still ship a broken HUD.
