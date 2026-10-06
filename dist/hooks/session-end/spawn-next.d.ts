import { type ChainOutcome, type RouteTable } from './routing.js';
export interface SpawnNextTracker {
    repo: string;
    issue: number;
    nextLabel: string;
    failedLabel: string;
}
/** How a finished session hands the chain to the next stage. Supplied by the enqueuer in the action payload under `chain`. */
export interface SpawnNextChain {
    outcome: ChainOutcome;
    reason: string;
    routeTable: RouteTable;
    sessionId: string;
    /** Ledger identity carried through so the next link's ledger keeps it. */
    intentId?: string;
    handoffContext?: string;
    tracker?: SpawnNextTracker;
    /** Per-stage link counts carried forward so the enqueuer can cap route loops. */
    visits?: Record<string, number>;
    /** Stage-visit cap carried forward from the first ledger (default 2 when absent). */
    maxStageVisits?: number;
}
export interface SpawnNextPlan {
    directive: {
        stage: string;
        skill: string;
    };
    handoffPath: string;
    spawnArgv: string[];
    /**
     * Pre-generated id of the next link (its chain-link id). A Claude link gets
     * it as `--session-id`; a Copilot link, which cannot pin a session id, gets
     * it as {@link CHAIN_LINK_ENV}. Either way its SessionEnd finds the ledger.
     */
    nextSessionId: string;
    trackerCommands: string[][];
}
export type SpawnFn = (command: string, args: string[], ctx?: SpawnContext) => {
    unref(): void;
};
/** Factory links spawn headless (AFK): their cwd must match the ledger's state root and their permission profile must be narrow. */
export interface SpawnContext {
    cwd?: string;
    /** Chain-link id handed to a Copilot link as {@link CHAIN_LINK_ENV}. */
    chainLink?: string;
}
/**
 * Env var that carries a factory chain link's identity into a Copilot link.
 * Copilot CLI has no `--session-id`, so the spawner pre-generates the link id,
 * writes `chain-<id>.json`, and sets this var on the child; the SessionEnd hook
 * inherits it from the Copilot process and resolves the ledger by it (see
 * resolveChainLink in chain-enqueuer.ts, which only trusts an open Copilot
 * ledger). The detached SessionEnd worker never forwards it: the chain
 * identity rides the durable manifest payload, and each spawned link gets its
 * own fresh value here.
 */
export declare const CHAIN_LINK_ENV = "OMC_CHAIN_LINK";
/**
 * Env for a spawned host link (`claude` or `copilot`): the caller's env minus
 * any inherited chain identity, plus this link's own {@link CHAIN_LINK_ENV}
 * (Copilot only; Claude pins `--session-id`). A launcher-level
 * COPILOT_ALLOW_ALL would override the AFK allowlist of every copilot link, so
 * a copilot child always gets the documented off value.
 */
export declare function chainLinkEnv(base: NodeJS.ProcessEnv, command: string, chainLink?: string): NodeJS.ProcessEnv;
/**
 * `--plugin-dir <root>` for a Copilot link when this process runs a dev plugin
 * root (`omg --plugin-dir`, which sets OMC_PLUGIN_ROOT): an installed plugin
 * loads by itself, but a --plugin-dir one does not reach a spawned link, whose
 * hooks (and therefore its SessionEnd chain hand-off) would never fire. Only an
 * absolute path to an existing directory is passed; anything else is dropped.
 *
 * Dropped as well when the root and the link's working directory overlap: an
 * AFK link may write files under its cwd (`--allow-tool=write`), and a link
 * that rewrote the plugin's hooks or scripts would run that code in its own
 * SessionEnd and in every later link, outside the AFK allowlist. A chain over
 * the plugin's own repo therefore needs the plugin installed, not a dev root.
 * On win32 a root containing `%` is dropped: cmd.exe argv quoting refuses it,
 * and every link launched through a .cmd shim would fail.
 */
export declare function copilotPluginDirArgs(env?: NodeJS.ProcessEnv, linkCwd?: string): string[];
/**
 * AFK allowlist for factory-spawned sessions: gh read/comment, file read/write,
 * and github.com-only WebFetch. Everything else is denied in -p mode and must
 * fall back to HITL (the session's issue-comment contract), never silent failure.
 */
export declare const AFK_ALLOWED_TOOLS: string;
export declare const AFK_SPAWN_FLAGS: string[];
/**
 * Copilot CLI translation of AFK_SPAWN_FLAGS: the same gh/file-write/
 * github.com-WebFetch surface as `--allow-tool` / `--allow-url` rules
 * (Copilot's reads need no rule), with `--no-ask-user` so a headless link never
 * blocks on a question. Copilot has no `--setting-sources` equivalent, so the
 * user-level settings isolation of a Claude link does not carry over.
 */
export declare const COPILOT_AFK_SPAWN_FLAGS: string[];
/**
 * Copilot matches a shell rule on the command stem, so a single-token rule
 * (`shell(node)`) admits that program with any arguments. A Copilot verify
 * rule must therefore name a subcommand or script, and an interpreter's second
 * token must not be a flag. `%` is refused on win32 because the rule rides
 * cmd.exe argv when copilot is a .cmd shim.
 */
