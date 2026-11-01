/**
 * Factory listener daemon (spec: OMC 软件工厂闭环, tracker issue #9).
 *
 * Resident intake daemon: transport adapters (smee/cloudflared/direct) live
 * outside the OMC boundary — the daemon only receives already-unpacked
 * webhook events as POSTs. It verifies the HMAC signature, enforces the repo
 * whitelist, applies the intake label gate (tracker issues) and routes through
 * the shared routing pure function (T1 seam). Check-suite webhooks are audited
 * and discarded; red CI reaches the heal queue through workflow_run. v1
 * processes events serially.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { createServer } from 'http';
import { appendFileSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { decideNextStage } from '../hooks/session-end/routing.js';
import { acquireChainSlot, releaseChainSlot } from '../hooks/session-end/guardrails.js';
import { AFK_INCLUDE_USER_SETTINGS_ENV, chainLinkHost, copilotPluginDirArgs, defaultSpawnFn, factoryLinkArgv, factoryLinkCommand, writeChainLinkLedger } from '../hooks/session-end/spawn-next.js';
import { resolveSkillSlash } from '../utils/skill-registry.js';
import { skillSlash } from '../utils/skill-slash.js';
import { DEFAULT_STALL_THRESHOLD_MS, detectStalledLinks, flagStall } from './watchdog.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { withFileLockSync } from '../lib/file-lock.js';
import { enqueueWebhookRun, healStateDir } from './heal/state.js';
export const INTAKE_LABEL = 'intake';
/** Tracker intake is harbor's job (verify, desk, signed dispositions); intent needs a live contributor. */
export const INTAKE_ROUTE_TABLE = { 'success:intake': { stage: 'harbor', skill: 'harbor' } };
/** Why a failed check suite starts nothing: heal owns CI via workflow_run. */
const CI_FAILURE_DISCARD_REASON = 'CI failures are healed from workflow_run';
/** The workflow whose red dev push runs may heal (fixed, like the poller's). */
export const HEAL_WORKFLOW_PATH = '.github/workflows/ci.yml';
export const DEFAULT_HEAL_BRANCH = 'dev';
/**
 * Pure heal intake decision for a `workflow_run` webhook (design §2): a
 * completed, failed push run of ci.yml on the heal branch. Only the run id is
 * taken from the payload; the scan re-reads everything else through gh.
 */
