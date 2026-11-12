/**
 * `omg factory bench run --live`: which Copilot model the lanes will use and
 * its premium multiplier, read before any child starts. Lanes pass no model
 * (engine.ts), so they get the runtime's default for a fresh job home with
 * only the login identity. The probe starts the runtime the same way (no
 * user profile, the session env allowlist), reads `listModels()` and the
 * current model of a new session, and ends: no prompt is ever sent, so no
 * model turn runs. Never throws: what it could not read is `null` with why.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultCopilotRunDeps, type CopilotRunDeps } from '../../copilot-run/job.js';
import { allowlistSessionEnv, sessionGitHubToken } from '../../copilot-run/sandbox.js';
import { errText, withTimeout } from '../../copilot-run/timeout.js';
import { resolveShimTarget, runtimePid, type SdkClientLike, type SdkSessionLike } from '../../smoke/copilot-sdk-driver.js';
import { RUNTIME_MIN_MAX_CREDITS } from '../../smoke/copilot-sdk-scenarios.js';
import { buildSessionEnv, loginIdentity } from '../../smoke/copilot-session-env.js';
import { childEnv } from '../../utils/windows-search.js';

export interface BenchModelInfo {
  /** The model a lane gets (the new session's current model), or null when the runtime names none. */
  model: string | null;
  /** That model's premium multiplier from listModels() `billing.multiplier`, or null when not exposed. */
  multiplier: number | null;
  /** What was read, or why not. */
  detail: string;
}

export type BenchModelProbe = () => Promise<BenchModelInfo>;

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
 * Null when the run may start, else why not: a known multiplier above 1
 * needs `--allow-multiplier` at or above it (one lane then costs that many
 * premium requests).
 */
export function multiplierRefusal(info: BenchModelInfo, allow: number | undefined): string | null {
  if (info.multiplier === null || info.multiplier <= 1) return null;
  if (allow !== undefined && allow >= info.multiplier) return null;
  return `the lanes' default Copilot model ${info.model ?? '(unnamed)'} bills ${info.multiplier}x premium requests per call; rerun with --allow-multiplier ${info.multiplier} to accept it, or pick a cheaper default model in Copilot`;
}

export async function probeLaneModel(jobRoot: string, deps: Pick<CopilotRunDeps, 'env' | 'platform' | 'loadSdk' | 'resolveBin' | 'userConfigDir'> = defaultCopilotRunDeps()): Promise<BenchModelInfo> {
  const none = (detail: string): BenchModelInfo => ({ model: null, multiplier: null, detail });
  const jobHome = join(jobRoot, `model-probe-${randomBytes(4).toString('hex')}`);
  const workDir = join(jobHome, 'work');
  let client: SdkClientLike | null = null;
  let session: SdkSessionLike | null = null;
  try {
    mkdirSync(workDir, { recursive: true });
    const loaded = await deps.loadSdk().catch(() => null);
    if (!loaded) return none('@github/copilot-sdk is not installed or could not be loaded');
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
    await withTimeout(c.start(), START_TIMEOUT_MS, 'client.start()');
    const models = (await withTimeout(c.listModels(), RPC_TIMEOUT_MS, 'listModels()')) as ModelEntry[];
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
      const pid = runtimePid(client);
      try { await withTimeout(client.stop(), RPC_TIMEOUT_MS, 'client.stop()'); } catch {
        try { await withTimeout(client.forceStop?.() ?? Promise.resolve(), RPC_TIMEOUT_MS, 'client.forceStop()'); } catch { /* gone */ }
        if (pid) try { process.kill(pid); } catch { /* gone */ }
      }
    }
    try { rmSync(jobHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
