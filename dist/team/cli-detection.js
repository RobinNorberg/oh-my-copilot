// Re-exports from model-contract.ts for backward compatibility
// and additional CLI detection utilities
export { isCliAvailable, validateCliAvailable, getContract } from './model-contract.js';
// The executable-resolution ritual (where.exe/which, batch shims, timeouts)
// lives in src/platform so every caller shares one hardened implementation.
export { detectAllClis, detectCli, probeCli, } from '../platform/executable-resolution.js';
//# sourceMappingURL=cli-detection.js.map