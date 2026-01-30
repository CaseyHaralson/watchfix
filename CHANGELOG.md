# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
