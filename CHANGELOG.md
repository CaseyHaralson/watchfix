# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- NDJSON (Newline Delimited JSON) log file support: file sources can now parse structured JSON logs with `format: ndjson` option
- Configurable field extraction for NDJSON logs: `messageField`, `timestampField`, `levelField`
- Level filtering for NDJSON logs: only process lines matching specified log levels
- Support for nested fields in NDJSON config using dot notation (e.g., `log.message`)
- Support for Bunyan numeric log levels (10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal)

## [0.3.0] - 2026-01-31

### Added

- Error classification during analysis: agents now categorize errors as `code`, `infrastructure`, or `configuration`

### Fixed

- Fixed `watchfix status` incorrectly showing "watcher not running" when the watcher was running
- Fixed `watchfix show <id>` displaying "fix attempts: 0" for successfully fixed errors
- New `deferred` status for non-code errors (infrastructure/configuration issues that can't be fixed by code changes)
- Deferred errors show remediation guidance instead of attempting automatic fixes
- Configurable grace period for deferred errors (`deduplication.deferred_grace_period`, default 1h) before re-analyzing
- Retry context for failed fixes: agents now see what was previously tried and why verification failed
- 1-indexed attempt display in logs and context files (attempt 1, 2, 3 instead of 0, 1, 2)

### Changed

- Improved agent prompts to focus on root cause analysis rather than symptom-level fixes
- Agent analysis now explicitly warns against anti-patterns (defensive checks that mask bugs, modifying error-throwing functions)
- Agent prompts now include classification instructions for categorizing error types

## [0.2.2] - 2026-01-30

### Fixed

- Fixed false "recurring error" detection caused by file watcher re-reading entire log file on mtime changes
- Added configurable grace period (`deduplication.fixed_grace_period`, default 10m) to prevent re-detection of recently-fixed errors

## [0.2.1] - 2026-01-30

### Fixed

- Duplicate error entries when logs contain both generic (e.g., `Error:`) and specific (e.g., `TypeError:`) error lines for the same error
- Unhelpful "Agent could not apply fix" message now shows reason (timeout, exit code) when agent fails

## [0.2.0] - 2026-01-29

### Added

- Already-fixed detection: agents now check if an issue still exists before suggesting a fix
- New `resolved` status for errors that were fixed by previous fixes
- Improved fix command output with detailed results and verification status

## [0.1.0] - 2026-01-29

### Added

- Initial release of watchfix CLI
- Log watching from files, commands, and Docker containers
- Configurable error pattern matching with regex support
- AI agent integration (Claude, Gemini, Codex)
- Context file generation for AI agents
- Error deduplication with similarity scoring
- SQLite database for error tracking
- Daemon mode for background watching (Linux/macOS)
- CLI commands: `init`, `watch`, `fix`, `show`, `status`, `stop`, `ignore`, `logs`, `clean`, `config validate`
- YAML configuration file format
- Comprehensive error status lifecycle (pending, suggested, fixing, fixed, ignored, failed)
