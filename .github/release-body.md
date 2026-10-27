# oh-my-copilot v5.14.0

A minor release from v5.13.1 with a **breaking change**: the budget now counts
AI Credits, and the plugin no longer enforces a budget. GitHub Copilot has
billed in AI Credits since 2026-06-01 (1 credit = $0.01, per token). `omg team`
no longer clamps or refuses fan-out, and the old enforcement settings are
deprecated no-ops. Set Copilot's per-session cap (`copilot --max-ai-credits`)
and Copilot admin USD budgets instead.

Install with `npm install -g oh-my-copilot@5.14.0`, or from the plugin
marketplace: `copilot plugin update oh-my-copilot@omc`.

## Breaking

- Budget enforcement is retired. `omg team` no longer clamps or refuses a
  launch, `copilot_run_start` no longer refuses a job, the `budget` hook never
  blocks, and `omg budget status` always exits 0.
- `budget.mode` `"enforce"`, `budget.hardLimit`, `budget.perTeamLimit` and
  `"unit": "premiumRequests"` still load as deprecated no-ops that warn once
  per surface. `--budget-override` is a no-op that warns. `budget.softLimit`
  stays as an advisory threshold.
- Set instead: `copilot --max-ai-credits` or SDK `sessionLimits.maxAiCredits`
  (a soft cap, minimum 30 credits since Copilot CLI 1.0.67), and Copilot admin
  USD budgets at the user, cost-center or org level.

## Changed

- The ledger, `omg budget`, the HUD (`creditBudget`, `cr:`), the smoke checks
  (`scn.team.credits`, `scn.chain.credits`) and the docs all show AI credits.
  Premium requests remain a read-compatible legacy field for annual Pro/Pro+
  plans, and old ledgers load unchanged.
- A `softLimit` written for premium requests now counts AI credits.
- The default tier-2 smoke costs about 0.6 AI credits.

Upgrade notes are in `docs/MIGRATION.md`. Fork deviations (kept and dropped)
are listed in `CHANGELOG.md`.
