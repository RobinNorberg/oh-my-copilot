/**
 * Tier 2 `chain` scenario of `omg smoke copilot` (opt-in): a real two-link
 * factory chain on Copilot CLI, outside the SDK runtime.
 *
 * 1. The sandbox project gets the factory layout, `omg factory init`'s route
 *    table widened by `success:*` -> link-2 (skill {@link CHAIN_SKILL}) and
 *    `failed:*` -> stop, and a project skill that replies with one token.
 * 2. Link 1's ledger is pre-written exactly as the listener does it (host
 *    copilot, stage link-1, maxStageVisits 1), and link 1 is spawned like a
 *    factory link: the Copilot AFK profile, `--plugin-dir` for the plugin
 *    under test, the prompt on stdin, and OMC_CHAIN_LINK set by chainLinkEnv.
 * 3. From there the chain runs itself: link 1's SessionEnd resolves its ledger
 *    by OMC_CHAIN_LINK and enqueues; the detached worker spawns link 2 with
 *    its own OMC_CHAIN_LINK; link 2's SessionEnd hits the visit cap and stops
 *    the chain (`loop-capped:link-2`).
 * 4. The ledgers, decisions, stop marker, and both link sessions'
 *    events.jsonl are collected for evaluateScenario.
 *
 * Cost: one user prompt per link, so about 2 premium requests. The links run
 * on the CLI's default model without `--max-ai-credits` (a factory link's argv
 * carries no credit cap), so the run's --max-credits does not bound them.
 */
import { randomUUID } from 'crypto';
import { spawn as nodeSpawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { delimiter, dirname, join } from 'path';
import { buildHostBinarySpawn } from '../cli/tmux-utils.js';
import { runFactoryInit } from '../cli/commands/factory.js';
import { factoryStateDir, readProjectRoutes } from '../hooks/session-end/chain-enqueuer.js';
import { chainLinkEnv, COPILOT_AFK_SPAWN_FLAGS, copilotPluginDirArgs, writeChainLinkLedger } from '../hooks/session-end/spawn-next.js';
import { getOmcRoot } from '../lib/worktree-paths.js';
import { excerpt, parseJsonl } from './copilot-session-eval.js';
import { CHAIN_INTENT_ID, CHAIN_LINK1_STAGE, CHAIN_LINK2_STAGE, CHAIN_SKILL, SCENARIOS, } from './copilot-sdk-scenarios.js';
import { runAsync } from './process-utils.js';
export const CHAIN_ACK_TOKEN = 'CHAIN_ACK';
/** Factory layout + widened route table + the chain-ack project skill. Returns an error or null. */
export function prepareChainProject(projectDir) {
    try {
        mkdirSync(join(getOmcRoot(projectDir), 'state'), { recursive: true });
        mkdirSync(join(projectDir, 'docs', 'design'), { recursive: true });
    }
    catch (err) {
        return `factory layout: ${err.message}`;
    }
    const init = runFactoryInit({ cwd: projectDir, force: true });
    if (init.exitCode !== 0)
        return init.message;
    const routes = {
        ...(readProjectRoutes(projectDir) ?? {}),
        'success:*': { stage: CHAIN_LINK2_STAGE, skill: CHAIN_SKILL },
        'failed:*': { stage: 'halt', skill: 'stop' },
    };
    try {
        writeFileSync(join(getOmcRoot(projectDir), 'factory-routes.json'), `${JSON.stringify(routes, null, 2)}\n`);
        const skillDir = join(projectDir, '.github', 'skills', CHAIN_SKILL);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, 'SKILL.md'), [
            '---',
            `name: ${CHAIN_SKILL}`,
            'description: Acknowledge an oh-my-copilot factory chain smoke link. Use when invoked as /chain-ack.',
            '---',
            '',
            `Reply with exactly: ${CHAIN_ACK_TOKEN}. Do not use tools and do not open the handoff file.`,
            '',
        ].join('\n'));
    }
    catch (err) {
        return `route table / skill: ${err.message}`;
    }
    return null;
}
function pathKey(env) {
    return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}
