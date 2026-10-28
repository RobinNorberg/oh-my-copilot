/**
 * Git Provider Detection and Registry
 *
 * Auto-detects git hosting provider from remote URLs and provides
 * access to provider-specific adapters.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { GitHubProvider } from './github.js';
import { GitLabProvider } from './gitlab.js';
import { BitbucketProvider } from './bitbucket.js';
import { AzureDevOpsProvider } from './azure-devops.js';
import { GiteaProvider } from './gitea.js';
import { detectProvider, parseRemoteUrl } from './remote-url.js';
// Pure URL parsing lives in remote-url.ts (the forge layer imports it without child_process).
export { detectProvider, parseRemoteUrl } from './remote-url.js';
// Singleton provider registry
let providerRegistry = null;
// TTL cache for git remote URL lookups keyed on resolved cwd
const REMOTE_URL_CACHE_TTL_MS = 60_000;
const remoteUrlCache = new Map();
/**
 * Reset the remote URL cache. Intended for use in tests.
 */
export function resetProviderCache() {
    remoteUrlCache.clear();
}
function getCachedRemoteUrl(cwd) {
    const entry = remoteUrlCache.get(cwd);
    if (!entry)
        return undefined; // cache miss
    if (Date.now() > entry.expiresAt) {
        remoteUrlCache.delete(cwd);
        return undefined; // expired
    }
    return entry.url; // may be null (cached "not a git repo")
}
function setCachedRemoteUrl(cwd, url) {
    remoteUrlCache.set(cwd, { url, expiresAt: Date.now() + REMOTE_URL_CACHE_TTL_MS });
}
function getRemoteUrl(cwd) {
    const resolvedCwd = resolve(cwd ?? process.cwd());
    const cached = getCachedRemoteUrl(resolvedCwd);
    if (cached !== undefined)
        return cached;
    try {
        const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
            cwd: resolvedCwd,
            encoding: 'utf-8',
            timeout: 3000,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        }).trim();
        const result = url || null;
        setCachedRemoteUrl(resolvedCwd, result);
        return result;
    }
    catch {
        setCachedRemoteUrl(resolvedCwd, null);
        return null;
    }
}
/**
 * Detect the git provider for the current working directory
 * by reading the origin remote URL.
 */
export function detectProviderFromCwd(cwd) {
    const url = getRemoteUrl(cwd);
    if (!url)
        return 'unknown';
    return detectProvider(url);
}
/**
 * Parse the remote URL for the current working directory.
 */
export function parseRemoteFromCwd(cwd) {
    const url = getRemoteUrl(cwd);
    if (!url)
        return null;
    return parseRemoteUrl(url);
}
/**
 * Initialize the provider registry with all available providers.
 */
function initRegistry() {
    if (providerRegistry)
        return providerRegistry;
    providerRegistry = new Map([
        ['github', new GitHubProvider()],
        ['gitlab', new GitLabProvider()],
        ['bitbucket', new BitbucketProvider()],
        ['azure-devops', new AzureDevOpsProvider()],
        ['gitea', new GiteaProvider()],
        ['forgejo', new GiteaProvider({ name: 'forgejo', displayName: 'Forgejo' })],
    ]);
    return providerRegistry;
}
/**
 * Get a provider instance by name.
 * Returns null if the provider is not registered.
 */
export function getProvider(name) {
    const registry = initRegistry();
    return registry.get(name) ?? null;
}
/**
 * Get a provider for the current working directory.
 * Detects the provider from the git remote URL and returns its adapter.
 */
export function getProviderFromCwd(cwd) {
    const name = detectProviderFromCwd(cwd);
    if (name === 'unknown')
        return null;
    return getProvider(name);
}
//# sourceMappingURL=index.js.map