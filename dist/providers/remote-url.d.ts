/**
 * Remote URL parsing and host detection. Pure (no git, no spawn), so the
 * forge layer can import it: src/forge/__tests__/no-spawn.test.ts walks the
 * forge imports and refuses any path to child_process. index.ts re-exports
 * these names.
 */
import type { ProviderName, RemoteUrlInfo } from './types.js';
export declare function isAzureDevOpsHost(host: string): boolean;
/** One Azure DevOps name segment (org, project, repo, team, board): no path separators or control characters. */
export declare const ADO_SEGMENT: RegExp;
/**
 * True when a `<scheme>://` URL's authority (everything before the first
 * `/`) holds `#?[]\`, whitespace or a control character: a regex then reads
 * another host than git / curl connect to (`https://evil#@github.com/o/r`
 * connects to evil).
 */
export declare function ambiguousAuthority(url: string): boolean;
/**
 * False when `url` is http(s) and its WHATWG hostname (the host git / curl
 * connect to) is not `host`, or its authority is ambiguous; true otherwise.
 */
export declare function urlHostAgrees(url: string, host: string): boolean;
/**
 * The org, project and repository (escapes decoded, case kept) of an Azure
 * DevOps URL in any ADO_URLS form; null when it is none of them; 'invalid'
 * when it matches one but its authority is ambiguous (urlHostAgrees) or a
 * decoded segment is not an ADO_SEGMENT (`a%2Fb` would collide with `a/b`).
 */
export declare function parseAzureDevOpsRepoUrl(url: string): {
    org: string;
    project: string;
    repo: string;
} | 'invalid' | null;
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