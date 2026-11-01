/**
 * Copilot's skill registry for unattended sessions: checks a bundled skill's
 * slash (skill-slash.ts) against `copilot skill list --json` before a session
 * is prompted with it.
 */

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join, win32 } from 'path';
import type { CliAgentType } from '../team/model-contract.js';
import { detectHostCliType } from './host-signal.js';
import { getHostCliBinary } from './host-detection.js';
import { SKILL_NAMESPACE, skillSlash } from './skill-slash.js';
import { childEnv, findOnPath, resolveBareExe } from './windows-search.js';

/** One entry of `copilot skill list --json`. */
export interface CopilotSkillEntry {
  name: string;
  source?: string;
  /** The skill's directory; a plugin skill sits at `<plugin root>/skills/<dir>`. */
  path?: string;
}

/**
 * Lists the skills a Copilot session in `cwd` would register; null when the
 * probe failed, `'unresolved'` when no host binary resolves on PATH.
 */
export type SkillListProbe = (cwd: string, extraArgs: readonly string[]) => CopilotSkillEntry[] | null | 'unresolved';

const PROBE_TIMEOUT_MS = 5_000;

/** A token cmd.exe could rewrite even inside quotes (`%VAR%`, a quote, a line break) is not probed. */
const CMD_UNSAFE = /["%\u0000-\u001f]/;

/**
 * How to start the host binary found on PATH only (absolute entries), never
 * by a cwd-relative lookup: the probe runs in the project cwd, where a repo
 * could plant a `copilot.exe` or `copilot.cmd`. A native binary is spawned
 * directly. An npm `.cmd`/`.bat` shim runs through
 * `%SystemRoot%\System32\cmd.exe /d /v:off /s /c` with every token quoted;
 * the child env (childEnv) keeps NoDefaultCurrentDirectoryInExePath set for
 * the shim's own `node` lookup.
 */
function probeLaunch(args: readonly string[]): { file: string; args: string[]; verbatim: boolean } | 'unresolved' | null {
  const binary = getHostCliBinary();
  if (process.platform !== 'win32') {
    const found = binary.includes('/') ? binary : findOnPath(binary, process.env, process.platform);
    return found ? { file: found, args: [...args], verbatim: false } : 'unresolved';
  }
  const exe = resolveBareExe(binary);
  if (exe) return { file: exe, args: [...args], verbatim: false };
  const shim = findOnPath(binary, { ...process.env, PATHEXT: '.CMD;.BAT' }, 'win32');
  if (!shim) return 'unresolved';
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !/^[A-Za-z]:\\[^"%\u0000-\u001f]*$/.test(systemRoot)) return null;
  const tokens = [shim, ...args];
  if (tokens.some((token) => CMD_UNSAFE.test(token))) return null;
  // Trailing backslashes are doubled so the closing quote stays a quote for the CRT argv parser.
  const line = tokens.map((token) => `"${token.replace(/(\\+)$/, '$1$1')}"`).join(' ');
  return { file: win32.join(systemRoot, 'System32', 'cmd.exe'), args: ['/d', '/v:off', '/s', '/c', `"${line}"`], verbatim: true };
}

/** `<host binary> [--plugin-dir <root>] skill list --json`: free, it starts no model session. */
export const defaultSkillListProbe: SkillListProbe = (cwd, extraArgs) => {
  const launch = probeLaunch([...extraArgs, 'skill', 'list', '--json']);
  if (!launch || launch === 'unresolved') return launch;
  try {
    const result = spawnSync(launch.file, launch.args, {
      cwd,
      env: childEnv(process.env),
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is CopilotSkillEntry =>
      typeof entry === 'object' && entry !== null && typeof (entry as CopilotSkillEntry).name === 'string');
  } catch {
    return null;
  }
};

let activeProbe: SkillListProbe = defaultSkillListProbe;
const probeCache = new Map<string, ReturnType<SkillListProbe>>();

/** Test seam: replace the probe (and drop the per-process cache). Returns the previous probe. */
export function setSkillListProbe(probe: SkillListProbe): SkillListProbe {
  const previous = activeProbe;
  activeProbe = probe;
  probeCache.clear();
  return previous;
}

export interface ResolveSkillSlashOptions {
  /** Working directory of the session that will run the slash (project skills live there). */
  cwd: string;
  /** Host that runs the session; defaults to the detected host. */
  host?: CliAgentType;
  /** Args the spawned session gets before the prompt that change the skill set, e.g. `--plugin-dir`. */
  probeArgs?: readonly string[];
  /**
   * The session runs without a human (an --allow-all link): a skill that is
   * not ours throws `skill-shadowed:<name>`, and no host binary on PATH to
   * probe throws `skill-unverifiable:<name>`.
   */
  unattended?: boolean;
  /** Where a mismatch warning goes; stderr by default. */
  warn?: (message: string) => void;
}

/** Copilot's `source` is printed in a warning: strip control characters so it cannot drive the terminal. */
function printable(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** A plugin entry whose plugin root (`<path>/../..`) has a plugin.json named oh-my-copilot. */
function isOurSkill(entry: CopilotSkillEntry): boolean {
  if (entry.source !== 'plugin' || typeof entry.path !== 'string' || entry.path === '') return false;
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(dirname(entry.path)), 'plugin.json'), 'utf8'));
    return typeof manifest === 'object' && manifest !== null && (manifest as { name?: unknown }).name === SKILL_NAMESPACE;
  } catch {
    return false;
  }
}

