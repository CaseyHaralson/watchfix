# Agent Default Configurations

## Provider Defaults

If only `provider` is specified in config, these defaults are used:

```typescript
const AGENT_DEFAULTS = {
  claude: {
    command: 'claude',
    args: ['--model', 'sonnet', '--dangerously-skip-permissions', '-p'],
    stderrIsProgress: false,
  },
  gemini: {
    command: 'gemini',
    args: ['--yolo', '-p'],
    stderrIsProgress: true,
  },
  codex: {
    command: 'codex',
    args: ['exec', '--yolo'],
    stderrIsProgress: true,
  },
};

const AGENT_CONFIG_DEFAULTS = {
  timeout: 5 * 60 * 1000, // 5 minutes in ms
  retries: 2,
};
```

## Override Behavior

If `command` or `args` are specified in config, they override the defaults entirely (not merged).

## Command Building

The agent args array contains everything *before* the prompt. At execution time, the prompt is appended as the final argument:

```typescript
function buildCommand(config: AgentConfig, prompt: string): [string, string[]] {
  return [config.command, [...config.args, prompt]];
}

// Example for Claude:
// command: "claude"
// args: ["--model", "sonnet", "--dangerously-skip-permissions", "-p"]
// prompt: "Read .selfheal/context/2025-01-27-error-1-attempt-0.md and follow the instructions."
// Result: claude --model sonnet --dangerously-skip-permissions -p "Read .selfheal/context/..."
```

## Prompt Templates

```typescript
const PROMPTS = {
  analyze: (contextPath: string) =>
    `Read ${contextPath} and follow the instructions.`,
  fix: (contextPath: string) =>
    `Read ${contextPath} and follow the instructions.`,
};
```

## Working Directory

The agent process is spawned with `cwd` set to the project root (resolved from `project.root` in config). All paths in context files are relative to this directory.

## stderr Handling

- `stderrIsProgress: false` — stderr indicates problems; captured and logged as warnings
- `stderrIsProgress: true` — stderr is progress info; streamed to terminal in foreground mode, captured but not logged as warnings
