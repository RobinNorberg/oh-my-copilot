/** Untrusted text on one line: control and line-separator characters become spaces, then it is cut. */
export function oneLine(text: string | undefined, max = 200): string {
  return (text ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
