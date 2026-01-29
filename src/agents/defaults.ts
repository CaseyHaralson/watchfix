export const AGENT_DEFAULTS = {
  claude: {
    command: "claude",
    args: ["--model", "sonnet", "--dangerously-skip-permissions", "-p"],
    stderrIsProgress: false,
  },
  gemini: {
    command: "gemini",
    args: ["--yolo", "-p"],
    stderrIsProgress: true,
  },
  codex: {
    command: "codex",
    args: ["exec", "--yolo"],
    stderrIsProgress: true,
  },
} as const;

export const AGENT_CONFIG_DEFAULTS = {
  timeout: 5 * 60 * 1000,
  retries: 2,
} as const;
