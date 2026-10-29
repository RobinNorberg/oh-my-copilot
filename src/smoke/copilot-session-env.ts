/**
 * Runtime-neutral helpers shared by the smoke and the SDK team host
 * (src/team/sdk-host.ts, src/team/runtime-v2.ts): the copilot child env
 * policy, the login-identity copy, and the plugin root lookup.
 *
 * Keep this module dependency-light: no imports of src/mcp/**, src/tools/**,
 * or anything that reaches `@ast-grep/napi`. The team MCP bundle
 * (scripts/build-team-server.mjs) inlines every module reachable from here,
 * including literal dynamic imports. Guarded by
 * tests/lint/team-bundle-no-native.test.ts.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { COPILOT_RUN_ALLOW_ENV } from '../copilot-run/names.js';
import { OMC_PLUGIN_ROOT_ENV } from '../lib/env-vars.js';
import { parseJsonc } from '../utils/jsonc.js';
import { PLUGIN_NAME } from './copilot-sdk-scenarios.js';

/**
 * Env policy for every copilot child the smoke spawns (the caller's env minus
 * what could redirect, disable, or re-host our hooks; precedent:
 * scripts/verify-graph-contained-fs.mjs).
 *
 * Stripped:
 * - every `OMC_*` var and `DISABLE_OMC` (state dir, plugin root, skip/disable
 *   switches, debug toggles), then only {@link SMOKE_SET_ENV} is re-added;
 * - Claude Code host markers: `CLAUDECODE`, `CLAUDE_SESSION_ID`,
 *   `CLAUDE_PLUGIN_ROOT`, and every `CLAUDE_CODE_*` (incl. CLAUDE_CODE_ENTRYPOINT);
 * - `NODE_OPTIONS` (preloads would run inside our node hooks);
 * - `COPILOT_HOME`, `COPILOT_OFFLINE`, `COPILOT_MODEL` (only `--model` picks the
 *   model), every `COPILOT_PROVIDER_*` (BYO provider routing);
 * - `OMG_COPILOT_RUN_ALLOW` (a session must not start copilot_run jobs);
 * - tier 1 with a copied login identity: `GH_TOKEN`, `GITHUB_TOKEN` (see
 *   {@link buildSessionEnv}).
 * Kept: everything else, notably PATH/PATHEXT/SystemRoot/HOME/USERPROFILE/
 * APPDATA/LOCALAPPDATA/TEMP (hooks spawn node and resolve home dirs),
 * `COPILOT_GITHUB_TOKEN`, and the remaining `COPILOT_*` (e.g. COPILOT_CLI_PATH).
 */
export const STRIPPED_ENV_EXACT = [
  'DISABLE_OMC',
  'CLAUDECODE',
  'CLAUDE_SESSION_ID',
  'CLAUDE_PLUGIN_ROOT',
  'NODE_OPTIONS',
  'COPILOT_HOME',
  'COPILOT_OFFLINE',
  'COPILOT_MODEL',
  COPILOT_RUN_ALLOW_ENV,
] as const;
export const STRIPPED_ENV_PREFIXES = ['OMC_', 'CLAUDE_CODE_', 'COPILOT_PROVIDER_'] as const;
/** Generic GitHub tokens dropped from the tier 1 session when a stored login was copied. */
export const LOGIN_SHADOWING_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;
/** Set on every copilot child (on top of COPILOT_HOME). */
export const SMOKE_SET_ENV = {
  COPILOT_ALLOW_ALL: 'false',
  COPILOT_AUTO_UPDATE: 'false',
  NO_COLOR: '1',
} as const;
/** Set on the tier 1 session only: a failing hook must surface as hook.end success:false. */
export const SESSION_SET_ENV = { OMC_HOOK_FAIL_CLOSED: '1' } as const;

/** Credential env keys matched by exact name (any case on Windows). */
export const CREDENTIAL_ENV = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL',
  // Azure DevOps: the azure-devops extension's PATs and a pipeline's job token.
  'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_EXT_AZURE_RM_SERVICE_PRINCIPAL_KEY', 'AZURE_DEVOPS_EXT_GITHUB_PAT', 'SYSTEM_ACCESSTOKEN',
  // azure-identity / az: service principal, certificate, workload identity and managed identity.
  'AZURE_CLIENT_SECRET', 'AZURE_CLIENT_CERTIFICATE_PATH', 'AZURE_CLIENT_CERTIFICATE_PASSWORD', 'AZURE_PASSWORD',
  'AZURE_FEDERATED_TOKEN_FILE', 'IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'MSI_ENDPOINT', 'MSI_SECRET',
  // az storage account keys and SAS.
  'AZURE_STORAGE_KEY', 'AZURE_STORAGE_CONNECTION_STRING', 'AZURE_STORAGE_SAS_TOKEN',
  // Terraform azurerm (ARM_*).
  'ARM_CLIENT_SECRET', 'ARM_CLIENT_CERTIFICATE_PATH', 'ARM_CLIENT_CERTIFICATE_PASSWORD', 'ARM_OIDC_TOKEN',
  'ARM_OIDC_TOKEN_FILE_PATH', 'ARM_OIDC_REQUEST_TOKEN', 'ARM_ACCESS_KEY', 'ARM_SAS_TOKEN',
] as const;
/**
 * Names that look like a secret (COPILOT_GITHUB_TOKEN included: callers that
 * keep it skip it themselves), or a URL / connection string that carries one
 * (`npm_config__auth`, a webhook, a DSN, a database URL). `AUTH` only as a
 * whole segment, so GIT_AUTHOR_NAME stays; proxy vars stay.
 */
