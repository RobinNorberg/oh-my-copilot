// Parse OMC_VITEST_MAX_WORKERS: a positive safe integer, else 0 (= not set).
export function parseMaxWorkers(value) {
  const raw = (value ?? '').trim();
  const n = /^[1-9]\d*$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(n) ? n : 0;
}