export declare function isCopilotVerifyCommandAllowed(command: string): boolean;
/** Host CLI binary that runs factory links: `copilot` on a Copilot host, `claude` under Claude Code. */
export declare function factoryLinkCommand(): string;
/**
 * Args (command excluded) for one factory chain link: intent prompt + AFK
 * permission profile. A stage's declared `verify` commands extend the profile
 * with exactly those `Bash(...)` entries — the argv is a trust boundary, so
 * they are re-checked against the routing pattern here rather than trusted from
 * whatever route table produced the directive.
 *
 * On a Copilot host the profile is COPILOT_AFK_SPAWN_FLAGS plus one
 * `--allow-tool=shell(<command>)` per extra command. Copilot cannot pin a
 * session id at launch, so `sessionId` is not passed to it: the spawner hands
 * it over as CHAIN_LINK_ENV. A dev plugin root adds `--plugin-dir`
 * (copilotPluginDirArgs).
 */
export declare function factoryLinkArgv(prompt: string, sessionId: string, verifyCommands?: readonly string[], fixedBashCommands?: readonly string[], 
/** The link's working directory (spawn cwd), for the --plugin-dir overlap check. */
linkCwd?: string): string[];
/** Shared label charset (stage/skill/labels): safe for paths and argv. */
export declare const LABEL_PATTERN: RegExp;
/**
 * The chain rides a detached manifest job: every field that lands in a
 * spawned argv or a filesystem path is validated here. An invalid chain is a
 * hard reject (manifest failure), not a partial spawn.
 */
export declare function validateChainFields(chain: SpawnNextChain): void;
/** A carried stage-visit cap: an integer 1..99. */
export declare function isStageVisitCap(value: unknown): value is number;
/**
 * A ledger's stage-visit cap: a positive integer, clamped to 99 (the visits
 * counter's ceiling), so a large declared cap stays effectively unlimited
 * instead of falling back to the default 2. Undefined when not set or invalid.
 */
export declare function stageVisitCap(value: unknown): number | undefined;
/** Host that runs a factory link; recorded in its ledger (`host`). */
export type ChainLinkHost = 'claude' | 'copilot';
/** Fields of a freshly written (open) link ledger. */
export interface ChainLinkLedgerSeed {
    intentId: string;
    stage: string;
    routeTable?: RouteTable;
    tracker?: SpawnNextTracker;
    visits?: Record<string, number>;
    maxStageVisits?: number;
    /** Link id of the link whose SessionEnd spawned this one (absent for a first link). */
    parentLink?: string;
}
/** Host of a link spawned with `command`: the Copilot binary or Claude. */
export declare function chainLinkHost(command: string): ChainLinkHost;
/**
 * Write the open ledger `chain-<linkId>.json` for a link about to spawn. It
 * records the link's identity (`chainLink`, `host`, `createdAt`): a Copilot
 * link's SessionEnd only trusts CHAIN_LINK_ENV when this ledger exists, names
 * host copilot, and has no `closedAt` yet. Returns the ledger path.
 */
export declare function writeChainLinkLedger(factoryDir: string, linkId: string, host: ChainLinkHost, seed: ChainLinkLedgerSeed): string;
export declare function spawnNextAlertComment(chain: SpawnNextChain): string;
export declare function planSpawnNext(chain: SpawnNextChain, omcRoot: string, linkCwd?: string): SpawnNextPlan | null;
/** IO orchestration only: the routing decision comes from the T1 pure function via planSpawnNext. */
export declare function executeSpawnNext(chain: SpawnNextChain, directory: string, spawnFn?: SpawnFn): void;
/**
 * `claude`, `copilot` and `gh` may be .cmd shims on Windows, which
 * CreateProcess cannot exec directly; those route through cmd.exe, native
 * .exe installs spawn directly. The -p prompt and the gh --body go through
 * stdin on Windows: cmd.exe's ANSI codepage mangles non-ASCII argv (dogfood:
 * Chinese intent prompts and issue bodies mojibake'd), while the stdin pipe
 * stays UTF-8 end to end. It also keeps free text away from cmd.exe, whose
 * quote parity disagrees with CRT argv parsing (`\"` splits argv) and which
 * expands %VAR% inside quotes. The remaining fixed argv is quoted by
 * quoteForCmd (CRT-correct, rejects `%` and CR/LF).
 *
 * The .cmd-shim constraint is a Windows PLATFORM fact, not a shell fact: gate
 * on process.platform, never on shell detection. Gating on the shell made
 * Git Bash (MSYSTEM set) skip the cmd.exe route and spawn the .cmd shim
 * directly, which CreateProcess cannot exec — the child died instantly and
 * silently (stdio ignored), so `omg ralph afk` under Git Bash launched
 * nothing. Factory chain links escaped this only by accident: the detached
 * worker's env is an allowlist that drops MSYSTEM. The long-running factory
 * listener (src/factory/listener.ts), which spawns links from its own
 * inherited environment, had the same broken route under Git Bash.
 *
 * detached:true is win32-hostile here (dogfood bisect: cmd.exe children
 * spawned detached exit 1 before writing a transcript), so it is only
 * applied off-win32. Orphaning still holds: Windows children survive
 * parent exit without the detached flag.
 */
export declare function defaultSpawnFn(command: string, args: string[], ctx?: SpawnContext): {
    unref(): void;
};
//# sourceMappingURL=spawn-next.d.ts.map