/**
 * Tier 2 of `omg smoke copilot`: scenario definitions and the pure evaluators
 * for the SDK static checks (`sdk.*`) and the scenario checks (`scn.<name>.*`).
 * No SDK, process or network access here, so the unit tests replay captured
 * event streams through the same functions the live driver uses.
 */
import { type CopilotEvent, type SmokeCheck } from './copilot-session-eval.js';
export type Scenario = 'smoke' | 'guardrail' | 'skill' | 'delegate' | 'filetools' | 'chain' | 'team' | FactoryRunScenario | 'sandbox-lane' | CliScenario;
/** `omg factory run` end to end, in-process, with real lanes (copilot-factory-run-scenario.ts). */
export type FactoryRunScenario = 'factory-run' | 'factory-run-fix';
export declare const FACTORY_RUN_SCENARIOS: readonly FactoryRunScenario[];
/** Sandboxed copilot_run lanes against the OS sandbox, in-process (copilot-sandbox-lane-scenario.ts). */
export declare const SANDBOX_LANE_SCENARIO: "sandbox-lane";
/**
 * Headless `copilot` CLI sessions (copilot-cli-scenarios.ts), not SDK
 * sessions: a stub plugin next to ours, a resumed session, or a seeded state.
 */
export type CliScenario = 'continuation' | 'prompt-context' | 'events' | 'ultragoal';
export declare const CLI_SCENARIOS: readonly CliScenario[];
/** What `--scenario all` runs: the SDK-session scenarios (one prompt each, about 0.3 to 0.9 AI credits measured). */
export declare const ALL_SCENARIOS: readonly Scenario[];
/**
 * Named explicitly only, never in `all` or the default: `filetools` (one
 * prompt) lets the model write files and loads a second, probe plugin;
 * `chain` spawns two real headless `copilot -p` factory links (one prompt
 * each) outside the SDK runtime's credit cap; `team` starts a real 2-worker
 * `omg team` with sdk workers (one prompt per worker); `factory-run` runs
 * `omg factory run` with a real implement and review lane (two lanes, about
 * 2 AI credits estimated) and `factory-run-fix` adds a fix round (four lanes,
 * about 4); `sandbox-lane` runs a review, a write and a canary lane in the
 * OS sandbox (three lanes, about 3 AI credits estimated). Lane scenarios pin
 * their lanes to the session's cheap model ({@link chooseModel}). The
 * {@link CLI_SCENARIOS}, AI credits measured on Copilot CLI 1.0.91 (legacy
 * premium requests in brackets): `continuation` 0.31 [2] (the prompt plus one
 * Stop-hook continuation, an extra model turn), `prompt-context` 0.29 [1],
 * `events` 0.76 [1] (the `/compact` of the resumed session bills credits),
 * `ultragoal` 0.65 [2] (the prompt plus one reinforcement continuation).
 */
export declare const OPT_IN_SCENARIOS: readonly Scenario[];
/**
 * Scenarios written to the behaviour another lane delivers: their failing
 * checks carry this note, so a red run reads as expected until it lands.
 * Remove the entry once the scenario passes on dev.
 */
export declare const PENDING_SCENARIOS: Partial<Record<Scenario, string>>;
export declare const KNOWN_SCENARIOS: readonly Scenario[];
/**
 * Two prompts (one per scenario), about 0.6 AI credits measured: the
 * tier2-smoke (0.34) and tier2-guardrail (0.29) fixtures' `session.shutdown`
 * totals on small auto-picked models; other models cost more.
 */
export declare const DEFAULT_SCENARIOS: readonly Scenario[];
export declare const PLUGIN_NAME = "oh-my-copilot";
export declare const DELEGATE_AGENT = "oh-my-copilot:architect";
export declare const MIN_PROTOCOL_VERSION = 3;
export declare const SDK_PACKAGE = "@github/copilot-sdk";
/** Lane B's CLI keys "pure skip" exit code 2 on this exact prefix. */
export declare const SDK_MISSING_DETAIL = "@github/copilot-sdk not installed \u2014 npm i -g @github/copilot-sdk --omit=optional --ignore-scripts";
/**
 * Never offered: our own `host_smoke` MCP tool (a smoke that can start a smoke).
 * MCP tools are named `<server>-<tool>` (server = the first `.mcp.json` key);
 * `t:host_smoke` / `t(host_smoke)` match nothing.
 */
