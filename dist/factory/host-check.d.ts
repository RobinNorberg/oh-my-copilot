/**
 * `omg factory check --host`: the host prerequisites of the factory in one
 * free pass (no model request, no session): node, git, the OS sandbox, the
 * Copilot CLI and SDK (v2, `@microsoft/copilot-sdk`) and their protocol,
 * and the login. Each item is ok / warn / fail with the
 * command that fixes it; any fail exits non-zero. Token values never appear:
 * the login item names credentials only, and every line is scrubbed.
 */
import { type Exec } from '../ship/exec.js';
import { type SandboxHostRecord, type SandboxSettings } from '../copilot-run/sandbox.js';
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
/** The first Copilot CLI on SDK protocol 4: older ones speak protocol 3, which SDK v2 refuses. */
export declare const FIRST_PROTOCOL4_CLI = "1.0.113";
/** Replaces SDK v1 with v2: the old package is never loaded, so it is removed rather than kept beside the new one. */
export declare const SDK_MIGRATE_COMMAND = "npm uninstall -g @github/copilot-sdk && npm i -g @microsoft/copilot-sdk@2 --ignore-scripts";
export interface HostCheckDeps {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    nodeVersion: string;
    userConfigDir: string;
    exec: Exec;
    /** Linux: why a trial bwrap launch fails, or null. */
    bwrapTrial: () => string | null;
    /** The factory sandbox settings the run gate uses; undefined when they cannot be loaded (then the sandbox item is strict). */
    sandboxSettings: () => SandboxSettings | undefined;
    resolveBin: () => string | null;
    /** `copilot --version` output of `bin` under `env`. */
    copilotVersion: (bin: string, env: NodeJS.ProcessEnv) => string;
    loadSdk: () => Promise<LoadedSdk | null>;
    /** The installed SDK v1 (`@github/copilot-sdk`) version in the global npm root, or null. */
    legacySdkVersion: () => string | null;
    /**
     * The no-session runtime start: the protocol mismatch text, or null; when it
     * started, the runtime's `getStatus()` (version, protocol) and, with `host`,
     * the sandbox.getHostSupport record.
     */
    probeRuntime: (loaded: LoadedSdk, bin: string, withHost: boolean) => Promise<{
        started: boolean;
        mismatch: string | null;
        status?: RuntimeStatus;
        host?: SandboxHostRecord;
    }>;
}
/** `client.getStatus()` of the probed runtime. */
export interface RuntimeStatus {
    version?: string;
    protocolVersion?: number;
}
export declare function defaultHostCheckDeps(env?: NodeJS.ProcessEnv): HostCheckDeps;
/** Every host item, in order. */
export declare function runHostCheck(d: HostCheckDeps): Promise<HostCheckItem[]>;
/** Prints the items (text or JSON); 0 when none failed, else 1. */
export declare function runFactoryHostCheck(opts: {
    json?: boolean;
}, d: HostCheckDeps, out: (line: string) => void): Promise<number>;
//# sourceMappingURL=host-check.d.ts.map