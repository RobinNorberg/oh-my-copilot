/**
 * Lazy loader for Node's built-in `node:sqlite` (unflagged from Node 22.13 / 23.4).
 *
 * Loading the module emits an ExperimentalWarning on current Node lines. Hooks and CLI
 * output must stay free of stderr noise, so only that one warning is filtered, and only
 * while the module loads. Nothing loads `node:sqlite` until a caller needs a database.
 * scripts/lib/node-sqlite.mjs is the hook-side copy; keep both in step.
 */
import type { DatabaseSync } from 'node:sqlite';
export type SqliteDatabase = DatabaseSync;
export type SqliteDatabaseConstructor = typeof DatabaseSync;
/** The `DatabaseSync` constructor. Throws when this Node runtime has no unflagged `node:sqlite`. */
export declare function loadDatabaseSync(): SqliteDatabaseConstructor;
/**
 * The SQLite result-code name of a `node:sqlite` error ('SQLITE_BUSY', 'SQLITE_LOCKED'), else
 * the error's own `code`. node:sqlite reports every failure as ERR_SQLITE_ERROR with the
 * (possibly extended) numeric result code in `errcode`.
 */
export declare function sqliteErrorCode(error: unknown): string | undefined;
//# sourceMappingURL=node-sqlite.d.ts.map