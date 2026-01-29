# Project Structure

```
watchfix/
├── src/
│   ├── cli/
│   │   ├── index.ts              # Entry point, commander setup
│   │   └── commands/
│   │       ├── init.ts
│   │       ├── watch.ts
│   │       ├── stop.ts
│   │       ├── status.ts
│   │       ├── fix.ts
│   │       ├── show.ts
│   │       ├── ignore.ts
│   │       ├── logs.ts
│   │       ├── config.ts         # config validate
│   │       ├── clean.ts          # context cleanup
│   │       └── version.ts
│   ├── agents/
│   │   ├── types.ts              # AgentConfig, AgentResult, Agent interface
│   │   ├── base.ts               # BaseAgent with spawn/output/timeout logic
│   │   ├── claude.ts             # Claude-specific handling (if any)
│   │   ├── gemini.ts             # Gemini-specific handling (if any)
│   │   ├── codex.ts              # Codex-specific handling (if any)
│   │   ├── defaults.ts           # AGENT_DEFAULTS
│   │   └── index.ts              # createAgent factory
│   ├── watcher/
│   │   ├── index.ts              # Watcher orchestrator, event queue
│   │   ├── sources/
│   │   │   ├── types.ts          # LogSource interface
│   │   │   ├── file.ts           # FileSource
│   │   │   ├── docker.ts         # DockerSource
│   │   │   └── command.ts        # CommandSource
│   │   ├── patterns.ts           # Error detection patterns
│   │   └── parser.ts             # Multi-line buffering, context window
│   ├── fixer/
│   │   ├── index.ts              # Fix orchestrator
│   │   ├── context.ts            # Context file generation
│   │   ├── output.ts             # Agent output parsing
│   │   ├── verifier.ts           # Test/health check runner
│   │   ├── queue.ts              # Fix queue management
│   │   └── lock.ts               # Locking utilities
│   ├── db/
│   │   ├── index.ts              # Database wrapper (WAL mode, connection management)
│   │   ├── schema.ts             # Table definitions, schema version
│   │   └── queries.ts            # Typed query functions
│   ├── config/
│   │   ├── schema.ts             # Zod schema
│   │   └── loader.ts             # Load and validate config
│   └── utils/
│       ├── logger.ts             # Logging utility with rotation
│       ├── hash.ts               # SHA256 hashing, message normalization
│       ├── daemon.ts             # Daemonization, signal handling
│       ├── process.ts            # CLI check, spawn helpers, timeout
│       ├── duration.ts           # Duration string parsing
│       ├── errors.ts             # UserError, InternalError classes
│       └── http.ts               # Health check client
├── test/
│   ├── unit/
│   │   ├── parser.test.ts
│   │   ├── config.test.ts
│   │   ├── hash.test.ts
│   │   ├── context.test.ts
│   │   ├── duration.test.ts
│   │   ├── lock.test.ts
│   │   └── agent-output.test.ts
│   ├── integration/
│   │   ├── db.test.ts
│   │   ├── file-source.test.ts
│   │   ├── docker-source.test.ts
│   │   ├── command-source.test.ts
│   │   └── verifier.test.ts
│   ├── e2e/
│   │   ├── manual-flow.test.ts
│   │   ├── autonomous-flow.test.ts
│   │   ├── concurrent-fix.test.ts
│   │   └── daemon-lifecycle.test.ts
│   ├── fixtures/
│   │   ├── logs/                 # Sample log files
│   │   ├── configs/              # Valid and invalid configs
│   │   └── agent-responses/      # Canned YAML outputs
│   └── helpers/
│       ├── mock-agent.ts         # Mock agent for testing
│       └── test-utils.ts         # Common test utilities
├── .gitignore
├── .eslintrc.cjs
├── .prettierrc
├── tsconfig.json
├── vitest.config.ts
├── package.json
└── README.md
```

## Runtime Directory Structure

```
.watchfix/
├── errors.db                     # SQLite database
├── daemon.log                    # Current log (< 10MB)
├── daemon.log.1                  # Rotated logs
├── daemon.log.2
├── daemon.log.3
├── daemon.log.4
├── daemon.log.5
└── context/
    ├── {date}-error-{id}-attempt-{n}-analyze.md
    ├── {date}-error-{id}-attempt-{n}-analysis.yaml
    ├── {date}-error-{id}-attempt-{n}-fix.md
    └── {date}-error-{id}-attempt-{n}-result.yaml
```
