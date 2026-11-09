/**
 * A scripted GitHub for the Copilot coding agent (night 3 goal 6, lane L6b):
 * the status read (fixture GraphQL built from a small model), the assign
 * POST, the agent PR's close and link comment, all behind the exec seam of
 * the engine harness (fake-lanes.ts). The agent's commits are real commits
 * pushed to the harness's bare remote as `refs/pull/<n>/head`, so the
 * engine's fetch is real git. No network, no assignment, no credits.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODING_AGENT_COMMIT_LOGIN, CODING_AGENT_LOGIN } from '../../../forge/github/coding-agent.js';
import { gitIn, ISSUE } from './fake-lanes.js';
export const AGENT = Object.freeze({ __typename: 'Bot', login: CODING_AGENT_LOGIN });
export const HUMAN = Object.freeze({ __typename: 'User', login: 'robin' });
/** GitHub times are whole seconds. */
export const ghTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
export class FakeAgentGithub {
    now;
    repo;
    available = true;
    /** The issue timeline's agent assign events. */
    events = [];
    prs = [];
    /** GitHub cuts the issue timeline. */
    truncate = false;
    /** The assign POST: adds an Assigned event at `now()` (`assign`), returns 2xx without one (`silent`), or fails (`fail`). */
    onAssign = 'assign';
    assigns = [];
    closes = [];
    comments = [];
    reads = 0;
    constructor(now, repo = 'o/r') {
        this.now = now;
        this.repo = repo;
    }
    /** The answer to a coding agent gh call, or undefined for any other call. */
    handle(args) {
        const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
        if (args[0] === 'api' && args[1] === 'graphql' && args[5]?.startsWith('query=query($owner:String!,$name:String!,$number:Int!,$since:DateTime!)')) {
            this.reads += 1;
            return ok(this.status());
        }
        if (args[0] === 'api' && args[3] === '--method' && args[4] === 'POST' && /\/issues\/\d+\/assignees$/.test(args[5] ?? '')) {
            this.assigns.push([...args]);
            if (this.onAssign === 'fail')
                return { status: 1, stdout: '', stderr: 'HTTP 422: Validation Failed' };
            if (this.onAssign === 'assign')
                this.events.push({ type: 'assigned', at: this.now() });
            return ok('{}');
        }
        if (args[0] === 'pr' && args[1] === 'close') {
            this.closes.push([...args]);
            const pr = this.prs.find((p) => String(p.number) === args[2]);
            if (pr)
                pr.state = 'CLOSED';
            return ok('');
        }
        if (args[0] === 'pr' && args[1] === 'comment' && args[3] === '--repo') {
            // The guard runs the comment with its own copy of the body: read it while it exists.
            this.comments.push({ args: [...args], body: readFileSync(args[6], 'utf8') });
            return ok('');
        }
        return undefined;
    }
    prNode(p) {
        return {
            __typename: 'PullRequest', number: p.number, state: p.state, isDraft: true, isCrossRepository: false,
            baseRefName: p.base ?? 'dev', headRefName: `copilot/fix-${ISSUE}`, headRefOid: p.head, author: p.author ?? AGENT,
            baseRepository: { nameWithOwner: this.repo }, headRepository: { nameWithOwner: this.repo },
            commits: {
                pageInfo: { hasPreviousPage: false },
                nodes: p.commits.map((c) => ({
                    commit: {
                        oid: c.oid, committedDate: c.at,
                        author: { user: { login: c.byAgent === false ? HUMAN.login : CODING_AGENT_COMMIT_LOGIN } },
                        signature: { isValid: c.signed !== false, wasSignedByGitHub: c.signed !== false },
                    },
                })),
            },
            timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: p.reviewRequests.map((at) => ({ __typename: 'ReviewRequestedEvent', createdAt: at, actor: AGENT })) },
        };
    }
    /** The status read's JSON (CODING_AGENT_STATUS_QUERY's shape). */
    status() {
        const nodes = [
            ...this.events.map((e) => ({ __typename: e.type === 'assigned' ? 'AssignedEvent' : 'UnassignedEvent', createdAt: e.at, assignee: AGENT })),
            ...this.prs.map((p) => ({ __typename: 'ConnectedEvent', createdAt: p.linkedAt, actor: AGENT, subject: this.prNode(p) })),
        ].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        return JSON.stringify({
            data: {
                repository: {
                    nameWithOwner: this.repo,
                    suggestedActors: { pageInfo: { hasNextPage: false }, nodes: this.available ? [AGENT] : [] },
                    issue: { number: ISSUE, state: 'OPEN', timelineItems: { pageInfo: { hasPreviousPage: this.truncate }, nodes } },
                },
            },
        });
    }
}
/** Route the coding agent's gh calls of the harness to `fake`; everything else keeps the harness's scripted gh and real git. */
export function installFakeAgent(h, fake) {
    const inner = h.exec;
    h.exec = (cmd, args, opts) => (cmd === 'gh' ? fake.handle(args) : undefined) ?? inner(cmd, args, opts);
}
let clones = 0;
/**
 * A commit by "the agent" on top of the remote's dev (or `parent`), pushed to
 * the bare remote as refs/pull/<pr>/head; the main checkout does not have it
 * until the engine fetches. Returns its sha.
 */
export function agentCommit(h, pr, files, parent) {
    const dir = join(h.dir, `agent-${++clones}`);
    gitIn(h.dir, 'clone', '-q', h.bare, dir);
    if (parent) {
        gitIn(dir, 'fetch', '-q', 'origin', `refs/pull/${pr}/head`);
        gitIn(dir, 'checkout', '-q', parent);
    }
    else {
        gitIn(dir, 'checkout', '-q', 'origin/dev');
    }
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), content);
    }
    gitIn(dir, 'add', '-A');
    gitIn(dir, '-c', 'user.name=copilot-swe-agent[bot]', '-c', 'user.email=198982749+Copilot@users.noreply.github.com', 'commit', '-q', '-m', 'agent work');
    const sha = gitIn(dir, 'rev-parse', 'HEAD');
    gitIn(dir, 'push', '-q', 'origin', `+HEAD:refs/pull/${pr}/head`);
    return sha;
}
//# sourceMappingURL=fake-coding-agent.js.map