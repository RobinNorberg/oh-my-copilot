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
export declare const REDACTED = "***";
export declare function redactAdoSecrets(text: string): string;
//# sourceMappingURL=redact.d.ts.map