export declare function hostSmokeToolName(mcpServer: string): string;
/** Built-in shell and file-writing tools, removed for scenarios that must not use them. */
export declare const NO_SHELL_OR_WRITE_TOOLS: readonly ["powershell", "shell", "create", "edit"];
export declare const NO_WRITE_TOOLS: readonly ["create", "edit"];
/** The subset of the SDK's PermissionRequest the policies read. */
export interface PermissionRequestLike {
    kind?: string;
    fullCommandText?: string;
    path?: unknown;
    [key: string]: unknown;
}
/** Where a scenario may act: the sandbox project and the plugin under test. */
export interface PermitContext {
    projectDir: string;
    pluginRoot: string;
    platform?: NodeJS.Platform;
}
export interface ScenarioSpec {
    name: Scenario;
    prompt: string;
    /** Built-in tools removed for this scenario; the driver adds {@link hostSmokeToolName}. */
    excludedTools: string[];
    /** Approve this permission request; everything else is rejected. */
    permit: (req: PermissionRequestLike, ctx: PermitContext) => boolean;
}
/** The one command the guardrail scenario may run (should our preToolUse hook not deny it first). */
export declare const GUARDRAIL_COMMAND: RegExp;
/** Only the exact guardrail push, and only from the sandbox project when the request names a cwd. */
export declare function permitGuardrailPush(req: PermissionRequestLike, ctx: PermitContext): boolean;
/** Reads only; when the request carries a path it must be under the plugin root or the sandbox project. */
export declare function permitScopedRead(req: PermissionRequestLike, ctx: PermitContext): boolean;
/** filetools fixture, relative to the sandbox project (forward slashes, as the model is told). */
export declare const FILETOOLS_DIR = "filetools";
export declare const FILETOOLS_FILES: {
    readonly notes: "filetools/notes.txt";
    readonly created: "filetools/new/created.txt";
    /**
     * Picked up by post-tool-directory-context-injector.mjs (README.md, not
     * AGENTS.md: Copilot loads AGENTS.md itself). The injector sends each
     * README once per session, so the read (view of notes.txt) and the write
     * (creating created.txt) each get their own.
     */
    readonly context: "filetools/README.md";
    readonly writeContext: "filetools/new/README.md";
};
export declare const FILETOOLS_MARKER = "Context marker:";
/** The PostToolUse matcher of our rules + directory-context injector entry in copilot/hooks.json. */
export declare const FILE_TOOL_MATCHER = "Read|Write|Edit|MultiEdit";
/** File reads and writes, only under the sandbox project. */
export declare function permitProjectFiles(req: PermissionRequestLike, ctx: PermitContext): boolean;
/** CLI scenario fixtures named in their prompts. */
export declare const PROMPT_CONTEXT_PREFIX = "OMG-PROMPT-CONTEXT:";
export declare const EVENTS_MISSING_FILE = "omg-missing-probe.txt";
export declare const EVENTS_SHELL_TOKEN = "omg-events-probe";
/** factory-run fixture: the scripted GitHub repository, issue, PR and base, and the one file the issue asks for. */
export declare const FACTORY_RUN_REPO_URL = "https://github.com/omg-smoke/factory-run";
export declare const FACTORY_RUN_ISSUE = 1;
export declare const FACTORY_RUN_PR = 2;
export declare const FACTORY_RUN_BASE = "dev";
export declare const FACTORY_RUN_FILE = "greet.txt";
export declare const FACTORY_RUN_ISSUE_BODY: string;
export declare const SCENARIOS: Record<Scenario, ScenarioSpec>;
/** The prompt the `events` scenario resumes its session with: preCompact, no user prompt (the summary still bills AI credits). */
export declare const COMPACT_PROMPT = "/compact";
/** The ultragoal activation prompt the seed sends through our UserPromptSubmit hook group. */
export declare const ULTRAGOAL_ACTIVATION_PROMPT = "use ultragoal to write a hello.txt file containing hi";
/** keyword-detector's confirmation window; the seed backdates the state past it. */
export declare const ULTRAGOAL_CONFIRM_TTL_MS = 120000;
/** The Stop-hook reason the continuation stub blocks with (once). */
export declare function continuationReason(nonce: string): string;
export declare function continuationToken(nonce: string): string;
export declare function promptContextLine(nonce: string): string;
/** One headless `copilot` process of a CLI scenario. */
export interface CliStepRecord {
    label: string;
    code: number | null;
    timedOut: boolean;
    durationMs: number;
    error?: string;
}
export interface CliEvidence {
    sessionId: string;
    /** Random token in the stub plugin's output, never in the prompt. */
    nonce: string;
    steps: CliStepRecord[];
    /** Stub plugin records: what each stub run read on stdin and printed. */
    stub: Array<{
        kind: string;
        payload: Record<string, unknown> | null;
        out: Record<string, unknown>;
    }>;
    /** ultragoal: the activation seed (our UserPromptSubmit group, then the TTL backdate). */
    seed?: {
        ok: boolean;
        detail: string;
        state?: Record<string, unknown> | null;
    };
}
/** A tool call our preToolUse hook denied for the ultragoal gate. */
export declare const ULTRAGOAL_DENY: RegExp;
/** The file each task commits; a task's subject names its file. */
export declare const TEAM_FILES: readonly string[];
/**
 * AI credits ceiling of the team scenario: one user prompt per worker plus its
 * tool turns. A generous ceiling (single smoke prompts measured 0.3 to 0.9
 * credits), not a measured figure; it catches runaway continuations.
 */
