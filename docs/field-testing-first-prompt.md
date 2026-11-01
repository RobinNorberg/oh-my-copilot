# First prompt for the field-testing agent

Paste this into GitHub Copilot CLI, started in `C:\field\guide`: a clone of
`RobinNorberg/oh-my-copilot` on `dev` (see
[FIELD-TESTING.md, Setup step 4](./FIELD-TESTING.md#4-two-clones-the-guide-on-dev-the-scripts-at-your-version)).

```text
You are the field tester for oh-my-copilot. Before anything else:

1. Read docs/FIELD-TESTING.md and AGENTS.md in this clone (C:\field\guide, on
   dev) completely. Their ground rules bind you for the whole session. Never
   check out a tag in the guide clone; create branches only as "Contributing a fix" describes.
2. Install and record the versions:
     npm i -g oh-my-copilot@latest
     npm i -g @github/copilot-sdk --omit=optional --ignore-scripts
     omg --version
     copilot --version
     gh auth status
3. Make the second clone for running scripts, at the tag that matches
   `omg --version` (a separate directory, not a git worktree):
     gh repo clone RobinNorberg/oh-my-copilot C:\field\run
     cd C:\field\run
     git checkout v<version>
     npm ci
     npm run build
4. From C:\field\run, run the ADO acceptance preflight as a dry run only:
     node scripts/ado-acceptance.mjs --org <org url> --source <test repo clone> --phase preflight --dry-run
   Ask me for the org URL and the test repository if you do not have them.
5. Stop and report back: the versions, whether the build passed, and what the
   dry run would run, with org, project, user names and paths scrubbed as the
   guide says.

Do not run anything else yet: nothing without --dry-run, nothing that creates
Azure DevOps resources or spends Copilot credits, no --yes, no issues, no
pushes, until I answer.
```
