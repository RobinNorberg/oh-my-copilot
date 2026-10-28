# Factory Run — Delta to FACTORY-FINAL-DESIGN

> **DRAFT for owner review. Nothing has been posted.** This is a proposal for upstream oh-my-claudecode. No issue, PR or comment exists for it upstream. The owner reviews and edits it before anything is filed.

**Status:** proposal; delta to `docs/design/FACTORY-FINAL-DESIGN.md`
**Scope:** two "to build" items of that design, the automated review stage (§3.4) and the chain-level check gate (§3.3), built as one deterministic engine, `omc factory run <issue>`
**Built and run in:** a downstream fork whose host is GitHub Copilot CLI. Everything here is translated to Claude Code. Parts that depend on the host are marked **[HOST]**.

## 0. Summary

The fork built both items as engine code rather than as chain stages. One command takes one tracker issue to a PR that is ready to merge:

```
intake → plan → implement → publish → review ─approve─→ prepare → gates ─green─→ merge (human) → merged
                                ▲          │                │         │
                                │   changes-requested    conflict   failed
                                └─ publish ◄─ fix ◄── conflict-fix   ci-fix ─→ publish → review
```

- **The engine owns every transition.** It is ordinary, tested code with a sealed state file. It never asks a model what to do next.
- **LLM work happens only in lanes.** A lane is one headless session in its own git worktree, with a cost cap and a timeout. The engine treats a lane's output as untrusted data.
- **Review-approve stays human.** The engine never merges. It parks at a named human gate with the diff, the filtered review findings and the exact merge command. This keeps the design's rule that the dark factory is structurally prevented for merges.

The engine is invoked by hand. The listener, cron and SessionEnd triggers do not start it.

## 1. What this changes in FACTORY-FINAL-DESIGN

| Section | Today | Proposed |
|---|---|---|
| §2 stone "Automated check" | chain-level check gate: to build | designed: the gates driver (§4 below) |
| §2 stone "Automated review" | not a chain stage: to build | designed: the review lane (§3 below), a filter before the human gate |
| §2 stone "Human review" | diff-first requirement: to build | partly served: the merge gate shows the diff and filtered findings, never an implementer summary. The signoff-validity rule of §3.4 stays to build. |
| §3.3 "check gate to build" | the link's checks must run green before SessionEnd reports success | replaced for engine runs: the engine reads the PR's CI checks for the exact pushed head and advances only on green |
| §3.4 "Automated review stage to build" | fresh-context reviewer before review-approve | designed as below |
| §5 defects 2 and 3 | open | 2 closed by the review lane; 3's check-gate half closed by the gates driver. The win32 flaky-spawn half stays open. |
| §7 non-goals | no dark-factory merges, no auto-resume, no inferred approvals | unchanged. Resume is an explicit rerun by a human, not an automatic one. |

Nothing in the chain layer changes. Chains, routes, `gradeGate` and the AFK profile keep working as they do. The engine is a second, narrower path: one issue, one PR, fixed phases.

## 2. Lanes

A lane is the only place a model runs. The engine depends on a host-neutral interface:

```ts
interface LaneRunner {
  start(spec: {
    prompt: string;
    startRef: string;          // 40-hex commit the worktree starts at
    profile: 'write' | 'review';
    maxCost: number;           // mandatory cap
    timeoutMs: number;
  }): Promise<{ jobId: string; worktree: string }>;
  poll(jobId: string): Promise<LaneStatus>;   // running | completed | failed, usage, final message, child pid
  cancel(jobId: string): Promise<void>;
}
```

Lane rules:

- **Fresh session per lane.** A fix lane never resumes the implement session, and a review lane never sees the implementer's summary.
- **Own worktree at a validated commit.** A start ref that starts with `-`, holds whitespace or does not resolve to a commit is refused before anything is created.
- **No push or PR rights.** A write lane may commit in its worktree and run tests. A review lane may not write files or change git state at all.
- **Mandatory cap.** The engine refuses to start without a resolved per-lane cap.

**[HOST]** The fork's lane is GitHub Copilot CLI driven through its SDK, with the CLI's AI-credit cap. A Claude Code lane is the proposed upstream implementation:

| Lane need | Fork (Copilot CLI) | Proposed Claude Code equivalent |
|---|---|---|
| Headless session | SDK session in-process | `claude -p` in the lane worktree, with `--session-id <uuid>` so the engine can find its transcript |
| Cost cap | AI-credit cap, soft, checked per model call | a turn cap (`--max-turns`) plus a spend cap if the CLI offers one; to confirm against current Claude Code flags |
| Measured usage | the session's shutdown event | the `-p` JSON result's usage and cost fields |
| No push, write confinement | a shell denylist and a worktree-only write policy | `--permission-mode` with `--disallowedTools` for `git push`, `gh` and writes outside the worktree, plus a PreToolUse hook as a second check |
| Review profile | a profile that denies the write tool and tree-changing git | `--allowedTools` limited to read tools and read-only git |

