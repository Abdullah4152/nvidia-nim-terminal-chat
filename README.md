# NIMForge CLI

NIMForge CLI is a local-first terminal interface for NVIDIA NIM and other OpenAI-compatible language-model endpoints. It is designed for coding and research workflows that need a fast terminal UI, streaming responses, local workspace tools, and explicit approval before files or shell commands are changed.

## Highlights

- NVIDIA NIM, Ollama, LM Studio, vLLM, and other OpenAI-compatible endpoints
- Streaming Markdown responses with code and diff rendering
- Expandable multiline terminal input with paste support
- Saved chat sessions, persistent memory, skills, and model/session pickers
- Sandboxed workspace file attachment, search, and proposed file writes
- Explicit confirmation for shell commands and file writes
- Local-model mode for private/offline workflows

## Quick start

Requirements: Windows PowerShell and Node.js 18 or newer.

```powershell
git clone https://github.com/Abdullah4152/nimforge-cli.git
Set-Location nimforge-cli
npm install
Unblock-File .\scripts\nvidia-chat.ps1
.\scripts\nvidia-chat.ps1
```

To start local mode with Ollama or another compatible local server:

```powershell
.\scripts\nvidia-chat.ps1 -Local -Model llama3.2
```

For an NVIDIA NIM model, run the launcher normally and enter an NVIDIA API key when prompted. You can also set `NVIDIA_API_KEY` as an environment variable.

## PowerShell profile shortcut

Add this to your PowerShell profile if you want to run the app using `nvchat` from any folder:

```powershell
function nvchat { & "C:\path\to\nimforge-cli\scripts\nvidia-chat.ps1" @args }
```

## Project layout

```text
nimforge-cli/
├── src/             Main Node.js terminal application
├── scripts/         PowerShell launcher
├── docs/            Detailed user guide
├── package.json     Runtime dependency manifest
└── LICENSE          MIT license
```

## Safety and privacy

NIMForge CLI never writes files or runs a shell command without an explicit confirmation. API keys, saved chats, local memory, shell logs, and dependencies are excluded from Git through `.gitignore`.

See [the user guide](docs/USER_GUIDE.md) for commands, keyboard controls, local mode, sessions, memory, skills, and troubleshooting.

## License

MIT. See [LICENSE](LICENSE).
