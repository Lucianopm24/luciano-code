# Luciano Code AI

A terminal-first AI coding agent for developers who want a focused, premium command-line workflow. Luciano Code runs entirely in the terminal, uses NVIDIA NIM for inference, and follows a **BYOK (Bring Your Own Key)** model so users control their own provider credentials.

## Features

- Responsive terminal UI with Unicode panels, status indicators, spinners, and Markdown rendering.
- Adaptive banners that preserve the full design on large terminals, use compact boxes on narrow terminals, and fall back to plain text on very small screens.
- NVIDIA NIM integration through its OpenAI-compatible chat completions API.
- Recommended model selection focused on tested DeepSeek presets, with support for custom model IDs.
- Explicit streaming of provider-supplied reasoning/progress in gray and assistant responses as they arrive, without duplicating accumulated SSE chunks.
- Optional `nothink` mode for direct responses when the selected model supports disabling reasoning.
- Automatic recovery for NVIDIA NIM overload (`529`) responses, with an interactive fallback after 10 consecutive retries.
- Interactive recovery for NVIDIA NIM rate-limit (`429`) responses.
- Workspace tools for listing, reading, creating, and editing files.
- Web search through SearXNG at `https://search.lucianopm.com` using its JSON API.
- Global NVIDIA NIM request protection: 35 requests per rolling minute, followed by a 70-second cooldown and visible countdown.
- Folder trust protection to reduce prompt-injection risks from repository content.
- Per-operation tool authorization, with optional approval for the rest of the current session.
- Workspace restrictions that block unsafe paths, protected directories, secrets, private keys, and oversized files.
- Optional account login with a manual device-authorization flow, plus the existing manual/API-key configuration path.
- Local configuration with masked API keys and support for environment-based credentials.
- Persistent local conversation memory stored under `~/.config/luciano-code/conversations/`, with configurable context limits and no tool-result transcripts saved.
- An explicit NVIDIA data-sharing consent gate shown before the first request; NVIDIA may process submitted prompts, files, tool results, and responses according to its current policies, including model-training policies.

## Requirements

- Node.js 18 or newer.
- An NVIDIA NIM API key.
- An interactive terminal for folder trust and tool authorization.

## Installation

Install the CLI globally with npm:

```bash
npm install --global luciano-code
```

The installation provides the `luciano-code` command, which can be run from any project directory:

```bash
cd ~/projects/my-app
luciano-code
```

Check the installed CLI:

```bash
luciano-code --help
luciano-code --version
```

## NVIDIA API key

Create an NVIDIA API key at:

<https://build.nvidia.com/settings/api-keys>

On the first launch, Luciano Code guides users through the initial setup. The setup flow can configure:

- NVIDIA API key
- Recommended DeepSeek model preset or custom model ID
- Response language (`es` or `en`)
- Temperature
- Streaming preference

An account session is stored as a plain-text opaque token in `~/.config/luciano-code/auth.json`. On startup, and with `/sync`, the CLI validates it through the Convex backend at `https://wry-deer-1.convex.site/cli/key`; if the account has a saved NVIDIA key, that key and its model are synchronized into the local `~/.config/luciano-code/config.json` through the normal config-saving path. Set `CONVEX_SITE_URL` only for development or another backend environment. The browser URL is supplied by the login response and is never constructed by the CLI. If the account has no saved key, the CLI keeps the manual setup path available and does not overwrite the existing manual key.

The `NVIDIA_API_KEY` environment variable can be used instead of storing a key locally:

```bash
export NVIDIA_API_KEY=nvapi-your-key
luciano-code
```

Environment credentials take precedence over the local configuration and are not persisted by the CLI. If an API key is exposed in a chat, issue, log, or screenshot, revoke it in NVIDIA and create a replacement.

## First launch and folder trust

Before interacting with project files, Luciano Code asks whether the current folder is trusted. This is an intentional security boundary: project files can contain instructions designed to manipulate an agent, so users should only trust folders whose authors and contents they understand.

If the folder is not trusted, agent execution and workspace tools remain disabled. Trust is stored for the exact folder path; trusting one directory does not automatically trust its parents or children.

## Model selection

The interactive selector currently shows only the recommended, tested model options:

1. **DeepSeek V4 Flash** — `deepseek-ai/deepseek-v4-flash`
2. **DeepSeek V4 Pro** — `deepseek-ai/deepseek-v4-pro`
3. **Custom model ID**

