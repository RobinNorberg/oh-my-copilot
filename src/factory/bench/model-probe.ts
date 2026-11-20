/**
 * `omg factory bench run --live`: which Copilot model the lanes will use and
 * its premium multiplier, read before any child starts. Without `--model`
 * lanes pass no model (engine.ts), so they get the runtime's default for a
 * fresh job home with only the login identity. The probe starts the runtime
 * the same way (no user profile, the session env allowlist), reads
 * `listModels()` and the current model of a new session, and ends: no prompt
 * is ever sent, so no model turn runs. With `--model <id>` it reads only
 * `listModels()` (no session): that id's multiplier, and the ids the account
 * offers (`offered`) so the runner can refuse an id it does not offer. Never
 * throws: what it could not read is `null` with why.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultCopilotRunDeps, type CopilotRunDeps } from '../../copilot-run/job.js';
import { allowlistSessionEnv, sessionGitHubToken } from '../../copilot-run/sandbox.js';
import { errText, withTimeout } from '../../copilot-run/timeout.js';
import { resolveShimTarget, rethrowSdkStartError, runtimePid, type SdkClientLike, type SdkSessionLike } from '../../smoke/copilot-sdk-driver.js';
import { RUNTIME_MIN_MAX_CREDITS, SDK_INSTALL_COMMAND } from '../../smoke/copilot-sdk-scenarios.js';
import { buildSessionEnv, loginIdentity } from '../../smoke/copilot-session-env.js';
import { hasExited } from '../../smoke/process-utils.js';
import { childEnv } from '../../utils/windows-search.js';

export interface BenchModelInfo {
  /** The model a lane gets (the new session's current model), or null when the runtime names none. */
  model: string | null;
  /** That model's premium multiplier from listModels() `billing.multiplier`, or null when not exposed. */
  multiplier: number | null;
  /** What was read, or why not. */
  detail: string;
  /** The lanes' model was named (`--model`), not the runtime's default. */
  explicit?: true;
  /** With an explicit model: the ids listModels() offers (absent when it could not be read). */
  offered?: string[];
}

/** `model`: the explicit lane model (`--model`); absent = the runtime's default. */
export type BenchModelProbe = (model?: string) => Promise<BenchModelInfo>;

const START_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;

type ModelEntry = { id?: unknown; billing?: { multiplier?: unknown } };
type ModelRpc = { model?: { getCurrent?: () => Promise<{ modelId?: unknown }> } };

/** The multiplier of `model` in a listModels() answer; null when absent or not a finite number >= 0. */
export function modelMultiplier(models: readonly ModelEntry[], model: string): number | null {
  const m = models.find((x) => x.id === model)?.billing?.multiplier;
  return typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : null;
}

/**
 * Null when the run may start, else why not. A known multiplier above 1
 * needs `--allow-multiplier` at or above it (one lane then costs that many
 * premium requests). An unknown model or multiplier fails closed: it needs
 * `--allow-multiplier`, given after checking the default model by hand.
 * `flag` names where an explicit model came from in the messages.
 */
export function multiplierRefusal(info: BenchModelInfo, allow: number | undefined, flag = '--model'): string | null {
  if (info.explicit) {
    if (!info.offered) return `the lanes' Copilot model ${info.model ?? '(none)'} could not be checked against your account's models (${info.detail}); the bench does not start an unchecked ${flag}`;
    if (!info.model || !info.offered.includes(info.model)) return `${flag} ${info.model ?? '(none)'} is not offered to your account by Copilot; listModels() offers: ${info.offered.join(', ') || '(none)'}`;
    if (info.multiplier === null) {
      if (allow !== undefined) return null;
      return `the lanes' Copilot model ${info.model} has no known premium multiplier (${info.detail}); check it by hand (/model in an interactive copilot), then rerun with --allow-multiplier <its multiplier, rounded up>`;
    }
    if (info.multiplier <= 1 || (allow !== undefined && allow >= info.multiplier)) return null;
    return `the lanes' Copilot model ${info.model} (${flag}) bills ${info.multiplier}x premium requests per call; rerun with --allow-multiplier ${Math.ceil(info.multiplier)} to accept it, or pick a cheaper ${flag}`;
  }
  if (info.multiplier === null) {
    if (allow !== undefined) return null;
    return `the lanes' default Copilot model ${info.model ?? '(unknown)'} has no known premium multiplier (${info.detail}); check the default Copilot model by hand (/model in an interactive copilot), then rerun with --allow-multiplier <its multiplier, rounded up>`;
  }
  if (info.multiplier <= 1) return null;
  if (allow !== undefined && allow >= info.multiplier) return null;
  return `the lanes' default Copilot model ${info.model ?? '(unnamed)'} bills ${info.multiplier}x premium requests per call; rerun with --allow-multiplier ${Math.ceil(info.multiplier)} to accept it, or pick a cheaper default model in Copilot`;
}

