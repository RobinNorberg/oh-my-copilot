export const UNIX_HOOK_PREFIX: string;

export interface HookInvocation {
  script: string;
  extra: string[];
}

export function parseHookInvocation(hook: unknown): HookInvocation | null;

export function windowsExecArgs(script: string, extra?: string[]): string[];

export function unixShellCommand(script: string, extra?: string[]): string;

export interface HookPlatformOptions {
  /** True when a bare `node` resolves on the hook PATH: POSIX then keeps the exec form. */
  nodeOnPath?: boolean;
}

export function nodeResolvesOnHookPath(env?: NodeJS.ProcessEnv): boolean;

export function hookPrefixForPlatform(platform?: string, options?: HookPlatformOptions): string;

export function normalizeHookCommand(command: string, prefix?: string): string;

export function normalizeHooksDataForPlatform(data: unknown, platform?: string, options?: HookPlatformOptions): boolean;
