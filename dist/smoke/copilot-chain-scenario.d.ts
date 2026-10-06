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
import { type ChainEvidence, type ScenarioRun } from './copilot-sdk-scenarios.js';
import { type SpawnFn, type SpawnSyncFn } from './process-utils.js';
export declare const CHAIN_ACK_TOKEN = "CHAIN_ACK";
export interface ChainScenarioInput {
    /** The installed copilot binary (.exe or the .js a shim launches). */
    bin: string;
    /** Plugin under test: passed as --plugin-dir and OMC_PLUGIN_ROOT. */
    root: string;
    /** Tier 2 session env (isolated COPILOT_HOME, login identity, OMC_HOOK_FAIL_CLOSED). */
    env: NodeJS.ProcessEnv;
    /** Sandbox git repo (trusted in the home's config.json). */
    projectDir: string;
    home: string;
    /** Per link: link 1's process timeout, then the wait for link 2 to close the chain. */
    timeoutMs: number;
    maxCredits: number;
    budget: number;
    eventsPath: string;
    spawnSync: SpawnSyncFn;
    /** Test seams. */
    spawn?: SpawnFn;
    pollMs?: number;
    randomUUID?: () => string;
}
/** Factory layout + widened route table + the chain-ack project skill. Returns an error or null. */
export declare function prepareChainProject(projectDir: string): string | null;
/**
 * Env for link 1 (and, through the hook and worker allowlists, every later
 * link): the plugin under test as OMC_PLUGIN_ROOT, the copilot binary's dir
 * first on PATH (the worker spawns link 2 as plain `copilot`), and this link's
 * OMC_CHAIN_LINK via chainLinkEnv.
 */
export declare function chainLinkSmokeEnv(base: NodeJS.ProcessEnv, bin: string, root: string, linkId: string): NodeJS.ProcessEnv;
/** Everything the chain left in `.omg/state/factory`, plus each closed link's session events. */
export declare function collectChainEvidence(projectDir: string, home: string, firstLink: string): ChainEvidence;
export declare function runChainScenario(input: ChainScenarioInput): Promise<Omit<ScenarioRun, 'logText'> & {
    wedged: boolean;
}>;
//# sourceMappingURL=copilot-chain-scenario.d.ts.map