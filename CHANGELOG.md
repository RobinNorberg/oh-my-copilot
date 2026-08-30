# oh-my-copilot v5.0.2

## Release Notes

v5.0.2 is the patch release from v5.0.1 through the final release candidate. It corrects Claude Code subagent nesting and concurrency guidance and hardens graph artifact containment, replay integrity, and path handling.

### Highlights

- Corrects Claude Code subagent nesting and concurrency workflow guidance for current Claude Code releases.
- Replaces opaque macOS `/dev/fd/N` graph failures with explicit fail-closed containment when a safe directory-descriptor primitive is unavailable.
- Closes graph artifact basename traversal, path-fallback time-of-check/time-of-use, malformed or unsafe epoch, symlink, and identity-validation gaps.
- Rejects missing journal history, descriptor/fingerprint metadata mismatches, special-file or hardlinked artifacts, and unsafe atomic-write temporary files before replay or publication.
- Keeps graph execution deterministic and safe on Linux while intentionally failing closed on macOS and Windows without a safe directory-descriptor primitive; macOS graph execution is not restored by this release.

### Validation

The release candidate was validated against the exact candidate head with version, projection, inventory, graph safe-fs/fence/CLI tests, build, typecheck, lint, package, and release-boundary checks. The release process must not treat any failing or unavailable validation as passing evidence.