export declare const TEAM_MAX_CREDITS = 10;
/** Wall-clock budget for start → both tasks completed → clean shutdown. */
export declare const TEAM_BUDGET_MS = 300000;
/** What the team run left behind, gathered by the runner before and during shutdown. */
export interface TeamEvidence {
    teamName: string | null;
    start: {
        code: number | null;
        ok: boolean | null;
        ms: number;
        launchMs: number | null;
        stderr: string;
    };
    /** The last `omg team status --json` before shutdown (null: none parsed). */
    status: Record<string, unknown> | null;
    /** `omg team api list-tasks` after the tasks settled. */
    tasks: Array<{
        id: string;
        subject: string;
        status: string;
        owner: string | null;
    }>;
    /**
     * Commits each worker added on top of the leader HEAD in its worktree, its
     * HEAD then, and how that HEAD fared at shutdown: `merged` into the leader
     * HEAD, `preserved` (the worktree kept at that HEAD and listed in
     * `preserved_worktrees`), `lost`, or null when there was nothing to keep.
     */
    commits: Array<{
        worker: string;
        worktree: string | null;
        subjects: string[];
        files: string[];
        head?: string | null;
        survived?: 'merged' | 'preserved' | 'lost' | null;
    }>;
    shutdown: {
        code: number | null;
        ms: number;
        stdout: string;
        stderr: string;
        forced: boolean;
    } | null;
    /** Host and runtime pids still alive after shutdown. */
    orphans: number[];
    /** Instance reservations left for the team after shutdown. */
    reservationsLeft: string[];
    stateLeft: boolean;
    durationMs: number;
    budgetMs: number;
    cost: ScenarioCost & {
        source: string;
    };
}
/** Intent id of the smoke chain; its stop marker is `chain-<id>.stopped.json`. */
export declare const CHAIN_INTENT_ID = "omg-smoke-chain";
/** Project skill link 2 is routed to (`/chain-ack ...`); it replies with one token. */
export declare const CHAIN_SKILL = "chain-ack";
export declare const CHAIN_LINK1_STAGE = "link-1";
export declare const CHAIN_LINK2_STAGE = "link-2";
/**
 * AI credits ceiling of the chain scenario: two links, one user prompt each.
 * A generous ceiling (single smoke prompts measured 0.3 to 0.9 credits), not a
 * measured figure; it catches a runaway link.
 */
export declare const CHAIN_MAX_CREDITS = 6;
/** One link ledger as found on disk (`chain-<file>.json`). */
export interface ChainLedgerRecord {
    file: string;
    [key: string]: unknown;
}
/** What the chain left behind, read after it stopped (or timed out). */
export interface ChainEvidence {
    /** Link id of the first link (pre-written by the scenario). */
    firstLink: string;
    ledgers: ChainLedgerRecord[];
    decisions: Array<Record<string, unknown>>;
    stopped: {
        reason?: unknown;
    } | null;
    /** Each closed link's host session and its persisted events (null: no events.jsonl). */
    sessions: Array<{
        hostSessionId: string;
        events: CopilotEvent[] | null;
    }>;
}
export declare function chainCost(chain: ChainEvidence): ScenarioCost & {
    source: string;
};
/**
 * AI credits ceilings: about 1 credit per lane is the estimate (a small write
 * or review with a few tool turns) on the cheap model the driver pins for the
 * lanes, 3 per lane the ceiling, as for chain. It catches a runaway lane, not
 * a measured figure. Lanes on runtime auto (no cheap model listed, or none
 * pinned) measured about 3.6 credits each on Sonnet (CLI 1.0.105) and fail it.
 */
