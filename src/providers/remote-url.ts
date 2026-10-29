/**
 * Remote URL parsing and host detection. Pure (no git, no spawn), so the
 * forge layer can import it: src/forge/__tests__/no-spawn.test.ts walks the
 * forge imports and refuses any path to child_process. index.ts re-exports
 * these names.
 */

import type { ProviderName, RemoteUrlInfo } from './types.js';
import { stripTrailingSlashes } from '../utils/url.js';

export function isAzureDevOpsHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return normalized === 'dev.azure.com' || normalized === 'ssh.dev.azure.com' || normalized.endsWith('.visualstudio.com');
}

/** One Azure DevOps name segment (org, project, repo, team, board): no path separators or control characters. */
export const ADO_SEGMENT = /^[^/\\\p{Cc}]{1,256}$/u;

/**
 * True when a `<scheme>://` URL's authority (everything before the first
 * `/`) holds `#?[]\`, whitespace or a control character: a regex then reads
 * another host than git / curl connect to (`https://evil#@github.com/o/r`
 * connects to evil).
 */
export function ambiguousAuthority(url: string): boolean {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i.exec(url.trim())?.[1];
  return authority !== undefined && /[#?[\]\\\s\p{Cc}]/u.test(authority);
}

/**
 * False when `url` is http(s) and its WHATWG hostname (the host git / curl
 * connect to) is not `host`, or its authority is ambiguous; true otherwise.
 */
export function urlHostAgrees(url: string, host: string): boolean {
  if (ambiguousAuthority(url)) return false;
  if (!/^https?:\/\//i.test(url.trim())) return true;
  try {
    return new URL(url.trim()).hostname.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The Azure DevOps repository URL forms (design §8.3), matched after trim,
 * `\` -> `/` and a trailing `/` and `.git` dropped:
 * `[https://][user@]dev.azure.com/<org>/<project>/_git/<repo>`,
 * `[ssh://]git@ssh.dev.azure.com[:/]v3/<org>/<project>/<repo>`, and the
 * legacy `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>`
 * and `<org>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo>`.
 */
const ADO_URLS: ReadonlyArray<{ re: RegExp; host: (org: string) => string | null }> = [
  { re: /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/(?<org>[^/]+)\/(?<project>[^/]+)\/_git\/(?<repo>[^/]+)$/i, host: () => 'dev.azure.com' },
  { re: /^(?:ssh:\/\/)?[^@/:]+@ssh\.dev\.azure\.com(?::|(?::\d+)?\/)v3\/(?<org>[^/]+)\/(?<project>[^/]+)\/(?<repo>[^/]+)$/i, host: () => null },
  { re: /^https?:\/\/(?:[^@/]+@)?(?<org>[^./@]+)\.visualstudio\.com\/(?:defaultcollection\/)?(?<project>[^/]+)\/_git\/(?<repo>[^/]+)$/i, host: (org) => `${org}.visualstudio.com` },
  { re: /^(?:ssh:\/\/)?[^@/:]+@vs-ssh\.visualstudio\.com(?::|(?::\d+)?\/)v3\/(?<org>[^/]+)\/(?<project>[^/]+)\/(?<repo>[^/]+)$/i, host: () => null },
];

/** `%20` and friends decoded; a malformed escape keeps the raw segment. */
const decodeSegment = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * The org, project and repository (escapes decoded, case kept) of an Azure
 * DevOps URL in any ADO_URLS form; null when it is none of them; 'invalid'
 * when it matches one but its authority is ambiguous (urlHostAgrees) or a
 * decoded segment is not an ADO_SEGMENT (`a%2Fb` would collide with `a/b`).
 */
export function parseAzureDevOpsRepoUrl(url: string): { org: string; project: string; repo: string } | 'invalid' | null {
  const s = url.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '');
  for (const { re, host } of ADO_URLS) {
    const g = re.exec(s)?.groups;
    if (!g) continue;
    const expected = host(g.org);
    if (ambiguousAuthority(url) || (expected !== null && !urlHostAgrees(url, expected))) return 'invalid';
    const [org, project, repo] = [g.org, g.project, g.repo].map(decodeSegment);
    return [org, project, repo].every((p) => ADO_SEGMENT.test(p)) ? { org, project, repo } : 'invalid';
  }
  return null;
}

/**
 * Detect provider from a git remote URL by matching known hostnames.
 */
export function detectProvider(remoteUrl: string): ProviderName {
  const url = remoteUrl.toLowerCase();

  // Extract host portion for accurate matching (strip port if present)
  const hostMatch = url.match(/^(?:https?:\/\/(?:[^@/?#]+@)?|ssh:\/\/[^@/?#]*@|[^@/:?#]+@)([^/:?#]+)/);
  const rawHost = hostMatch ? hostMatch[1].toLowerCase() : '';
  const host = rawHost.replace(/:\d+$/, ''); // strip port for matching

  // Azure DevOps (check before generic patterns)
  if (isAzureDevOpsHost(host)) {
    return 'azure-devops';
  }

  // GitHub
  if (host === 'github.com') {
    return 'github';
  }

  // GitLab (SaaS)
  if (host === 'gitlab.com') {
    return 'gitlab';
  }

  // Bitbucket
  if (host === 'bitbucket.org') {
    return 'bitbucket';
  }

  // Self-hosted heuristics — match hostname labels only
  if (/(^|[.-])gitlab([.-]|$)/.test(host)) {
    return 'gitlab';
  }
  if (/(^|[.-])gitea([.-]|$)/.test(host)) {
    return 'gitea';
  }
  if (/(^|[.-])forgejo([.-]|$)/.test(host)) {
    return 'forgejo';
  }

  return 'unknown';
}

/**
 * Parse a git remote URL into structured components.
 * Supports HTTPS, SSH (SCP-style), and provider-specific formats.
 */
export function parseRemoteUrl(url: string): RemoteUrlInfo | null {
  // Browser addresses and some `git remote set-url` values keep a trailing
  // slash. Git still fetches them. The matchers below require the URL to end
  // on the repo name, so drop only trailing slashes before they run.
  const trimmed = stripTrailingSlashes(url.trim());

  // Azure DevOps HTTPS: https://dev.azure.com/{org}/{project}/_git/{repo}
  const azureHttpsMatch = trimmed.match(
    /^https?:\/\/(?:[^/@?#]+@)?dev\.azure\.com\.?\/([^/]+)\/([^/]+)\/_git\/([^/\s]+)$/i
  );
  if (azureHttpsMatch) {
    return {
      provider: 'azure-devops',
      host: 'dev.azure.com',
      owner: `${azureHttpsMatch[1]}/${azureHttpsMatch[2]}`,
      repo: azureHttpsMatch[3].replace(/\.git$/, ''),
    };
  }

  // Azure DevOps SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  const azureSshMatch = trimmed.match(
    /^git@ssh\.dev\.azure\.com\.?:v3\/([^/]+)\/([^/]+)\/([^/\s]+)$/i
  );
  if (azureSshMatch) {
    return {
      provider: 'azure-devops',
      host: 'dev.azure.com',
      owner: `${azureSshMatch[1]}/${azureSshMatch[2]}`,
      repo: azureSshMatch[3].replace(/\.git$/, ''),
    };
  }

  // Azure DevOps legacy HTTPS: https://{org}.visualstudio.com/{project}/_git/{repo}
  const azureLegacyMatch = trimmed.match(
    /^https?:\/\/(?:[^/@?#]+@)?([^.]+)\.visualstudio\.com\.?\/([^/]+)\/_git\/([^/\s]+)$/i
  );
  if (azureLegacyMatch) {
    return {
      provider: 'azure-devops',
      host: `${azureLegacyMatch[1]}.visualstudio.com`,
      owner: `${azureLegacyMatch[1]}/${azureLegacyMatch[2]}`,
      repo: azureLegacyMatch[3].replace(/\.git$/, ''),
    };
  }

  // Standard HTTPS: https://host/owner/repo.git (supports nested groups like group/subgroup/repo)
  const httpsMatch = trimmed.match(
    /https?:\/\/([^/]+)\/(.+?)\/([^/\s]+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    const host = httpsMatch[1];
    return {
      provider: detectProvider(trimmed),
      host,
      owner: httpsMatch[2],
      repo: httpsMatch[3],
    };
  }

  // SSH URL-style: ssh://git@host[:port]/owner/repo.git (must check before SCP-style)
  const sshUrlMatch = trimmed.match(
    /ssh:\/\/git@([^/:]+)(?::\d+)?\/(.+?)\/([^/\s]+?)(?:\.git)?$/
  );
  if (sshUrlMatch) {
    const host = sshUrlMatch[1];
    return {
      provider: detectProvider(trimmed),
      host,
      owner: sshUrlMatch[2],
      repo: sshUrlMatch[3],
    };
  }

  // SSH SCP-style: git@host:owner/repo.git (supports nested groups like group/subgroup/repo)
  const sshMatch = trimmed.match(
    /git@([^:]+):(.+?)\/([^/\s]+?)(?:\.git)?$/
  );
  if (sshMatch) {
    const host = sshMatch[1];
    return {
      provider: detectProvider(trimmed),
      host,
      owner: sshMatch[2],
      repo: sshMatch[3],
    };
  }

  return null;
}
