## OMC v5.0.2

v5.0.2 is the patch release from v5.0.1 through the final release candidate.

Install the release globally with `npm install -g oh-my-copilot@5.0.2`.

### Highlights

- Corrects Claude Code subagent nesting and concurrency workflow guidance.
- Hardens graph artifact containment and path validation, including traversal, TOCTOU, epoch, symlink, and identity cases.
- Rejects missing journal history, replay metadata mismatches, special-file or hardlinked artifacts, and unsafe atomic-write temporary files.
- Fails closed for macOS and Windows graph execution when a safe directory-descriptor primitive is unavailable; macOS graph execution is intentionally not restored by this release.

### Verification

Release validation covers exact-head version consistency, projections, inventory, graph runtime tests, lint, typecheck, tests, build, package checks, and release-boundary checks.