The custom option accepts any NVIDIA NIM model ID, including models that are not currently shown as recommendations. The internal model catalog remains multi-provider and can be expanded as additional models are tested; hiding a preset from the selector does not remove compatibility with existing configurations or direct `/model set <model-id>` usage.

New configurations default to **DeepSeek V4 Flash**. Existing configurations keep their current model. If an existing model is no longer a visible recommendation, the selector marks it as the current custom choice until you select a recommended model or enter another custom ID.

The `/models` command still lists model IDs returned by the configured NVIDIA NIM endpoint. Availability and runtime behavior can vary by NVIDIA catalog, account, region, or endpoint. A 404 response generally means that the selected model ID is not available exactly as configured.

## Commands

| Command | Description |
| --- | --- |
| `/login` | Sign in with a Luciano Code account in the browser using device authorization; status is checked only when you press Enter. |
| `/sync` | Refresh the account API key and model for the current CLI session. |
| `/whoami` | Show the saved account name, username, or email. |
| `/logout` | Remove the local account session. |
| `/setup` | Run or repeat the configuration wizard. |
| `/key set` | Change the NVIDIA API key. |
| `/model set` | Open the interactive model selector. |
| `/model set <model-id>` | Set a model ID directly. |
| `/models` | List model IDs available from NVIDIA NIM. |
| `/config` | Show the endpoint, model, preferences, and masked key status. |
| `/trust` | Show whether the current folder is trusted. |
| `/trust reset` | Revoke trust for the current folder. |
| `/status` | Show workspace and provider status. |
| `/tools` | Display the agent tool instructions, including web search. |
| `/nothink on` | Disable model reasoning/thinking when supported. |
| `/nothink off` | Re-enable model reasoning/thinking. |
| `/nothink status` | Show the current no-think setting. |
| `429` provider error | Choose `Try again` or return to the prompt with `Send another request`. |
| `529` provider error | Retries automatically up to 10 consecutive times, then offers `Change model` or `Try again`. |
| `/demo` | Run a clearly labeled visual demo without calling the API; it does not inspect the workspace. |
| `/analyze` | Analyze the real workspace through authorized tools and the configured model. |
| `/help` | Show available commands. |
| `/history` | Show recent local conversation sessions. |
| `/clear` | Confirm, archive, and clear the current conversation. |
| `/new` | Archive the current conversation and start a new local session. |
| `/resume` | Resume the latest archived local conversation. |
| `/consent` | Show NVIDIA data-sharing consent status. |
| `/consent accept` / `/consent decline` | Change the NVIDIA data-sharing decision; declining blocks remote requests. |
| `/screen` | Clear the terminal display without changing conversation memory. |
| `/exit` / `/quit` | Close the CLI. |

Only input that begins with `/` is routed as an internal command. Any other text—including phrases such as `analiza este proyecto`, `revisa mis archivos`, or `ayúdame con código`—is sent to NVIDIA NIM when the folder is trusted, consent has been accepted, and a provider key is available.

## Local conversation memory and NVIDIA consent

Conversation messages are stored locally on the device in:

```text
~/.config/luciano-code/conversations/current.json
~/.config/luciano-code/conversations/history/
```

Stored entries contain only `user`, `assistant`, and `system` messages with timestamps. Tool execution results are request-local context and are not written to the conversation files. Luciano Code keeps the full local history but sends only the latest configured number of conversational messages to NVIDIA (24 by default; configurable through the local configuration). `/clear` archives before starting an empty current conversation, while `/new` starts a new session and `/resume` restores the latest archived session.

Before the first remote request, Luciano Code separately asks whether you trust the folder authors and whether you agree that prompts, selected files, tool results, and responses may be sent to NVIDIA NIM, where NVIDIA may use submitted data for model training according to its policies. This consent is stored locally and can be changed with `/consent accept` or `/consent decline`. If consent is declined or undecided, remote requests—including model listing—are blocked; local commands such as `/history`, `/clear`, `/new`, `/resume`, `/help`, and `/consent` remain available.

## Agent tools and authorization

The agent can use the following workspace tools:

- `list_files` — list visible files and directories.
- `read_file` — read a UTF-8 text file.
- `write_file` — create or replace a complete file.
- `edit_file` — replace an exact text snippet in an existing file.
- `web_search` — search the public web via SearXNG JSON at `https://search.lucianopm.com`.

A typical request might look like:

```text
Read src/index.js and fix its error handling. Show me what you plan to change.
```

The agent may read the relevant file, propose a change, and request an edit or write operation. Luciano Code asks for authorization before executing each operation:

```text
Allow? [y/N/a]
```

