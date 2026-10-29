/**
 * Remote URL parsing and host detection. Pure (no git, no spawn), so the
 * forge layer can import it: src/forge/__tests__/no-spawn.test.ts walks the
 * forge imports and refuses any path to child_process. index.ts re-exports
 * these names.
 */
import type { ProviderName, RemoteUrlInfo } from './types.js';
export declare function isAzureDevOpsHost(host: string): boolean;
/**
 * Detect provider from a git remote URL by matching known hostnames.
 */
export declare function detectProvider(remoteUrl: string): ProviderName;
/**
 * Parse a git remote URL into structured components.
 * Supports HTTPS, SSH (SCP-style), and provider-specific formats.
 */
export declare function parseRemoteUrl(url: string): RemoteUrlInfo | null;
//# sourceMappingURL=remote-url.d.ts.map