/**
 * The slash an unattended session should be prompted with for a bundled
 * skill. On Copilot the registry is probed once per process (per cwd and
 * args): a namespaced-only entry (a plugin-name collision) wins, a missing or
 * shadowed name is warned about, and a failed probe falls back to the bare
 * name. With `unattended`, a bare entry that is not our plugin's skill (a
 * project or user skill, or another plugin's) throws instead.
 */
export function resolveSkillSlash(name: string, options: ResolveSkillSlashOptions): string {
  const host = options.host ?? detectHostCliType();
  if (host !== 'copilot') return skillSlash(name, host);
  const probeArgs = options.probeArgs ?? [];
  const key = `${options.cwd}\0${probeArgs.join('\0')}`;
  if (!probeCache.has(key)) probeCache.set(key, activeProbe(options.cwd, probeArgs));
  const entries = probeCache.get(key);
  if (entries === 'unresolved' && options.unattended) {
    throw new Error(`skill-unverifiable:${name}: no copilot binary on PATH to list the registered skills; an unattended session cannot be checked for a shadowing skill`);
  }
  // A probe that ran but failed (timeout, old CLI): even unattended, the bare
  // name goes out. Refusing would stop every chain wherever the probe cannot
  // parse, and the caller already confirmed the skill is bundled; the shadow
  // check narrows the risk where it can verify, it is not the boundary.
  if (!entries || entries === 'unresolved') return skillSlash(name, host);
  const warn = options.warn ?? ((message: string) => process.stderr.write(`[oh-my-copilot] ${message}\n`));
  const bare = entries.find((entry) => entry.name === name);
  if (bare) {
    if (options.unattended && !isOurSkill(bare)) {
      throw new Error(`skill-shadowed:${name}: a ${printable(bare.source ?? 'unknown')} skill registers as /${name}; an unattended session would run it instead of the bundled skill`);
    }
    if (bare.source && bare.source !== 'plugin') {
      warn(`a ${printable(bare.source)} skill named "${name}" shadows the bundled skill; /${name} will run that skill instead.`);
    }
    return `/${name}`;
  }
  const namespaced = `${SKILL_NAMESPACE}:${name}`;
  if (entries.some((entry) => entry.name === namespaced)) return `/${namespaced}`;
  warn(`copilot skill list has no skill named "${name}"; /${name} may be rejected as an unknown command.`);
  return `/${name}`;
}
