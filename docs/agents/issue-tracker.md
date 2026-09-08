# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the GitHub CLI for all operations.

## Repository

- **Repository**: tickernelz/omp-fabric
- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open`
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue and apply the appropriate triage label.

## Blocking

Use GitHub native issue dependencies when available. Otherwise record each dependency in a `Blocked by` line in the issue body.
