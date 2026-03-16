# Review: Bug Fixes and Infrastructure Changes

Scope reviewed:
- `src/team/shell-path.ts`
- `src/hud/render.ts`
- `src/notifications/slack-socket.ts`
- `src/notifications/reply-listener.ts`
- `src/hooks/bridge-normalize.ts`
- `src/openclaw/index.ts`
- `bridge/gyoshu_bridge.py`

## 1) src/team/shell-path.ts

### (a) Bugs or logic errors
- `WARN`: Fish shell remains a functional fallback, not a real fix. The code always invokes `['-ilc', 'env']` (`src/team/shell-path.ts:42`), which fish does not support; fish users fall back to current `process.env.PATH` (`src/team/shell-path.ts:59`) and may miss login-shell PATH additions.

### (b) Missing edge case handling
- `WARN`: A transient timeout/failure is cached permanently for the process lifetime. If shell spawn fails once, fallback PATH is cached in `_resolved` (`src/team/shell-path.ts:14`, `src/team/shell-path.ts:59`) and never retried except test-only reset.

### (c) Potential security issues
- No critical issue found. `SHELL` is user-controlled, but threat model here is local-user context.

### (d) Overall assessment
- `WARN`

## 2) src/hud/render.ts

### (a) Bugs or logic errors
- `WARN`: For very small widths (`maxWidth` 1 or 2), truncation returns `...` (`src/hud/render.ts:86`) with visible width 3, exceeding the requested max width and violating the function contract comment.

### (b) Missing edge case handling
- `WARN`: ANSI regex (`src/hud/render.ts:34`) does not cover all terminal escape variants (e.g., OSC terminated by `ESC \\`), so some sequences may be mis-measured/truncated incorrectly.

### (c) Potential security issues
- None identified.

### (d) Overall assessment
- `WARN`

## 3) src/notifications/slack-socket.ts

### (a) Bugs or logic errors
- `WARN`: Reconnect scheduling has no guard against an already-pending timer (`src/notifications/slack-socket.ts:212-231`). Under repeated close/error edge sequences, this can queue overlapping reconnect attempts.

### (b) Missing edge case handling
- `WARN`: `start()`/`stop()` lifecycle is one-way (`isShuttingDown` is never reset). If a caller reuses the same client instance after `stop()`, reconnect will never resume.

### (c) Potential security issues
- No critical issue found. Envelope ACK and channel/subtype filtering are implemented.

### (d) Overall assessment
- `WARN`

## 4) src/notifications/reply-listener.ts

### (a) Bugs or logic errors
- No blocking logic error found in reviewed paths.
- The Telegram fixes appear present:
  - offset advances for ignored/non-message updates (`src/notifications/reply-listener.ts:618-664`)
  - at-most-once offset persistence before injection (`src/notifications/reply-listener.ts:662-664`)
  - confirmation reply targets the original message (`reply_to_message_id`) (`src/notifications/reply-listener.ts:676`)

### (b) Missing edge case handling
- Minor: offset uses truthy check (`src/notifications/reply-listener.ts:576`), so value `0` would not increment. Likely negligible for real Telegram update IDs.

### (c) Potential security issues
- No major issue found. Authorization checks, sanitization, and secure file writes are in place.

### (d) Overall assessment
- `PASS`

## 5) src/hooks/bridge-normalize.ts

### (a) Bugs or logic errors
- `WARN`: Sensitive-hook allowlist likely drops camelCase equivalents for key passthrough fields. `KNOWN_FIELDS` includes snake_case names (`permission_mode`, `tool_use_id`, `agent_id`, etc.) but not camelCase counterparts (`src/hooks/bridge-normalize.ts:91-103`). If a sensitive hook input is camelCase-only, these values can be silently dropped.

### (b) Missing edge case handling
- `WARN`: Fast-path camelCase normalization (`src/hooks/bridge-normalize.ts:151-172`) depends on the same allowlist behavior, so the camelCase data-loss edge case is amplified.

### (c) Potential security issues
- No critical issue found in sensitive-hook filtering itself; unknown fields are dropped for sensitive hooks.

### (d) Overall assessment
- `WARN`

## 6) src/openclaw/index.ts

### (a) Bugs or logic errors
- No direct logic break found in this file.

### (b) Missing edge case handling
- `WARN` (cross-file reliability): `wakeOpenClaw()` is robust, but stop-hook delivery in short-lived `copilot -p` flows remains best-effort unless awaited by caller. Stop path is still fire-and-forget in bridge wrapper (`src/hooks/bridge.ts:826-833`, stop wake call at `src/hooks/bridge.ts:536`). Session-end path is awaited in `src/hooks/session-end/index.ts:451-460`.

### (c) Potential security issues
- No major issue found. Context is explicitly whitelisted before dispatch.

### (d) Overall assessment
- `WARN`

## 7) bridge/gyoshu_bridge.py

### (a) Bugs or logic errors
- `FAIL`: Windows fallback detection is incorrect. `HAS_AF_UNIX = hasattr(socket_module, "AF_UNIX")` (`bridge/gyoshu_bridge.py:707`) can be `True` on modern Windows, which forces Unix-socket mode (`bridge/gyoshu_bridge.py:771-774`) and skips TCP + `bridge.port` creation (`bridge/gyoshu_bridge.py:780-788`).
- This conflicts with Node bridge-manager behavior, which hardcodes TCP fallback on win32 and waits for `bridge.port` (`src/tools/python-repl/bridge-manager.ts:198`, `src/tools/python-repl/bridge-manager.ts:216-219`). Result: bridge readiness failures on Windows.

### (b) Missing edge case handling
- `WARN`: Port-file write is non-atomic (`bridge/gyoshu_bridge.py:787-788`), though low-risk in practice.

### (c) Potential security issues
- TCP mode correctly binds localhost and rejects non-127.0.0.1 clients (`bridge/gyoshu_bridge.py:783`, `bridge/gyoshu_bridge.py:816-818`). No critical issue here.

### (d) Overall assessment
- `FAIL`

---

## Summary
- `PASS`: 1 file
- `WARN`: 5 files
- `FAIL`: 1 file (`bridge/gyoshu_bridge.py`)

Most critical regression risk before release is the Windows AF_UNIX/TCP fallback mismatch between Python bridge and Node bridge-manager.
