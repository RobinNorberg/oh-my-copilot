/**
 * LSP Aggregator - Fallback strategy for directory diagnostics
 *
 * When tsc is not available or not suitable, iterate through files
 * and collect LSP diagnostics for each.
 */
import { readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { lspClientManager, getServerForFile } from '../lsp/index.js';
import { LSP_DIAGNOSTICS_WAIT_MS } from './index.js';
/**
 * Recursively find files with given extensions
 */
function findFiles(directory, extensions, ignoreDirs = []) {
    const results = [];
    const ignoreDirSet = new Set(ignoreDirs);
    function walk(dir) {
        try {
            const entries = readdirSync(dir);
            for (const entry of entries) {
                const fullPath = join(dir, entry);
                try {
                    const stat = statSync(fullPath);
                    if (stat.isDirectory()) {
                        // Skip ignored directories
                        if (!ignoreDirSet.has(entry)) {
                            walk(fullPath);
                        }
                    }
                    else if (stat.isFile()) {
                        const ext = extname(fullPath);
                        if (extensions.includes(ext)) {
                            results.push(fullPath);
                        }
                    }
                }
                catch (_error) {
                    // Skip files/dirs we can't access
                    continue;
                }
            }
        }
        catch (_error) {
            // Skip directories we can't read
            return;
        }
    }
    walk(directory);
    return results;
}
/**
 * Run LSP diagnostics on all TypeScript/JavaScript files in a directory
 * @param directory - Project directory to scan
 * @param extensions - File extensions to check (default: ['.ts', '.tsx', '.js', '.jsx'])
 * @returns Aggregated diagnostics from all files
 */
export async function runLspAggregatedDiagnostics(directory, extensions = ['.ts', '.tsx', '.js', '.jsx']) {
    // Find all matching files
    const files = findFiles(directory, extensions, ['node_modules', 'dist', 'build', '.git']);
    const allDiagnostics = [];
    let filesChecked = 0;
    const skippedFiles = [];
    const installHintSet = new Set();
    for (const file of files) {
        // Guards future callers passing custom extensions with no registered LSP; redundant under default extension list.
        if (!getServerForFile(file)) {
            skippedFiles.push({ file, reason: 'no language server registered for extension' });
            continue;
        }
        try {
            await lspClientManager.runWithClientLease(file, async (client) => {
                // Open document to trigger diagnostics
                await client.openDocument(file);
                // Wait for the server to publish diagnostics via textDocument/publishDiagnostics
                // notification instead of using a fixed delay. Falls back to LSP_DIAGNOSTICS_WAIT_MS
                // as a timeout so we don't hang forever on servers that omit the notification.
                await client.waitForDiagnostics(file, LSP_DIAGNOSTICS_WAIT_MS);
                // Get diagnostics for this file
                const diagnostics = client.getDiagnostics(file);
                // Add to aggregated results
                for (const diagnostic of diagnostics) {
                    allDiagnostics.push({
                        file,
                        diagnostic
                    });
                }
                // Must remain the last statement in the lease callback to preserve filesChecked + skippedFiles.length === files.length.
                filesChecked++;
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Regex pinned to throw at src/tools/lsp/client.ts:186 — keep header literal in formatLspResult in sync.
            const match = message.match(/^Language server '([^']+)' not found\.\nInstall with: (.+)$/s);
            if (match) {
                installHintSet.add(match[2].trim());
                skippedFiles.push({ file, reason: `missing language server: ${match[1]}` });
            }
            else {
                skippedFiles.push({ file, reason: message });
            }
        }
    }
    // Count errors and warnings
    const errorCount = allDiagnostics.filter(d => d.diagnostic.severity === 1).length;
    const warningCount = allDiagnostics.filter(d => d.diagnostic.severity === 2).length;
    const installHints = Array.from(installHintSet);
    const allFilesSkipped = filesChecked === 0 && files.length > 0;
    return {
        success: errorCount === 0 && !allFilesSkipped,
        diagnostics: allDiagnostics,
        errorCount,
        warningCount,
        filesChecked,
        skippedFiles,
        installHints,
    };
}
//# sourceMappingURL=lsp-aggregator.js.map