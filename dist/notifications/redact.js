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
 * - PEM private key blocks: -----BEGIN ... PRIVATE KEY----- ...
 * - Slack bot tokens: xoxb-...
 * - Slack app tokens: xapp-...
 * - Slack user/workspace tokens: xoxp-..., xoxa-...
 * - Telegram bot tokens in URL paths: /bot123456:ABC.../method
 * - Telegram bot tokens standalone: 123456789:AAF-abc123...
 * - Bearer and Bot authorization values
 * - Anthropic and OpenAI-style keys (sk-ant-api..., sk-proj-..., sk-...)
 * - GitHub tokens (ghp_, gho_, ghs_, ghu_, ghr_, github_pat_), AWS access key IDs
 * - Secret-named JSON fields, plain or escaped: {"password":"..."}, {\"token\":\"...\"}
 * - Credential headers: Authorization (keeping the scheme), Proxy-Authorization,
 *   Cookie, X-*-Key / X-*-Token / X-*-Secret / X-*-Auth
 * - Secret-named assignments and flags: AWS_SECRET_ACCESS_KEY=..., GITHUB_TOKEN="...",
 *   OPENAI_KEY=..., --password=..., --api-key ..., --token -dashvalue, --auth ...
 *   (the value is masked, the name is kept)
 * - Command-specific password arguments: curl -u user:pass, mysql -pSecret,
 *   `... login ... -p secret` (docker, az, podman, ...)
 * - Credentials in URLs: https://user:pass@host, redis://:pass@host
 * - Slack and Discord webhook URL secrets
 * - Padded base64 blobs (16+ characters ending in `=`)
 */
const SECRET_NAME = String.raw `[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|CREDENTIALS?|WEBHOOK|_KEY\b)[A-Za-z0-9_-]*`;
// Short flag names that are secrets only as a whole word (`--auth`, not `--author`).
const FLAG_NAME = String.raw `(?:${SECRET_NAME}|(?:auth|pass|pw|passphrase|key)(?![A-Za-z0-9_-]))`;
const QUOTED_OR_BARE = String.raw `("[^"]*"|'[^']*'|[^\s"']+)`;
// A value an earlier pattern already masked keeps its recognisable prefix (xoxb-****).
const maskValue = (name, sep, value) => `${name}${sep}${value.includes('****') ? value : '****'}`;
export function redactTokens(input) {
    return input
        // PEM private keys: the whole body, up to the END line or the end of the text
        .replace(/(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '$1****')
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
        // OpenAI-style keys: sk-..., sk-proj-...
        .replace(/\b(sk-(?:proj-|live-|test-|svcacct-)?)(?!ant-api)[A-Za-z0-9_-]{8,}/g, '$1****')
        // GitHub tokens: ghp_, gho_, ghs_, github_pat_
        .replace(/\b(ghp_)[A-Za-z0-9]+/g, '$1****')
        .replace(/\b(gho_)[A-Za-z0-9]+/g, '$1****')
        .replace(/\b(ghs_)[A-Za-z0-9]+/g, '$1****')
        .replace(/\b(gh[ur]_)[A-Za-z0-9]+/g, '$1****')
        .replace(/\b(github_pat_)[A-Za-z0-9_]+/g, '$1****')
        // AWS access key IDs: AKIA...
        .replace(/\b(AKIA)[A-Z0-9]{16}\b/g, '$1****')
        // Secret-named JSON fields, also with escaped quotes: {"password":"x"}, {\"token\":\"x\"}
        .replace(new RegExp(String.raw `((\\?["'])${SECRET_NAME}\2\s*:\s*)(?:(\\?["'])(.*?)\3|([^\s,}\]"'\\]+))`, 'gi'), (_m, head, _q, vq, quoted, bare) => vq !== undefined ? `${head}${vq}${(quoted ?? '').includes('****') ? quoted : '****'}${vq}` : `${head}${bare?.includes('****') ? bare : '****'}`)
        // Credential headers: Authorization: Basic x, X-API-Key: x, Cookie: x (the scheme is kept)
        .replace(/\b((?:Proxy-)?Authorization|Cookie|X-[A-Za-z0-9-]*(?:Key|Token|Secret|Auth|Signature)[A-Za-z0-9-]*)(\s*:\s*)((?:Bearer|Basic|Bot|Token|Digest|Negotiate)\s+)?([^"'\\\r\n]+)/gi, (_m, name, sep, scheme, value) => `${name}${sep}${scheme ?? ''}${value.includes('****') ? value : '****'}`)
        // Secret-named env assignments / --flag=value: GITHUB_TOKEN=..., --password="..."
        .replace(new RegExp(String.raw `(\b${SECRET_NAME})(\s*=\s*)${QUOTED_OR_BARE}`, 'gi'), (_m, name, sep, value) => maskValue(name, sep, value))
        // Secret-named flags with a separate value: --token abc, --api-key abc, --token -abc (not --next-flag)
        .replace(new RegExp(String.raw `(--?${FLAG_NAME})(=|\s+)(?!--)${QUOTED_OR_BARE}`, 'gi'), (_m, name, sep, value) => maskValue(name, sep, value))
        // URL credentials: scheme://user:pass@host, scheme://:pass@host
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]+@/gi, '$1****@')
        // curl -u user:pass / --user user:pass (not `-u redis://...`)
        .replace(/(\s(?:-u|--user)(?:=|\s+)["']?[^\s:"']*:)((?!\/)[^\s"']+)/g, (_m, head, value) => `${head}${value.includes('****') ? value : '****'}`)
        // mysql/mariadb -pSecret (attached password)
        .replace(/(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n|;&]*?\s-p)([^\s-][^\s]*)/g, '$1****')
        // `... login ... -p secret` (docker/podman/helm/az login)
        .replace(/(\blogin\b[^\n|;&]*?\s-p\s+)("[^"]*"|'[^']*'|\S+)/g, '$1****')
        // Webhook URL secrets: hooks.slack.com/services/..., discord.com/api/webhooks/...
        .replace(/(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s"']+/gi, '$1****')
        .replace(/(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[^\s"'/?]+/gi, '$1****')
        // Padded base64 blobs: c2VjcmV0cGFzc3dvcmQ=
        .replace(/(?<![A-Za-z0-9+/=*])[A-Za-z0-9+/]{16,}={1,2}(?![A-Za-z0-9+/=])/g, '****');
}
//# sourceMappingURL=redact.js.map