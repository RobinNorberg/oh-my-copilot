# OMP Analytics CLI

Command-line interface for Oh-My-ClaudeCode analytics, token tracking, cost reports, and session management.

## Installation

Install via npm (note: the npm package name is `oh-my-copilot`):

```bash
npm install -g oh-my-copilot
```

The `omg-analytics` command will be available globally.

## Commands

### Stats

Show current session statistics including token usage, costs, and top agents.

```bash
omg-analytics stats
omg-analytics stats --json
```

### Cost Reports

Generate cost reports for different time periods.

```bash
omg-analytics cost daily
omg-analytics cost weekly
omg-analytics cost monthly
omg-analytics cost monthly --json
```

### Session History

View historical session data.

```bash
omg-analytics sessions
omg-analytics sessions --limit 20
omg-analytics sessions --json
```

### Agent Usage

Show agent usage breakdown by tokens and cost.

```bash
omg-analytics agents
omg-analytics agents --limit 20
omg-analytics agents --json
```

### Export Data

Export analytics data to JSON or CSV format.

```bash
# Export cost report
omg-analytics export cost json ./cost-report.json
omg-analytics export cost csv ./cost-report.csv --period weekly

# Export session history
omg-analytics export sessions json ./sessions.json
omg-analytics export sessions csv ./sessions.csv

# Export usage patterns
omg-analytics export patterns json ./patterns.json
```

### Cleanup

Remove old logs and orphaned background tasks.

```bash
omg-analytics cleanup
omg-analytics cleanup --retention 60  # Keep 60 days instead of default 30
```

## Data Storage

Analytics data is stored in:
- `~/.omg/analytics/tokens/` - Token usage logs
- `~/.omg/analytics/sessions/` - Session history
- `~/.omg/analytics/metrics/` - Performance metrics

## JSON Output

All commands support `--json` flag for machine-readable output, useful for integration with other tools or scripts.

```bash
# Example: Parse JSON output with jq
omg-analytics stats --json | jq '.stats.totalCost'
omg-analytics agents --json | jq '.topAgents[0].agent'
```

## Examples

### Daily Cost Tracking

```bash
# Check today's cost
omg-analytics cost daily

# Export weekly report
omg-analytics export cost csv weekly-report.csv --period weekly
```

### Session Analysis

```bash
# View recent sessions
omg-analytics sessions --limit 5

# Export all sessions for analysis
omg-analytics export sessions json all-sessions.json
```

### Agent Performance

```bash
# See which agents are most expensive
omg-analytics agents --limit 10

# Export for spreadsheet analysis
omg-analytics export patterns csv agent-patterns.csv
```

### Maintenance

```bash
# Monthly cleanup (keep 90 days of data)
omg-analytics cleanup --retention 90
```