export declare const FACTORY_RUN_MAX_CREDITS: Readonly<Record<FactoryRunScenario, number>>;
/** The lanes each variant must run, in order, with the review verdicts. */
export declare const FACTORY_RUN_EXPECTED_LANES: Readonly<Record<FactoryRunScenario, ReadonlyArray<{
    kind: string;
    verdict?: string;
}>>>;
/** What the factory run left behind: the engine outcome, its state, the bare remote and the scripted gh. */
export interface FactoryRunEvidence {
    outcome: {
        exitCode: number;
        phase: string | null;
        gate: string | null;
        message: string;
        mergeCommand: string | null;
    } | null;
    lanes: Array<{
        id: string;
        kind: string;
        status: string;
        verdict: string | null;
        jobId: string | null;
        startSha: string;
        endSha: string | null;
        maxCredits: number;
        credits: number | null;
        source: string | null;
    }>;
    /** Every lane start the backend saw (the engine's caps and profiles). */
    laneStarts: Array<{
        laneId: string;
        profile: string;
        maxCredits: number;
    }>;
    /** The last head the engine pushed, and the bare remote's factory branch. */
    head: string | null;
    remoteHead: string | null;
    /** The bare remote's base branch before and after the run (a merge would move it). */
    baseBefore: string;
    baseAfter: string;
    remoteRefs: string[];
    shipVerdict: {
        verdict: string;
        sha: string;
        reviewer: string;
    } | null;
    /** The factory state passes its integrity seal (a rerun resumes from it). */
    integrityOk: boolean;
    /** History notes that mention tampering (lane-tampered, state-tampered). */
    tamperNotes: string[];
    gh: {
        prCreates: string[];
        ready: boolean;
        mergeCalls: string[];
    };
    warnings: string[];
    durationMs: number;
    cost: ScenarioCost & {
        source: string;
    };
}
/** The file the write lane's probe creates in its worktree, the one change the engine commits. */
export declare const SANDBOX_LANE_FILE = "sandbox-lane-ok.txt";
/** The file the review lane is asked to create in its worktree (it must not land). */
export declare const SANDBOX_REVIEW_FILE = "review-canary.txt";
/** The file the canary lane's executeUserRequested command creates in its worktree. */
export declare const SANDBOX_CANARY_FILE = "canary-inside.txt";
/** The probe script committed at the scenario repository's root; it prints one {@link SANDBOX_PROBE_MARKER} line. */
export declare const SANDBOX_PROBE_SCRIPT = "sandbox-probe.mjs";
export declare const SANDBOX_PROBE_MARKER = "OMG_SANDBOX_PROBE ";
/** A ceiling of 3 AI credits per lane over the three lanes on the pinned cheap model, as for factory-run: it catches a runaway lane. */
export declare const SANDBOX_LANE_MAX_CREDITS = 9;
export type SandboxLaneRole = 'review' | 'write' | 'canary';
/** Where a probe write aimed; the host checks after the lane whether a file landed there. */
export type SandboxTargetKind = 'main-checkout' | 'shared' | 'git-dir' | 'real-home' | 'profile' | 'worktree';
export interface SandboxWriteTarget {
    kind: SandboxTargetKind;
    path: string;
    landed: boolean;
}
/** The sandbox state of one lane as copilot_run recorded it (CopilotRunSandboxState). */
export interface SandboxLaneState {
    mode: string;
    host: {
        supported: boolean;
        reason?: string;
        capabilities: Record<string, boolean>;
    };
    applied: string;
    enforcement?: {
        required: boolean;
        blocked: boolean;
        reason?: string;
    };
    canary: string;
    unsandboxedCalls: number;
    reason?: string;
}
export interface SandboxLaneRecord {
    role: SandboxLaneRole;
    state: string;
    error: string | null;
    sandbox: SandboxLaneState | null;
    /** Completed shell tool calls in the lane's events, and those without `sandboxed: true`. */
    shellCalls: number;
    unattestedShellCalls: number;
    /** Shell calls that completed with `success: true`: evidence the lane launched a process at all. */
    okShellCalls: number;
    /** Files changed or added in the lane worktree (copilot_run `changes`). */
    changedFiles: string[];
    maxCredits: number;
    credits: number | null;
    /** The model the lane's session ran on (copilot_run snapshot.model; null: not reported). */
    model: string | null;
}
/** What the probe script printed (its {@link SANDBOX_PROBE_MARKER} line): per-write outcome and the two network reaches. */
export interface SandboxProbeOutput {
    /** `<os.homedir()>/omg-canary-<nonce>` inside the sandbox: the relocated profile. */
    home?: string;
    writes: Array<{
        path: string;
        ok: boolean;
        error?: string;
    }>;
    net: {
        local?: {
            ok: boolean;
            status?: number;
            error?: string;
        } | null;
        outbound?: {
            ok: boolean;
            status?: number;
            error?: string;
        } | null;
    };
}
/** The canary lane's `session.rpc.shell.executeUserRequested` call before its first turn (Q5). */
export interface SandboxCanaryRecord {
    called: boolean;
    error?: string;
    result: {
        success: boolean;
        exitCode: number | null;
        output: string;
        toolCallId: string;
    } | null;
    /** `sandboxed` of the tool.execution_complete with the call's toolCallId (null: no such event, or no field). */
    sandboxed: boolean | null;
    /** onPermissionRequest calls the session made while the RPC ran. */
    permissionRequests: number;
    targets: SandboxWriteTarget[];
}
export interface SandboxLaneEvidence {
    nonce: string;
    lanes: SandboxLaneRecord[];
    reviewTargets: SandboxWriteTarget[];
    writeTargets: SandboxWriteTarget[];
    /** The write lane's probe output, read from its shell tool result (null: the probe never ran). */
    probe: SandboxProbeOutput | null;
    /** Requests the host's loopback listener received from the write lane's probe. */
    localHits: number;
    commit: {
        ok: boolean;
        sha?: string;
        files: string[];
        reason?: string;
    } | null;
    canary: SandboxCanaryRecord | null;
    /** The OS temp dir: the default sandbox grant includes it, and the scenario repository lives there. */
    tempDir: string;
    /** Set when the host probe said unsupported: no lane ran and no credit was spent. */
    hostUnsupported?: {
        supported: boolean;
        reason?: string;
        capabilities: Record<string, boolean>;
    };
    durationMs: number;
    cost: ScenarioCost & {
        source: string;
    };
}
/** The probe output line in a tool result text, or null. */
export declare function parseSandboxProbe(text: string): SandboxProbeOutput | null;
/**
 * Probe plugin entries, loaded next to ours: each records its stdin payload.
 * PascalCase entries get the Claude-format payload (tool_name, tool_input);
 * camelCase entries the native one (toolName, toolArgs).
 */