- `y` or `s` — approve the current operation.
- `a` — approve subsequent tools for the current session.
- `n` — reject the operation.

Session approval is temporary and is not persisted after the CLI exits. File modifications are never silently authorized by default.

## Workspace protections

Tools are restricted to the trusted workspace. They cannot access:

- Paths outside the workspace, including escaping with `../`.
- Symlinks that resolve outside the workspace.
- `.git`, `node_modules`, or Luciano Code's internal state directory.
- `.env` files, certificates, private keys, and similar sensitive files.
- Files larger than 1 MB.

Writes use an atomic temporary-file strategy under normal operating-system conditions to reduce the risk of leaving a destination file truncated if a write fails.

## Configuration and security

The local configuration is stored at:

```text
~/.config/luciano-code/config.json
```

The configuration directory uses permission `700` and the file uses permission `600` where supported. API keys are masked in CLI output. Local configuration is not encrypted; on shared machines, prefer `NVIDIA_API_KEY` or another protected environment-management solution.

Folder trust records are stored separately as exact absolute paths. Resetting trust revokes authorization for the current folder without changing provider settings.

## Request protection and provider error recovery

Luciano Code counts outbound NVIDIA NIM requests globally in the running process. After 35 requests in a rolling 60-second window, it blocks additional NIM requests for 70 seconds and displays a `Rate Limit Protection` countdown to avoid model locks. SearXNG web search is a separate public search tool and is not counted against the NVIDIA NIM budget.


If NVIDIA NIM returns a `529`, Luciano Code automatically retries the request up to 10 consecutive times without opening the recovery prompt. The spinner displays the current retry number while this happens. A successful response resets the consecutive-failure counter.

If all 10 automatic retries fail, Luciano Code shows:

> The NVIDIA NIM servers are overloaded. Try again or try with a different model

The terminal then offers `Change model` and `Try again`. Choosing `Change model` opens the predefined model selector, including the custom model option, saves a new selection, and retries the request.

If NVIDIA NIM returns a `429`, Luciano Code shows:

> You are going too fast! Wait a minute and then try again

The terminal offers `Try again` and `Send another request`. The latter stops the current agent request and returns to the normal prompt so another request can be entered. In non-interactive environments, the request is stopped safely instead of waiting for input.

## Markdown and streaming

Responses are requested in Markdown and rendered safely for the terminal, including headings, lists, emphasis, tables, links, and fenced code blocks. HTML and ANSI escape sequences supplied by the model are not executed.

When streaming is enabled:

- Provider-supplied `reasoning_content` or `reasoning` fields are shown in gray as progress.
- Assistant content is displayed as it arrives rather than waiting for the complete response.
- Native tool-call deltas are accumulated while content and progress continue to stream.
- If a provider does not expose explicit reasoning, Luciano Code shows a `Thinking...` indicator instead; it does not invent or expose private chain-of-thought.
- The `nothink` preference sends `chat_template_kwargs.enable_thinking=false` to compatible NVIDIA NIM deployments and suppresses provider reasoning output locally. Models that do not support this option may ignore it.

## NVIDIA NIM endpoint

Luciano Code uses NVIDIA's OpenAI-compatible endpoint:

```text
https://integrate.api.nvidia.com/v1/chat/completions
```

Useful references:

- [NVIDIA API Catalog](https://build.nvidia.com/)
- [NVIDIA API key settings](https://build.nvidia.com/settings/api-keys)
- [NVIDIA API documentation](https://docs.api.nvidia.com/)

## Development

The project is open to improvements and contributions. A local development checkout can be validated with:

```bash
npm install
npm run check
npm run demo
```

The main source areas are:

- `bin/luciano-code.js` — executable entry point.
- `src/index.js` — startup, flags, and onboarding.
- `src/cli.js` — readline loop and command handling.
- `src/config.js` — local configuration and credential precedence.
- `src/models.js` — model presets and selection.
- `src/setup.js` — interactive setup and masked key capture.
- `src/trust.js` — folder trust and prompt-injection boundary.
- `src/nvidia.js` — NVIDIA NIM client, model listing, rate limiting, and SSE streaming.
- `src/rate-limit.js` — global rolling-window NVIDIA request protection.
- `src/tools.js` — workspace tools, path validation, and authorization.
- `src/ui/markdown.js` — safe terminal Markdown renderer.
- `src/agent.js` — conversation, streaming, and tool orchestration.
- `src/demo.js` — visual flows that do not modify the filesystem.
- `src/ui/` — reusable colors, boxes, statuses, spinner, and banner components.

## License

MIT
