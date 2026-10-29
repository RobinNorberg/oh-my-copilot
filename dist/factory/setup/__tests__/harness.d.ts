/**
 * Fakes for the setup wizard tests: one Exec that answers git, gh and az
 * (ADO `devops invoke` calls from the fixtures in ./fixtures/ado, in the
 * src/forge/ado/__tests__/fixtures format), and a scripted Prompter.
 */
import type { ForgeItem } from '../../../forge/types.js';
import type { ExecResult } from '../../../ship/exec.js';
import type { FactorySetupDeps } from '../../../cli/commands/factory-setup.js';
import { type Prompter } from '../intake-pick.js';
export declare const SETUP_ADO_FIXTURES: string;
export declare const GITHUB_ORIGIN = "https://github.com/acme/widgets.git";
export declare const ADO_ORIGIN = "https://dev.azure.com/contoso/Web/_git/web-app";
export declare const QUERY_ID = "0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3";
export interface FakeWorld {
    root: string;
    origin: string;
    /** gh / az (non-invoke) answers keyed by `cmd args…`; missing = exit 1. */
    answers: Record<string, Partial<ExecResult>>;
    labels: string[];
    calls: Array<{
        cmd: string;
        args: string[];
    }>;
}
export declare function tempRoot(): string;
export declare function githubWorld(root?: string): FakeWorld;
export declare function adoWorld(root?: string): FakeWorld;
export declare function fakeExec(world: FakeWorld): FactorySetupDeps['exec'];
export declare function fakeForge(items: Array<Pick<ForgeItem, 'id' | 'title' | 'url'>>, seen?: {
    exec?: unknown;
    queried?: unknown[];
}): FactorySetupDeps['createForge'];
export declare function scriptedPrompter(answers: Array<string | boolean>): Prompter & {
    asked: string[];
};
export declare function setupDeps(world: FakeWorld, over?: Partial<FactorySetupDeps>): FactorySetupDeps;
//# sourceMappingURL=harness.d.ts.map