# oh-my-copilot v5.33.1

A patch release for the release tooling and the tier 2 smoke. Nothing changes for sdk team workers, `copilot_run`, factory lanes or gates. See CHANGELOG.md.

Install with `npm install -g oh-my-copilot@5.33.1`, or from the plugin marketplace: `copilot plugin update oh-my-copilot@omc`.

v5.33.0 moved to Copilot SDK v2 (`@microsoft/copilot-sdk` 2.x, Copilot CLI 1.0.113 or newer). If you come from an older version, follow "Upgrade: Copilot SDK v2" in the v5.33.0 release notes first.

There is no new factory bench run in this release. The bench baseline is unchanged from v5.31.0.

## Fixed

- **The tag run no longer fails when the npm tarball shows up a few minutes after the version.** On v5.31.0 and v5.33.0 the package was published correctly, but the registry check saw the tarball URL return 404 while the version metadata was already there, so the GitHub Release was not created. `release-boundary.mjs verify-registry` now waits up to 10 minutes, with backoff, for the registry reads that lag behind a fresh publish (404, 408, 429, 5xx and transient network errors). A tarball whose bytes or digests do not match still fails at once, and so do redirects, other 4xx answers, refused connections, unknown hosts and TLS errors.
- **A failed verify phase no longer damages the earlier records of `omg release`.** A verify failure after a published release used to void the pr, promote and tag records. They are now kept, and `omg release <X.Y.Z> --from verify` passes once a Release Recovery run for that tag, dispatched from `main`, has succeeded. A GitHub release made by hand does not count.
- **`omg smoke copilot --tier 2` signs in on a Linux or macOS host without a keyring.** On such a host the Copilot CLI keeps the login in its `config.json`, and the smoke's own SDK sessions ran signed out ("This session is not signed in"). The smoke now sends the stored login over the session RPC, only when its runtime is not signed in, and scrubs the token from its report and event files. Factory lanes and `copilot_run` already did this; only the smoke harness was affected.

## Changed / Upgrade notes

- **The Release Recovery command needs `--ref main`:** `gh workflow run release.yml --ref main -f tag=v<version> -f sha=<main merge sha>`. The workflow run is now titled `Release Recovery <tag> <sha>`, and `omg release --from verify` accepts only such a run as proof.
- **The recovery rule starts with this release.** The recovery runs for v5.31.0 and v5.33.0 predate the run title, so `omg release --from verify` for those two versions does not pass. Both are published; nothing needs doing.
- The tag run's Create GitHub Release job has a 120 minute timeout.

## Caveats

- **Test evidence:** published with CI on the release commit, not the maintainer's local full test suite. The release commit got no local live smoke. The registry wait and the recovery rule were tested against local test servers and scripted commands only; this release's own tag run is their first real use.
- **SDK v2 on Linux:** the sandboxed-lane smoke (review, write and canary lanes) passed live in WSL Ubuntu on the commit this release is built from, with Copilot CLI 1.0.116 and SDK 2.0.3. macOS, machines with an organisation-managed sandbox policy and sandbox-proxy hosts are still untested: a runtime that reports extra policy entries there would make lanes refuse with `sandbox-unavailable:` (fail closed). Please report it if you see that.
- On a keyring-less host the smoke's `chain` and `team` scenarios and its CLI tiers still need `COPILOT_GITHUB_TOKEN`.
- The other caveats of v5.33.0 (.NET support, private NuGet feeds, Microsoft.Testing.Platform, redaction) are unchanged.
