import { execFileSync } from 'node:child_process';
/** Resolve paths for identity comparisons; only Windows has case-insensitive paths. */
export declare function pathIdentity(path: string): string;
export declare function processStartIdentities(pids: number[], exec?: typeof execFileSync): Map<number, string>;
export interface CacheOccupancyRecord {
    version: 1;
    pid: number;
    processStartIdentity: string;
    pluginRoot: string;
    updatedAt: string;
}
export declare function getCacheOccupancyDir(configDir?: string): string;
export declare function publishCacheOccupancy(pluginRoot: string, configDir?: string): Promise<boolean>;
export declare function readOccupiedPluginRoots(configDir?: string): {
    roots: Set<string>;
    unavailable: boolean;
};
//# sourceMappingURL=cache-occupancy.d.ts.map