import type { TeamConfig, TeamGovernance, TeamManifestV2, TeamPolicy, TeamTransportPolicy } from './types.js';
export type LifecycleProfile = 'default' | 'linked_ralph';
export declare const DEFAULT_TEAM_TRANSPORT_POLICY: TeamTransportPolicy;
export declare const DEFAULT_TEAM_GOVERNANCE: TeamGovernance;
type LegacyPolicyLike = Partial<TeamPolicy> & Partial<TeamGovernance>;
export declare function normalizeTeamTransportPolicy(policy?: LegacyPolicyLike | null): TeamTransportPolicy;
export declare function normalizeTeamGovernance(governance?: Partial<TeamGovernance> | null, legacyPolicy?: LegacyPolicyLike | null): TeamGovernance;
export declare function normalizeTeamManifest(manifest: TeamManifestV2): TeamManifestV2;
export declare function getConfigGovernance(config: TeamConfig | null | undefined): TeamGovernance;
/**
 * Resolve the effective lifecycle profile for a team.
 * Manifest takes precedence over config; defaults to 'default'.
 */
export declare function resolveLifecycleProfile(config?: Pick<TeamConfig, 'lifecycle_profile'> | null, manifest?: Pick<TeamManifestV2, 'lifecycle_profile'> | null): LifecycleProfile;
/** Returns true when the effective lifecycle profile is 'linked_ralph' */
export declare function isLinkedRalphProfile(config?: Pick<TeamConfig, 'lifecycle_profile'> | null, manifest?: Pick<TeamManifestV2, 'lifecycle_profile'> | null): boolean;
export {};
//# sourceMappingURL=governance.d.ts.map