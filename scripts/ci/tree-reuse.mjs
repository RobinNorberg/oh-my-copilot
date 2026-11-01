#!/usr/bin/env node
/**
 * Tree-hash evidence lookup: has this exact git tree already passed a full
 * ci.yml run? Read-only (GITHUB_TOKEN with actions: read); nothing is posted.
 *
 * A CI run is evidence for tree T only when all of these hold:
 *   - it is a run of .github/workflows/ci.yml in this repository, on a commit
 *     whose tree is T and that is HEAD or a same-tree ancestor of HEAD;
 *   - its event is push, or pull_request from a branch of this repository
 *     (never a fork);
 *   - it is under MAX_AGE_DAYS old;
 *   - every job of its latest attempt concluded success (NOT_EVIDENCE_JOBS
 *     aside), so a run that itself reused evidence never counts;
 *   - its CI Gate job log carries `ci-evidence v1 tree=T`, the tree the run
 *     checked out (for a pull_request run, the merge commit's tree).
 * Any error or doubt means no reuse: the jobs run.
 *
 * ci.yml runs this file from a trusted tree (a PR's base commit, a pushed
 * dev/main commit, a tag on main), never from the tree under test, which it
 * names with --sha. A commit missing from the local clone (a PR's merge
 * commit) has its tree read from the API.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const WORKFLOW_PATH = '.github/workflows/ci.yml';
export const TRUSTED_EVENTS = ['push', 'pull_request'];
export const MAX_AGE_DAYS = 14;
/** Jobs whose result says nothing about the tree: advisory, tag-only, and this lookup. */
export const NOT_EVIDENCE_JOBS = ['No Committed Build Artifacts', 'Create GitHub Release', 'Tree evidence', 'Release tree evidence'];
/** A run missing any of these did not run the gate (the ruleset checks plus the aggregator). */
export const REQUIRED_JOBS = ['CI Gate', 'Lint & Type Check', 'Build', 'Test', 'Version Consistency Check'];
const MAX_COMMITS = 6;
const MAX_RUNS = 10;
const SHA = /^[0-9a-f]{40}$/;
const EVIDENCE_LINE = /^\d{4}-\d\d-\d\dT[\d:.]+Z ci-evidence v1 tree=(\S*)\r?$/gm;

/** GitHub REST client; `fetchImpl` is injectable for tests. */
export function createApi({ repo, token, fetchImpl = fetch, apiUrl = 'https://api.github.com' }) {
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' };
  return {
    async json(path) {
      const res = await fetchImpl(`${apiUrl}/repos/${repo}/${path}`, { headers });
      if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
      return res.json();
    },
    /** Job logs redirect to blob storage; follow by hand so the token never leaves api.github.com. */
    async jobLog(jobId) {
      const res = await fetchImpl(`${apiUrl}/repos/${repo}/actions/jobs/${jobId}/logs`, { headers, redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        const blob = await fetchImpl(location);
        if (!blob.ok) throw new Error(`job ${jobId} log: HTTP ${blob.status}`);
        return blob.text();
      }
      if (!res.ok) throw new Error(`job ${jobId} log: HTTP ${res.status}`);
      return res.text();
    },
  };
}

/** HEAD plus its ancestors with the same tree (merge commits whose content one parent already had). */
export async function sameTreeCommits(api, sha, tree) {
  const found = [];
  const queue = [sha];
  const seen = new Set();
  while (queue.length > 0 && found.length < MAX_COMMITS) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    const commit = await api.json(`commits/${next}`);
    if (commit?.sha !== next || commit?.commit?.tree?.sha !== tree) continue;
    found.push(next);
    for (const parent of commit.parents ?? []) if (SHA.test(parent?.sha ?? '')) queue.push(parent.sha);
  }
  return found;
}

