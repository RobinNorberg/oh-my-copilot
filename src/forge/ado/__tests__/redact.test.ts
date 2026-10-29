import { describe, expect, it } from 'vitest';
import { redactAdoSecrets } from '../redact.js';

const CLASSIC = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
const MODERN = `${'A1b2C3d4E5'.repeat(7)}x9Y8z7AZDOq1W2`;

describe('redactAdoSecrets', () => {
  it('fixtures have the PAT lengths', () => {
    expect(CLASSIC).toHaveLength(52);
    expect(MODERN).toHaveLength(84);
  });

  it('masks a 52-character base32 PAT', () => {
    expect(redactAdoSecrets(`token ${CLASSIC} rejected`)).toBe('token *** rejected');
    expect(redactAdoSecrets(`"pat":"${CLASSIC}"`)).toBe('"pat":"***"');
  });

  it('masks an 84-character PAT with the AZDO signature', () => {
    expect(redactAdoSecrets(`pat=${MODERN}.`)).toBe('pat=***.');
  });

  it('masks Authorization headers and Basic/Bearer credentials', () => {
    expect(redactAdoSecrets('Authorization: Basic OnRva2VuMTIzNDU2Nzg5MA==\nnext')).toBe('Authorization: ***\nnext');
    expect(redactAdoSecrets("{'Authorization': 'Bearer eyJhbGciOi.x.y'}")).toBe("{'Authorization': '***'}");
    expect(redactAdoSecrets('header Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig')).toBe('header Bearer ***');
    expect(redactAdoSecrets('using basic dXNlcjpwYXNz')).toBe('using basic ***');
  });

  it('leaves look-alikes alone: shas, GUIDs, short words, 53-char and 84-char runs without AZDO', () => {
    const text = [
      '1111111111111111111111111111111111111111',
      '6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c',
      `${CLASSIC}a`,
      'B'.repeat(84),
      'Basic auth is disabled',
      'TF401232: Work item 404 does not exist',
    ].join(' ');
    expect(redactAdoSecrets(text)).toBe(text);
  });
});