export function routeWorkflowRun(event, whitelist, healBranch = DEFAULT_HEAL_BRANCH) {
    const repo = event.repository?.full_name;
    if (!repo || !whitelist.includes(repo)) {
        return { kind: 'rejected', status: 403, reason: `repository outside whitelist: ${repo ?? '(missing)'}` };
    }
    const run = event.workflow_run ?? {};
    if (event.action !== 'completed')
        return { kind: 'discarded', reason: `workflow_run action ${String(event.action ?? '?').slice(0, 40)}` };
    if (run.conclusion !== 'failure')
        return { kind: 'discarded', reason: `workflow_run conclusion ${String(run.conclusion ?? '?').slice(0, 40)}` };
    if (run.event !== 'push')
        return { kind: 'discarded', reason: 'workflow_run is not a push run' };
    if (run.head_branch !== healBranch)
        return { kind: 'discarded', reason: `workflow_run is not on ${healBranch}` };
    if (run.path !== HEAL_WORKFLOW_PATH)
        return { kind: 'discarded', reason: `workflow_run is not ${HEAL_WORKFLOW_PATH}` };
    const runId = typeof run.id === 'number' && Number.isSafeInteger(run.id) && run.id > 0 ? String(run.id) : null;
    if (!runId)
        return { kind: 'rejected', status: 422, reason: 'invalid workflow_run id' };
    return { kind: 'enqueue', runId };
}
export function verifySignature(secret, rawBody, signatureHeader) {
    if (!signatureHeader?.startsWith('sha256='))
        return false;
    const provided = signatureHeader.slice('sha256='.length);
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    if (provided.length !== expected.length)
        return false;
    return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
}
/** Pure intake decision: whitelist -> label gate -> shared routing seam. */
export function routeTrackerEvent(event, whitelist, table = INTAKE_ROUTE_TABLE) {
    const repo = event.repository?.full_name;
    if (!repo || !whitelist.includes(repo)) {
        return { kind: 'rejected', status: 403, reason: `repository outside whitelist: ${repo ?? '(missing)'}` };
    }
    const labels = new Set();
    if (event.label?.name)
        labels.add(event.label.name);
    for (const l of event.issue?.labels ?? [])
        if (l.name)
            labels.add(l.name);
    const labeled = (event.action === 'labeled' || event.action === 'opened') && labels.has(INTAKE_LABEL);
    if (!labeled)
        return { kind: 'discarded', reason: `no ${INTAKE_LABEL} label (action: ${event.action ?? '?'})` };
    const issueNumber = event.issue?.number;
    if (issueNumber !== undefined && !(typeof issueNumber === 'number' && Number.isSafeInteger(issueNumber) && issueNumber > 0)) {
        return { kind: 'discarded', reason: INVALID_ISSUE_NUMBER };
    }
    const directive = decideNextStage('success', 'intake', table);
    if (!directive)
        return { kind: 'discarded', reason: 'route table has no intake directive' };
    return { kind: 'routed', directive, issueNumber: issueNumber, issueUrl: event.issue?.html_url };
}
/** Harbor's own single-ship form under the slash the link's host registers; harbor writes the tracker in English. */
export function buildHarborPrompt(directive, issueNumber, issueUrl, slash = skillSlash(directive.skill)) {
    const target = issueNumber !== undefined ? `#${issueNumber}` : issueUrl ?? '#?';
    return `${slash} look at ${target}`;
}
const INVALID_ISSUE_NUMBER = 'invalid issue number';
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/;
function issueUrlMatchesRepo(issueUrl, repo) {
    if (!issueUrl)
        return true;
    if (!ISSUE_URL_PATTERN.test(issueUrl))
        return false;
    return issueUrl.startsWith(`https://github.com/${repo}/issues/`);
}
function defaultAudit(cwd) {
    const dir = join(getOmcRoot(cwd), 'state');
    return (record) => {
        try {
            mkdirSync(dir, { recursive: true });
            appendFileSync(join(dir, 'factory-listener-audit.jsonl'), `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`, 'utf8');
        }
        catch {
            // best-effort audit trail
        }
    };
}
/**
 * One-shot stall check for a spawned link: after the stall threshold, if the
 * pre-written ledger still has no routeTable and no 'enqueued' decision, the
 * link never made it to a SessionEnd handoff — flag it. Best-effort: watchdog
 * failures must never break the listener. Test seam via deps.scheduleStallCheck.
 */