export async function probeLaneModel(jobRoot: string, deps: Pick<CopilotRunDeps, 'env' | 'platform' | 'loadSdk' | 'resolveBin' | 'userConfigDir' | 'killTree'> = defaultCopilotRunDeps(), requested?: string): Promise<BenchModelInfo> {
  const none = (detail: string): BenchModelInfo => (requested ? { model: requested, multiplier: null, detail, explicit: true } : { model: null, multiplier: null, detail });
  const jobHome = join(jobRoot, `model-probe-${randomBytes(4).toString('hex')}`);
  const workDir = join(jobHome, 'work');
  let client: SdkClientLike | null = null;
  let session: SdkSessionLike | null = null;
  try {
    mkdirSync(workDir, { recursive: true });
    const loaded = await deps.loadSdk().catch(() => null);
    if (!loaded) return none(`@github/copilot-sdk is not installed or could not be loaded (${SDK_INSTALL_COMMAND})`);
    const found = deps.resolveBin();
    const bin = found && deps.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(found) ? resolveShimTarget(found) : found;
    if (!bin) return none('the copilot CLI was not found');
    const ident = loginIdentity(deps.userConfigDir());
    writeFileSync(join(jobHome, 'config.json'), `${JSON.stringify({ ...ident, trustedFolders: [workDir] }, null, 2)}\n`);
    const env = childEnv(allowlistSessionEnv(buildSessionEnv(deps.env, jobHome, { session: false, hasLogin: ident.loggedInUsers !== undefined }), jobHome));
    mkdirSync(env.XDG_CONFIG_HOME!, { recursive: true });
    mkdirSync(dirname(env.GIT_CONFIG_GLOBAL!), { recursive: true });
    mkdirSync(env.TEMP!, { recursive: true });
    const gitHubToken = sessionGitHubToken(deps.env);
    const { CopilotClient, RuntimeConnection } = loaded.module;
    const c: SdkClientLike = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: bin, args: ['--max-ai-credits', String(RUNTIME_MIN_MAX_CREDITS)], env }),
      baseDirectory: jobHome,
      workingDirectory: workDir,
    });
    client = c;
    await withTimeout(c.start().catch(rethrowSdkStartError), START_TIMEOUT_MS, 'client.start()');
    const models = (await withTimeout(c.listModels(), RPC_TIMEOUT_MS, 'listModels()')) as ModelEntry[];
    if (requested) {
      // An explicit lane model: the account's list and that id's multiplier; no session is made.
      const list = Array.isArray(models) ? models : [];
      const offered = list.map((m) => m.id).filter((id): id is string => typeof id === 'string');
      const multiplier = modelMultiplier(list, requested);
      return {
        model: requested, multiplier, explicit: true, offered,
        detail: !offered.includes(requested) ? `listModels() does not offer ${requested}` : multiplier === null ? `listModels() gives no billing multiplier for ${requested}` : `listModels() billing.multiplier of ${requested}`,
      };
    }
    // A session with no tools and every permission refused; it is never sent a prompt.
    session = await withTimeout(c.createSession({
      onPermissionRequest: () => ({ kind: 'reject' }),
      pluginDirectories: [],
      workingDirectory: workDir,
      disabledMcpServers: ['github-mcp-server'],
      excludedTools: [],
      availableTools: [],
      ...(gitHubToken ? { gitHubToken } : {}),
    }), RPC_TIMEOUT_MS, 'createSession()');
    const getCurrent = (session.rpc as ModelRpc).model?.getCurrent;
    if (!getCurrent) return none(`this SDK (${loaded.version ?? 'unknown version'}) has no session.rpc.model.getCurrent`);
    const current = await withTimeout(getCurrent(), RPC_TIMEOUT_MS, 'model.getCurrent()');
    const model = typeof current?.modelId === 'string' && current.modelId ? current.modelId : null;
    if (!model) {
      // Picked at the first turn: say what the account offers instead.
      const list = Array.isArray(models) ? models : [];
      const known = list.map((m) => (typeof m.id === 'string' ? modelMultiplier(list, m.id) : null)).filter((m): m is number => m !== null);
      const range = known.length ? `; listModels() offers ${list.length} models, multipliers ${Math.min(...known)}x to ${Math.max(...known)}x` : '';
      return none(`the runtime names no current model for a new session (model.getCurrent: ${JSON.stringify(current ?? null).slice(0, 200)}); the default is picked at the first turn${range}`);
    }
    const multiplier = modelMultiplier(Array.isArray(models) ? models : [], model);
    return { model, multiplier, detail: multiplier === null ? `listModels() gives no billing multiplier for ${model}` : `listModels() billing.multiplier of ${model}` };
  } catch (error) {
    return none(`the probe failed: ${errText(error)}`);
  } finally {
    if (session) {
      try { await withTimeout(session.disconnect(), RPC_TIMEOUT_MS, 'disconnect()'); } catch { /* runtime gone */ }
      try { await withTimeout(client!.deleteSession(session.sessionId), RPC_TIMEOUT_MS, 'deleteSession()'); } catch { /* best effort */ }
    }
    if (client) {
      try { await withTimeout(client.stop(), RPC_TIMEOUT_MS, 'client.stop()'); } catch {
        try { await withTimeout(client.forceStop?.() ?? Promise.resolve(), RPC_TIMEOUT_MS, 'client.forceStop()'); } catch { /* gone */ }
      }
      // The runtime this probe's client spawned, through the SDK's own child handle (set at spawn, also when
      // start() then hung or timed out): if it still runs, end its tree. The handle's exit state guards against
      // a recycled pid. No handle means start() hung before spawning, so nothing of ours is running.
      const proc = (client as unknown as { cliProcess?: { exitCode?: number | null; signalCode?: NodeJS.Signals | null } | null }).cliProcess;
      const pid = runtimePid(client);
      if (proc && pid && !hasExited(proc)) {
        try { deps.killTree(pid); } catch { /* gone */ }
      }
    }
    try { rmSync(jobHome, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmdirSync(jobRoot); } catch { /* not empty, or gone */ }
  }
}