/**
 * Env for link 1 (and, through the hook and worker allowlists, every later
 * link): the plugin under test as OMC_PLUGIN_ROOT, the copilot binary's dir
 * first on PATH (the worker spawns link 2 as plain `copilot`), and this link's
 * OMC_CHAIN_LINK via chainLinkEnv.
 */
export function chainLinkSmokeEnv(base, bin, root, linkId) {
    const key = pathKey(base);
    const withPath = { ...base, [key]: [dirname(bin), base[key]].filter(Boolean).join(delimiter), OMC_PLUGIN_ROOT: root };
    return chainLinkEnv(withPath, 'copilot', linkId);
}
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
/** Everything the chain left in `.omg/state/factory`, plus each closed link's session events. */
export function collectChainEvidence(projectDir, home, firstLink) {
    const factoryDir = factoryStateDir(projectDir);
    let entries = [];
    try {
        entries = readdirSync(factoryDir);
    }
    catch { /* chain never started */ }
    const ledgers = [];
    for (const entry of entries) {
        const match = /^chain-([0-9a-f-]{36})\.json$/i.exec(entry);
        if (!match)
            continue;
        const value = readJson(join(factoryDir, entry));
        if (value && typeof value === 'object' && !Array.isArray(value))
            ledgers.push({ ...value, file: match[1] });
    }
    // Spawn order: link 1 first, then by createdAt.
    ledgers.sort((a, b) => (a.file === firstLink ? -1 : b.file === firstLink ? 1 : String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))));
    let decisions = [];
    try {
        decisions = parseJsonl(readFileSync(join(factoryDir, 'chain-decisions.jsonl'), 'utf8')).events;
    }
    catch { /* no decisions */ }
    const stopped = readJson(join(factoryDir, `chain-${CHAIN_INTENT_ID}.stopped.json`));
    const sessions = ledgers
        .map((l) => l.hostSessionId)
        .filter((id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id))
        .map((hostSessionId) => {
        let events = null;
        try {
            events = parseJsonl(readFileSync(join(home, 'session-state', hostSessionId, 'events.jsonl'), 'utf8')).events;
        }
        catch { /* not persisted */ }
        return { hostSessionId, events };
    });
    return { firstLink, ledgers, decisions, stopped, sessions };
}
/** Ids of link ledgers no SessionEnd has closed yet. */
function openLinks(projectDir) {
    const factoryDir = factoryStateDir(projectDir);
    let entries = [];
    try {
        entries = readdirSync(factoryDir);
    }
    catch {
        return [];
    }
    return entries
        .map((e) => /^chain-([0-9a-f-]{36})\.json$/i.exec(e)?.[1])
        .filter((id) => !!id)
        .filter((id) => !readJson(join(factoryDir, `chain-${id}.json`))?.closedAt);
}
/**
 * The chain stopped: every ledger is closed (the enqueuer writes a stop marker
 * just before it closes the ending link's ledger, so the marker alone is not
 * enough) and no closed link still owes a next link, i.e. every `enqueued`
 * link has a child ledger. A link closed with a failure decision
 * (enqueued-failed, worker-spawn-failed, guardrail, ...) settles the chain.
 */
function chainSettled(projectDir, firstLink) {
    const factoryDir = factoryStateDir(projectDir);
    if (!existsSync(join(factoryDir, `chain-${firstLink}.json`)) || openLinks(projectDir).length > 0)
        return false;
    const ledgers = readdirSync(factoryDir)
        .filter((e) => /^chain-[0-9a-f-]{36}\.json$/i.test(e))
        .map((e) => ({ id: e.slice('chain-'.length, -'.json'.length), ledger: readJson(join(factoryDir, e)) }));
    return ledgers.every(({ id, ledger }) => ledger?.decision !== 'enqueued' || ledgers.some((l) => l.ledger?.parentLink === id));
}
/**
 * Timed out: close every open ledger (decision `smoke-timeout`) so a link
 * still running cannot enqueue another one when it ends (its SessionEnd then
 * records `already-closed`), and leave a stop marker for `omg factory status`.
 * A running link is not killed: it is a detached grandchild of the SessionEnd
 * worker with no pid on record.
 */
