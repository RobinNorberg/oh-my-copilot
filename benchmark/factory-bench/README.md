# Factory bench baseline

`baseline.json` is the `omg factory bench` results file that `omg release <version> --bench <results.json>` compares against in its preflight phase. A regression refuses the release unless `--allow-bench-regression` is passed. Without `--bench`, the release makes no bench comparison and only says so.

The committed `baseline.json` is a live run of omg 5.27.0 on fixture v2: all 12 issues, 11 of 12 passed, 21 premium requests. Issue 6 (discount-codes) passed review and gates but fails the hidden acceptance test, so it counts as a failure in the baseline. Local paths in the notes are replaced with `~` and `<fixture>`. Check the `mode` field of any baseline: a `fake` one comes from scripted lanes and proves only the harness, the scoring and the trap expectations. Requests per merged park are not compared between a fake and a live file.

## Refresh the baseline

1. Make a fixture outside any checkout you are working in: `omg factory bench init <dir>`.
2. Run it: `omg factory bench run <dir> --live --max-requests <n>` (or `--fake` for a free harness check). Do not run other tools inside `<dir>/repo` while it runs.
3. Check the new results against the old baseline: `omg factory bench compare benchmark/factory-bench/baseline.json <the results JSON the run printed> --fail-on-regression`.
4. Copy the results JSON over `baseline.json`. Replace your home directory with `~` and the fixture directory with `<fixture>` in its text, so the public repository holds no local paths. Change nothing else. Compare the original and the redacted file with `--fail-on-regression` (exit 0). Commit it with a note on the omg version and the mode.

The release compares the same issues only. If the baseline came from `--issues`, run the release bench with the same `--issues`.