function scheduleStallCheck(cwd, session, deps) {
    if (deps.scheduleStallCheck) {
        deps.scheduleStallCheck(session);
        return;
    }
    const timer = setTimeout(() => {
        try {
            const factoryDir = join(getOmcRoot(cwd), 'state', 'factory');
            const stall = detectStalledLinks(factoryDir).find((s) => s.session === session);
            if (stall)
                flagStall(stall, { cwd });
        }
        catch {
            // watchdog is best-effort
        }
    }, DEFAULT_STALL_THRESHOLD_MS);
    timer.unref();
}
function spawnChainLink(req) {
    const slot = acquireChainSlot(req.intentId, join(getOmcRoot(req.config.cwd), 'state', 'factory'));
    if (!slot.allowed) {
        req.audit({ kind: 'discarded', reason: `guardrail: ${slot.reason}`, detail: slot.detail, intentId: req.intentId });
        return { status: 204, kind: 'discarded', detail: `guardrail ${slot.reason}: ${slot.detail}` };
    }
    const nextSessionId = randomUUID();
    const includeUserSettings = process.env[AFK_INCLUDE_USER_SETTINGS_ENV] === '1';
    const args = factoryLinkArgv(req.prompt, nextSessionId, [], [], includeUserSettings, req.config.cwd);
    const command = factoryLinkCommand();
    // chainLink: a Copilot link cannot take --session-id, so it gets the link id as OMC_CHAIN_LINK.
    const spawnCtx = { cwd: req.config.cwd, chainLink: nextSessionId };
    try {
        // Pre-write the first chain ledger so the spawned session's SessionEnd
        // finds it (route table falls back to the project's factory-routes.json).
        // Best-effort: a ledger write failure must not block spawning the link.
        try {
            writeChainLinkLedger(join(getOmcRoot(req.config.cwd), 'state', 'factory'), nextSessionId, chainLinkHost(command), {
                intentId: req.intentId,
                stage: req.directive.stage,
                includeUserSettings,
                ...(req.tracker ? { tracker: req.tracker } : {}),
            });
        }
        catch (error) {
            req.audit({ kind: 'discarded', reason: 'ledger write failed', detail: error instanceof Error ? error.message : String(error), session: nextSessionId });
        }
        if (req.deps.spawner)
            req.deps.spawner(command, args, spawnCtx);
        else
            defaultSpawnFn(command, args, spawnCtx);
        scheduleStallCheck(req.config.cwd, nextSessionId, req.deps);
    }
    finally {
        releaseChainSlot(slot);
    }
    req.audit({ kind: 'routed', stage: req.directive.stage, skill: req.directive.skill, ...req.routedAuditFields, session: nextSessionId });
    return { status: 202, kind: 'accepted', detail: `spawned ${req.directive.stage} session (${req.directive.skill})` };
}
/** Orchestrates one tracker event: audit rejections, discard noise, spawn routed sessions. */
export function processEvent(event, config, deps = {}) {
    const audit = deps.audit ?? defaultAudit(config.cwd);
    const outcome = routeTrackerEvent(event, config.whitelist);
    if (outcome.kind === 'rejected') {
        audit({ kind: 'rejected', status: outcome.status, reason: outcome.reason });
        return { status: outcome.status, kind: 'rejected', detail: outcome.reason };
    }
    if (outcome.kind === 'discarded') {
        if (outcome.reason === INVALID_ISSUE_NUMBER)
            audit({ kind: 'discarded', reason: outcome.reason });
        return { status: 204, kind: 'discarded', detail: outcome.reason };
    }
    const repo = event.repository?.full_name ?? '';
    if (!issueUrlMatchesRepo(outcome.issueUrl, repo)) {
        audit({ kind: 'discarded', reason: 'issue url outside whitelisted repo', url: outcome.issueUrl });
        return { status: 204, kind: 'discarded', detail: 'issue url outside whitelisted repo' };
    }
    const intentId = `${repo}#${outcome.issueNumber ?? 0}`.replace(/[^\w.-]/g, '-');
    let slash;
    try {
        slash = resolveSkillSlash(outcome.directive.skill, {
            cwd: config.cwd,
            probeArgs: copilotPluginDirArgs(process.env, config.cwd),
            unattended: true,
        });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        audit({ kind: 'discarded', reason, intentId });
        return { status: 204, kind: 'discarded', detail: reason };
    }
    return spawnChainLink({
        intentId,
        directive: outcome.directive,
        prompt: buildHarborPrompt(outcome.directive, outcome.issueNumber, outcome.issueUrl, slash),
        // No labels: harbor owns the issue's labels. The pointer lets the watchdog flag a stall.
        tracker: outcome.issueNumber !== undefined ? { repo, issue: outcome.issueNumber } : undefined,
        routedAuditFields: { issue: outcome.issueUrl ?? outcome.issueNumber },
        config,
        deps,
        audit,
    });
}
/**
 * One CI check-suite event. It never spawns a session: a failure is an
 * audited discard, because heal owns CI through workflow_run (the retired
 * route spawned a billed session for a `diagnose` skill that does not exist).
 */
export function processCheckFailureEvent(event, config, deps = {}) {
    const audit = deps.audit ?? defaultAudit(config.cwd);
    const repo = event.repository?.full_name;
    if (!repo || !config.whitelist.includes(repo)) {
        const reason = `repository outside whitelist: ${repo ?? '(missing)'}`;
        audit({ kind: 'rejected', status: 403, reason });
        return { status: 403, kind: 'rejected', detail: reason };
    }
    if (event.action !== 'completed' || event.check_suite?.conclusion !== 'failure') {
        return { status: 204, kind: 'discarded', detail: `not a failed check run (action: ${event.action ?? '?'}, conclusion: ${event.check_suite?.conclusion ?? '?'})` };
    }
    audit({ kind: 'discarded', reason: CI_FAILURE_DISCARD_REASON, repo });
    return { status: 204, kind: 'discarded', detail: CI_FAILURE_DISCARD_REASON };
}
function defaultEnqueueHeal(cwd, runId) {
    return withFileLockSync(join(healStateDir(cwd), 'scan.lock'), () => enqueueWebhookRun(cwd, runId, new Date()), { timeoutMs: 5_000 });
}
/**
 * One `workflow_run` event: enqueue the run id for the heal scan, nothing
 * else. It never spawns a session or a lane; the poller stays the source of
 * truth and decides with what it re-reads through gh.
 */
