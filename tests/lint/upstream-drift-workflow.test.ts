/**
 * Pins .github/workflows/upstream-drift.yml (docs/DEVELOPERS.md, "Upstream
 * drift bot"): schedule + manual triggers only, minimal permissions, the
 * optional UPSTREAM_DRIFT_TOKEN with a GITHUB_TOKEN fallback and caveat, one
 * bot item per upstream head, draft PRs to dev, and never a force-push.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs script without type declarations
import { renderMarkdown } from "../../scripts/port/upstream-drift.mjs";

const REPO_ROOT = join(import.meta.dirname, "../..");
const wf = readFileSync(join(REPO_ROOT, ".github/workflows/upstream-drift.yml"), "utf8");
const TOKEN_EXPR = "${{ secrets.UPSTREAM_DRIFT_TOKEN || github.token }}";

interface Step { raw: string; name: string; id?: string; if?: string; run: string }

const jobStart = wf.indexOf("\n  drift:\n");
const job = wf.slice(jobStart + 1);
const steps: Step[] = (() => {
  const starts = [...job.matchAll(/^ {6}- (?=name:|uses:)/gm)].map((m) => m.index!);
  return starts.map((start, i) => {
    const raw = job.slice(start, starts[i + 1]);
    const field = (key: string) => raw.match(new RegExp(`^(?: {6}- | {8})${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    const block = raw.match(/^ {8}run:\s*\|\s*\n((?: {10}.*\n?| *\n)*)/m)?.[1];
    const run = block?.replace(/^ {10}/gm, "").trim() || field("run") || "";
    return { raw, name: field("name") ?? field("uses") ?? "", id: field("id"), if: field("if"), run };
  });
})();
const step = (name: string): Step => {
  const found = steps.find((s) => s.name === name);
  expect(found, `drift job must have the step "${name}"`).toBeTruthy();
  return found!;
};
const DRIFT = "steps.check.outputs.drift == 'true'";
const APPLIED = "steps.apply.outcome == 'success'";

describe("upstream drift workflow", () => {
  it("runs daily and on demand, never on pushes or PRs, one run at a time", () => {
    expect(wf).toMatch(/^on:\n {2}schedule:\n {4}- cron: '[0-9]+ [0-9]+ \* \* \*'\n {2}workflow_dispatch:\n\n/m);
    expect(wf).not.toMatch(/^ {2}(push|pull_request|pull_request_target):/m);
    expect(wf).toMatch(/^concurrency:\n {2}group: upstream-drift\n {2}cancel-in-progress: false$/m);
  });

  it("keeps every run script in a block scalar (an inline `: ` breaks the YAML)", () => {
    expect(job).not.toMatch(/^ {8}run: (?![|>])/m);
  });

  it("asks only for contents, pull-requests and issues write", () => {
    expect(wf).toMatch(/^permissions:\n {2}contents: write\n {2}pull-requests: write\n {2}issues: write\n\n/m);
    expect(wf.match(/permissions:/g)).toHaveLength(1);
  });

  it("uses UPSTREAM_DRIFT_TOKEN when set, falls back to GITHUB_TOKEN, and prints the CI caveat", () => {
    expect(job).toContain(`      GH_TOKEN: ${TOKEN_EXPR}\n`);
    expect(job).toContain("      HAS_DRIFT_TOKEN: ${{ secrets.UPSTREAM_DRIFT_TOKEN != '' }}\n");
    const checkout = step("actions/checkout@v4");
    expect(checkout.raw).toContain(`token: ${TOKEN_EXPR}`);
    expect(checkout.raw).toContain("ref: dev");
    expect(checkout.raw).toContain("fetch-depth: 0");
    expect(wf.split("secrets.").length - 1, "secrets appear only in the token lines").toBe(3);
    expect(wf).not.toMatch(/if:[^\n]*secrets\./);
    const caveat = step("Report the token source");
    expect(caveat.run).toContain("::warning title=Upstream drift::UPSTREAM_DRIFT_TOKEN is not set; using GITHUB_TOKEN, so CI does not run on bot PRs");
    expect(step("Apply the upstream range").run).toContain('if [ "$HAS_DRIFT_TOKEN" != "true" ]; then');
  });

  it("checks upstream dev with the script and gates everything after it on new commits", () => {
    expect(step("Fetch upstream dev").run).toContain("git fetch --no-tags upstream dev");
    expect(job).toContain("UPSTREAM_URL: https://github.com/Yeachan-Heo/oh-my-claudecode.git");
    const check = step("Check for new upstream commits");
    expect(check.id).toBe("check");
    expect(check.run).toContain('node scripts/port/upstream-drift.mjs --check --json > "$RUNNER_TEMP/check.json"');
    expect(check.run).toMatch(/0\) drift=false ;;\n\s*1\) drift=true ;;\n\s*\*\) exit "\$status" ;;/);
    expect(step("Find bot items for this upstream head").if).toBe(DRIFT);
    expect(step("Apply the upstream range").if).toBe(`${DRIFT} && steps.existing.outputs.skip != 'true'`);
  });

  it("applies on a fresh port/bot-<sha> branch from dev and reports with the same range", () => {
    const apply = step("Apply the upstream range");
    expect(apply.raw).toContain("BRANCH: port/bot-${{ steps.check.outputs.short }}");
    expect(apply.run).toContain('git switch -c "$BRANCH"');
    expect(apply.run).toContain('node scripts/port/upstream-drift.mjs --apply --base "$BASE_SHA" --head "$HEAD_SHA"');
    expect(apply.run).toContain('--report --base "$BASE_SHA" --head "$HEAD_SHA" > "$RUNNER_TEMP/report.json"');
    expect(apply.run).toContain('--report --base "$BASE_SHA" --head "$HEAD_SHA" --markdown > "$RUNNER_TEMP/body.md"');
  });

  it("opens a draft PR to dev only when clean, an issue only when conflicted, both labelled", () => {
    expect(job).toContain("      LABEL: upstream-port\n");
    const pr = step("Open the draft port PR");
    expect(pr.if).toBe(`${APPLIED} && steps.apply.outputs.clean == 'true'`);
    expect(pr.run).toContain("title=$(jq -r .titles.pr \"$RUNNER_TEMP/report.json\")");
    expect(pr.run).toContain('git commit -q -m "$title"');
    expect(pr.run).toContain('gh pr create --draft --base dev --head "$BRANCH" --title "$title" --body-file "$RUNNER_TEMP/body.md" --label "$LABEL"');
    const issue = step("Open or update the conflict issue");
    expect(issue.if).toBe(`${APPLIED} && steps.apply.outputs.clean == 'false'`);
    expect(issue.run).toContain("title=$(jq -r .titles.issue \"$RUNNER_TEMP/report.json\")");
    expect(issue.run).toContain('gh issue edit "$ISSUE" --title "$title" --body-file "$RUNNER_TEMP/body.md"');
    expect(issue.run).toContain('gh issue create --title "$title" --body-file "$RUNNER_TEMP/body.md" --label "$LABEL"');
  });

  it("never force-pushes; an existing branch is reused for the PR without a push", () => {
    const pushes = job.split("\n").filter((l) => /git push/.test(l)).map((l) => l.trim());
    expect(pushes).toEqual(['git push -u origin "$BRANCH"']);
    expect(wf).not.toMatch(/--force|push -f|\+refs\/|--force-with-lease/);
    const pr = step("Open the draft port PR");
    expect(pr.run).toMatch(/if git ls-remote --exit-code --heads origin "\$BRANCH" > \/dev\/null; then\n[\s\S]*?\n\s*else\n\s*git push -u origin "\$BRANCH"\n\s*fi\n\s*url=\$\(gh pr create/);
  });

  it("says which commit a reused branch carries, since the body comes from this run's apply", () => {
    const pr = step("Open the draft port PR");
    const reuse = pr.run.slice(pr.run.indexOf("if git ls-remote"), pr.run.indexOf("git push -u origin"));
    expect(reuse).toContain('git fetch --no-tags origin "$BRANCH"');
    expect(reuse).toContain("pushed=$(git rev-parse FETCH_HEAD)");
    expect(reuse).toContain("if git diff --quiet HEAD FETCH_HEAD; then");
    expect(reuse).toContain(`printf '\\n> This PR reuses branch \`%s\` from an earlier run. It contains commit \`%s\`: %s\\n' "$BRANCH" "$pushed" "$note" >> "$RUNNER_TEMP/body.md"`);
    expect(pr.run.indexOf("This PR reuses branch")).toBeLessThan(pr.run.indexOf("gh pr create"));
  });

  it("blocks a head whose PR a maintainer closed, but not one the bot closed as superseded", () => {
    expect(job).toContain("      SUPERSEDED: 'upstream-drift: superseded by '\n");
    const existing = step("Find bot items for this upstream head");
    expect(existing.run).toContain('gh pr list --label "$LABEL" --state all --limit 100 --json number,state,body,comments');
    expect(existing.run).toContain('select(.state != "CLOSED" and (.body | contains($m)))');
    expect(existing.run).toContain('select(.state == "CLOSED" and (.body | contains($m)) and (any(.comments[]; .body | startswith($s)) | not))');
    expect(existing.run).toMatch(/elif \[ -n "\$closed_pr" \]; then\n\s*echo "::notice[^\n]*closed by a maintainer[^\n]*"\n\s*skip=true/);
    const close = step("Close superseded bot items");
    expect(close.run).toContain('comment="${SUPERSEDED}${by} ($RUN_URL)."');
    expect(close.run).toContain('gh pr close "$n" --comment "$comment"');
    expect(close.run).toContain('gh issue close "$n" --comment "$comment"');
    expect(close.run.match(/--comment/g)).toHaveLength(2);
  });

  it("keeps PRs someone pushed to and items labelled keep, and closes all once dev caught up", () => {
    expect(job).toContain("      KEEP_LABEL: keep\n");
    const close = step("Close superseded bot items");
    expect(close.run).toContain(`if [ "$(gh pr view "$n" --json commits --jq '.commits | length')" != "1" ]; then`);
    expect(close.run).toContain('if [ "$DRIFT" != "true" ]; then marker="${HEAD_MARKER_PREFIX}none -->";');
    expect(close.run).toContain("and (any(.labels[]; .name == $k) | not)");
    expect(close.run).toContain('gh pr list --label "$LABEL" --state open --limit 100 --json number,body,labels | jq -r --arg p "$HEAD_MARKER_PREFIX" --arg m "$marker" --arg k "$KEEP_LABEL" "$stale"');
    expect(close.run).toContain('gh issue list --label "$LABEL" --state open --limit 100 --json number,body,labels | jq -r --arg p "$HEAD_MARKER_PREFIX" --arg m "$marker" --arg k "$KEEP_LABEL" "$stale"');
  });

  it("dedupes by the head marker the script writes, and closes only older bot items after success", () => {
    const prefix = job.match(/HEAD_MARKER_PREFIX: '([^']+)'/)?.[1];
    const head = "a".repeat(40);
    const body: string = renderMarkdown({
      base: "b".repeat(40), head, upstream_ref: "upstream/dev", commits: [], files: [], conflicts: [], clean: true, leaks: [], package_json_delta: "",
    });
    expect(body.startsWith(`${prefix}${head} -->\n`)).toBe(true);
    const existing = step("Find bot items for this upstream head");
    expect(existing.run).toContain('marker="${HEAD_MARKER_PREFIX}${HEAD_SHA} -->"');
    expect(existing.run).toContain('gh pr list --label "$LABEL" --state all');
    const close = step("Close superseded bot items");
    expect(close.if).toBe("steps.check.outcome == 'success'");
    expect(close.run).toContain("select((.body | contains($p)) and ((.body | contains($m)) | not) and ");
    expect(close.raw).not.toMatch(/always\(\)/);
    const order = ["check", "Find bot items for this upstream head", "Apply the upstream range", "Open the draft port PR", "Open or update the conflict issue", "Close superseded bot items"]
      .map((n) => steps.findIndex((s) => s.name === n || s.id === n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
