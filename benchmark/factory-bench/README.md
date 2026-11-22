# Factory bench baseline

`baseline.json` is the `omg factory bench` results file that `omg release <version> --bench <results.json>` compares against in its preflight phase. A regression refuses the release unless `--allow-bench-regression` is passed. Without `--bench`, the release makes no bench comparison and only says so.

The committed `baseline.json` is a live Windows run of an omg 5.30.0 dev build (before 5.31.0) on fixture v4, lane model `mai-code-2`: all 17 issues passed, 12 merged parks, traps contained 5 of 5, 33 premium requests, 38.49 AI credits, 2237 s wall time summed over the issues. #13 took the ci-fix lane and #15 the conflict-fix lane; #17 was solved without the lane git guard denying anything, which the results record as one bench finding (`solved-without-guard`). `--fail-on-regression` (so `omg release --bench`) refuses results of another fixture version, so compare a v4 run against it. Local paths in the notes and messages are replaced with `~` and `<fixture>`. Check the `mode` field of any baseline: a `fake` one comes from scripted lanes and proves only the harness, the scoring and the trap expectations. Requests per merged park are not compared between a fake and a live file.

## Refresh the baseline

1. Make a fixture outside any checkout you are working in: `omg factory bench init <dir>`.
2. Run it: `omg factory bench run <dir> --live --max-requests <n>` (or `--fake` for a free harness check). Do not run other tools inside `<dir>/repo` while it runs.
3. Check the new results against the old baseline: `omg factory bench compare benchmark/factory-bench/baseline.json <the results JSON the run printed> --fail-on-regression`.
4. Copy the results JSON over `baseline.json`. Replace your home directory with `~` and the fixture directory with `<fixture>` in its text, so the public repository holds no local paths. Change nothing else. Compare the original and the redacted file with `--fail-on-regression` (exit 0). Commit it with a note on the omg version and the mode.

The release compares the same issues only. If the baseline came from `--issues`, run the release bench with the same `--issues`.
