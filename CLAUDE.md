# CLAUDE.md

## Project Basics
- TypeScript project with npm
- Key commands: `npm run build`, `npm test`, `npm run lint`

## Repo Structure
- src/: source code
  - agents/: AI agent implementations
  - cli/: command-line interface
  - config/: configuration handling
  - db/: database queries and persistence
  - fixer/: error fixing logic
  - utils/: shared utilities
  - watcher/: log file watching
- test/: test suite

## Branching and PRs
- Never commit directly to main
- Create descriptive branches (feat/*, fix/*, docs/*, chore/*, refactor/*, release/*)
- Use `gh pr create` for PRs

## Working Agreement
- After making changes, run `npm run lint`
- Before committing, run `npm test && npm run build`
- Before committing, check if changes need CHANGELOG entry
- Use conventional commit format: `type(scope): description`

## Changelog Rules
- User-facing changes in src/ need CHANGELOG entry under [Unreleased]
- NOT needed for: test-only, docs, refactors with no behavior change

## Commit Examples
```
feat(cli): add --verbose flag
fix(fixer): handle empty log files
docs: update CLI examples
feat!: breaking change description
```

## Release Workflow
1. Read CHANGELOG.md [Unreleased] section
2. Suggest version based on changes (feat = minor, fix = patch, breaking = major)
3. Confirm version with user
4. `git checkout -b release/vX.Y.Z`
5. Update package.json version
6. Update CHANGELOG.md (move Unreleased to new version section with date)
7. `git commit -am "chore: prepare release vX.Y.Z"`
8. `git push -u origin release/vX.Y.Z && gh pr create`
9. After merge: `git checkout main && git pull origin main`
10. `git tag vX.Y.Z && git push origin vX.Y.Z`
11. Create GitHub release: `gh release create vX.Y.Z --title "vX.Y.Z" --notes-from-tag` (use changelog notes for body)
12. Remind user to `npm publish`
