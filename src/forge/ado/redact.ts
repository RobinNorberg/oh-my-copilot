/**
 * Mask Azure DevOps credentials in text the adapter shows or stores: az
 * stderr in error messages, recorded fixtures (factory forges design §8.2,
 * critic amendments §A.8).
 *
 * - Classic PATs: 52 characters of lowercase base32 (a-z, 2-7).
 * - Current PATs: 84 alphanumeric characters carrying the `AZDO` signature.
 * - `Authorization:` header values and `Basic`/`Bearer` credentials, which
 *   az prints with `--debug` (the guard refuses that flag; this is the
 *   second line).
 */

export const REDACTED = '***';

const CLASSIC_PAT = /(?<![A-Za-z0-9])[a-z2-7]{52}(?![A-Za-z0-9])/g;
const AZDO_PAT = /(?<![A-Za-z0-9])(?=[A-Za-z0-9]{84}(?![A-Za-z0-9]))[A-Za-z0-9]*AZDO[A-Za-z0-9]*/g;
/** The whole header value, up to the end of the line or a quote. */
const AUTH_HEADER = /(\bAuthorization['"]?\s*[:=]\s*['"]?)[^\r\n'"]+/gi;
const SCHEME = /\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{6,}/gi;

export function redactAdoSecrets(text: string): string {
  return text
    .replace(AUTH_HEADER, `$1${REDACTED}`)
    .replace(SCHEME, `$1 ${REDACTED}`)
    .replace(AZDO_PAT, REDACTED)
    .replace(CLASSIC_PAT, REDACTED);
}