export declare const PROBE_ENTRIES: readonly [{
    readonly event: "PreToolUse";
    readonly label: "PreToolUse";
}, {
    readonly event: "PostToolUse";
    readonly label: "PostToolUse";
}, {
    readonly event: "PostToolUse";
    readonly label: "PostToolUse:matcher";
    readonly matcher: "Read|Write|Edit|MultiEdit";
}, {
    readonly event: "preToolUse";
    readonly label: "preToolUse";
}, {
    readonly event: "postToolUse";
    readonly label: "postToolUse";
}];
export type ProbeLabel = typeof PROBE_ENTRIES[number]['label'];
/** The probe plugin's hooks.json: `node <script> <label> <log>` per {@link PROBE_ENTRIES} entry. */
export declare function probeHooksJson(node: string, script: string, log: string): Record<string, unknown>;
/** One probe hook run: its entry label and the payload it read on stdin (null: not JSON). */
export interface ProbeRecord {
    label: string;
    payload: Record<string, unknown> | null;
}
export interface FiletoolsEvidence {
    /** Random tokens in the fixture's two README.md files (read side, write side), never in the prompt. */
    nonce: string;
    writeNonce: string;
    probe: ProbeRecord[];
    /** notes.txt reads `status: done`; created.txt exists. */
    edited: boolean;
    created: boolean;
}
/** Copilot's built-in file tools: read and write side. */
export declare const FILE_READ_TOOLS: readonly string[];
export declare const FILE_WRITE_TOOLS: readonly string[];
/**
 * Tool name and input of a probe payload: Claude format (`tool_name`,
 * `tool_input`) for PascalCase entries, native (`toolName`, `toolArgs`) for
 * camelCase ones (Copilot CLI 1.0.91).
 */
