# Version Bump — Search Before Commit

## The Insight
Version strings are scattered across more files than you think. Package.json is obvious, but docs, copilot-instructions.md, marketplace.json, CLAUDE.md, and hardcoded references in source code all carry version numbers. A version bump that misses any of these creates subtle drift that breaks tests, confuses users, or causes release pipeline failures.

## Why This Matters
Multiple sessions have hit this: bumping package.json but missing docs/CLAUDE.md, marketplace.json, or README badges. The result is failing tests, follow-up commits to fix missed references, and wasted cycles. The worst case is publishing a release where the version in the UI doesn't match the installed version.

## Recognition Pattern
- Any task involving "bump version", "release", or "update version"
- After changing a version number in any file
- Before committing a version change

## The Approach
Before committing ANY version change:

1. **Grep for the OLD version string** across all file types:
   ```bash
   grep -r 'OLD_VERSION' --include='*.json' --include='*.md' --include='*.ts' --include='*.mjs' --include='*.cjs' --include='*.yml'
   ```
2. **Update every match** — not just the ones you expect
3. **Grep again** to confirm zero remaining references to the old version
4. **Rebuild** (if applicable) before committing — dist bundles may embed the version
5. Only then commit

Key files that are commonly missed in this project:
- `.claude-plugin/marketplace.json`
- `docs/CLAUDE.md` (version marker)
- `package-lock.json` (regenerate, don't hand-edit)
- README badges or version references
- `Directory.Build.targets` (for .NET/IPA projects — preview version)
