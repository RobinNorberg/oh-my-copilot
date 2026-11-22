/**
 * `omg factory check --host`: the host prerequisites of the factory in one
 * free pass (no model request, no session): node, git, the OS sandbox, the
 * Copilot CLI and SDK and their protocol, the login, and a newer Copilot
 * runtime in the package cache. Each item is ok / warn / fail with the
 * command that fixes it; any fail exits non-zero. Token values never appear:
 * the login item names credentials only, and every line is scrubbed.
 */
import { type Exec } from '../ship/exec.js';
import { type SandboxHostRecord } from '../copilot-run/sandbox.js';
import { type LoadedSdk } from '../smoke/copilot-sdk-driver.js';
export type HostCheckStatus = 'ok' | 'warn' | 'fail';
export interface HostCheckItem {
    id: string;
    status: HostCheckStatus;
    detail: string;
    /** The command (or step) that fixes a warn or fail. */
    fix?: string;
}
/** package.json `engines.node` (a test pins the two equal). */
export declare const NODE_ENGINE_RANGE = "^22.13.0 || ^23.4.0 || 24.x || 25.x || 26.x";
/** Whether `version` ("22.23.5") satisfies {@link NODE_ENGINE_RANGE}. */
export declare function nodeSatisfiesEngines(version: string): boolean;
/** The pin the factory's SDK speaks to: the last protocol-3 CLI. */
export declare const COPILOT_INSTALL_COMMAND = "npm i -g @github/copilot@1.0.112";
export interface HostCheckDeps {
    platform: NodeJS.Platform;
    arch: string;
    env: NodeJS.ProcessEnv;
    nodeVersion: string;
    homedir: string;
    userConfigDir: string;
    exec: Exec;
    /** Linux: why a trial bwrap launch fails, or null. */
    bwrapTrial: () => string | null;
    resolveBin: () => string | null;
    /** `copilot --version` output of `bin` under `env`. */
    copilotVersion: (bin: string, env: NodeJS.ProcessEnv) => string;
    loadSdk: () => Promise<LoadedSdk | null>;
    /**
     * The no-session runtime start: the protocol mismatch text, or null; with
     * `host`, the sandbox.getHostSupport record when the start succeeded.
     */
    probeRuntime: (loaded: LoadedSdk, bin: string, withHost: boolean) => Promise<{
        started: boolean;
        mismatch: string | null;
        host?: SandboxHostRecord;
    }>;
    listDir: (dir: string) => string[];
    exists: (path: string) => boolean;
}
export declare function defaultHostCheckDeps(env?: NodeJS.ProcessEnv): HostCheckDeps;
/** A version dir name ("1.0.114") with an index.js, newer than {@link LAST_PROTOCOL3_CLI}, under each package cache the CLI searches. */
export declare function newerCachedRuntimes(d: Pick<HostCheckDeps, 'platform' | 'arch' | 'env' | 'homedir' | 'listDir' | 'exists'>): string[];
/** Every host item, in order. */
export declare function runHostCheck(d: HostCheckDeps): Promise<HostCheckItem[]>;
/** Prints the items (text or JSON); 0 when none failed, else 1. */
export declare function runFactoryHostCheck(opts: {
    json?: boolean;
}, d: HostCheckDeps, out: (line: string) => void): Promise<number>;
//# sourceMappingURL=host-check.d.ts.map