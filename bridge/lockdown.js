// The tool lockdown for the spawned claude CLI, kept in one place so the command-line
// flags and the settings file can never disagree.
//
// Two independent mechanisms, because a future Claude Code version may add a tool this
// list does not name: every tool below is denied by name, AND the permission mode is
// "manual" with an empty allow list, so an unnamed tool still has no standing approval.
// bridge/README.md documents the canary that verifies the result is an empty tool list.

export const DENY = [
  "Bash", "BashOutput", "KillShell", "Edit", "Write", "Read", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "TodoWrite", "Skill", "ToolSearch", "Workflow", "Artifact",
  "CronCreate", "CronDelete", "CronList", "DesignSync", "EnterWorktree", "ExitWorktree",
  "ListAgents", "Monitor", "PushNotification", "RemoteTrigger", "ReportFindings",
  "ScheduleWakeup", "SendMessage", "EndConversation", "ExitPlanMode", "EnterPlanMode",
];

export const lockdownSettings = () => ({
  permissions: { defaultMode: "manual", allow: [], deny: DENY },
  enableAllProjectMcpServers: false,
  disableAllHooks: true,
  includeCoAuthoredBy: false,
});

/** Command-line arguments that pin the CLI to one non-interactive, tool-less translation. */
export const claudeArgs = ({ settingsPath, system }) => [
  "-p",
  "--settings", settingsPath,
  "--permission-mode", "manual",
  "--strict-mcp-config",
  "--mcp-config", '{"mcpServers":{}}',
  "--disallowedTools", ...DENY,
  "--append-system-prompt", system,
  "--output-format", "json",
];
