/**
 * Lazy loader for Node's built-in `node:sqlite` (unflagged from Node 22.13 / 23.4).
 *
 * Loading the module emits an ExperimentalWarning on current Node lines. Hooks and CLI
 * output must stay free of stderr noise, so only that one warning is filtered, and only
 * while the module loads. Nothing loads `node:sqlite` until a caller needs a database.
 * scripts/lib/node-sqlite.mjs is the hook-side copy; keep both in step.
 */

import { createRequire } from 'module';
import type { DatabaseSync } from 'node:sqlite';

export type SqliteDatabase = DatabaseSync;
export type SqliteDatabaseConstructor = typeof DatabaseSync;

const require = createRequire(
  import.meta.url || (typeof __filename === 'string' ? __filename : process.cwd() + '/'),
);
let DatabaseCtor: SqliteDatabaseConstructor | null = null;

function isSqliteExperimentalWarning(warning: unknown, typeOrOptions: unknown): boolean {
  const type = typeof typeOrOptions === 'string'
    ? typeOrOptions
    : (typeOrOptions as { type?: unknown } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined);
  const message = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
  return type === 'ExperimentalWarning' && message.includes('SQLite');
}

/** The `DatabaseSync` constructor. Throws when this Node runtime has no unflagged `node:sqlite`. */
export function loadDatabaseSync(): SqliteDatabaseConstructor {
  if (DatabaseCtor) return DatabaseCtor;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function emitWarning(this: unknown, warning: string | Error, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    return (originalEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    DatabaseCtor = (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  return DatabaseCtor;
}

/**
 * The SQLite result-code name of a `node:sqlite` error ('SQLITE_BUSY', 'SQLITE_LOCKED'), else
 * the error's own `code`. node:sqlite reports every failure as ERR_SQLITE_ERROR with the
 * (possibly extended) numeric result code in `errcode`.
 */
export function sqliteErrorCode(error: unknown): string | undefined {
  const { code, errcode } = (error ?? {}) as { code?: unknown; errcode?: unknown };
  if (typeof errcode === 'number') {
    const primary = errcode & 0xff;
    if (primary === 5) return 'SQLITE_BUSY';
    if (primary === 6) return 'SQLITE_LOCKED';
  }
  return typeof code === 'string' ? code : undefined;
}
