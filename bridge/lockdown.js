// The tool lockdown for the spawned claude CLI, kept in one place so the command-line
// flags and the settings file can never disagree.
//
// Layered, because a future Claude Code version (or a remotely enabled feature flag) may
// add a tool this list does not name: `--tools ""` removes every built-in tool, every tool
// below is also denied by name, and the permission mode is "manual" with an empty allow
// list, so an unnamed tool still has no standing approval. `--restricted` keeps the user's
// own ~/.claude settings (bypass mode, Remote Control, env) out of the spawned CLI.
// bridge/README.md documents the canary that verifies the result is an empty tool list.

export const DENY = [
  "Bash", "BashOutput", "KillShell", "Edit", "Write", "Read", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "TodoWrite", "Skill", "ToolSearch", "Workflow", "Artifact",
  "CronCreate", "CronDelete", "CronList", "DesignSync", "EnterWorktree", "ExitWorktree",
  "ListAgents", "Monitor", "PushNotification", "RemoteTrigger", "ReportFindings",
  "ScheduleWakeup", "SendMessage", "EndConversation", "ExitPlanMode", "EnterPlanMode",
  "LSP",
];

export const lockdownSettings = () => ({
  // Named here because --restricted ignores the user's settings, where it used to come from.
  model: "opus",
  permissions: { defaultMode: "manual", allow: [], deny: DENY },
  enableAllProjectMcpServers: false,
  disableAllHooks: true,
  includeCoAuthoredBy: false,
});

/** Command-line arguments that pin the CLI to one non-interactive, tool-less translation. */
export const claudeArgs = ({ settingsPath, system }) => [
  "-p",
  "--restricted",
  "--tools", "",
  "--settings", settingsPath,
  "--permission-mode", "manual",
  "--strict-mcp-config",
  "--mcp-config", '{"mcpServers":{}}',
  "--disallowedTools", ...DENY,
  "--append-system-prompt", system,
  "--output-format", "json",
];

/**
 * The spawned CLI's whole environment: the subscription token and nothing that would
 * redirect it to another endpoint or leak the bridge's own secrets. Nonessential traffic
 * (feature flags, telemetry) stays on; only self-updating is off, so a translation never
 * rewrites the shared binary in CLAUDE_BIN.
 */
export const childEnv = (env = process.env) => ({
  PATH: env.PATH,
  HOME: env.HOME,
  USER: env.USER,
  SHELL: "/bin/false",
  CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
  DISABLE_AUTOUPDATER: "1",
});
