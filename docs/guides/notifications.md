# Notifications

OMC can send session summaries and event notifications to Microsoft Teams, Discord, Telegram, Slack, and custom webhooks.

## Supported Platforms

| Platform | Transport | Tag/Mention Support |
|----------|-----------|---------------------|
| Microsoft Teams | Power Automate Workflows / O365 Connectors | `DisplayName:AAD-Object-ID` for @mentions |
| Discord | Webhook | `@here`, `@everyone`, user IDs, `role:<id>` |
| Telegram | Bot API | `@username` |
| Slack | Webhook | `<@MEMBER_ID>`, `<!channel>`, `<!here>`, `<!subteam^GROUP_ID>` |
| Webhook | Custom HTTP POST | N/A |
| File | Local file append | N/A |

## Quick Setup

```bash
# Microsoft Teams
omc config-stop-callback teams --enable --webhook <power-automate-url>

# Discord
omc config-stop-callback discord --enable --webhook <discord-webhook-url>

# Telegram
omc config-stop-callback telegram --enable --token <bot-token> --chat <chat-id>

# Slack
omc config-stop-callback slack --enable --webhook <slack-webhook-url>

# Custom webhook
omc config-stop-callback webhook --enable --webhook <url>

# File output
omc config-stop-callback file --enable --path ./session-log.txt
```

Or use the interactive setup:

```bash
/oh-my-copilot:configure-notifications
```

## Microsoft Teams

Teams notifications are sent as **Adaptive Cards** via Power Automate Workflows or legacy O365 Connector webhooks.

### Setup

1. In Teams, create a Power Automate Workflow that accepts incoming webhooks
2. Copy the workflow URL (starts with `https://*.logic.azure.com/...` or `https://*.webhook.office.com/...`)
3. Configure:

```bash
omc config-stop-callback teams --enable --webhook <workflow-url>
```

### Tag Mentions

Teams uses `DisplayName:AAD-Object-ID` pairs for @mentions in Adaptive Cards:

```bash
omc config-stop-callback teams --enable --webhook <url> \
  --tag-list "John Doe:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

To find a user's AAD Object ID: Azure Portal → Azure Active Directory → Users → select user → Object ID.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OMC_MICROSOFT_TEAMS=1` | Enable Teams notifications |
| `OMC_MICROSOFT_TEAMS_WEBHOOK_URL` | Teams webhook URL |

## Discord

```bash
omc config-stop-callback discord --enable --webhook <url> \
  --tag-list "@here,123456789012345678,role:987654321098765432"
```

Tag formats: `@here`, `@everyone`, numeric user IDs, `role:<id>`.

## Telegram

```bash
omc config-stop-callback telegram --enable --token <bot-token> --chat <chat-id> \
  --tag-list "@alice,@bob"
```

Usernames are automatically prefixed with `@`.

## Slack

```bash
omc config-stop-callback slack --enable --webhook <url> \
  --tag-list "<!here>,<@U1234567890>"
```

Tag formats: `<@MEMBER_ID>`, `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^GROUP_ID>`.

## Managing Tags

```bash
# Add a tag incrementally
omc config-stop-callback telegram --add-tag charlie

# Remove a tag
omc config-stop-callback discord --remove-tag @here

# Clear all tags
omc config-stop-callback discord --clear-tags
```

## Notification Profiles

Create named profiles for different notification configurations:

```bash
omc config-notify-profile work --type teams --webhook <url> --tag-list "..."
omc config-notify-profile personal --type telegram --token <token> --chat <id>
```

## Notes

- `file` callbacks ignore tag options
- All webhooks are validated for correct URL format before saving
- Teams supports both Power Automate Workflows and legacy O365 Connector URLs
- Notifications fire on session completion by default; per-event configuration available in `.omg-config.json`
