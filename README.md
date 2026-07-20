# NVIDIA NIM Terminal Chat

**NVIDIA NIM Terminal Chat** is a Windows terminal application for talking to NVIDIA NIM models and other OpenAI-compatible LLM servers from the folder where you are working.

It is built for researchers and developers who want a terminal-first chat workflow: ask questions, keep sessions, inspect files in the current workspace, use local models when privacy matters, and approve any file write or shell command before it happens.

## What it does

### Chat with cloud or local models

- Connects to NVIDIA NIM through an NVIDIA API key.
- Also connects to local OpenAI-compatible servers such as Ollama, LM Studio, and vLLM.
- Streams replies as they are generated instead of waiting for a whole response.
- Lets you change the active model during a conversation with **/model**.

### A terminal UI made for long technical answers

- Rendered Markdown-style answers with headings, lists, code blocks, and red/green diffs.
- An expandable multiline input box: paste a long prompt, review it, then send it.
- Scroll long conversations with Up/Down, Page Up/Page Down, or the mouse wheel.
- Press Esc to cancel a request that is queued or streaming.

### Workspace-aware assistance

- Attach a file with **/file path/to/file**.
- Search the current workspace with **/search text**.
- Ask the model to create or update a file. It must propose the write, and NIM Terminal Chat asks for approval before writing.
- Run a workspace command with **/run command** only after a confirmation prompt.

### Keep work across sessions

- Save a conversation with **/save experiment-idea**.
- Restore it with **/resume** and choose a saved session from the list.
- Store small persistent facts or preferences with **/remember**.
- Load reusable Markdown instruction files as skills from **.nvchat/skills**.
- Summarize long conversations to reduce context pressure.

## Requirements

- Windows PowerShell
- Node.js 18 or newer
- An NVIDIA API key for NVIDIA NIM, or a local OpenAI-compatible server for local mode

## Install once

Choose a folder where you keep development tools. The example below uses **D:\tools**; change it if you prefer another location.

~~~powershell
Set-Location D:\tools
git clone https://github.com/Abdullah4152/nvidia-nim-terminal-chat.git
Set-Location .\nvidia-nim-terminal-chat
npm install
Unblock-File .\scripts\nvidia-chat.ps1
~~~

The launcher automatically checks for Node.js and installs the one runtime dependency on first use if needed.

## Run it from any folder

Add this function to your PowerShell profile one time. Replace the path if you cloned the project somewhere else.

~~~powershell
notepad $PROFILE
~~~

Add this line to the profile file, save it, and close Notepad:

~~~powershell
function nvchat { & "D:\tools\nvidia-nim-terminal-chat\scripts\nvidia-chat.ps1" @args }
~~~

Load the changed profile:

~~~powershell
. $PROFILE
~~~

After that, you can start the app from **any folder**:

~~~powershell
PS C:\Users\abdul> nvchat
~~~

The current folder becomes the workspace. For example, if you start it inside **D:\research\project-a**, then **/file**, **/search**, and approved file writes are limited to that project folder.

## Start with NVIDIA NIM

~~~powershell
nvchat
~~~

The launcher asks for:

~~~text
NVIDIA API key:
Model ID []:
~~~

Enter a model ID, such as:

~~~text
meta/llama-3.3-70b-instruct
~~~

You can leave Model ID empty and press Enter to use the internal default model. The API key is passed through an environment variable for the running process; it is not saved in chat sessions or committed to Git.

To avoid entering the key every time, set it for your current PowerShell session:

~~~powershell
$env:NVIDIA_API_KEY = "nvapi-your-key-here"
nvchat
~~~

## Start with a local model

For Ollama or another local OpenAI-compatible server:

~~~powershell
nvchat -Local -Model llama3.2
~~~

By default, local mode uses:

~~~text
http://localhost:11434/v1
~~~

Use a different compatible endpoint when needed:

~~~powershell
nvchat -Local -LocalUrl http://localhost:1234/v1 -Model your-model-id
~~~

## Everyday commands

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

Type **/** in the input box to open the command picker. Use Up/Down to highlight a command and Enter or Tab to complete it.

## Keyboard controls

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

## Data, safety, and privacy

- API keys are not written to session files.
- Saved sessions, memories, skill data, tool output, and local logs live under **.nvchat/** and are ignored by Git.
- File writes and shell commands require a confirmation step.
- Workspace file tools reject paths outside the folder where you launched the application.
- Local mode keeps model traffic on your local endpoint, subject to the configuration of that endpoint.

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

## Contributing and extending

The main application is in **src/nvchat.js**. The launcher is in **scripts/nvidia-chat.ps1**. The current implementation uses Node.js and the Blessed terminal library.

Useful extensions include additional model providers, richer syntax highlighting, project-specific skills, evaluation logging, and a Python/Textual implementation for research environments that prefer Python tooling.

For full troubleshooting and feature notes, read [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## License

MIT. See [LICENSE](LICENSE).