function stopTimedOutChain(projectDir, open) {
    const factoryDir = factoryStateDir(projectDir);
    const now = new Date().toISOString();
    for (const id of open) {
        const ledger = readJson(join(factoryDir, `chain-${id}.json`));
        if (!ledger || typeof ledger !== 'object')
            continue;
        try {
            writeFileSync(join(factoryDir, `chain-${id}.json`), JSON.stringify({ ...ledger, closedAt: now, decision: 'smoke-timeout' }, null, 2));
        }
        catch { /* best effort */ }
    }
    const marker = join(factoryDir, `chain-${CHAIN_INTENT_ID}.stopped.json`);
    if (existsSync(marker))
        return;
    try {
        writeFileSync(marker, JSON.stringify({ intentId: CHAIN_INTENT_ID, reason: 'smoke-timeout', stoppedAt: now }, null, 2));
    }
    catch { /* best effort */ }
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
export async function runChainScenario(input) {
    const base = {
        name: 'chain',
        timeoutMs: input.timeoutMs,
        model: 'link default (copilot -p, no --model)',
        maxCredits: input.maxCredits,
        budget: input.budget,
        capped: false,
        wedged: false,
    };
    const prepError = prepareChainProject(input.projectDir);
    if (prepError)
        return { ...base, events: [], idle: false, timedOut: false, error: `chain setup: ${prepError}` };
    const firstLink = (input.randomUUID ?? randomUUID)();
    writeChainLinkLedger(factoryStateDir(input.projectDir), firstLink, 'copilot', {
        intentId: CHAIN_INTENT_ID,
        stage: CHAIN_LINK1_STAGE,
        // Link 2 (stage link-2, visit 1) then hits the cap: exactly two links.
        maxStageVisits: 1,
    });
    const env = chainLinkSmokeEnv(input.env, input.bin, input.root, firstLink);
    // The factory link argv minus `-p <prompt>`: the prompt rides stdin, as
    // defaultSpawnFn sends it on win32 (copilot reads a piped prompt).
    const plan = buildHostBinarySpawn(input.bin, [...COPILOT_AFK_SPAWN_FLAGS, ...copilotPluginDirArgs(env, input.projectDir)]);
    const link1 = await runAsync(input.spawn ?? nodeSpawn, input.spawnSync, plan.command, plan.args, {
        cwd: input.projectDir,
        env,
        input: `${SCENARIOS.chain.prompt}\n`,
        timeoutMs: input.timeoutMs,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    // Link 2 is a detached grandchild of link 1's SessionEnd worker: wait on the ledgers.
    let timedOut = link1.timedOut;
    const deadline = Date.now() + input.timeoutMs;
    while (!timedOut && !chainSettled(input.projectDir, firstLink)) {
        if (Date.now() >= deadline) {
            timedOut = true;
            break;
        }
        await sleep(input.pollMs ?? 1_000);
    }
    const stillOpen = timedOut ? openLinks(input.projectDir) : [];
    if (timedOut)
        stopTimedOutChain(input.projectDir, stillOpen);
    const chain = collectChainEvidence(input.projectDir, input.home, firstLink);
    const events = chain.sessions.flatMap((s) => s.events ?? []);
    try {
        writeFileSync(input.eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
    }
    catch { /* best effort */ }
    const linkError = link1.error
        ?? (link1.code !== 0 && !link1.timedOut ? `link 1 exited ${String(link1.code)}: ${excerpt(link1.stderr, 200)}` : undefined)
        ?? (stillOpen.length ? `timed out with open link(s) ${stillOpen.join(', ')}; their ledgers were closed (smoke-timeout) so they cannot enqueue, but a running link was not killed` : undefined);
    return {
        ...base,
        events,
        idle: !timedOut && !linkError,
        timedOut,
        ...(linkError ? { error: linkError } : {}),
        chain,
    };
}
//# sourceMappingURL=copilot-chain-scenario.js.map