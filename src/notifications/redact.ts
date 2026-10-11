/**
 * Token Redaction Utility
 *
 * Masks sensitive tokens in strings to prevent exposure in logs, error messages,
 * and persisted state. Covers Slack, Telegram, and generic Bearer/Bot tokens.
 *
 * @see https://github.com/Yeachan-Heo/oh-my-claudecode/issues/1162
 */

/**
 * Redact sensitive tokens from a string.
 *
 * Patterns masked:
 * - Slack bot tokens: xoxb-...
 * - Slack app tokens: xapp-...
 * - Slack user/workspace tokens: xoxp-..., xoxa-...
 * - Telegram bot tokens in URL paths: /bot123456:ABC.../method
 * - Telegram bot tokens standalone: 123456789:AAF-abc123...
 * - Bearer and Bot authorization values
 * - GitHub tokens (ghp_, gho_, ghs_, ghu_, ghr_, github_pat_), AWS access key IDs
 * - Secret-named assignments and flags: AWS_SECRET_ACCESS_KEY=..., GITHUB_TOKEN="...",
 *   --password=..., --api-key ... (the value is masked, the name is kept)
 * - Credentials in URLs: https://user:pass@host
 */
const SECRET_NAME = String.raw`[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|CREDENTIALS?)[A-Za-z0-9_-]*`;
// A value an earlier pattern already masked keeps its recognisable prefix (xoxb-****).
const maskValue = (name: string, sep: string, value: string) => `${name}${sep}${value.includes('****') ? value : '****'}`;

export function redactTokens(input: string): string {
  return input
    // Slack tokens: xoxb-..., xapp-..., xoxp-..., xoxa-...
    .replace(/\b(xox[bpae]-)[A-Za-z0-9-]+/g, '$1****')
    .replace(/\b(xapp-)[A-Za-z0-9-]+/g, '$1****')
    // Telegram bot tokens in URL paths: /bot123456:ABC.../
    .replace(/\/bot(\d+):[A-Za-z0-9_-]+/g, '/bot$1:****')
    // Telegram bot tokens standalone: 123456789:AAHfoo-bar_Baz
    .replace(/\b(\d{8,12}):[A-Za-z0-9_-]{20,}\b/g, '$1:****')
    // Bearer/Bot authorization values in error strings
    .replace(/(Bearer\s+)\S+/gi, '$1****')
    .replace(/(Bot\s+)\S+/gi, '$1****')
    // Anthropic API keys: sk-ant-api...
    .replace(/\b(sk-ant-api)[A-Za-z0-9_-]+/g, '$1****')
    // GitHub tokens: ghp_, gho_, ghs_, github_pat_
    .replace(/\b(ghp_)[A-Za-z0-9]+/g, '$1****')
    .replace(/\b(gho_)[A-Za-z0-9]+/g, '$1****')
    .replace(/\b(ghs_)[A-Za-z0-9]+/g, '$1****')
    .replace(/\b(gh[ur]_)[A-Za-z0-9]+/g, '$1****')
    .replace(/\b(github_pat_)[A-Za-z0-9_]+/g, '$1****')
    // AWS access key IDs: AKIA...
    .replace(/\b(AKIA)[A-Z0-9]{16}\b/g, '$1****')
    // Secret-named env assignments / --flag=value: GITHUB_TOKEN=..., --password="..."
    .replace(new RegExp(String.raw`(\b${SECRET_NAME})(\s*=\s*)("[^"]*"|'[^']*'|[^\s"']+)`, 'gi'), (_m, name: string, sep: string, value: string) => maskValue(name, sep, value))
    // Secret-named flags with a separate value: --token abc, --api-key abc
    .replace(new RegExp(String.raw`(--?${SECRET_NAME})(\s+)("[^"]*"|'[^']*'|[^\s"'-][^\s"']*)`, 'gi'), (_m, name: string, sep: string, value: string) => maskValue(name, sep, value))
    // URL credentials: scheme://user:pass@host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1****@');
}
