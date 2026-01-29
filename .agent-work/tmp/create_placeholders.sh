#!/usr/bin/env bash
set -euo pipefail
files=(
  src/cli/index.ts
  src/cli/commands/init.ts
  src/cli/commands/watch.ts
  src/cli/commands/stop.ts
  src/cli/commands/status.ts
  src/cli/commands/fix.ts
  src/cli/commands/show.ts
  src/cli/commands/ignore.ts
  src/cli/commands/logs.ts
  src/cli/commands/config.ts
  src/cli/commands/clean.ts
  src/cli/commands/version.ts
  src/agents/types.ts
  src/agents/base.ts
  src/agents/claude.ts
  src/agents/gemini.ts
  src/agents/codex.ts
  src/agents/defaults.ts
  src/agents/index.ts
  src/watcher/index.ts
  src/watcher/sources/types.ts
  src/watcher/sources/file.ts
  src/watcher/sources/docker.ts
  src/watcher/sources/command.ts
  src/watcher/patterns.ts
  src/watcher/parser.ts
  src/fixer/index.ts
  src/fixer/context.ts
  src/fixer/output.ts
  src/fixer/verifier.ts
  src/fixer/queue.ts
  src/fixer/lock.ts
  src/db/index.ts
  src/db/schema.ts
  src/db/queries.ts
  src/config/schema.ts
  src/config/loader.ts
  src/utils/logger.ts
  src/utils/hash.ts
  src/utils/daemon.ts
  src/utils/process.ts
  src/utils/duration.ts
  src/utils/errors.ts
  src/utils/http.ts
)

for file in "${files[@]}"; do
  mkdir -p "$(dirname "/workspace/$file")"
  if [[ ! -f "/workspace/$file" ]]; then
    cat <<'CONTENT' > "/workspace/$file"
export {};
CONTENT
  fi
done