The engine code does not change between hosts. Only the `LaneRunner` does.

## 3. Automated review stage (§3.4)

The review lane is the "fresh-context reviewer" of §3.4. It is a filter, never the gate.

- **Input.** The issue, the plan and the diff from the base to the exact head. Never the implementer's summary.
- **Identity.** Write lanes share the implementer name `factory-impl-<n>`. Each review lane is `factory-review-<n>-<jobId>`. The verdict store refuses a verdict from the implementer, and the engine asserts the review job is no write lane's job.
- **Output contract.** The final message ends with exactly one fenced `json` block:

  ```json
  { "verdict": "approve", "sha": "<40 hex>",
    "findings": [{ "severity": "major", "file": "src/x.ts", "line": 12, "summary": "…" }],
    "notes": "at most 500 characters" }
  ```

  `verdict` is `approve` or `request-changes`. `severity` is `blocker`, `major`, `minor` or `nit`.
- **Fail closed.** The lane reads PR content, which an attacker controls, so anything off-contract is `invalid` and records no verdict. That covers no block, two blocks (a quoted copy could be the PR's), text after the block, a wrong sha, an edited worktree, and a PR head that moved. An `approve` with a `blocker` or `major` finding counts as `request-changes`. An invalid review gets one fresh retry, then a human gate.
- **Effect.** `request-changes` feeds the findings to a fresh fix lane, up to a fix-round limit (default 2). `approve` lets the run go on to prepare and the gates. Either way the engine posts the findings as one PR comment, so the human at the merge gate sees filtered findings next to the diff.

The scoped reviewer prompt per change type (security, contract, performance) that §3.4 describes is not built yet. The fork uses one diff-first review prompt.

## 4. Chain-level check gate (§3.3)

The gates driver is the check gate. It reads the PR's CI checks, not a link's local test run, because CI is the check a human trusts at merge.

- **Exact head.** Every read is for the head the engine pushed. A read counts only when GitHub reports that head and every check belongs to a workflow run for that head. A head the engine did not push stops at `head-moved-externally`.
- **Flaky is broken.** A known-flaky failure gets a bounded number of reruns, recorded in state so a crash cannot double-rerun. Past that the run stops at a human gate.
- **Failure routing.** A real failure gets one ci-fix lane with the failing check names and test titles, then a new review. A second failure is a human gate.
- **Trusted config.** Required checks, advisory checks and the known-flaky list load only from the user config or the base branch at GitHub's base sha. A lane can drop a config file into its checkout, so the working tree and the PR head never count.
- **Bounds.** A watch window that times out is a heartbeat. The whole gates phase has an overall bound (default 90 minutes). No workflow run for the head after 5 minutes is a human gate.

Before the gates the engine runs a **prepare** step: it merges the base in an engine-owned checkout and runs the repository's own checks. Housekeeping commits from prepare are recorded as such and need no new review. A conflict outside generated files gets up to 2 conflict-fix lanes, and each one goes back through review, because a lane's merge is not housekeeping.

**Prerequisite.** The fork built prepare, the gates reader and the merge rule as a separate library (the fork calls it `ship`) before the engine. Upstream has no equivalent today. The proposal therefore comes in two parts: that library first, then the engine on top. Its merge rule refuses a merge without an independent approval on the head (modulo housekeeping commits), with protected paths changed, or with a broken state seal.

## 5. The human merge gate

After green gates the engine asks the merge rule about the current head. Then it comments the decision and the exact merge command on the PR, and parks at `awaiting-human: merge`. The human reads the diff, merges, and reruns `omc factory run <n>`. The engine reads the PR state and finishes as `merged`.

There is no auto mode and no config key for one. The engine's command guard refuses `gh pr merge` outright. The fork's earlier design had an opt-in auto-merge. The fork's maintainer dropped it, so fork and upstream agree.

## 6. State, resume and human gates

- **State.** `.omc/state/factory/run-<issue>.json`, written under a file lock, atomically, with a sha256 seal. An owner file keeps a second engine off the same issue; a dead pid on the same host is taken over.
- **Resume.** Every stop is either terminal (`merged`, `cancelled`, `failed`) or a named `awaiting-human` gate on the current phase. A human rerun clears the gate and re-evaluates the phase. Each step re-reads the remote before acting, so a crash between a push and its record repeats nothing.
- **Lost lanes.** A lane recorded as running at resume is lost. The engine kills its recorded child if it still runs, keeps its worktree, and respawns one fresh lane. Two losses in a row are a human gate.
- **Gate comments.** Every gate posts one issue comment that names the gate, the reason and the command to resume, once per gate and head.

The gates the fork has today:

| Group | Gates |
|---|---|
| Plan and intake | `needs-plan`, `pr-exists` |
| Lanes | `implement-failed`, `fix-failed`, `ci-fix-failed`, `conflict-fix-failed`, `review-invalid`, `review-identity`, `lane-lost`, `lane-unconfirmed` |
| Review | `fix-rounds-spent` |
| Tamper | `lane-tampered`, `review-tampered`, `state-tampered`, `protected-paths` |
| PR | `head-moved-externally`, `pr-not-open`, `base-changed` |
| Prepare and gates | `merge-conflicts`, `ci-failed`, `ci-flaky`, `no-workflows`, `gates-timeout`, `gates-disagree` |
| Limits | `budget`, `wall-time` |
| Merge | `merge`, `merge-refused` |

## 7. Security model

The design assumes any lane may be prompt-injected by issue or PR content and will try anything its tools allow.

- **Only the engine acts on GitHub.** Its command guard allows a fixed list of `gh` and `git` forms: issue and PR reads, PR create, ready and comment, and a plain push of a 40-hex sha to `factory/issue-<n>`. It never allows a `+` refspec, a protected branch, `gh api` or `gh pr merge`.
- **Protected paths.** Before every push the engine checks the change against the merge rule's protected paths.
- **Tamper checks.** The engine snapshots the shared git state before and after every lane and around prepare, whose checks run the PR's own code. The snapshot covers refs, config, `hooks/`, `info/`, `worktrees/`, `modules/`, alternates, the global git config and its includes, both HEADs, the main checkout's status and a few ignored files such as `.env*`. A lane may add only its own branch and worktree. Anything else stops the run, drops the verdict and pushes nothing. The check repeats at every step boundary and before every push.
- **Engine-owned state.** The seal on the state file is an unkeyed hash, so it only catches accidents. The engine also keeps its own record of every byte it wrote, outside the repository. Any other change to the run state, owner or lock files, or the verdict store stops the run.
- **Hardened engine git.** The engine's own git runs with an empty `core.hooksPath` and `core.fsmonitor=false`, so a hook a lane plants never runs in the engine.
- **Residual risk.** Lanes are not sandboxed. A lane's shell runs as the user and can reach the home directory, including the engine's record. The checks narrow that, and a human merge always comes last. **[HOST]** The fork plans to run lanes in the host's sandbox. For Claude Code the equivalent would be its sandboxed bash mode, to confirm.

## 8. Cost model

- **Every lane has a mandatory cap.** **[HOST]** The fork's unit is the host's AI Credits, with a floor of 30 per lane that the CLI imposes. A Claude Code lane would cap turns and spend instead.
- **An optional per-run cap** lowers each lane's cap to what is left, and parks at `budget` when less than one lane's minimum is left.
- **Wall time** per lane (default 30 minutes) and per run (default 4 hours), and one retry per phase.
- **Lane count.** An approved first review costs 2 lanes. Each fix, conflict-fix or ci-fix round adds 2, because each one is followed by a new review. With the defaults the worst case is 12 lanes before retries.
- **Measured.** A smoke run of one implement and one review lane on a small model is estimated at about 2 AI credits on the fork's host.

Limits come from the user config. The working-tree project config can only lower them, because a lane can write that file.

## 9. Verification in the fork

- **Unit and integration tests** run the engine with a fake `LaneRunner`, a scripted `gh`, real git and a local bare remote. They cover the happy path to `merged`, fix rounds, conflict-fix, ci-fix, gates timeout and resume, crash injection after each engine write, and cancel during a lane wait.
- **Two opt-in live smoke scenarios** run real lanes against a sandbox repository with a bare `origin` and a scripted `gh`, so nothing touches GitHub. `factory-run` runs implement and review up to the merge gate. `factory-run-fix` adds one changes-requested round. Both assert that no lane pushed and nothing merged.

## 10. Proposed upstream sequencing

1. **Merge-rule library.** Prepare, the gates reader with trusted config, and the merge rule with independent-approval-on-head.
2. **Lane primitive.** The `LaneRunner` interface and a Claude Code implementation, with a review profile.
3. **Engine core.** State, intake, plan, implement, publish, review and fix, parking before prepare.
4. **Prepare, gates driver and the human merge gate.**
5. **Live smoke scenarios and docs.**

## 11. Open questions for the owner

1. Should engine runs stay separate from chains, or should a chain route be able to start one?
2. Is the PR's CI the right check gate for §3.3, or should a local check run as well, before publish?
3. Which Claude Code flags give the lane a hard spend cap and a read-only review profile?
4. Should the merge-rule library land upstream as its own command, as in the fork, or stay internal to the engine?
