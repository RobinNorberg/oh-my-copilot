# Field testing oh-my-copilot

This guide is for a GitHub Copilot CLI agent that tests oh-my-copilot on a
second Windows computer and reports back to
[RobinNorberg/oh-my-copilot](https://github.com/RobinNorberg/oh-my-copilot).
It stands on its own: read it end to end before the first command, then keep
it open as a checklist.

## Purpose

Fixtures and unit tests show how `omg factory` behaves against recorded
answers. Field testing shows how it behaves against the real thing: a real
Azure DevOps org, a real `az` on Windows, real `psmux` panes, a real Copilot
CLI. The goal is to harden two areas:

- `omg factory` on Azure DevOps (setup, intake, runs, heal) and on GitHub;
- native Windows behaviour (paths, `az` spawning, team workers, sandboxed lanes).

Your output is GitHub issues, one per finding, and sometimes a small fix as a
draft PR. The maintainer side triages the issues, fixes the subtle ones,
reviews every PR and releases. Robin is the only person who merges.

## Ground rules

Each rule is a check you can run on yourself. Break none of them; when one is
in the way, stop and ask Robin.

1. **Test the published package, and record its version.** Run `omg --version`
   before each session and put the number in every issue. *Why:* a finding is
   only useful when the maintainer can install the same build; a local build
   may hold fixes or bugs that no user has.
2. **Never merge, and never force-push.** No `gh pr merge`, no
   `git push --force` or `--force-with-lease`, no rebase of a pushed branch.
   When your branch falls behind `dev`, run `git merge origin/dev` and push
   again. *Why:* Robin is the only merger, and a force-push can destroy
   commits the maintainer side added to your branch.
3. **Push only `field/*` branches.** Every `git push` names a branch that
   starts with `field/`. *Why:* `dev`, `main` and `release/*` are the
   maintainer's; a `field/` prefix also tells everyone where a branch came
   from.
4. **Do not edit protected files.** Never change repository rulesets or
   settings, `.github/known-flaky-tests.json`, `.github/workflows/*`, release
   files (`CHANGELOG.md` released sections, `.github/release-body.md`,
   `.github/release-notes.md`, `.github/upstream-port.json`, the version in
   `package.json`). The one exception is your entry under
   `## [Unreleased]` in `CHANGELOG.md`. *Why:* these files gate CI and
   releases; a change to them needs the maintainer's judgement, not a field
   fix.
5. **Never post secrets or identities.** No PATs, tokens, auth headers, org,
   project, repository or user names, emails, machine or agent names, or user
   profile paths in an issue, comment, commit, PR or branch name. Scrub first
   (see [Scrubbing](#scrubbing)). *Why:* the repository is public, and GitHub
   keeps edited-away text in the edit history.
6. **The acceptance script creates real Azure DevOps projects; clean up only
   your own.** Run `--phase cleanup` only with the `--run <runId>` of a run
   you made, and never delete any other project, repository, pipeline, work
   item or agent in the org, by script or by hand. *Why:* the org may hold
   other work; the cleanup guard deletes only the project in that run's
   manifest, and nothing else is ever safe to delete.
7. **Ask Robin before spending Copilot credits.** These commands spend AI
   credits: `scripts/ado-acceptance.mjs --with-lanes`, `omg factory run`
   without `--dry-run`, `omg factory heal run` and `heal approve`,
   `omg team` with real workers, and every live smoke (`omg smoke copilot
   --tier 1`, `--tier 2` with scenarios, `--record`). Free: `--dry-run`
   forms, `omg factory setup|check|board|enqueue --dry-run|poll --once`,
   `omg factory heal scan`, `omg smoke copilot` (tier 0), `omg smoke copilot
   --sdk-static`, `omg smoke copilot --replay`, `omg smoke cassette verify`.
   Before a paid command, say which command, why, and the estimate (the
   [REFERENCE.md](./REFERENCE.md#omg-smoke-copilot) figures), and wait for a
   yes. *Why:* the account's quota is small and shared with releases.
8. **One finding per issue, and search first.** *Why:* one issue maps to one
   fix and one close; duplicates split the discussion.

## Setup

### 1. GitHub CLI with minimal rights

Use a fine-grained personal access token scoped to
`RobinNorberg/oh-my-copilot` only, with:

| Permission | Access | For |
|---|---|---|
| Contents | Read and write | pushing `field/*` branches |
| Issues | Read and write | filing findings, labels, comments |
| Pull requests | Read and write | draft PRs |
| Metadata | Read | required by GitHub |

Give it nothing else: no Administration, no Workflows, no Actions write, no
Secrets. Without the Workflows permission GitHub itself refuses a push that
touches `.github/workflows/`. Contents write still allows pushing any branch,
so rule 3 is yours to keep.

```powershell
gh auth login --hostname github.com   # paste the token when asked
gh auth status
```

### 2. Git identity

Use your GitHub noreply address, never a personal email (rule 5):

```powershell
git config --global user.name "<your GitHub login>"
git config --global user.email "<id>+<login>@users.noreply.github.com"
```

### 3. The published package

```powershell
npm i -g oh-my-copilot@latest
omg --version
omg setup
omg doctor
```

Write the version down; it goes in every issue.

### 4. A clone at the same version

The acceptance and fixture scripts live in the repository, not the package,
and need a build. Check out the tag that matches `omg --version`:

```powershell
gh repo clone RobinNorberg/oh-my-copilot C:\field\oh-my-copilot
cd C:\field\oh-my-copilot
git checkout v<version>     # for example v5.19.2
npm ci
npm run build
```

Use this checkout for testing. Fixes start from `origin/dev` instead (see
[Contributing a fix](#contributing-a-fix)).

### 5. Azure DevOps access

- Azure CLI with the extension: `az extension add --name azure-devops`.
- Sign in with `az login`, or set `AZURE_DEVOPS_EXT_PAT` in the session only
  (never in a file in the repository).
- A test repository to push into the throwaway project: a local clone with a
  `BACKLOG.md` of `## EXC-NNN` tickets. Ask Robin which one.
- An agent for the project's pipeline: the self-hosted pool `Default` (free,
  register an agent on this machine) or `--hosted` (needs the org linked to an
  Azure subscription; ask Robin before using it, it can bill).

## What to test

Do these in order. Each step names the command and what to look for. Run
everything in PowerShell unless a step says otherwise, and keep the full
output of anything that surprises you.

### Step 1: the ADO acceptance flow

The script is `scripts/ado-acceptance.mjs`; its reference is
[Live acceptance on Azure DevOps](./REFERENCE.md#live-acceptance-on-azure-devops-maintainers).
Every phase takes `--org https://dev.azure.com/<org>`; the first phases also
take `--source <test repo clone>`.

1. **Dry run first, always.**
   `node scripts/ado-acceptance.mjs --org <org url> --source <clone> --phase preflight --dry-run`
   prints the exact argv of every command and every file it would write, and
   runs nothing. Observe: every `az` call ends in `--output json`; no argv
   holds a token; paths are Windows paths.
2. **Preflight.** The same without `--dry-run`. It is read-only and free.
   Observe: one `ok` line per check (az, the `azure-devops` extension, the
   login, the org, a clean `--source`, `BACKLOG.md`, the build), the pool
   advice, and `Copilot: no lane runs without --with-lanes (0 credits)`.
3. **Create.** `--phase create`. Makes one private Agile project named
   `omg-acc-<yyyymmddHHMM>` and writes its manifest to
   `~/.omg/acceptance/<runId>.json`. Note the run id. Observe: the push of
   `main` succeeds before the build policy appears; `omg factory setup` runs
   and pushes `.copilot/omg.jsonc`.
4. **Enqueue.** `--phase enqueue --run <runId>`. It shows the user-config
   change (adding the spec creator to `trustedAuthors`) and the enqueue dry
   run, and asks twice. Read both before answering. Observe: every ticket
   becomes a User Story child of the spec; a second dry run reports every
   ticket `unchanged`.
5. **Exercise.** `--phase exercise --run <runId>` (no `--with-lanes`). It runs
   `omg factory check`, `check --parent`, `board` and `run --next --parent
   <spec> --dry-run`. Observe: each `PASS`/`FAIL` line; a ticket with a
   predecessor is `blocked` with `depends-on:#<id>`.
6. **Heal drill**, only with a working agent: `--phase heal-drill --run
   <runId>`. Pushes a failing test, waits up to 20 minutes for the red build,
   runs `omg factory heal scan` and `heal run <sig8> --dry-run`, then reverts.
   Observe: the build policy is enabled again afterwards.
7. **Capture.** `--phase capture --run <runId>`. Writes fixtures to
   `~/.omg/acceptance/<runId>/capture/` and prints a drift report against the
   recording. A drift line is a finding.
8. **Cleanup.** `--phase cleanup --org <org url> --run <runId>`. Deletes only
   this run's project (restorable for 28 days) and its clone. It prints the
   `trustedAuthors` the run added; remove those from the user config by hand
   if they should not stay.

`--with-lanes` on `exercise` or `heal-drill` runs real lanes and spends
credits (rule 7).

### Step 2: the factory by hand, on GitHub and on Azure DevOps

Run these inside a test repository whose `origin` is the forge under test (the
acceptance clone under `~/.omg/acceptance/<runId>/repo/` for Azure DevOps; a
scratch GitHub repository of your own for GitHub). The reference is
[`omg factory`](./REFERENCE.md#omg-factory).

| Command | Observe |
|---|---|
| `omg factory setup --intake <source> --dry-run --json` (`<source>` as in the reference, for example `label:factory` or `wiql-query:<guid>`) | the detected forge, the auth check (no token printed), the diff it would write, the preview |
| `omg factory check --json` | every item in exactly one bucket (`runnable`, `needs-plan`, `blocked`) with its reason codes |
| `omg factory board --json` | the same items with their runs and stages; no write to the tracker |
| `omg factory poll --once --json` | one tick, no lane started, no tracker write |
| `omg factory run --next --parent <spec> --dry-run` | the pick matches the first runnable item of `check --parent` |
| `omg factory heal scan --dry-run --json` | red CI runs classified; no state written |

`omg factory run --next --parent <spec>` without `--dry-run` runs lanes:
credits, ask first. It must stop at `awaiting-human: merge` and never merge.

### Step 3: Windows team workers

The reference is [`omg team`](./REFERENCE.md#omg-team-cli-runtime-surface) and
its [Windows (psmux)](./REFERENCE.md#windows-psmux) section.

1. Free checks: `omg doctor`, `omg smoke copilot` (tier 0) and
   `omg smoke copilot --sdk-static`. Observe: all checks pass; `sdk.sandbox`
   reports host support.
2. With Robin's yes (credits): `omg team 2:copilot "<a tiny task>"`, then
   `omg team status --json` and `omg team shutdown <team>`. Observe:
   `transport`, worker states, AI credits per worker, a clean shutdown, no
   leftover psmux namespace.

### Step 4: Copilot record and replay (when asked)

The reference is [`omg smoke copilot`](./REFERENCE.md#omg-smoke-copilot).

- Free: `omg smoke copilot --tier 2 --scenario factory-run --replay
  src/smoke/__tests__/fixtures/cassettes` in the clone replays recorded
  model traffic. A miss or a failed check is a finding.
- Paid, only on Robin's request: `omg smoke copilot --tier 2 --scenario
  <list> --model <id> --record ~/omg-cassettes` records new cassettes. See
  [Captured data](#captured-data) for how they come in.

## Filing a finding

**When to file.** A command that fails, hangs, prints a secret, writes where
it should not, disagrees with REFERENCE.md, or behaves differently on Windows
than the docs say. One finding per issue. A question about intent is a
finding too; say so in the title.

**Search first.**

```powershell
gh issue list --repo RobinNorberg/oh-my-copilot --label field --state all --search "<two or three keywords>"
```

When a match exists, add your data as a comment on it instead.

**The form.** On the web, use **New issue → Field report**. From the CLI,
`gh issue create` does not render forms, so write a body with the same
headings and pass the labels yourself:

```powershell
gh issue create --repo RobinNorberg/oh-my-copilot --title "factory-ado: <short symptom>" --label field --label field:ado --body-file finding.md
```

Required in the body, under these headings: **Area**, **oh-my-copilot
version**, **OS**, **Copilot CLI version**, **Forge**, **Command run**,
**Expected**, **Actual**, **Logs**, and the two confirmations (scrubbed;
duplicates searched). Add `field:ado` for Azure DevOps findings and
`field:windows` for Windows-only ones. Keep `finding.md` outside the clone.

### Scrubbing

Before anything leaves this machine:

- **ADO captures and recordings:** never paste them. They come in by PR after
  `node scripts/ado-fixture-import.mjs <dir> --dry-run` (see
  [Captured data](#captured-data)). In an issue, quote only the one or two
  lines that matter, scrubbed by hand.
- **By hand, in logs and text**, replace with the same names the import uses,
  so issues and fixtures agree:

| Real value | Write |
|---|---|
| org / project / repository | `contoso` / `Web` / `web-app` |
| a user's email or `uniqueName` | `user1@example.com` (`user2@…` for the next) |
| a display name | `User 1` |
| a PAT, token, `Authorization` header | `[REDACTED]` |
| a machine or agent name | `agent1` |
| `C:\Users\<name>` | `C:\Users\user` |
| a GUID that identifies your org or project | `00000000-0000-0000-0000-000000000001` |

Then search the text for `@`, `dev.azure.com/`, `Bearer`, `Basic `, your
login and your machine name; each hit must be one of the scrubbed forms.

## Contributing a fix

**Fix it yourself only when all of these hold:** the cause is in one place,
the fix is a few lines, a focused test proves it (red before, green after),
and it touches no protected file (rule 4). Typical: a wrong path join on
Windows, a missing `--output json`, a doc that names a flag wrongly.

**File only** when the cause is unclear, the fix spans modules, it touches a
security guard (`runGuardedAdo`, `plainText`, the neutralization helpers,
the sandbox, the cleanup guard), it changes GitHub forge behaviour, or the
test needs live services. Say what you suspect in the issue.

**Steps** (the project rules are in [CONTRIBUTING.md](../CONTRIBUTING.md) and
[AGENTS.md](../AGENTS.md); where this fork differs from CONTRIBUTING.md, the
list below wins and the difference is called out):

1. Comment on the issue that you are taking it and add
   `field:fix-in-progress`.
2. Branch from `dev`, in a checkout separate from your testing tag:
   `git fetch origin` then `git switch -c field/<issue#>-<slug> origin/dev`
   (for example `field/412-az-path-join`).
3. Reproduce on `dev` first. When `dev` already behaves, say so on the issue
   and stop.
4. Write the failing test, then the fix. Keep the diff small; match the
   surrounding code.
5. Build and check:

   ```powershell
   npm run build
   npx vitest run <the test files you touched>
   npx tsc --noEmit
   ```

6. Add one entry under `## [Unreleased]` in `CHANGELOG.md` (Fixed, Changed or
   Docs), ending with the issue number.
7. Stage, then regenerate the inventory (it counts tracked files only, so it
   comes after `git add`):

   ```powershell
   git add -A
   git add -f dist bridge
   node scripts/generate-inventory-graph.mjs --write
   node scripts/generate-inventory-graph.mjs --verify
   git add -A
   git status
   ```

   On this fork `dist/` and `bridge/` are committed, so `git add -f dist
   bridge` is required; CONTRIBUTING.md §6 describes the upstream policy.
   Never `git add -A -f`: it would add ignored files such as `node_modules/`
   and `.omg/`. `git status` must show neither.
8. Commit with a conventional message (`fix(factory): …`), then push:
   `git push -u origin field/<issue#>-<slug>`.
9. Open a draft PR to `dev`:

   ```powershell
   gh pr create --repo RobinNorberg/oh-my-copilot --base dev --draft --title "fix(<area>): <summary>" --body-file pr.md
   ```

   The body holds: what and why in two or three lines; `Fixes #<n>`; the red
   evidence (the test failing before the fix, output trimmed); the green
   evidence (the same test passing, plus `npx tsc --noEmit` clean); what you
   could not verify. `Fixes #<n>` closes the issue when the change reaches
   `main` in a release, not when the PR merges to `dev`.
10. Answer review comments with new commits on the same branch. Never
    force-push (rule 2).

## Captured data

ADO fixture captures and Copilot replay cassettes come in by PR only, never as
issue attachments or pasted text.

- **ADO captures** (`~/.omg/acceptance/<runId>/capture/`, or a recording
  under `recorded/`): in a `field/` branch from `dev`, run
  `node scripts/ado-fixture-import.mjs <dir> --dry-run`, then without
  `--dry-run`. The import scrubs every string again and refuses the whole
  import when anything identifying is left; a refusal is itself a finding.
  The files land under `src/forge/ado/__tests__/fixtures/live/<name>/`. Read
  the diff before committing.
- **Replay cassettes** (from `--record <dir>`): run
  `omg smoke cassette verify <dir>` (the redaction gate, then a free replay),
  then from the clone root `omg smoke cassette import <dir>`, which copies them
  into `src/smoke/__tests__/fixtures/cassettes/`. A cassette marked
  `REDACTION-FAILED` never goes in. Read the diff before committing.

Then follow [Contributing a fix](#contributing-a-fix) from step 5, with a PR
body that names the run, the moment or scenario, and the Copilot CLI version.

## Labels and what happens next

| Label | Set by | Meaning | Next |
|---|---|---|---|
| `field` | the issue form, or you | a field-test finding | the maintainer side triages it |
| `field:ado` | you | it involves Azure DevOps | triaged with the ADO adapter work |
| `field:windows` | you | it is specific to native Windows | checked on a second Windows machine |
| `field:needs-repro` | the maintainer | not reproduced from the report | add the missing data as a comment; the label is removed when it reproduces |
| `field:fix-in-progress` | whoever starts the fix | a branch or PR is open for it | nobody else starts a second fix |

An idle issue gets the `stale` label after 30 days and closes 14 days later;
a comment resets the clock.

## What the maintainer side does

The maintainer side is a Claude Code session on Robin's main computer.

- It reads new `field` issues, labels and reproduces them, and answers on the
  issue. Expect questions there, not elsewhere.
- It implements the subtle fixes itself, with separate review lanes, and links
  them to your issue.
- It reviews your draft PRs. It may push commits to your `field/` branch; pull
  before you continue (`git pull`, a merge, never a rebase).
- Robin merges to `dev`, and releases from `dev` to `main`. A released fix
  closes its issue; then test it again on the new published version.
