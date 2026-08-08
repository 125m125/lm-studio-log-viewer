# LM Studio Log Viewer

A dependency-free, client-side viewer for LM Studio server logs. It reconstructs chat-completion requests and predictions, highlights incomplete calls, and groups related message histories into conversation threads.

## Use

Open the viewer from a modern browser, then drag in one or more `.log` files or use **Open log files**. For live updates, use **Watch log folder** and select the LM Studio server-log directory once. The viewer loads the existing `.log` history, then polls each file for appended bytes and handles log rotation without requiring repeated uploads. Recoverable read and parse problems appear in the persistent **Live diagnostics** panel. No files or log contents leave the browser tab, and nothing is retained after the tab closes.

For the supplied validation log, browse to:

`C:\Users\fabia\.lmstudio\server-logs\2026-06\2026-06-27.2.log`

The browser cannot open that path automatically because local-file access always requires a user gesture.

llama.cpp-style minilog files such as `request.log.log` are also supported. Their
`Prompt:` JSON blocks and following `token:` lines are reconstructed into calls
for both one-shot import and live folder watching.

## Features

- Multiline, string-aware JSON parsing for LM Studio request and prediction records
- llama.cpp `--minilog` prompt parsing with reconstructed token responses
- Streamed `Generated packet:` responses are reconstructed into final outputs while preserving packet-level delta evidence
- Live folder watching with incremental updates and rotation handling (Chromium-based browsers over HTTPS or localhost)
- Request/response matching using inference lifecycle markers
- Explicit matched, uncertain, and incomplete states
- Conversation reconstruction requiring identical initial system/user prompts, then using ordered message overlap for ancestry
- Added/removed message summaries between related calls
- Collapsible messages, reasoning, content, tool calls, usage, and raw evidence
- Multi-file loading, filtering, and full-text search
- No server, build process, dependencies, network calls, or local persistence

## Tests

With Node.js 18 or newer:

```powershell
node --test tests\parser.test.js
```

Opening the viewer through a local HTTP server enables background parsing in a Web Worker, but this is optional. Under `file://`, it automatically uses the same parser directly.

Live folder watching uses the browser File System Access API and requires a secure origin such as GitHub Pages, HTTPS, or localhost. Browsers without directory-picker support can still use one-shot file import. Because LM Studio logs do not always expose a request ID linking requests to streams, concurrent log-only attribution may be shown as uncertain.
