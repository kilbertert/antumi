# CodeArts recordings

Antumi's `AcpDriver` with `codeartsDialect`, driving the bridge (`codearts-bridge-main.ts`) over CodeArts 26.11.11's own `codearts serve`, on macOS arm64, 2026-11-20. No Huawei Cloud account: a placeholder `CODEARTS_CLI_AK` / `CODEARTS_CLI_SK` passes its start check, and in a throwaway HOME

- `~/.codeartsdoer/codearts_cli.json` points the `huaweicloud-maas` provider (`options.baseURL`) at a local OpenAI-compatible mock scripted by keywords (`RUN-CMD <command>`, `RUN-EDIT <path>`, `RUN-MCP`, `LIST-TOOLS`, `RUN-SLOW`); a custom provider is not offered, as it enables only its own;
- `~/.cache/codeartsdoer/models-cache.json` holds one model, as it fetches its model list from Huawei Cloud first and stops without one;
- `cli-data/settings.json` trusts the work folder.

The modes and approval recordings ran with Antumi's config (its agents and permission plugin) in `OPENCODE_CONFIG_CONTENT`. Paths are rewritten to `/work`, session ids to `ses_codeartsN`, and the first prompt to the message as the chat keeps it (without Antumi's start note).

| File | What |
| --- | --- |
| `codearts-session.jsonl` | A reply, a command run in its sandbox, Antumi's MCP tool through `tool_call` |
| `codearts-modes.jsonl` | Automatic: a write to a reference project and a blacklisted command refused; read-only's tools |
| `codearts-approve.jsonl` | A blacklisted command (`rmdir`) asked about and allowed |
| `codearts-deny.jsonl` | The same refused; the turn goes on |
| `codearts-resume.jsonl` | `session/load` of an earlier session, its history replayed |
| `codearts-fork.jsonl` | `session/fork` of it |
| `codearts-cancel.jsonl` | A slow turn cancelled, then a reply |
| `codearts-no-access-key.jsonl` | No access key: `initialize` fails with its message |
