# Offline Factory (the `local` forge)

`omg factory` normally needs a GitHub or Azure DevOps origin: issues are the intake, PRs carry the work, CI runs the gates. The `local` forge runs the same engine with no server at all. Items are markdown files in the repository, PRs are local branches pushed to a bare mirror the engine owns, the gate is a command you configure, and the merge is a `git merge` you run yourself.

Use it to try the factory on a scratch repository, to demo it, or to work on a machine with no forge. It is not for sharing work between machines.

## Quick start

```bash
omg factory setup --forge local --dry-run   # show the config diff and the sample item; writes nothing
omg factory setup --forge local --yes       # write them
```

Setup writes `factory.forge.kind: "local"`, `factory.forge.local.backlogDir: ".copilot/backlog"` and the intake source `local-backlog` to `.copilot/omg.jsonc`. When `.copilot/backlog/` holds no item yet, it adds a sample `.copilot/backlog/1-example.md` with `state: closed`, so no run picks it up before you edit it. Setup never writes the gate (see [Trust rules](#trust-rules)), creates no labels and checks no login.

Then:

1. Set the gate in your user config, or in `.copilot/omg.jsonc` committed on the base branch (`ship.base`):

   ```jsonc
   { "factory": { "forge": { "local": { "gate": ["node", "--test"] } } } }
   ```

2. Write an item (see [Backlog items](#backlog-items)) and commit it on the base branch.
3. `omg factory check` lists it as `runnable`.
4. `omg factory run <id>` (or `omg factory run --next`) drives it to `awaiting-human: merge`.
5. Merge it yourself on the base branch, then rerun `omg factory run <id>` or let `omg factory poll` see it.

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

**Only committed items run.** `omg factory run` reads items as committed on the base branch, so an edit in the working tree cannot change what a run does. `omg factory check` and `omg factory board` also read the working tree: a new or edited file that is not committed on the base shows as `blocked` with reason `uncommitted` in check, and with an "uncommitted: untrusted until it is committed on `<base>`" warning on the board. A malformed committed file is skipped with a warning that names it.

## How a run works offline

`omg factory run` follows the same phases as on GitHub (see [`omg factory run`](REFERENCE.md#omg-factory-run-experimental)). What changes:

- **The mirror.** The first run creates a bare mirror in the engine's forge state directory, outside the repository: `~/.omg/state/forge/local/<repo>-<hash>.git` on Windows and macOS, `$XDG_STATE_HOME/omc/forge/local/...` on Linux (default `~/.local/state/omc/forge/local/...`), or `$OMC_HOME/state/forge/local/...` when `OMC_HOME` is set. It is registered in your checkout as the git remote `omg-local`; `origin` is never used. The first push copies the repository history, about the size of the packed `.git`; later pushes are incremental.
- **Base sync.** Each run, and each `omg factory poll` tick, pushes your local base branch to the mirror fast-forward only. If the base was rewritten or reset, the sync refuses with a message; restore the branch, or move the mirror aside to start a new one. Before it uses the remote, the engine refuses with exit 5 (on `run` and on each `poll` tick) when your git config, in any scope, sets one of these:
  - a `remote.omg-local.fetch` other than `+refs/heads/*:refs/remotes/omg-local/*`, or any `remote.omg-local.vcs` or `remote.omg-local.mirror`. Remove the key with `git config --unset <key>` in the file that `git config --show-origin --get-regexp <key>` names;
  - a `url.<x>.insteadOf` or `url.<x>.pushInsteadOf` whose value is a prefix of the mirror path;
  - a remote whose name spells the mirror path. Remove it with `git config --remove-section "remote.<path>"`;
  - an `omg-local` url or push url that is not exactly the mirror path. Fix it with `git remote set-url omg-local <mirror>` and remove any `pushurl`.

  A base that is not a fast-forward of the mirror's base is a plain error, not exit 5.
- **PRs.** A PR is the branch `factory/issue-<n>` pushed to the mirror plus an entry in a JSON store next to it (`<repo>-<hash>/prs.json`). Its draft and ready state are kept there.
- **The gate.** The engine runs `factory.forge.local.gate` once per pushed head, in its own prepare checkout, with a scrubbed environment and the timeout. The result is the check `local-gate` (`SUCCESS` or `FAILURE` with the last 8000 characters of output), recorded under `<repo>-<hash>/checks/<sha>.json`. A rerun removes the record and the gate runs again. `ship.requiredChecks` and `advisoryChecks` are ignored on the local forge: the gates wait for `local-gate` only, with a warning when you configured other required checks.
  - The gate runs the PR's own code. `["npm","test"]` runs the `package.json` script of the pushed head, so a lane that edits scripts or tests changes what the gate does.
  - The run records the gate argv it first ran (state `localGate`). If `factory.forge.local.gate` changes mid-run, the run parks at `awaiting-human: gates`. Restore the gate, or run `omg factory run cancel` and start a new run.
  - A `PENDING` record older than the gate timeout plus 1 minute counts as left by a crashed engine, and the next run reruns the gate.
  - A rerun inside the gates phase starts only if a full gate timeout still ends before the gates deadline. Otherwise the run parks at `gates-timeout`.
  - The verdict is the exit status of the gate's root process. Output written more than 2 s after the root exits is dropped. At the timeout the whole process tree is killed. After the root has exited, leftover descendants are killed on POSIX only. On Windows they survive and are no longer waited for.
- **Review.** The factory's own review lane still runs. There are no human or remote review threads.
- **Merge.** The run parks at `awaiting-human: merge` and prints the command, `git -C <root> merge --no-ff <sha>`. Run it on the base branch. The next `omg factory run <n>` or `omg factory poll` tick syncs the base to the mirror and reads the PR as `MERGED`.
- **Comments and progress** go to `.omg/factory/local/` in the repository (`items/<id>/` and `prs/`), not to a server.

## Commands

| Command | On the local forge |
|---|---|
| `omg factory setup --forge local` | Needs no origin. Refuses `--org`, `--project` and `--repo`. Prints the limitations, a note when no gate is set, a reminder to commit backlog items on `<base>`, and an override note when an origin exists |
| `omg factory check`, `board` | Work with no origin; the base is your local `<base>` branch (no fetch). Text output prints the limitations; `--json` has them in the top-level `limitations` array |
| `omg factory enqueue` | Writes the tickets as backlog files in the working tree, with `Part of #<spec>` and `Blocked by #n` lines. The spec must be committed on `<base>`. Commit the new files on `<base>` before a run can take them. A rerun before the commit does not duplicate them |
| `omg factory run` | As above. `--dry-run` reads the local base, fetches nothing and writes nothing (no mirror, no remote) |
| `omg factory poll` | Each tick first syncs the mirror base (JSON `baseSync`), so a PR you merged reads as merged. A plain sync error, such as a non-fast-forward base, is a tick error. A refused git config or a mirror remote mismatch exits 5 and stops `--loop`; fix the config, then restart the poller. No heal, no review threads |
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

`omg factory setup`, `check`, `board`, `enqueue`, `poll` and `run` (including `--dry-run` and `--next`) exit `5` when the repository has no usable forge: no origin, an origin that is neither GitHub nor Azure DevOps, or a config that does not match the origin. `run` and `poll` also exit `5` on the local forge's refused git config or a mirror remote mismatch (see Base sync above). stderr starts with `unsupported forge:` and, where it applies, ends with `for the offline (local) forge run omg factory setup --forge local`. For a local forge refusal, `poll` prints `Error: refusing the local forge: ...` or `Error: refusing to sync the local forge mirror: ...` instead.
