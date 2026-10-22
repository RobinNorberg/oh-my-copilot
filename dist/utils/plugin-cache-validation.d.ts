import { type BigIntStats, type Stats } from 'fs';
export declare function isOmcPluginCacheIdentity(pluginName: string, marketplace: string): boolean;
/** Callers stat with `{ bigint: true }`: NTFS file IDs exceed 2^53, so distinct Number inodes can collide. */
export type FileSystemIdentity = Stats | BigIntStats;
export declare function sameFileSystemIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean;
export declare function hasAncestorWithIdentity(path: string, identity: FileSystemIdentity): boolean;
export declare function firstChildBelowDirectoryIdentity(path: string, directoryIdentity: FileSystemIdentity): string | undefined;
/** Includes the server and share, which win32.parse omits for extended UNC roots. */
export declare function pathRootForTraversal(path: string): string;
/**
 * True when `path` is a usable plugin root. When supplied, the stale identity
 * also prevents required paths from traversing the version being demoted.
 */
export declare function isUsableVersionPath(path: string, staleVersionIdentity?: FileSystemIdentity): boolean;
export declare function isUsableGenericPluginTarget(target: string, staleVersionIdentity: FileSystemIdentity): boolean;
//# sourceMappingURL=plugin-cache-validation.d.ts.map