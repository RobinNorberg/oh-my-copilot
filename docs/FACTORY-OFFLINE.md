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

**The gate names a script.** The run compares the gate's definition, the files that decide what command runs, with the base (see [The gate](#how-a-run-works-offline)). `omg factory check` prints `gate: ok` only for a gate the repository defines:

- a `package.json` script (`npm test`, `npm run <script>`, pnpm and yarn equivalents, or `node --run <script>`), or
- a script file in the repository (`node scripts/gate.mjs`, `./ci/gate.sh`), compared by its own file; arguments after the script are the script's own, or
- `node --test` with plain path or glob arguments and any `--test-*` flags (or `--experimental-test-coverage`), or `node -e`, `--eval`, `-p` or `--print` with inline code as its first option. These are known and have no source files; the code lives in your config.

A gate that runs `npx`, a program found on PATH (`cargo test`, `go test`, `pytest`, `make check`), a program given by a path outside the repository (with or without arguments), or `node` with any other option before its script (`-r`, `--import`, `--loader`, `--env-file`, `--inspect`, `--watch`, `--permission` and the like) prints `gate: unresolved (<why>)`. So do a gate with no script, a workspace selector (`-w`, `-ws`, `--workspace`, `--filter`, `-r`, `yarn workspace`), `exec`, `dlx`, `create`, `yarn node`, and a package directory outside the repository. A run with an unresolved gate parks at `awaiting-human: gate-definition-unknown` before it starts any lane, so no AI credits are spent. The way out is to wrap the command in a script committed in the repository, for example `node scripts/gate.mjs`, which runs `cargo test`, and use that as `factory.forge.local.gate`. `--allow-gate-change` does not apply to an unknown definition. `omg factory check` prints `gate: ok`, `gate: unresolved (<why>)` or `gate: not set`.

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

**Only committed items run.** `omg factory run` reads items as committed on the base branch, so an edit in the working tree cannot change what a run does. `omg factory run --next` reads committed items only: an uncommitted file is not listed, and a dependency closed only in the working tree is not met. `omg factory check` and `omg factory board` also read the working tree: a new or edited file that is not committed on the base shows as `blocked` with reason `uncommitted` in check, and with an "uncommitted: untrusted until it is committed on `<base>`" warning on the board. A malformed committed file is skipped with a warning that names it. A malformed file in the working tree is skipped with one warning too; `enqueue` and `triage` refuse to edit it, naming the file, and leave it unchanged.

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
- To reopen the item, commit a change of its `state:` line on the base after the merge: set `state: closed`, commit it, then commit `state: open` again. The item then reads from its file again. Other edits of the file after the merge, such as the body or the labels, keep it closed. So does a `state:` change made before the merge, in the PR's own commits, or only in a merge commit. A body line that starts with `state:` is not the `state:` line, so adding one never reopens the item, even after a real reopen. Closing the item and reopening it again later counts as a reopen: the engine looks past the latest edit of the line to the last real change of its value.

## How a run works offline

