# NIMForge CLI user guide

`NIMForge CLI` is a Node-based terminal chat UI for NVIDIA NIM (or any OpenAI-compatible endpoint). The PowerShell file is only a launcher, so an `nvchat` profile alias keeps working.

## Requirements

- Node.js **18 or newer** (built-in `fetch`). The launcher checks and tells you if it's missing or too old.
- `npm install` once in this folder (the launcher does it automatically on first run).

## Start

```powershell
nvchat
```

Enter your NVIDIA key and model ID when asked. The model prompt stays empty; pressing Enter uses `meta/llama-3.3-70b-instruct`. The key is passed to the app via an environment variable, never on the command line, and is never written to saved sessions.

For a local OpenAI-compatible server (Ollama, LM Studio, vLLM):

```powershell
nvchat -Local -Model llama3.2
```

## Keys

| Key | Action |
| --- | --- |
| `Enter` | Send the message (or complete a partial `/command`) |
| `Ctrl+J` | Insert a newline (multiline messages) |
| `Ctrl+S` | Also sends (alias) |
| `Ctrl+U` | Clear the input box |
| `Esc` | Cancel an active request / close the command menu |
| `Up` / `Down`, `PgUp` / `PgDn`, mouse wheel | Scroll the transcript |
| `Ctrl+C` | Quit |

Pasting multi-line text just works: pasted line breaks become newlines in the input box and never trigger a send per line. Review, then press `Enter`.

Note: blessed's textarea has no mid-line cursor movement (no Left/Right editing). `Backspace` deletes, `Ctrl+U` restarts the line. That's an upstream library limitation.

## Interface

- Header shows the active model, mode (nvidia/local), workspace, and last response time.
- The transcript scrolls above the bordered input box; the box grows to eight lines.
- Type `/` to open the command menu. `Up`/`Down` moves its selection; `Tab` or `Enter` completes the command. Outside that menu, `Up`/`Down` scrolls the transcript.
- Streaming replies render markdown: headings, bullets, `code`, fenced blocks with basic highlighting, and diffs.

## Commands

```text
/model [model-id]    Change model; without an ID, choose from a picker.
/save <name>         Save messages and settings in .nvchat/sessions.
/resume [name]       Restore a saved chat; without a name, choose from a picker.
/sessions            List saved chats.
/file <path>         Attach one workspace file as context.
/search <text>       Search readable files in the workspace sandbox (binary files skipped).
/run <command>       Run a workspace shell command after approval; tail shown inline,
                     full output saved under .nvchat/tool-output.
/agent <task>        Plan and run up to three isolated sub-agent calls.
/summarize           Compact older chat messages into a summary.
/remember <text>     Save persistent memory for later sessions.
/memories            List persistent memories.
/skills              List Markdown skills in .nvchat/skills.
/skill <name>        Load .nvchat/skills/<name>.md for the current chat.
/temperature <0..2>  Set sampling temperature.
/tokens <n>          Set max output tokens.
/ls                  List workspace files (directories first).
/pwd                 Show the workspace folder.
/clear               Clear the active chat.
/exit                Close nvchat (also: exit, quit, or /quit).
/help                Show commands and keys.
```

Saved sessions never include your API key.

## Agent framework

- **Sub-agents:** `/agent` gives each sub-task a fresh model context plus persistent memory; it does not expose the parent chat transcript.
- **Filesystem:** `/file`, `/search`, and file writes are sandboxed to the workspace directory.
- **Context:** `/summarize` compacts long chats automatically after 26 messages or manually on demand. Shell output is offloaded to `.nvchat/tool-output`.
- **Human approval:** file writes and `/run` shell commands always show a y/n confirmation dialog before acting.
- **Memory and skills:** memory is stored in `.nvchat/memory.json`; reusable skills are Markdown files in `.nvchat/skills`. The loaded skill name shows in the header.

## Files

Ask explicitly to create or update a file. When the model returns real file blocks, nvchat shows a confirmation dialog listing every path before writing. Placeholder/example paths and file blocks returned for non-file requests are ignored.

## Rate limits and errors

- 429 and 5xx responses are retried automatically (up to 3 attempts, honoring `Retry-After`), with the wait shown in the spinner line.
- Other API errors appear in the transcript with status code and detail.
- `Esc` cancels a waiting or streaming request. If a partial reply already streamed, it is kept in history and marked as canceled; if nothing arrived, your message is rolled back so history stays consistent.

## What was fixed in this version

- **File writes and `/run` crashed the app** — the code called `screen.question()`, which does not exist in blessed. Replaced with a proper modal confirm dialog.
- **Enter did nothing** — blessed names the physical Enter key `'return'` (and emits it twice per press); the old handler only listened for `'enter'`, which is actually Ctrl+J. Enter now sends; the duplicate emission is deduplicated.
- **Model output containing `{` or `}` rendered garbage** — blessed has no backslash escaping; braces are now escaped with `{open}`/`{close}`.
- **API key leaked into the process list** — it was passed as a command-line argument; now passed via environment variable.
- Streaming errors/cancels corrupted chat history (wrong message popped); spinner animation; throttled rendering; scroll position preserved while reading backlog; binary files skipped in `/search`; sessions re-render their transcript on `/resume`; retry with backoff on 429.