export function processWorkflowRunEvent(event, config, deps = {}) {
    const audit = deps.audit ?? defaultAudit(config.cwd);
    const outcome = routeWorkflowRun(event, config.whitelist, config.healBranch);
    if (outcome.kind === 'rejected') {
        audit({ kind: 'rejected', status: outcome.status, reason: outcome.reason });
        return { status: outcome.status, kind: 'rejected', detail: outcome.reason };
    }
    if (outcome.kind === 'discarded')
        return { status: 204, kind: 'discarded', detail: outcome.reason };
    let added;
    try {
        added = (deps.enqueueHeal ?? defaultEnqueueHeal)(config.cwd, outcome.runId);
    }
    catch (error) {
        audit({ kind: 'discarded', reason: 'heal enqueue failed', detail: error instanceof Error ? error.message : String(error), runId: outcome.runId });
        return { status: 503, kind: 'discarded', detail: 'heal queue busy; the next scan polls the run anyway' };
    }
    audit({ kind: 'routed', stage: 'heal-queue', runId: outcome.runId, added });
    return { status: 202, kind: 'accepted', detail: added ? `enqueued run ${outcome.runId} for the next heal scan` : `run ${outcome.runId} already queued` };
}
function pidFilePath(cwd) {
    return join(getOmcRoot(cwd), 'state', 'factory-listener.json');
}
export function startListener(config, deps = {}) {
    if (!config.secret?.trim()) {
        throw new Error('HMAC secret is required and cannot be empty');
    }
    const startedAt = new Date().toISOString();
    const host = config.host || '127.0.0.1';
    let tail = Promise.resolve();
    const server = createServer((req, res) => {
        // Serial v1: each request is fully handled (body drained -> verify ->
        // spawn) before the next one starts.
        tail = tail
            .then(() => handleRequest(req, res, config, deps, startedAt))
            .catch(() => {
            try {
                res.writeHead(500).end();
            }
            catch { /* response already sent */ }
        });
    });
    return new Promise((resolve) => {
        server.listen(config.port, host, () => {
            mkdirSync(join(pidFilePath(config.cwd), '..'), { recursive: true });
            const addr = server.address();
            const portForLog = addr && typeof addr !== 'string' ? addr.port : config.port;
            const hostForLog = addr && typeof addr !== 'string' ? addr.address : host;
            writeFileSync(pidFilePath(config.cwd), JSON.stringify({ pid: process.pid, port: portForLog, host: hostForLog, startedAt }, null, 2));
            resolve(server);
        });
    });
}
export function stopListener(server, cwd) {
    try {
        unlinkSync(pidFilePath(cwd));
    }
    catch {
        // already gone
    }
    server.close();
}
export const MAX_BODY_BYTES = 1024 * 1024;
async function handleRequest(req, res, config, deps, startedAt) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'payload too large' }));
            req.destroy();
            return;
        }
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pid: process.pid, port: config.port, startedAt }));
        return;
    }
    if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
    }
    const sig = req.headers['x-hub-signature-256'];
    if (!verifySignature(config.secret, raw, Array.isArray(sig) ? sig[0] : sig)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid signature' }));
        return;
    }
    let event;
    try {
        event = JSON.parse(raw);
    }
    catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
    }
    // A body carrying workflow_run feeds the heal queue; one carrying
    // check_suite is a CI check-run webhook; everything else is tracker issue intake.
    const result = hasWorkflowRun(event)
        ? processWorkflowRunEvent(event, config, deps)
        : hasCheckSuite(event)
            ? processCheckFailureEvent(event, config, deps)
            : processEvent(event, config, deps);
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
}
function hasWorkflowRun(event) {
    return event.workflow_run !== undefined;
}
function hasCheckSuite(event) {
    return event.check_suite !== undefined;
}
//# sourceMappingURL=listener.js.map