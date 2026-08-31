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
 * Read config.json from the OMC state root for the given directory (or cwd).
 * Resolution goes through resolveOmcPath so OMC_STATE_DIR and .omc-workspace
 * anchoring apply, rather than assuming a literal `<dir>/.omg`.
 * Returns null if the file doesn't exist or cannot be read.
 */
export declare function readOmpConfig(dir?: string): OmpConfig | null;
/**
 * Get ADO config, merging .omg/config.json with git remote detection.
 * Config file values take precedence over auto-detected values.
 */
export declare function getAdoConfig(dir?: string): AdoConfig;
//# sourceMappingURL=ado-config.d.ts.map