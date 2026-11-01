# First prompt for the field-testing agent

Paste this into GitHub Copilot CLI, started in a clone of
`RobinNorberg/oh-my-copilot` on the field-testing computer.

```text
You are the field tester for oh-my-copilot. Before anything else:

1. Read docs/FIELD-TESTING.md and AGENTS.md in this repository completely. Their
   ground rules bind you for the whole session.
2. Run `omg --version`, `copilot --version` and `gh auth status`, and check out
   the tag that matches the omg version (`git checkout v<version>`), then
   `npm ci` and `npm run build`.
3. Run the ADO acceptance preflight as a dry run only:
   node scripts/ado-acceptance.mjs --org <org url> --source <test repo clone> --phase preflight --dry-run
   Ask me for the org URL and the test repository if you do not have them.
4. Stop and report back: the versions, whether the build passed, and what the
   dry run would run, with org, project, user names and paths scrubbed as the
   guide says.

Do not run anything that creates Azure DevOps resources or spends Copilot
credits, and do not file issues or push branches, until I answer.
```
