import { describe, expect, it } from 'vitest';

import { isCredentialEnvKey } from '../copilot-session-env.js';

describe('isCredentialEnvKey', () => {
  const dropped = [
    'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'NPM_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'GIT_CONFIG_COUNT', 'GCM_CREDENTIAL_STORE',
    // Credential-carrying URLs and strings.
    'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK', 'npm_config__auth', 'NPM_CONFIG__AUTH', 'BASIC_AUTH', '_AUTH', 'AUTH',
    'AUTH_HEADER', 'SENTRY_DSN', 'SQL_CONNSTR', 'DB_CONNECTION_STRING', 'SERVICEBUS_CONNECTIONSTRING', 'DB_PWD',
    'DATABASE_URL', 'REDIS_URL', 'MONGODB_URI', 'DOCKER_AUTH_CONFIG',
  ];
  const kept = [
    'PATH', 'PWD', 'OLDPWD', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'JAVA_HOME', 'ANDROID_HOME',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'AUTHOR', 'AUTHORS_FILE', 'OAUTH_CLIENT_ID', 'OMC_TEAM_WORKER',
    'OMC_STATE_DIR', 'ANTHROPIC_MODEL', 'COPILOT_CLI_PATH', 'GH_CONFIG_DIR', 'GIT_TERMINAL_PROMPT',
  ];
  it.each(dropped)('drops %s', (key) => { expect(isCredentialEnvKey(key)).toBe(true); });
  it.each(kept)('keeps %s', (key) => { expect(isCredentialEnvKey(key)).toBe(false); });
  it('matches in any letter case', () => {
    expect(isCredentialEnvKey('gh_token')).toBe(true);
    expect(isCredentialEnvKey('Database_Url')).toBe(true);
  });
});
