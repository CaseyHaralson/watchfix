# CLAUDE.md - Project Guidelines for Claude Code

## Project Overview

**watchfix** is a CLI tool that watches log files and automatically applies fixes based on detected error patterns.

### Key Development Commands

```bash
npm run build    # Compile TypeScript
npm test         # Run test suite
npm run lint     # Check code style
```

## Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/) to enable automated changelog generation and semantic versioning.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type       | Description                                      | Version Bump |
|------------|--------------------------------------------------|--------------|
| `feat`     | New feature                                      | MINOR        |
| `fix`      | Bug fix                                          | PATCH        |
| `docs`     | Documentation only                               | -            |
| `style`    | Code style (formatting, semicolons, etc.)        | -            |
| `refactor` | Code change that neither fixes nor adds features | -            |
| `test`     | Adding or correcting tests                       | -            |
| `chore`    | Maintenance tasks                                | -            |

### Breaking Changes

Breaking changes trigger a MAJOR version bump. Indicate them by:
- Adding `!` after type: `feat!: remove deprecated API`
- Or adding `BREAKING CHANGE:` in the footer

### Scope (optional)

Indicates the area of the codebase affected. Examples: `cli`, `fixer`, `db`

### Examples

```
feat(cli): add --verbose flag to watch command
fix(fixer): handle empty log files gracefully
docs: update CLI usage examples
feat!: remove deprecated --legacy flag
```

## Branching Strategy

Create branches from `main` using these prefixes:

| Prefix      | Purpose              |
|-------------|----------------------|
| `feat/`     | New features         |
| `fix/`      | Bug fixes            |
| `docs/`     | Documentation        |
| `chore/`    | Maintenance          |
| `refactor/` | Refactoring          |
| `release/`  | Release preparation  |

**Naming conventions:**
- Use lowercase
- Use hyphens as separators
- No spaces

Example: `feat/add-retry-logic`

## Pull Request Workflow

1. Create branch from `main`
2. Make changes with conventional commits
3. Push branch and create PR
4. Ensure CI passes (lint, test, build)
5. Squash merge with conventional commit message as PR title

## Changelog Updates

This project follows [Keep a Changelog](https://keepachangelog.com/) format. Categories map to commit types:

| Category       | Source                              |
|----------------|-------------------------------------|
| **Added**      | `feat:` commits                     |
| **Changed**    | Changes to existing functionality   |
| **Deprecated** | Soon-to-be removed features         |
| **Removed**    | Removed features                    |
| **Fixed**      | `fix:` commits                      |
| **Security**   | Security fixes                      |

Add entries under the `## [Unreleased]` section. When commits follow Conventional Commits, the changelog can be generated from git history.

## Release Process

1. **Ask the user** what version bump is needed (major/minor/patch)
2. Create release branch: `release/vX.Y.Z`
3. Update version in `package.json`
4. Update `CHANGELOG.md`:
   - Add new version heading with date: `## [X.Y.Z] - YYYY-MM-DD`
   - Move items from `[Unreleased]` to the new version section
   - Keep an empty `[Unreleased]` section for future changes
5. Commit: `chore: prepare release vX.Y.Z`
6. Push and create PR to main
7. After PR merge:
   - Pull latest main
   - Create tag: `git tag vX.Y.Z && git push origin vX.Y.Z`
   - Remind user to run `npm publish` (requires npm login)

## Optional Tooling

Consider adding `standard-version` or `release-please` to automate version bumps and changelog generation from conventional commits.
