// Re-exports from model-contract.ts for backward compatibility
// and additional CLI detection utilities
export { isCliAvailable, validateCliAvailable, getContract, type CliAgentType } from './model-contract.js';

// The executable-resolution ritual (where.exe/which, batch shims, timeouts)
// lives in src/platform so every caller shares one hardened implementation.
export {
  detectAllClis,
  detectCli,
  probeCli,
  type CliInfo,
  type CliProbeResult,
} from '../platform/executable-resolution.js';
