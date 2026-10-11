import { type Stats } from 'fs';
export declare function isOmcPluginCacheIdentity(pluginName: string, marketplace: string): boolean;
export declare function sameFileSystemIdentity(left: Stats, right: Stats): boolean;
export declare function hasAncestorWithIdentity(path: string, identity: Stats): boolean;
export declare function firstChildBelowDirectoryIdentity(path: string, directoryIdentity: Stats): string | undefined;
/** Includes the server and share, which win32.parse omits for extended UNC roots. */
export declare function pathRootForTraversal(path: string): string;
/**
 * True when `path` is a usable plugin root. When supplied, the stale identity
 * also prevents required paths from traversing the version being demoted.
 */
export declare function isUsableVersionPath(path: string, staleVersionIdentity?: Stats): boolean;
export declare function isUsableGenericPluginTarget(target: string, staleVersionIdentity: Stats): boolean;
//# sourceMappingURL=plugin-cache-validation.d.ts.map