`omg factory run` follows the same phases as on GitHub (see [`omg factory run`](REFERENCE.md#omg-factory-run-experimental)). What changes:

- **The mirror.** The first run creates a bare mirror in the engine's forge state directory, outside the repository: `~/.omg/state/forge/local/<repo>-<hash>.git` on Windows and macOS, `$XDG_STATE_HOME/omc/forge/local/...` on Linux (default `~/.local/state/omc/forge/local/...`), or `$OMC_HOME/state/forge/local/...` when `OMC_HOME` is set. It is registered in your checkout as the git remote `omg-local`; `origin` is never used. The first push copies the repository history, about the size of the packed `.git`; later pushes are incremental.
- **Base sync.** Each run, and each `omg factory poll` tick, pushes your local base branch to the mirror fast-forward only. If the base was rewritten or reset, the sync refuses with a message; restore the branch, or move the mirror aside to start a new one. Before it uses the remote, the engine refuses with exit 5 (on `run` and on each `poll` tick) when your git config, in any scope, sets one of these:
  - a `remote.omg-local.fetch` other than `+refs/heads/*:refs/remotes/omg-local/*`, or any `remote.omg-local.vcs` or `remote.omg-local.mirror`. Remove the key with `git config --unset <key>` in the file that `git config --show-origin --get-regexp <key>` names;
  - a `url.<x>.insteadOf` or `url.<x>.pushInsteadOf` whose value is a prefix of the mirror path;
  - a remote whose name spells the mirror path. Remove it with `git config --remove-section "remote.<path>"`. When another config file sets it, add `--global`, or `--file <path>` with the file that `git config --show-origin --get-regexp '^remote\.'` names;
  - an `omg-local` url or push url that is not exactly the mirror path. The refusal names the value it found, such as `pushes to <value> (a remote.omg-local.pushurl or pushInsteadOf)`, and lists the fix for each cause: `git remote set-url omg-local <mirror>` (or `git config remote.omg-local.url <mirror>` when the remote has no url), `git config --unset-all remote.omg-local.pushurl`, and `git config --unset-all url.<x>.pushinsteadof` for a `pushInsteadOf` that rewrites the url. For a key in another config file, add `--global`, or `--file` with the file `git config --show-origin` names.

  A base that is not a fast-forward of the mirror's base is a plain error, not exit 5.
- **Mirror safety.** The engine's pushes run the mirror's receive-pack with the engine's empty hooks directory and with `core.fsmonitor`, `core.alternateRefsCommand` and `receive.autogc` pinned off, `core.bare=true`, and `receive.denyCurrentBranch` and `receive.denyDeleteCurrent` set to `refuse`, so hooks or such config in the mirror never run and a push never checks files out in it. Its fetches and `ls-remote` run the mirror's upload-pack with `core.alternateRefsCommand` pinned off. Before every push, fetch and `ls-remote` on `omg-local` (the engine's, `omg factory poll`'s, `omg factory run clean`'s and `reset`'s), the engine refuses when:
  - the mirror path is a symlink or junction, or the mirror has a `.git`, `commondir`, `gitdir` or `config.worktree` entry, any of which would point git at another repository;
  - the mirror has `objects/info/alternates` or `info/attributes`;
  - the mirror's `config` holds a key other than the ones `git init --bare` writes (`core.repositoryformatversion`, `filemode`, `bare`, `symlinks`, `ignorecase`, `precomposeunicode`, `extensions.objectformat`), or does not set `core.bare = true` exactly once. Remove a key with `git config --file <mirror>/config --unset <key>`.
- **The trusted base** is your local base branch as the engine synced it, never the mirror's ref. A mirror base that differs from it parks the run at `lane-tampered`. `omg factory pr diff` and `view` use your base: they refuse (exit 1) only when the mirror's base is neither your base nor an ancestor of it (a mirror that lags behind your own commits is fine). The engine cannot tell a commit on your base made by code that ran on your machine (a prepare check or the gate runs the PR's code) from your own merge: keep the base branch yours.
- **PRs.** A PR is the branch `factory/issue-<n>` pushed to the mirror plus an entry in a JSON store next to it (`<repo>-<hash>/prs.json`). Its draft and ready state are kept there.
- **Prepare.** Before the gate, the engine runs ship's prepare in its checkout: it merges the base, then runs the checks. With `ship.prepare.checks` set, it runs those argv commands (`[]` runs none). Otherwise it runs only the built-in checks your base branch has: `tsc --noEmit` when the base has `tsconfig.json` and `node_modules` has the typescript package, eslint on changed `src` TypeScript when the base has an eslint config and `node_modules` has eslint, and vitest on the tests mapped from the diff when `node_modules` has vitest. A repository without them runs none. A check the base has whose file the PR deleted fails prepare instead of being skipped. Your test command belongs in `factory.forge.local.gate`, not here. `omg factory check` prints `prepare checks: ...` so you can see the base-level checks that will run (the generator `--verify` scripts depend on the diff and are not listed). See `ship.prepare.checks` under [`omg ship`](REFERENCE.md#omg-ship).
- **The gate.** The engine runs `factory.forge.local.gate` once per pushed head, in its own prepare checkout, with the timeout. The result is the check `local-gate` (`SUCCESS` or `FAILURE` with the last 8000 characters of output, and `sandbox`: `enforced`, `ack` or `unsandboxed`), recorded under `<repo>-<hash>/checks/<sha>.json`.
  - **In the sandbox.** By default (`factory.run.sandbox.gates: "enforced"`) the gate and prepare's checks run in the Copilot runtime's OS sandbox: read-write on the prepare checkout only, the git dir read-only, no network (`factory.run.sandbox.writeNetwork: "registry"` opens the npm registry) and no credential variable in the env. Your home's credential files are hidden only where the host reports `denied_paths`. Known gap: the Copilot CLI sandbox on Windows cannot deny paths, so there the gate's code can read files under your user profile, credential stores included. It still has no network by default, no token in the env, the git dir and `node_modules` read-only, and writes confined to the checkout and job temp. Output tails are redacted by pattern, which reduces exposure but isolates nothing: it catches only a token printed verbatim, and the PR's code can encode what it read, or write it into a file prepare commits (such as the inventory). The gate runs and counts, the record and a PR note say `sandboxed; credential files readable on this host`, and `factory.run.sandbox.requireDeniedPaths: true` parks such a host instead (see "Known gap" in [REFERENCE.md](REFERENCE.md#sandboxed-lanes)); the only way past that park is `--allow-unsandboxed-gates`, which runs the head with no sandbox at all. Where the sandbox cannot start the command under a confirmed policy, or with `gates: "ack"` (also `OMG_SANDBOX=off`), the run parks at `awaiting-human: gates-unsandboxed` before the head's code runs; `omg factory run <n> --allow-unsandboxed-gates` runs that head unsandboxed, as you, with an allowlisted env and an empty home, and a new head parks again. That ack trusts all of the head's code with your account: your files and credential files stay readable by path, and a process it leaves behind keeps running. A command that ran in the sandbox but gave no verdict parks at `awaiting-human: gate-no-verdict` (no ack offer, no pass, no failure). `gates: "unsandboxed"` (user config only) runs it unsandboxed with a warning and a PR note. A gate that fails in the sandbox counts as a failure only when it passes in the sandbox on the base; otherwise the run parks at `awaiting-human: gate-sandbox-incompatible` with no `FAILURE` and no ci-fix lane. Unsolved: `ack` and `unsandboxed` runs have your full user rights; Linux (bwrap) and macOS are untested; the exit marker's assumptions (see REFERENCE) need a live run; whether the turnless sandbox runtime costs a premium request is not measured yet. See "Sandboxed gates" in [REFERENCE.md](REFERENCE.md#sandboxed-lanes). A rerun removes the record and the gate runs again. `ship.requiredChecks` and `advisoryChecks` are ignored on the local forge: the gates wait for `local-gate` only, with a warning when you configured other required checks.
  - **The checkout.** The checkout must be exactly the pushed head first: it is compared with a fresh index read from that head (only the engine's own `node_modules` link is allowed). A changed tracked file, or an untracked file that is not ignored, parks the run at `lane-tampered` before the gate runs. Ignored entries of any kind (the build output of a prepare check such as `dist/` or `target/`, a previous gate's `coverage/` when the gate runs again in the same checkout, a Python venv or `bazel-*` links, the tree a check's `npm ci` makes) are left as they are, links included, so a gate can use them: the checks and the gate run the same head's code in the same sandbox, so such an entry gives the gate nothing the PR's own tests could not do, and removing the checkout unlinks every link before it deletes anything. A checkout you removed by hand, `rm -rf` included, is prepared again on the next run (the engine prunes its stale worktree entry). The checkout is read only through the admin dir the engine's `git worktree add` made (recorded in the run state); a `.git` file naming another one parks too. A checkout made by an older release has no recorded admin dir: the engine discards it as `omg factory run clean` would and prepares a fresh one, with no lane run again.
  - The gate runs the PR's own code. Offline the gate is the only check, so a lane may not change the gate's own definition. For an npm, pnpm or yarn gate that is the `package.json` script it runs with its `pre` and `post` scripts, plus `.npmrc`, `.yarnrc`, `.yarnrc.yml` and `.pnpmfile.cjs` (at the top and in the package directory) and an argv `--script-shell`, `--userconfig` or `--globalconfig` file inside the repository. For a node gate it is the script file. Before anything is pushed, the head's definition must equal the one on the base. Otherwise the run parks at `awaiting-human: gate-definition-changed`, and the message names the files and a `git diff` to inspect.
  - `omg factory run <n> --allow-gate-change` accepts that one definition. It works only on a rerun of a run parked at `gate-definition-changed`, and accepts exactly the parked definition; otherwise it is ignored with a warning. A later change in the same run parks again.
  - The definition check does not cover what the script itself runs, such as the tests, a test config or `node_modules`, nor a file a config line points at (a `yarnPath` release, a `script-shell`). Config files compare by their text. Review covers the rest.
  - The run records the gate argv the first time the gate actually starts (state `localGate`). If the gate could not start (the run parked at `awaiting-human: gates` with "the local gate could not start"), fix `factory.forge.local.gate` and rerun: the run adopts the new gate. Once a gate has started, a changed `factory.forge.local.gate` parks the run at `awaiting-human: gates`. Restore the gate, or cancel the run and start over (see [Cancelling and retrying an item](#cancelling-and-retrying-an-item)).
  - A failed gate starts the ci-fix lane with the gate's output tail as the failure.
  - A `PENDING` record older than the gate timeout plus 1 minute counts as left by a crashed engine, and the next run reruns the gate.
  - A rerun inside the gates phase starts only if a full gate timeout still ends before the gates deadline. Otherwise the run parks at `gates-timeout`.
  - The verdict is the exit status of the gate's root process. Output written more than 2 s after the root exits is dropped. At the timeout the whole process tree is killed. When the root has exited but its output pipes stay open, the leftover processes are killed before the verdict:
    - On POSIX the gate runs in its own process group, which is signalled while the leader still has the recorded start identity.
    - On Windows the root's children created between the gate's start and the root's exit are listed, matched by start time, and killed with their trees. A grandchild whose parent already exited is not reachable this way.
    - The engine records the gate's processes under the forge store (`gate-procs/<head>.json`). The next gate run for the same head, and a sweep at the first gate of each engine process, clean up leftovers of an engine that crashed. A POSIX group whose leader is already gone is not signalled, because its id cannot be told from a reused one.
- **Review.** The factory's own review lane still runs. There are no remote review threads. You can record your own review of a local PR with `omg factory pr review` (see [Reviewing a local PR](#reviewing-a-local-pr)); `omg factory poll` counts it, but the engine does not yet act on it. The review lane is static: its shell runs read-only commands only (no npm or node), and the gate runs the tests after review.
- **Inspecting a run.** `git fetch omg-local factory/issue-<n>` during a run is safe: a tracking ref moved to the mirror's own sha does not count as tampering. Any other move, or a deletion, of such a ref while a lane runs still parks the run at `lane-tampered` or `review-tampered`, whoever did it. To read without touching refs, use `git --git-dir <mirror> log factory/issue-<n>`.
- **Tamper quarantine and hold.** When `.git` itself changed during a lane or prepare (a hook, an `info/` file, a config key, a ref, also in a submodule's git dir or another worktree's `config.worktree`), the engine first kills what is left of the lane's processes. It then saves each changed item to `~/.omg/factory-ledger/quarantine/<repo>/<time>/` (renaming it there when it cannot be read), removes added hooks and puts back changed ones. Config keys are an allowlist: only `user.*`, a branch's upstream settings and a remote's URLs and refspecs are left in place (your own `git push -u`, `git remote add`, `git config user.email`); any other key changed during the run gets its old value back. The engine also deletes a planted `refs/replace/*` ref and lists every other ref change with its undo command in `refs.txt`. Anything it could not undo is named STILL ACTIVE with what to do. Unless only refs and allowlisted keys changed, every `omg factory run` here, and the poller's auto-start, exits 6 until `omg factory run release --tamper` (it prints what moved and clears the hold). If the change was yours, the `cp` command in `undo.txt` in the quarantine folder puts it back. Details: [Security model](REFERENCE.md#security-model).
- **Lane commit parks.** `secret-shaped-content`: the lane's change holds a key or token shape (paths and kinds named); remove it from the lane worktree and rerun, or rerun with `--allow-secret-shapes` for test fixtures. `lane-unconfirmed` with pids: a process of the finished lane is still alive; stop it and rerun. Both reruns commit the same worktree and start no new lane. A process listing that fails only warns (`process tree not proven` in the history).
- **Wording.** Lane prompts, the PR body and the run history call the item a backlog item, not an issue or a work item.
- **Merge.** The run parks at `awaiting-human: merge` and prints the command, `git -C <root> merge --no-ff --no-edit <sha>`. Run it on the base branch. The next `omg factory run <n>` or `omg factory poll` tick syncs the base to the mirror and reads the PR as `MERGED`. The run counts it as merged only when your base contains the head the engine pushed; a PR store that says `MERGED` otherwise parks the run at `lane-tampered`. Then set `state: closed` in the item's file (see [Merged items](#merged-items)).
- **Comments and progress** go to `.omg/factory/local/` in the repository (`items/<id>/` and `prs/`), not to a server.
- **Run state** is where it is on GitHub, under the state root `.omg/`: the state file `.omg/state/factory/run-<n>.json` and the progress log `.omg/progress/factory-<n>.log`.

## Cancelling and retrying an item

`omg factory run cancel <n>` closes the item's local PR (state `CLOSED`, reason `cancelled`) once the cancel finishes. The branch and the worktrees are kept. To run the item again:

```bash
omg factory run reset 3   # remove the run's worktrees and start the cancelled run over
omg factory run 3         # a new run with a new local PR
```

A cancel during a lane leaves that lane's partial edits in its worktree. `omg factory run clean 3` keeps such a dirty worktree and says so; `omg factory run clean 3 --discard` gives the uncommitted changes up. Reset does the same itself before it starts the run over. Neither removes a worktree that holds commits no base or mirror branch has.

Reset keeps the old branch in the mirror as `factory/cancelled/issue-<n>-<time>`, deletes `factory/issue-<n>` there, closes the local PR if it is still open, and moves the run state aside as `run-<n>.json.reset-<time>`. It is for the local forge only: with another configured forge it exits 2. It refuses, with exit 1, a run whose recorded forge is not local, a run whose mirror differs from the configured one, no run at all, a run that is not cancelled, a run with a worktree that holds such commits, a run with a lane worktree kept as tamper evidence (inspect it; `omg factory run clean <n> --discard` removes it), a run state that fails its seal or is not the engine's last write, and a live engine. It exits 6 while a lane whose stop was not confirmed may still run: the message names the lane and its pid, or its worktree path (look for Copilot CLI processes whose command line names it); once that process is stopped, `omg factory run reset <n> --lane-stopped` records your word and goes on, unless the recorded child is seen alive. A reset stopped part way is finished by running it again. After a reset, `omg factory check` reads the item as new.

## Reviewing a local PR

```bash
omg factory pr list
omg factory pr view 1
omg factory pr diff 1                     # prints the head sha first
omg factory pr review 1 --request-changes --body-file notes.md --head <full sha>
omg factory pr review 1 --approve --head <full sha>
```

`pr list`, `pr view` and `pr diff` read a local PR without running any hook, external diff or textconv of your checkout. `pr review` records your review (`--approve`, `--request-changes` or `--comment`, the last two with `--body-file`) on the PR's head. It needs the full 40-character head sha that `pr diff` printed as `--head`, and exits 2 with `head moved` when the PR moved since, so an approval never covers commits you did not read. A `--comment` after an `--approve` on the same head replaces the approval as your latest decision.

`omg factory poll` counts a recorded review as a human thread. The engine reads it at the merge step, for the head it pushed. With `factory.review.human: "fix"` (the default) an open thread of a trusted reviewer starts a fix round, and a recorded `--request-changes` parks the run at `awaiting-human: human-review` until you record an approval. A recorded `--comment` never starts a fix round; the merge message lists it. See [Human review at the merge step](REFERENCE.md#human-review-at-the-merge-step).

The local forge trusts every recorded review. Keep the state directory at its default (`~/.omg`) and run lanes in a sandbox that denies it. If `OMC_STATE_DIR` points into a place a lane can write, or the sandbox cannot deny paths, a lane could record an approval.

## Commands

| Command | On the local forge |
|---|---|
| `omg factory setup --forge local` | Needs no origin. Refuses `--org`, `--project` and `--repo`. Writes `ship.base` when no config names one (see [Quick start](#quick-start)). Prints the limitations, a note when no gate is set, a reminder to commit backlog items on `<base>`, and an override note when an origin exists |
| `omg factory check`, `board` | Work with no origin; the base is your local `<base>` branch (no fetch). A missing base branch exits 2 (see [Exit code 2](#exit-code-2)). Text output prints the limitations; `--json` has them in the top-level `limitations` array. Check also prints `gate: ok`, `gate: unresolved (<why>)` or `gate: not set` (`gate` in `--json`) |
| `omg factory enqueue` | Writes the tickets as backlog files in the working tree, with `Part of #<spec>` and `Blocked by #n` lines. The spec must be committed on `<base>`. Commit the new files on `<base>` before a run can take them. A rerun before the commit does not duplicate them |
| `omg factory run` | As above. `--dry-run` reads the local base, fetches nothing and writes nothing (no mirror, no remote). It reports an open local PR as `pr-exists`, a gate whose definition cannot be read as `gate-definition-unknown`, and a gate that cannot start (`plan.gateProblem` in `--json`), without running the gate. `--next` reads the local base like `check` (no fetch) and committed items only; a missing base branch exits 2. `poll`'s `factory.intake.autoStart` runs `--next` too |
| `omg factory run cancel`, `reset` | Cancel closes the local PR; reset starts a cancelled run over (see [Cancelling and retrying an item](#cancelling-and-retrying-an-item)) |
| `omg factory poll` | Each tick first syncs the mirror base (JSON `baseSync`), so a PR you merged reads as merged. A tick with nothing new on the base skips the fetch. A plain sync error, such as a non-fast-forward base, is a tick error. A refused git config or a mirror remote mismatch exits 5 and stops `--loop`; fix the config, then restart the poller. A missing base branch exits 2. No heal. Reviews you record with `omg factory pr review` are counted as human threads |
| `omg factory pr` | `list`, `view`, `diff` and `review` work on local PRs only (see [Reviewing a local PR](#reviewing-a-local-pr)); on another forge they exit 2 |
| `omg factory triage` | Works with no origin. A dry run by default; `--apply` edits the backlog files in the working tree (priority, `needs-split`, `needs-plan`). Commit them on `<base>`. See [`omg factory triage`](REFERENCE.md#omg-factory-triage-experimental) |
| `omg factory setup --workflows` | Not applicable: the cloud heartbeat needs a GitHub or Azure DevOps repository. Setup says so and writes nothing |
| `omg factory listen` | Refused when your user config sets `factory.forge.kind: "local"`: there are no webhooks. Use `omg factory poll` |

## Busy runs and parallel runs

One engine runs per checkout. A second `omg factory run` in the same checkout, or a `run clean`, `reset` or `release` while an engine owns the run, exits 6 (busy) and touches nothing. `--dry-run` names the holder and exits 6. `omg factory run status` without an item lists the engines running in this checkout, and `omg factory run release` removes a lock a crash left behind (see [Parallel runs and exit 6](REFERENCE.md#parallel-runs-and-exit-6-busy)). Read commands (`check`, `board`, `pr`, `triage`, `enqueue`) never fail because an engine runs: while one does, a command that would fetch `origin/<base>` reads the last fetched base and warns instead, and exits 6 only when no base was ever fetched. An engine start waits up to 60 s for such a fetch before it exits 6 (see [Parallel runs and exit 6](REFERENCE.md#parallel-runs-and-exit-6-busy)).

Parallel runs need separate clones, each with its own mirror and PR store. On the local forge the clones coordinate through a cross-clone claim keyed on the repository's root commit (each clone has its own mirror and no `origin`): while one clone's run holds an item, parked included, a run of that item in another clone exits 6 and its dry run names the claim. This works on one host with one `OMC_STATE_DIR` (or none in all clones); `omg factory run release <n>` removes a claim nobody will resume. A shallow clone gets claims of its own, not shared with full clones (shallow clones at the same boundary do share them), and each command warns once about it; after `git fetch --unshallow` its earlier claim goes with the run. `omg factory poll` in a checkout whose engine is running skips its base sync for that tick (`skipped: engine busy`).

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

The Copilot coding agent is GitHub only. With `factory.run.implementer: "coding-agent"` a local run uses the Copilot implement lane and prints `the coding agent is GitHub-only; using a Copilot lane`.

## Exit code 5

`omg factory setup`, `check`, `board`, `enqueue`, `poll` and `run` (including `--dry-run` and `--next`) exit `5` when the repository has no usable forge: no origin, an origin that is neither GitHub nor Azure DevOps, or a config that does not match the origin. `run` and `poll` also exit `5` on the local forge's refused git config or a mirror remote mismatch (see Base sync above). stderr starts with `unsupported forge:` and, where it applies, ends with `for the offline (local) forge run omg factory setup --forge local`. For a local forge refusal, `poll` prints `Error: refusing the local forge: ...` or `Error: refusing to sync the local forge mirror: ...` instead. With `--json`, `poll` prints no `Error:` line: the refusal is the `error` field of the JSON line `{"ok":false,"error":"..."}` on stdout.

## Exit code 2

On the local forge, `omg factory check`, `board`, `poll` and `run --next` exit `2` when the base branch does not exist in the repository:

```text
the base branch dev does not exist in this repository, so no committed backlog item or config can be read; set ship.base in .copilot/omg.jsonc to the branch you merge into (omg factory setup --forge local writes it)
```

Set `ship.base` in `.copilot/omg.jsonc` to the branch you merge into. When no config sets `ship.base`, `omg factory setup --forge local` detects and writes it; setup never changes a `ship.base` that is already set.
