/**
 * Step 2 of `omg factory setup` (factory forges design §4): the forge CLI is
 * logged in and can read the repository. Every call runs through the setup
 * guard. Nothing an auth command prints on stdout is kept or shown (gh and az
 * can print account data); a failure reports the exit code, the redacted
 * first stderr line and the command that fixes it.
 */
import { type SetupIo } from './guard.js';
export interface AuthCheck {
    name: string;
    ok: boolean;
    detail: string;
}
export interface AuthReport {
    ok: boolean;
    checks: AuthCheck[];
    /** The command that fixes the first failed check. */
    fix?: string;
}
export declare function checkGitHubAuth(io: SetupIo): AuthReport;
export declare function checkAdoAuth(io: SetupIo, env: Readonly<Record<string, string | undefined>>): AuthReport;
//# sourceMappingURL=auth.d.ts.map