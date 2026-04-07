export interface UnifiedMcpRegistryEntry {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    timeout?: number;
}
export type UnifiedMcpRegistry = Record<string, UnifiedMcpRegistryEntry>;
export interface UnifiedMcpRegistrySyncResult {
    registryPath: string;
    copilotConfigPath: string;
    codexConfigPath: string;
    registryExists: boolean;
    bootstrappedFromCopilot: boolean;
    serverNames: string[];
    copilotChanged: boolean;
    codexChanged: boolean;
}
export interface UnifiedMcpRegistryStatus {
    registryPath: string;
    copilotConfigPath: string;
    codexConfigPath: string;
    registryExists: boolean;
    serverNames: string[];
    copilotMissing: string[];
    copilotMismatched: string[];
    codexMissing: string[];
    codexMismatched: string[];
}
export declare function getUnifiedMcpRegistryPath(): string;
export declare function getCopilotMcpConfigPath(): string;
export declare function getCodexConfigPath(): string;
export declare function extractCopilotMcpRegistry(settings: Record<string, unknown>): UnifiedMcpRegistry;
export declare function applyRegistryToCopilotSettings(settings: Record<string, unknown>): {
    settings: Record<string, unknown>;
    changed: boolean;
};
export declare function renderManagedCodexMcpBlock(registry: UnifiedMcpRegistry): string;
export declare function syncCodexConfigToml(existingContent: string, registry: UnifiedMcpRegistry): {
    content: string;
    changed: boolean;
};
export declare function syncUnifiedMcpRegistryTargets(settings: Record<string, unknown>): {
    settings: Record<string, unknown>;
    result: UnifiedMcpRegistrySyncResult;
};
export declare function inspectUnifiedMcpRegistrySync(): UnifiedMcpRegistryStatus;
//# sourceMappingURL=mcp-registry.d.ts.map