const SECRET_NAME = /TOKEN|SECRET|PASSW(?:OR)?D|PASSPHRASE|CREDENTIAL|API_?KEY|PRIVATE_KEY|ACCESS_KEY|_PAT(?:\b|_)|PRINCIPAL_?KEY|FEED_ENDPOINTS|ARM_CLIENT_CERTIFICATE|WEBHOOK|_AUTH$|^_?AUTH(?:_|$)|_DSN$|CONNSTR|CONNECTION_?STRING|_PWD$|DATABASE_URL|REDIS_URL|MONGODB_URI|DOCKER_AUTH_CONFIG/i;

/**
 * Whether a credential-free env drops `key`: a known credential
 * ({@link CREDENTIAL_ENV}), any secret-named var, a `GIT_CONFIG*` override
 * (could re-enable a credential helper) or a `GCM_*` setting. Any case.
 */
export function isCredentialEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (CREDENTIAL_ENV as readonly string[]).includes(upper)
    || SECRET_NAME.test(upper) || upper.startsWith('GIT_CONFIG') || upper.startsWith('GCM_');
}

export function isStrippedEnvKey(key: string): boolean {
  const upper = process.platform === 'win32' ? key.toUpperCase() : key;
  return (STRIPPED_ENV_EXACT as readonly string[]).includes(upper)
    || STRIPPED_ENV_PREFIXES.some((p) => upper.startsWith(p));
}

/** Walk up from this module to the directory holding the oh-my-copilot plugin.json. */
export function resolveDefaultPluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[OMC_PLUGIN_ROOT_ENV]?.trim();
  if (fromEnv) return resolve(fromEnv);
  return findPluginRoot([...moduleDirs(), process.cwd()]) ?? process.cwd();
}

/**
 * The oh-my-copilot package root that contains the running module (no env,
 * no cwd fallback), or null when this code is not running from a plugin tree.
 */
export function resolvePackageRoot(): string | null {
  return findPluginRoot(moduleDirs());
}

function moduleDirs(): string[] {
  const starts: string[] = [];
  if (typeof __dirname !== 'undefined' && __dirname) starts.push(__dirname);
  try { starts.push(dirname(fileURLToPath(import.meta.url))); } catch { /* CJS bundle */ }
  return starts;
}

function findPluginRoot(starts: string[]): string | null {
  for (const start of starts) {
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
      if (isPluginRoot(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function isPluginRoot(dir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8')) as { name?: unknown };
    return manifest.name === PLUGIN_NAME && existsSync(join(dir, 'package.json'));
  } catch {
    return false;
  }
}

export interface SessionEnvOptions {
  /** Tier 1 session (adds {@link SESSION_SET_ENV}); false for the tier 0 list commands. */
  session?: boolean;
  /** A stored login was copied into the home: drop {@link LOGIN_SHADOWING_TOKENS}. */
  hasLogin?: boolean;
}

/** Apply the env policy documented at {@link STRIPPED_ENV_EXACT}. */
export function buildSessionEnv(base: NodeJS.ProcessEnv, home: string, opts: SessionEnvOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (isStrippedEnvKey(key)) continue;
    if (opts.hasLogin && (LOGIN_SHADOWING_TOKENS as readonly string[]).includes(key.toUpperCase())) continue;
    env[key] = value;
  }
  env.COPILOT_HOME = home;
  Object.assign(env, SMOKE_SET_ENV);
  if (opts.session) Object.assign(env, SESSION_SET_ENV);
  return env;
}

/**
 * Copy only the login identity (`loggedInUsers`, `lastLoggedInUser`) from the
 * user's real config. The token stays in the OS credential store; without
 * these keys an empty COPILOT_HOME falls back to `gh auth token`, whose OAuth
 * app is not entitled to Copilot models ("Model ... is not available").
 *
 * Token precedence (`copilot help environment`, 1.0.91): COPILOT_GITHUB_TOKEN,
 * GH_TOKEN, GITHUB_TOKEN each take precedence over stored credentials. So when
 * a login was copied, the session drops GH_TOKEN/GITHUB_TOKEN (typically gh or
 * Actions tokens, which would shadow the entitled login) and keeps
 * COPILOT_GITHUB_TOKEN (an explicit Copilot opt-in). Without a stored login
 * (CI) all three pass through, since a token is then the only credential.
 */
export function loginIdentity(userConfigDir: string): Record<string, unknown> {
  try {
    const parsed = parseJsonc(readFileSync(join(userConfigDir, 'config.json'), 'utf-8')) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const key of ['loggedInUsers', 'lastLoggedInUser']) if (parsed[key] !== undefined) out[key] = parsed[key];
    return out;
  } catch {
    return {};
  }
}
