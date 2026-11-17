// Lazy loader for Node's built-in `node:sqlite` (unflagged from Node 22.13 / 23.4).
// Hook-side copy of src/lib/node-sqlite.ts; keep both in step. Loading the module emits an
// ExperimentalWarning on current Node lines, and hooks must not print stderr noise, so only
// that one warning is filtered, and only while the module loads.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let DatabaseCtor = null;

function isSqliteExperimentalWarning(warning, typeOrOptions) {
  const type = typeof typeOrOptions === 'string'
    ? typeOrOptions
    : typeOrOptions?.type ?? (warning instanceof Error ? warning.name : undefined);
  const message = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
  return type === 'ExperimentalWarning' && message.includes('SQLite');
}

/** The `DatabaseSync` constructor. Throws when this Node runtime has no unflagged `node:sqlite`. */
export function loadDatabaseSync() {
  if (DatabaseCtor) return DatabaseCtor;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    return originalEmitWarning.call(process, warning, ...rest);
  };
  try {
    DatabaseCtor = require('node:sqlite').DatabaseSync;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  return DatabaseCtor;
}

/** 'SQLITE_BUSY' / 'SQLITE_LOCKED' for a node:sqlite error (ERR_SQLITE_ERROR + errcode), else its code. */
export function sqliteErrorCode(error) {
  const errcode = error?.errcode;
  if (typeof errcode === 'number') {
    const primary = errcode & 0xff;
    if (primary === 5) return 'SQLITE_BUSY';
    if (primary === 6) return 'SQLITE_LOCKED';
  }
  return typeof error?.code === 'string' ? error.code : undefined;
}
