# LM Studio Log Viewer

A dependency-free, client-side viewer for LM Studio server logs. It reconstructs chat-completion requests and predictions, highlights incomplete calls, and groups related message histories into conversation threads.

## Use

Open `index.html` in a modern browser, then drag in one or more `.log` files or use **Open log files**. No files or log contents leave the browser tab, and nothing is retained after the tab closes.

For the supplied validation log, browse to:

`C:\Users\fabia\.lmstudio\server-logs\2026-06\2026-06-27.2.log`

The browser cannot open that path automatically because local-file access always requires a user gesture.

## Features

- Multiline, string-aware JSON parsing for LM Studio request and prediction records
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
