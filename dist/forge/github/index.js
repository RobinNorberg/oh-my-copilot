/**
 * The GitHub forge (factory forges design §2, PR 2): every gh call the ship,
 * factory and heal code make, built on the caller's already-guarded Exec.
 * The call sites use the per-file gh functions directly where they need
 * their exact legacy results; this object is the Forge interface over them.
 */
import { githubChecks } from './checks.js';
import { githubCi } from './ci.js';
import { githubMerge } from './merge.js';
import { githubReviews } from './reviews.js';
import { githubTracker } from './tracker.js';
export const createGitHubForge = (exec, cwd, config) => ({
    kind: 'github',
    provider: 'github',
    repo: config.repo,
    tracker: githubTracker(exec, cwd, config),
    reviews: githubReviews(exec, cwd),
    checks: githubChecks(exec, cwd),
    merge: githubMerge(),
    ci: githubCi(exec, cwd),
    capabilities: { heal: true, projectsV2: false, boardColumns: false, webhookIntake: true },
});
//# sourceMappingURL=index.js.map