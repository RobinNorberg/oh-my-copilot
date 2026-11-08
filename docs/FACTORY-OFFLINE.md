# Offline Factory (the `local` forge)

`omg factory` normally needs a GitHub or Azure DevOps origin: issues are the intake, PRs carry the work, CI runs the gates. The `local` forge runs the same engine with no server at all. Items are markdown files in the repository, PRs are local branches pushed to a bare mirror the engine owns, the gate is a command you configure, and the merge is a `git merge` you run yourself.

Use it to try the factory on a scratch repository, to demo it, or to work on a machine with no forge. It is not for sharing work between machines.

## Quick start

The steps below work on Windows in a repository with only a `main` branch and no remote. The commands are the same in PowerShell and bash.

```bash
omg factory setup --forge local --dry-run   # show the config diff and the sample item; writes nothing
omg factory setup --forge local --yes       # write them
```

Setup writes `factory.forge.kind: "local"`, `factory.forge.local.backlogDir: ".copilot/backlog"` and the intake source `local-backlog` to `.copilot/omg.jsonc`. When `.copilot/backlog/` holds no item yet, it adds a sample `.copilot/backlog/1-example.md` with `state: closed`, so no run picks it up before you edit it. Setup never writes the gate (see [Trust rules](#trust-rules)), creates no labels and checks no login.

**The base branch.** Setup also writes `ship.base`, the branch you merge into, when neither `.copilot/omg.jsonc` nor your user config names one: `dev` if that branch exists, else your current branch. In a repository with only `main`, that is `main`. Setup prints the base it chose and why. It keeps a `ship.base` that is already set, and stops with exit 2 when that value is not a plain branch name. With a detached HEAD and no `dev` branch it writes none and prints a note naming `ship.base`. The committed `.copilot/omg.jsonc` counts only on a base in `ship.trustedBases` (user config only; default `dev`, `main`, `master`); setup prints a note when the base is not in that list.

Then:

1. Add the gate to the `factory.forge` section of `.copilot/omg.jsonc`, or to your user config (there it is nested under `"factory": { "forge": { ... } }`):

   ```jsonc
   "local": { "backlogDir": ".copilot/backlog", "gate": ["npm", "test"] }
   ```

2. Write a spec item, for example `.copilot/backlog/2-cli-flags.md` (see [Backlog items](#backlog-items) and [Specs](#specs)). Commit `.copilot/` on the base branch: a run reads the gate, the config and the items only as committed there.
3. Write the tickets file (the format is under [`omg factory enqueue`](REFERENCE.md#omg-factory-enqueue)) outside the repository, and enqueue it. Enqueue writes each ticket as a backlog file with a `Part of #2` line. Commit them on the base branch:

   ```bash
   omg factory enqueue --spec 2 --file ../tickets.json --dry-run
   omg factory enqueue --spec 2 --file ../tickets.json
   git add .copilot/backlog
   git commit -m "factory: tickets for #2"
   ```

   You can also write items by hand and skip enqueue. Commit them the same way. Enqueue numbers each new file one past the highest existing id: with the sample as #1 and the spec as #2, the first ticket is #3, which the steps below use as the example id.
4. `omg factory check` lists each ticket without an open dependency as `runnable` and prints `prepare checks: ...`. `omg factory board` shows the same items.
5. `omg factory run <id>` (here `omg factory run 3`, or `omg factory run --next`) drives the ticket to `awaiting-human: merge` and prints the merge command.
6. Run the printed command on the base branch. It has `--no-edit`, so git opens no editor and the message is `Merge commit '<sha>'`. Replace `--no-edit` with `-m "<message>"` for your own message.

   ```bash
   git -C <root> merge --no-ff --no-edit <sha>
   ```

7. `omg factory poll --once` syncs the merge to the mirror. `omg factory run 3` then finishes as `merged`, and `omg factory run clean 3` removes the run's worktrees and local lane branches.
8. Set `state: closed` in the ticket's backlog file and commit it (see [Merged items](#merged-items)).

## Configuration

```jsonc
"factory": {
  "forge": {
    "kind": "local",
    "local": {
      "backlogDir": ".copilot/backlog",   // repo-relative, no "..", no absolute path
      "gate": ["node", "--test"],         // argv; trusted layers only
      "gateTimeoutMinutes": 20            // 1..120
    }
  },
  "intake": { "source": { "type": "local-backlog", "label": "factory" } }   // label optional
}
```

| Key | Default | Meaning |
|---|---|---|
| `factory.forge.kind` | from the origin | `"local"` selects the offline forge (see the trust rules) |
| `factory.forge.local.backlogDir` | `.copilot/backlog` | Where the item files live. Project, then user, then base-committed config |
| `factory.forge.local.gate` | unset | The gate command as an argv. Read from the user config or the base-committed `.copilot/omg.jsonc` only |
| `factory.forge.local.gateTimeoutMinutes` | `20` | Wall time of one gate run, 1 to 120 |
| `factory.intake.source` | | `{ "type": "local-backlog" }` takes every open item; with `"label"`, only open items carrying that label (compared without regard to case) |

`--source local-backlog` or `--source local-backlog:<label>` works on `omg factory check` and `omg factory board`, and `--intake local-backlog[:<label>]` on `omg factory setup` (the default with `--forge local`).

**The gate names a script.** Name a `package.json` script (`npm test`, `npm run <script>`, pnpm/yarn equivalents) or a node script file in the repository so the run can compare its definition (see [The gate](#how-a-run-works-offline)). Another executable is compared only by its own file when it is a path inside the repository; otherwise nothing is compared, and `omg factory check` still prints `gate: ok`. A gate with no script, a workspace selector (`-w`, `-ws`, `--workspace`, `--filter`, `-r`, `yarn workspace`), `exec`, `dlx`, `create`, `yarn node`, or a package directory outside the repository cannot be compared. The run then parks at `awaiting-human: gate-definition-unknown` before it starts any lane, so no AI credits are spent. `omg factory check` prints `gate: ok`, `gate: unresolved (<why>)` or `gate: not set`.

**The gate runs without a shell.** On Windows, `["npm","test"]` and `npx ...` run through node and npm's own `npm-cli.js` (or `npx-cli.js`) in node's directory. `pnpm` and `yarn` need a real `.exe` on PATH, or corepack's script beside node. A `.cmd` or `.bat` gate is never run. A gate whose executable cannot start parks the run at `awaiting-human: gates` with the reason. It records no `FAILURE` and starts no ci-fix lane.

### Trust rules

The local forge drops CI and remote review, so the config layers that may select it are limited:

- **No GitHub or Azure DevOps origin** (no origin, a path, another host): any config layer may set `kind: "local"`.
- **A GitHub or Azure DevOps origin:** only your user config or the `.copilot/omg.jsonc` committed on the base branch may switch the forge to local, and the command warns. A working-tree `kind: "local"` is refused with `forge-mismatch`.
- **`local.gate`** is a command, so it counts only from the user config or the base-committed file. A different gate in the working tree is ignored with a warning.

Without a gate, `omg factory setup` says so, and a run parks at `awaiting-human: gates` (with the same hint) instead of passing.

## Backlog items

One file per item, named `<id>-<slug>.md` (for example `3-add-remove.md`). Other files in the directory, such as a README, are ignored.

```markdown
---
title: Add remove()
state: open
labels: [factory, size:2]
dependsOn: [2]
parent: 1
priority: 2
size: 3
---
Remove an entry by key and return whether it existed.

## Acceptance
- [ ] `node --test` passes
- [ ] `remove('missing')` returns false
```

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | One line, up to 256 characters |
| `state` | no | `open` (default) or `closed` |
| `labels` | no | A flow list `[a, b]` or a block list of `- name` lines |
| `dependsOn` | no | Item ids this one waits for. `Depends on #n` / `Blocked by #n` lines in the body count too |
| `parent` | no | The spec item's id. A `Part of #n` line in the body counts too |
| `priority`, `size` | no | Positive integers; `omg factory check` sorts by priority |

The `## Acceptance` (or `## Acceptance criteria`) section is the item's acceptance criteria. Any other frontmatter key is an error that names the file.

**Only committed items run.** `omg factory run` reads items as committed on the base branch, so an edit in the working tree cannot change what a run does. `omg factory run --next` reads committed items only: an uncommitted file is not listed, and a dependency closed only in the working tree is not met. `omg factory check` and `omg factory board` also read the working tree: a new or edited file that is not committed on the base shows as `blocked` with reason `uncommitted` in check, and with an "uncommitted: untrusted until it is committed on `<base>`" warning on the board. A malformed committed file is skipped with a warning that names it.

### Specs

A spec is an item that other items name as their `parent`. Check reads it by its children:

- **No children yet.** The spec is an ordinary item. With an `## Acceptance` section it is `runnable`, so `omg factory run --next` would implement the whole spec. Enqueue its tickets and commit them before you use `--next`, or write the spec without an `## Acceptance` section: it then reads `needs-plan` (`no-plan`) until it has children. Enqueue does not need the section.
- **The label `spec`.** A spec item labelled `spec` is `blocked` with `needs-split` (`labelled spec: add its tickets with omg factory enqueue and commit them`) until it has children, like the GitHub label `epic`. Without the label, a spec stays runnable until it has children, as above.
- **Open children.** The spec is `blocked` with `needs-split`.
- **Every child closed.** The spec is `blocked` with `children-done`: `every child (#3) is closed: close this spec item; the factory never runs a spec that was split`. Set `state: closed` in the spec's file and commit it.

### Merged items

After you merge an item's local PR, its backlog file still says `state: open`. The item reads as closed anyway for `check`, `board`, dependencies and its spec, once the engine has recorded the merge in its PR store. The next `omg factory poll` tick or `omg factory run <id>` records it. Only the item's own PR counts (`factory/issue-<n>` for that item), and only a merge into the current base (`ship.base`).

- `check`, `board`, `enqueue` and the run intake print a warning: `local backlog: #3 is merged (local PR #1) but .copilot/backlog/3-x.md still says state: open; set state: closed there and commit it on the base branch (to reopen #3 later, commit state: open again after that: only a change of the state: line after the merge reopens it)`.
- The merged run ends with `; set state: closed in <path> and commit it on <base> (omg factory check already counts #3 as closed)`.
- To reopen the item, commit a change of its `state:` line on the base after the merge: set `state: closed`, commit it, then commit `state: open` again. The item then reads from its file again. Other edits of the file after the merge, such as the body or the labels, keep it closed. So does a `state:` change made before the merge, in the PR's own commits, or only in a merge commit.

## How a run works offline

`omg factory run` follows the same phases as on GitHub (see [`omg factory run`](REFERENCE.md#omg-factory-run-experimental)). What changes:

- **The mirror.** The first run creates a bare mirror in the engine's forge state directory, outside the repository: `~/.omg/state/forge/local/<repo>-<hash>.git` on Windows and macOS, `$XDG_STATE_HOME/omc/forge/local/...` on Linux (default `~/.local/state/omc/forge/local/...`), or `$OMC_HOME/state/forge/local/...` when `OMC_HOME` is set. It is registered in your checkout as the git remote `omg-local`; `origin` is never used. The first push copies the repository history, about the size of the packed `.git`; later pushes are incremental.
- **Base sync.** Each run, and each `omg factory poll` tick, pushes your local base branch to the mirror fast-forward only. If the base was rewritten or reset, the sync refuses with a message; restore the branch, or move the mirror aside to start a new one. Before it uses the remote, the engine refuses with exit 5 (on `run` and on each `poll` tick) when your git config, in any scope, sets one of these:
  - a `remote.omg-local.fetch` other than `+refs/heads/*:refs/remotes/omg-local/*`, or any `remote.omg-local.vcs` or `remote.omg-local.mirror`. Remove the key with `git config --unset <key>` in the file that `git config --show-origin --get-regexp <key>` names;
  - a `url.<x>.insteadOf` or `url.<x>.pushInsteadOf` whose value is a prefix of the mirror path;
  - a remote whose name spells the mirror path. Remove it with `git config --remove-section "remote.<path>"`. When another config file sets it, add `--global`, or `--file <path>` with the file that `git config --show-origin --get-regexp '^remote\.'` names;
  - an `omg-local` url or push url that is not exactly the mirror path. The refusal names the value it found, such as `pushes to <value> (a remote.omg-local.pushurl or pushInsteadOf)`, and lists the fix for each cause: `git remote set-url omg-local <mirror>` (or `git config remote.omg-local.url <mirror>` when the remote has no url), `git config --unset-all remote.omg-local.pushurl`, and `git config --unset-all url.<x>.pushinsteadof` for a `pushInsteadOf` that rewrites the url. For a key in another config file, add `--global`, or `--file` with the file `git config --show-origin` names.

  A base that is not a fast-forward of the mirror's base is a plain error, not exit 5.
- **PRs.** A PR is the branch `factory/issue-<n>` pushed to the mirror plus an entry in a JSON store next to it (`<repo>-<hash>/prs.json`). Its draft and ready state are kept there.
- **Prepare.** Before the gate, the engine runs ship's prepare in its checkout: it merges the base, then runs the checks. With `ship.prepare.checks` set, it runs those argv commands (`[]` runs none). Otherwise it runs only the built-in checks your base branch has: `tsc --noEmit` when the base has `tsconfig.json` and `node_modules` has the typescript package, eslint on changed `src` TypeScript when the base has an eslint config and `node_modules` has eslint, and vitest on the tests mapped from the diff when `node_modules` has vitest. A repository without them runs none. A check the base has whose file the PR deleted fails prepare instead of being skipped. Your test command belongs in `factory.forge.local.gate`, not here. `omg factory check` prints `prepare checks: ...` so you can see the base-level checks that will run (the generator `--verify` scripts depend on the diff and are not listed). See `ship.prepare.checks` under [`omg ship`](REFERENCE.md#omg-ship).
- **The gate.** The engine runs `factory.forge.local.gate` once per pushed head, in its own prepare checkout, with a scrubbed environment and the timeout. The result is the check `local-gate` (`SUCCESS` or `FAILURE` with the last 8000 characters of output), recorded under `<repo>-<hash>/checks/<sha>.json`. A rerun removes the record and the gate runs again. `ship.requiredChecks` and `advisoryChecks` are ignored on the local forge: the gates wait for `local-gate` only, with a warning when you configured other required checks.
  - The gate runs the PR's own code. Offline the gate is the only check, so a lane may not change the gate's own definition. For an npm, pnpm or yarn gate that is the `package.json` script it runs with its `pre` and `post` scripts, plus `.npmrc`, `.yarnrc`, `.yarnrc.yml` and `.pnpmfile.cjs` (at the top and in the package directory) and an argv `--script-shell`, `--userconfig` or `--globalconfig` file inside the repository. For a node gate it is the script file. Before anything is pushed, the head's definition must equal the one on the base. Otherwise the run parks at `awaiting-human: gate-definition-changed`, and the message names the files and a `git diff` to inspect.
  - `omg factory run <n> --allow-gate-change` accepts that one definition. It works only on a rerun of a run parked at `gate-definition-changed`, and accepts exactly the parked definition; otherwise it is ignored with a warning. A later change in the same run parks again.
  - The definition check does not cover what the script itself runs, such as the tests, a test config or `node_modules`, nor a file a config line points at (a `yarnPath` release, a `script-shell`). Config files compare by their text. Review covers the rest.
  - The run records the gate argv the first time the gate actually starts (state `localGate`). If the gate could not start (the run parked at `awaiting-human: gates` with "the local gate could not start"), fix `factory.forge.local.gate` and rerun: the run adopts the new gate. Once a gate has started, a changed `factory.forge.local.gate` parks the run at `awaiting-human: gates`. Restore the gate, or cancel the run and start over (see [Cancelling and retrying an item](#cancelling-and-retrying-an-item)).
  - A failed gate starts the ci-fix lane with the gate's output tail as the failure.
  - A `PENDING` record older than the gate timeout plus 1 minute counts as left by a crashed engine, and the next run reruns the gate.
  - A rerun inside the gates phase starts only if a full gate timeout still ends before the gates deadline. Otherwise the run parks at `gates-timeout`.
  - The verdict is the exit status of the gate's root process. Output written more than 2 s after the root exits is dropped. At the timeout the whole process tree is killed. After the root has exited, leftover descendants are killed on POSIX only. On Windows they survive and are no longer waited for.
- **Review.** The factory's own review lane still runs. There are no human or remote review threads. The review lane is static: its shell runs read-only commands only (no npm or node), and the gate runs the tests after review.
- **Inspecting a run.** `git fetch omg-local factory/issue-<n>` during a run is safe: a tracking ref moved to the mirror's own sha does not count as tampering. Any other move, or a deletion, of such a ref while a lane runs still parks the run at `lane-tampered` or `review-tampered`, whoever did it. To read without touching refs, use `git --git-dir <mirror> log factory/issue-<n>`.
- **Wording.** Lane prompts, the PR body and the run history call the item a backlog item, not an issue or a work item.
- **Merge.** The run parks at `awaiting-human: merge` and prints the command, `git -C <root> merge --no-ff --no-edit <sha>`. Run it on the base branch. The next `omg factory run <n>` or `omg factory poll` tick syncs the base to the mirror and reads the PR as `MERGED`. Then set `state: closed` in the item's file (see [Merged items](#merged-items)).
- **Comments and progress** go to `.omg/factory/local/` in the repository (`items/<id>/` and `prs/`), not to a server.
- **Run state** is where it is on GitHub, under the state root `.omg/`: the state file `.omg/state/factory/run-<n>.json` and the progress log `.omg/progress/factory-<n>.log`.

## Cancelling and retrying an item

`omg factory run cancel <n>` closes the item's local PR (state `CLOSED`, reason `cancelled`) once the cancel finishes. The branch and the worktrees are kept. To run the item again:

```bash
omg factory run clean 3   # remove the run's worktrees and local lane branches
omg factory run reset 3   # start the cancelled run over
omg factory run 3         # a new run with a new local PR
```

Reset keeps the old branch in the mirror as `factory/cancelled/issue-<n>-<time>`, deletes `factory/issue-<n>` there, closes the local PR if it is still open, and moves the run state aside as `run-<n>.json.reset-<time>`. It is for the local forge only. It refuses, with exit 1, a run whose recorded forge is not local, a run whose mirror differs from the configured one, no run at all, a run that is not cancelled, a run that still has worktrees (`run clean` first), a run state that fails its seal or is not the engine's last write, and a live engine. A reset stopped part way is finished by running it again. After a reset, `omg factory check` reads the item as new.

## Commands

| Command | On the local forge |
|---|---|
| `omg factory setup --forge local` | Needs no origin. Refuses `--org`, `--project` and `--repo`. Writes `ship.base` when no config names one (see [Quick start](#quick-start)). Prints the limitations, a note when no gate is set, a reminder to commit backlog items on `<base>`, and an override note when an origin exists |
| `omg factory check`, `board` | Work with no origin; the base is your local `<base>` branch (no fetch). A missing base branch exits 2 (see [Exit code 2](#exit-code-2)). Text output prints the limitations; `--json` has them in the top-level `limitations` array. Check also prints `gate: ok`, `gate: unresolved (<why>)` or `gate: not set` (`gate` in `--json`) |
| `omg factory enqueue` | Writes the tickets as backlog files in the working tree, with `Part of #<spec>` and `Blocked by #n` lines. The spec must be committed on `<base>`. Commit the new files on `<base>` before a run can take them. A rerun before the commit does not duplicate them |
| `omg factory run` | As above. `--dry-run` reads the local base, fetches nothing and writes nothing (no mirror, no remote). It reports an open local PR as `pr-exists`, a gate whose definition cannot be read as `gate-definition-unknown`, and a gate that cannot start (`plan.gateProblem` in `--json`), without running the gate. `--next` reads the local base like `check` (no fetch) and committed items only; a missing base branch exits 2. `poll`'s `factory.intake.autoStart` runs `--next` too |
| `omg factory run cancel`, `reset` | Cancel closes the local PR; reset starts a cancelled run over (see [Cancelling and retrying an item](#cancelling-and-retrying-an-item)) |
| `omg factory poll` | Each tick first syncs the mirror base (JSON `baseSync`), so a PR you merged reads as merged. A tick with nothing new on the base skips the fetch. A plain sync error, such as a non-fast-forward base, is a tick error. A refused git config or a mirror remote mismatch exits 5 and stops `--loop`; fix the config, then restart the poller. A missing base branch exits 2. No heal, no review threads |
| `omg factory listen` | Refused when your user config sets `factory.forge.kind: "local"`: there are no webhooks. Use `omg factory poll` |

## What offline mode does not do

`omg factory setup`, `check` and `board` print these lines (and `--json` returns them as `limitations`):

```text
local forge (offline): no CI; gates = factory.forge.local.gate, run once per head on this machine
no remote or human PR review threads (the factory's own review lane still runs)
no issue or PR comments on a server (written to .omg/factory/local/)
no webhooks (omg factory listen) and no heal
no progress sync to a board
merge is a git merge you run on <base>
not for sharing work between machines
```

On GitHub and Azure DevOps, `limitations` is an empty array.

## Exit code 5

`omg factory setup`, `check`, `board`, `enqueue`, `poll` and `run` (including `--dry-run` and `--next`) exit `5` when the repository has no usable forge: no origin, an origin that is neither GitHub nor Azure DevOps, or a config that does not match the origin. `run` and `poll` also exit `5` on the local forge's refused git config or a mirror remote mismatch (see Base sync above). stderr starts with `unsupported forge:` and, where it applies, ends with `for the offline (local) forge run omg factory setup --forge local`. For a local forge refusal, `poll` prints `Error: refusing the local forge: ...` or `Error: refusing to sync the local forge mirror: ...` instead. With `--json`, `poll` prints no `Error:` line: the refusal is the `error` field of the JSON line `{"ok":false,"error":"..."}` on stdout.

## Exit code 2

On the local forge, `omg factory check`, `board`, `poll` and `run --next` exit `2` when the base branch does not exist in the repository:

```text
the base branch dev does not exist in this repository, so no committed backlog item or config can be read; set ship.base in .copilot/omg.jsonc to the branch you merge into (omg factory setup --forge local writes it)
```

Set `ship.base` in `.copilot/omg.jsonc` to the branch you merge into. When no config sets `ship.base`, `omg factory setup --forge local` detects and writes it; setup never changes a `ship.base` that is already set.
