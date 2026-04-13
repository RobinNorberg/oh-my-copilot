export interface AdoConfig {
    org?: string;
    project?: string;
    defaultWorkItemType?: string;
    areaPath?: string;
    iterationPath?: string;
    /** When code repo and work items live in different ADO projects */
    workItemOrg?: string;
    workItemProject?: string;
}
export interface OmpConfig {
    version?: number;
    platform?: string;
    ado?: AdoConfig;
}
/**
 * Read .omcp/config.json from the given directory (or cwd).
 * Returns null if the file doesn't exist.
 */
export declare function readOmpConfig(dir?: string): OmpConfig | null;
/**
 * Get ADO config, merging .omcp/config.json with git remote detection.
 * Config file values take precedence over auto-detected values.
 */
export declare function getAdoConfig(dir?: string): AdoConfig;
//# sourceMappingURL=ado-config.d.ts.map