export declare function probeTool(r: ProbeRecord): {
    name: string;
    input: unknown;
};
/** The session's excludedTools for a scenario: its built-ins plus our host_smoke tool. */
export declare function scenarioExcludedTools(name: Scenario, mcpServer: string): string[];
/** Check ids a scenario yields, in report order (stable; Lane B's docs list them). */
export declare function scenarioCheckIds(name: Scenario): string[];
export declare const SDK_STATIC_IDS: readonly ["sdk.available", "sdk.runtime", "sdk.plugins", "sdk.skills", "sdk.agents", "sdk.mcp", "sdk.tools_excluded", "sdk.sandbox"];
/** Every sdk.* and scn.* id failed with one detail (SDK missing, binary missing, runtime start failure). */
export declare function failedTier2Checks(scenarios: readonly Scenario[], detail: string, from?: 'all' | 'after-available'): SmokeCheck[];
/** Copilot CLI rejects `--max-ai-credits` below this (also in `--headless` runtime mode, CLI 1.0.91). */
export declare const RUNTIME_MIN_MAX_CREDITS = 30;
/** Reported for scenarios not started once the run's credit cap was reached. */
export declare const CREDIT_CAP_SKIP_DETAIL = "skipped: credit cap reached";
/** A scenario's checks all failed with one detail (not started). */
export declare function skippedScenarioChecks(name: Scenario, detail: string): SmokeCheck[];
/** An RPC result or the error message it failed with. */
export type Rpc<T = unknown> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: string;
};
export declare function evaluateSdkRuntime(status: Rpc<{
    version?: unknown;
    protocolVersion?: unknown;
}>, binVersion: string | null, model: string): SmokeCheck;
export declare function evaluateSdkPlugins(plugins: Rpc, packageVersion: string | null): SmokeCheck;
export declare function evaluateSdkSkills(skills: Rpc, root: string, skillDirs: string[], platform?: NodeJS.Platform): SmokeCheck;
export declare function evaluateSdkAgents(agents: Rpc, agentFiles: string[]): SmokeCheck;
export declare function evaluateSdkMcp(mcp: Rpc, tools: Rpc, server: string, expected: number | string): SmokeCheck;
/**
 * `excludedTools` really removed our host_smoke tool: it is absent from the
 * session's initialized tool list (`session.rpc.tools.getCurrentMetadata`),
 * while other tools of the same server are present (else the absence proves
 * nothing, e.g. the MCP tools were never offered).
 */
export declare function evaluateSdkToolsExcluded(meta: Rpc, server: string): SmokeCheck;
/** The free part of the sandbox probe: host support, then the review policy on the static session and its enforcement. */
export interface SdkSandboxProbe {
    /** The host-support RPC answered (false: missing or it threw). */
    answered: boolean;
    host: {
        supported: boolean;
        reason?: string;
        capabilities: Record<string, boolean>;
    };
    /** Why the review policy was not applied (null: applied); absent when the host is unsupported. */
    applyError?: string | null;
    /** The enforcement status after the apply, or why it could not be read. */
    enforcement?: {
        required: boolean;
        blocked: boolean;
        reason?: string;
    } | string;
    /** The spawn canary (a sandboxed `echo` with the lane env, no model turn); absent when it did not get that far. */
    spawn?: {
        ok: boolean;
        detail: string;
    };
}
/**
 * `sdk.sandbox`, no model call: what copilot_run would decide on this host.
 * An unsupported host passes (sessions fail closed: no shell for review,
 * write refuses); a supported host must take the review policy without
 * enforcement reporting blocked, and the spawn canary must launch a
 * sandboxed process with the lane env. The detail starts with `supported`
 * or `unsupported`.
 */
