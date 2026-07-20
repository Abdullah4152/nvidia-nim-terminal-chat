<div align="center">
  <a href="https://docs.langchain.com/oss/python/deepagents/overview#deep-agents-overview">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/images/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset=".github/images/logo-light.svg">
      <img alt="Deep Agents Logo" src=".github/images/logo-dark.svg" width="50%">
    </picture>
  </a>
</div>

<div align="center">
  <h3>The terminal-first client for NVIDIA NIM.</h3>
</div>

<div align="center">
  <a href="https://opensource.org/licenses/MIT" target="_blank"><img src="https://img.shields.io/pypi/l/deepagents" alt="PyPI - License"></a>
  <a href="https://pypistats.org/packages/deepagents" target="_blank"><img src="https://img.shields.io/pepy/dt/deepagents" alt="PyPI - Downloads"></a>
  <a href="https://pypi.org/project/deepagents/#history" target="_blank"><img src="https://img.shields.io/pypi/v/deepagents?label=%20" alt="Version"></a>
  <a href="https://x.com/langchain_oss" target="_blank"><img src="https://img.shields.io/twitter/url/https/twitter.com/langchain_oss.svg?style=social&label=Follow%20%40LangChain" alt="Twitter / X"></a>
</div>

<br>

NVIDIA NIM Terminal Chat is a Windows terminal application for talking to NVIDIA NIM models and other OpenAI-compatible LLM servers, run from the folder where you're working. It's built for researchers and developers who want a terminal-first workflow: ask questions, keep sessions, inspect files in the current workspace, use local models when privacy matters, and approve every file write or shell command before it happens.

**Principles:**

- **Terminal-first** — streamed replies and Markdown-style rendering, no browser tab required
- **Workspace-scoped** — file access, search, and writes stay inside the folder you launched from
- **Approval-gated** — the model can propose a file write or a shell command, but nothing runs until you confirm it
- **Model-agnostic** — NVIDIA NIM or any OpenAI-compatible endpoint, cloud or fully local

**Features include:**

- **Cloud or local models** — connect to NVIDIA NIM with an API key, or point at a local server like Ollama, LM Studio, or vLLM; switch models mid-chat with `/model`
- **Streaming, readable output** — rendered Markdown-style answers, code blocks, and red/green diffs, typed into an expandable multiline input box
- **Workspace tools** — attach files with `/file`, search the workspace with `/search`, and let the model propose writes or commands with `/run` behind a confirmation prompt
- **Sub-agents** — split a task into up to three isolated sub-agent calls with `/agent`
- **Sessions & memory** — save and resume conversations, store standing preferences with `/remember`, and compact long threads with `/summarize`
- **Skills** — load reusable Markdown instructions from `.nvchat/skills` with `/skill`

> [!NOTE]
> NIM Terminal Chat is a Windows PowerShell application — every command below assumes a PowerShell prompt on Windows.

## Quickstart

You'll need Windows PowerShell, Node.js 18 or newer, and either an NVIDIA API key or a local OpenAI-compatible server.

Clone the project into a folder where you keep development tools — this guide uses `D:\tools`, change it if you prefer another location — and install its dependencies:

~~~powershell
Set-Location D:\tools
git clone https://github.com/Abdullah4152/nvidia-nim-terminal-chat.git
Set-Location .\nvidia-nim-terminal-chat
npm install
Unblock-File .\scripts\nvidia-chat.ps1
~~~

Register it as a command so you can launch it from any project folder:

~~~powershell
notepad $PROFILE
~~~

Add this line to the profile file (update the path if you cloned somewhere else), save, and close Notepad:

~~~powershell
function nvchat { & "D:\tools\nvidia-nim-terminal-chat\scripts\nvidia-chat.ps1" @args }
~~~

Reload the profile, then start the app from any folder — that folder becomes your workspace for `/file`, `/search`, and approved writes:

~~~powershell
. $PROFILE
PS C:\Users\abdul> nvchat
~~~

The launcher checks for Node.js and installs its one runtime dependency the first time it runs.

> [!TIP]
> Set `$env:NVIDIA_API_KEY = "nvapi-your-key-here"` before launching to skip the key prompt every session.

## Usage

### NVIDIA NIM

~~~powershell
nvchat
~~~

The launcher prompts for:

~~~text
NVIDIA API key:
Model ID []:
~~~

Enter a model ID, such as `meta/llama-3.3-70b-instruct`, or leave it blank to use the default model. The key is only passed through an environment variable for the running process — it's never saved in chat sessions or committed to Git.

### Local models

For Ollama or another local OpenAI-compatible server:

~~~powershell
nvchat -Local -Model llama3.2
~~~

Local mode defaults to `http://localhost:11434/v1`. Point it at a different compatible endpoint when needed:

~~~powershell
nvchat -Local -LocalUrl http://localhost:1234/v1 -Model your-model-id
~~~

## Commands

Type `/` in the input box to open the command picker — Up/Down highlights a command, Enter or Tab completes it.

### Everyday commands

| Command | What it does | Example |
| --- | --- | --- |
| **/model** | Opens a model picker. You can also type a model ID directly. | **/model meta/llama-3.2-3b-instruct** |
| **/save** | Saves the active chat locally. | **/save thesis-notes** |
| **/resume** | Opens a saved-session picker. | **/resume thesis-notes** |
| **/sessions** | Lists saved chats. | **/sessions** |
| **/file** | Adds a workspace file to the conversation. | **/file src/main.py** |
| **/search** | Searches text files in the workspace. | **/search learning_rate** |
| **/run** | Runs a workspace command only after approval. | **/run python train.py** |
| **/agent** | Splits a task into up to three isolated sub-agent calls. | **/agent review the data pipeline** |
| **/summarize** | Compacts old messages into a summary. | **/summarize** |
| **/remember** | Stores a persistent preference locally. | **/remember Prefer concise Python examples** |
| **/skills** | Lists reusable skills. | **/skills** |
| **/skill** | Loads a Markdown skill for the current chat. | **/skill paper-review** |
| **/clear** | Clears the active transcript and its chat history. | **/clear** |
| **/exit** | Closes the application. | **/exit** |

### Keyboard controls

Scroll the transcript with Up/Down, Page Up/Page Down, or your mouse wheel.

| Key | Action |
| --- | --- |
| Enter | Send the message or complete a partial command |
| Ctrl+J | Insert a newline in a multiline message |
| Ctrl+S | Send the current message |
| Ctrl+U | Clear only the current input text |
| Esc | Cancel a request or close a menu |
| Up / Down | Scroll the transcript when a menu is not open |
| Page Up / Page Down | Scroll a full page of transcript |
| Ctrl+C | Exit immediately |

## Project layout

~~~text
nvidia-nim-terminal-chat/
├── src/
│   └── nvchat.js              Main terminal UI and LLM client
├── scripts/
│   └── nvidia-chat.ps1        Windows PowerShell launcher
├── docs/
│   └── USER_GUIDE.md          Detailed reference and troubleshooting
├── package.json               Node.js dependency manifest
├── README.md                  Project overview and setup
└── LICENSE                    MIT license
~~~

## Contributing

The main application lives in `src/nvchat.js`; the launcher is `scripts/nvidia-chat.ps1`.

Good areas to extend: additional model providers, richer syntax highlighting, project-specific skills, evaluation logging, and a Python/Textual port for research environments that prefer Python tooling.

## FAQ

### Does it work with local models?

Yes — anything that speaks the OpenAI-compatible `/v1` chat completions API works, including Ollama, LM Studio, and vLLM. Launch with `-Local` (and `-LocalUrl` if your server isn't Ollama's default) instead of an NVIDIA API key.

### Is my API key stored anywhere?

No. It's only passed through an environment variable for the running process — never written into saved sessions and never committed to Git.

### Can the model write files or run commands on its own?

No. It can propose a write or a command, but nothing happens until you confirm it, and workspace tools reject any path outside the folder you launched from.

### What's the difference between /save and /remember?

`/save` stores the whole conversation so you can `/resume` it later. `/remember` stores one small standing preference or fact — like a coding style — that persists across every session instead of a full transcript.

---

## Resources

- [User Guide](docs/USER_GUIDE.md) — full command reference and troubleshooting
- [Source](src/nvchat.js) — the terminal UI and LLM client
- [Launcher](scripts/nvidia-chat.ps1) — the Windows PowerShell entry point
- [License](LICENSE) — MIT

---

## Acknowledgements

Built with Node.js and the Blessed terminal UI library.

## Security & Privacy

Two things NIM Terminal Chat is opinionated about: the model never writes or runs anything without your approval, and workspace access never leaves the folder you launched from.

- File writes and shell commands always require a confirmation step before they happen.
- Workspace file tools reject any path outside the folder where you launched the application.
- API keys are passed through an environment variable for the running process only — never written into session files or committed to Git.
- Saved sessions, memories, skill data, tool output, and local logs live under `.nvchat/` and are gitignored.
- Local mode keeps model traffic on your local endpoint, subject to that endpoint's own configuration.
