# oh-my-copilot v5.27.0

This release brings in 412 upstream oh-my-claudecode commits (dev through 330d5c391, #524), adapted to GitHub Copilot CLI. The factory features from 5.26.0 are unchanged.

Install with `npm install -g oh-my-copilot@5.27.0`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

## From upstream

- Everything upstream shipped from 5.7.31 to 5.8.4 that applies to Copilot: team task-claim renewal for long-running tasks, Herdr panes for team launches, the `sdd` skill, playbook checks for user-level playbooks, keyword-detector fixes (the autopilot keyword now needs an explicit command), `$ARGUMENTS` substituted literally in commands, `--json` read correctly in subcommands, and Windows rename retries on `EPERM`/`EBUSY`/`EACCES`.
- **Smaller inventory file.** The committed inventory is now a minimal provenance baseline (upstream #5017), so pull requests no longer conflict on it with every merge.
- **Hooks run as `node` plus arguments** in the plugin manifest. The Copilot hook file is generated from it as before.

## Fixed in the port

- `/oh-my-copilot:autopilot` and `/omg:autopilot` activate autopilot again (the upstream command check only knew the upstream name).

## Caveats

- **A custom `COPILOT_HOME`** now has its own `.claude.json` for the Claude MCP profile; the default `~/.copilot` still uses `~/.claude.json`.
- **A config folder shared between WSL and Windows:** after WSL rewrites the cached plugin hook manifest, Claude Code hooks on Windows fail until a Windows-side install or `omg doctor` repair restores it. Copilot is not affected; it loads its own hook file.
- **Herdr panes** have not been run on Windows (no Herdr binary was available).
- The large team modules were reformatted to upstream's style, so their diff is mostly formatting.
- **Test evidence:** this release was published with CI on the release commit, not the maintainer's local full test suite.
