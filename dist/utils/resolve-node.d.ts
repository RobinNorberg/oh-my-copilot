/**
 * Resolve the absolute path to the Node.js binary.
 *
 * Priority order:
 * 1. process.execPath  — current Node.js process (always available, most reliable)
 * 2. which/where node  — if Node is on PATH
 * 3. nvm versioned paths (~/.nvm/versions/node/<latest>/bin/node)
 * 4. fnm versioned paths (~/.fnm/node-versions/<latest>/installation/bin/node)
 * 5. Homebrew / system paths (/opt/homebrew/bin/node, /usr/local/bin/node, /usr/bin/node)
 * 6. Fallback: bare 'node' (lets the shell resolve at runtime)
 *
 * This is used at setup time to embed the absolute node path into the HUD
 * statusLine command and into .omc-config.json so that hook scripts can
 * locate node even when it is not on PATH (nvm/fnm users, non-interactive
 * shells, issue #892).
 *
 * @returns Absolute path to the node binary, or 'node' as a last-resort fallback.
 */
export declare function resolveNodeBinary(): string;
/**
 * Pick the latest semver version from a list of version strings.
 * Handles both "v20.0.0" and "20.0.0" formats.
 * Returns undefined if the list is empty.
 */
export declare function pickLatestVersion(versions: string[]): string | undefined;
//# sourceMappingURL=resolve-node.d.ts.map