export declare function evaluateSdkSandbox(probe: SdkSandboxProbe): SmokeCheck;
/**
 * Split runtime log text into windows by each line's leading ISO timestamp:
 * window i holds lines stamped in [starts[i], starts[i+1]); the last window is
 * open-ended. Lines before starts[0] are dropped; unstamped (continuation)
 * lines follow the previous stamped line. Attributing by time, not byte
 * offset, keeps a late SessionEnd line of scenario N out of scenario N+1.
 */
export declare function sliceLogByTime(text: string, starts: number[]): string[];
export interface ScenarioRun {
    name: Scenario;
    events: CopilotEvent[];
    /** A `session.idle` arrived for the prompt. */
    idle: boolean;
    timedOut: boolean;
    timeoutMs: number;
    /** createSession/send threw. */
    error?: string;
    /** Debug-log lines written while this scenario ran (null: no log found). */
    logText: string | null;
    /** guardrail: `git for-each-ref` output of the bare remote (null: could not inspect). */
    remoteRefs?: string | null;
    model: string;
    /** The run's credit cap (`--max-credits`). */
    maxCredits: number;
    /** What was left of {@link maxCredits} when this scenario started (default: all of it). */
    budget?: number;
    /** The driver aborted the turn because `assistant.usage` credits passed {@link budget}. */
    capped?: boolean;
    /** chain: the ledgers, decisions and link sessions the chain left behind. */
    chain?: ChainEvidence;
    /** team: start, status, tasks, commits and shutdown evidence of the 2-worker sdk team. */
    team?: TeamEvidence;
    /** factory-run, factory-run-fix: the engine outcome and state, the bare remote and the scripted gh. */
    factory?: FactoryRunEvidence;
    /** sandbox-lane: the three lanes, the host-side write checks, the engine commit and the canary RPC. */
    sandbox?: SandboxLaneEvidence;
    /** filetools: the probe plugin's hook records and the fixture's state after the turn. */
    filetools?: FiletoolsEvidence;
    /** CLI scenarios: the session id, stub nonce, per-process results, stub records and seed. */
    cli?: CliEvidence;
}
/** What one scenario run cost: chain and team span several sessions with their own totals. */
export declare function runCost(run: Pick<ScenarioRun, 'events' | 'chain' | 'team' | 'factory' | 'sandbox'>): ScenarioCost & {
    source: string;
};
/** AI credits billed, plus the legacy premium request count the CLI still reports. */
export interface ScenarioCost {
    credits: number;
    premiumRequests: number;
}
/** AI credits billed by one `assistant.usage` event (0 for any other event). */
export declare function usageCredits(event: CopilotEvent): number;
/**
 * Prefer `session.shutdown` totals (emitted at disconnect); else sum
 * `assistant.usage`: AI credits from `copilotUsage.totalNanoAiu` (every model
 * call bills credits), and the legacy premium requests counted per
 * user-initiated call.
 */
export declare function scenarioCost(events: CopilotEvent[]): ScenarioCost & {
    source: string;
};
/**
 * Hook stderr lines from our adapter (`[omg-hook]`) or hook runner
 * (`[run.cjs]`, e.g. a timeout). A hook that exits 0 has its stderr logged as
 * `[hook stderr]` lines; one that exits non-zero (fail-closed, e.g. 124) as a
 * multi-line `[ERROR] ... execution failed` entry whose stderr starts with
 * `Stderr: ` (Copilot CLI 1.0.91). Both forms count.
 */
export declare function adapterErrorLines(logText: string): string[];
/** Hook script names mentioned in adapter error lines (e.g. wiki-session-end.mjs). */
export declare function hookScriptNames(lines: string[]): string[];
export declare function evaluateScenario(run: ScenarioRun): {
    checks: SmokeCheck[];
    cost: ScenarioCost;
};
/** `ScenarioRun.model` of a lane scenario: the model pinned for its lanes, then the ones they reported running on. */
export declare function laneModelLabel(pinned: string | undefined, used: ReadonlyArray<string | null>): string;
/**
 * An explicit request wins. Otherwise the first listed non-`auto` model whose
 * id looks cheap; when the runtime lists only `auto` (Copilot CLI 1.0.91 for
 * individual accounts) the session config omits `model` and the runtime routes.
 */
export declare function chooseModel(listed: string[], requested?: string): {
    model?: string;
    label: string;
    note: string;
};
//# sourceMappingURL=copilot-sdk-scenarios.d.ts.map