/** Why `run` is not evidence for `tree` at `sha`, or null when it is. */
export async function rejectRun(api, run, { repo, sha, tree, now, currentRunId }) {
  if (String(run.id) === String(currentRunId)) return 'this run';
  if (run.path !== WORKFLOW_PATH) return `workflow ${run.path}`;
  if (run.head_sha !== sha) return `head ${run.head_sha}`;
  if (!TRUSTED_EVENTS.includes(run.event)) return `event ${run.event}`;
  if (run.repository?.full_name !== repo || run.head_repository?.full_name !== repo) return `head repository ${run.head_repository?.full_name}`;
  const age = now - Date.parse(run.created_at);
  if (!(age >= 0 && age <= MAX_AGE_DAYS * 86_400_000)) return `created ${run.created_at}`;
  const jobs = (await api.json(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs ?? [];
  const missing = REQUIRED_JOBS.filter((name) => !jobs.some((j) => j.name === name));
  if (missing.length > 0) return `no job ${missing.join(', ')}`;
  const notGreen = jobs.filter((j) => !NOT_EVIDENCE_JOBS.includes(j.name) && j.conclusion !== 'success');
  if (notGreen.length > 0) return `${notGreen.map((j) => `${j.name}: ${j.conclusion ?? j.status}`).join(', ')}`;
  const gate = jobs.filter((j) => j.name === 'CI Gate');
  if (gate.length !== 1) return `${gate.length} CI Gate jobs`;
  const trees = [...(await api.jobLog(gate[0].id)).matchAll(EVIDENCE_LINE)].map((m) => m[1]);
  if (trees.length !== 1 || trees[0] !== tree) return `CI Gate recorded tree ${trees.join(', ') || 'none'}`;
  return null;
}

/** First run that proves `tree`, as { reused, runUrl, sha, considered[] }. */
export async function findEvidence(api, { repo, sha, tree, now = Date.now(), currentRunId = '' }) {
  const considered = [];
  let examined = 0;
  for (const candidate of await sameTreeCommits(api, sha, tree)) {
    const runs = (await api.json(`actions/workflows/ci.yml/runs?head_sha=${candidate}&per_page=20`)).workflow_runs ?? [];
    for (const run of [...runs].sort((a, b) => b.id - a.id)) {
      if (examined >= MAX_RUNS) return { reused: false, considered };
      if (String(run.id) !== String(currentRunId)) examined += 1;
      const reason = await rejectRun(api, run, { repo, sha: candidate, tree, now, currentRunId });
      if (reason === null) return { reused: true, runUrl: run.html_url, sha: candidate, considered };
      considered.push(`${run.html_url ?? run.id} (${candidate.slice(0, 12)}): ${reason}`);
    }
  }
  return { reused: false, considered };
}

function out(file, lines) {
  if (file) appendFileSync(file, `${lines.join('\n')}\n`);
}

export async function cliMain({ env = process.env, argv = process.argv.slice(2), fetchImpl = fetch, log = console.log } = {}) {
  const shaArg = argv[0] === '--sha' ? argv[1] : undefined;
  let tree = '';
  let result = { reused: false, considered: [] };
  let note = '';
  try {
    const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const sha = shaArg ?? git(['rev-parse', 'HEAD']);
    if (!SHA.test(sha)) throw new Error(`bad commit ${sha}`);
    const repo = env.GITHUB_REPOSITORY;
    const api = createApi({ repo, token: env.GITHUB_TOKEN, fetchImpl, apiUrl: env.GITHUB_API_URL });
    let tested;
    try {
      tested = git(['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]);
    } catch {
      const commit = await api.json(`commits/${sha}`);
      tested = commit?.sha === sha ? commit?.commit?.tree?.sha : undefined;
    }
    if (!SHA.test(tested ?? '')) throw new Error(`bad tree ${tested}`);
    tree = tested;
    log(`tested tree ${tree} (commit ${sha})`);
    if (env.CI_EVIDENCE_REUSE === 'false') {
      note = 'reuse disabled (CI_EVIDENCE_REUSE=false)';
    } else {
      result = await findEvidence(api, { repo, sha, tree, currentRunId: env.GITHUB_RUN_ID });
    }
  } catch (error) {
    note = `lookup failed, running the jobs: ${error instanceof Error ? error.message : String(error)}`;
    result = { reused: false, considered: result.considered };
  }
  for (const line of result.considered) log(`  not evidence: ${line}`);
  if (result.reused) {
    log(`::notice title=Tree evidence::tests reused from run ${result.runUrl}: it passed tree ${tree} on ${result.sha}`);
    out(env.GITHUB_STEP_SUMMARY, [`### Tree evidence`, ``, `Tree \`${tree}\` already passed every job in ${result.runUrl} (commit \`${result.sha}\`). The jobs it proves are skipped.`]);
  } else {
    log(`no evidence for tree ${tree || '(unknown)'}${note ? `: ${note}` : ''}; the jobs run`);
    out(env.GITHUB_STEP_SUMMARY, [`### Tree evidence`, ``, `No reusable run for tree \`${tree || 'unknown'}\`${note ? ` (${note})` : ''}. The jobs run.`]);
  }
  out(env.GITHUB_OUTPUT, [`tree=${tree}`, `reused=${result.reused}`, `run_url=${result.reused ? result.runUrl : ''}`]);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cliMain();
}
