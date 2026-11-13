# Factory bench baseline

`baseline.json` is the `omg factory bench` results file that `omg release <version> --bench <results.json>` compares against in its preflight phase. A regression refuses the release unless `--allow-bench-regression` is passed. Without `--bench`, the release makes no bench comparison and only says so.

Check the `mode` field of `baseline.json`. A `fake` baseline comes from scripted lanes and proves only the harness, the scoring and the trap expectations. Replace it with a `live` run when one is available. Requests per merged park are not compared between a fake and a live file.

## Refresh the baseline

1. Make a fixture outside any checkout you are working in: `omg factory bench init <dir>`.
2. Run it: `omg factory bench run <dir> --live --max-requests <n>` (or `--fake` for a free harness check). Do not run other tools inside `<dir>/repo` while it runs.
3. Check the new results against the old baseline: `omg factory bench compare benchmark/factory-bench/baseline.json <the results JSON the run printed> --fail-on-regression`.
4. Copy the results JSON over `baseline.json` and commit it with a note on the omg version and the mode.

The release compares the same issues only. If the baseline came from `--issues`, run the release bench with the same `--issues`.
