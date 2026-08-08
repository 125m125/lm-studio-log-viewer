# Ollama.cpp/llama.cpp Minilog Support Design

## Context

LM Studio can expose server output produced by the llama.cpp-style `--minilog`
mode in a file such as `request.log.log`. The existing viewer recognizes LM
Studio request, prediction, and streamed-packet records, but minilogs use a
different format:

```text
[1786211394] Prompt:
{
  "model": "qwen/qwen3.6-35b-a3b",
  "stream": true,
  "messages": []
}
[1786211402] token:Hello
[1786211402] token: world
```

The file may be actively appended while the viewer is running. A minilog has
no explicit response-finished marker: the next `Prompt:` starts the next call.

## Goals

- Support minilog files through normal file import.
- Support minilog files through live folder watching and incremental appends.
- Preserve the JSON request body, model, stream flag, messages, timestamps, raw
  evidence, and reconstructed assistant response in the existing call shape.
- Keep partially written prompt JSON and token lines buffered without throwing
  or fabricating a call.
- Close a call at the next `Prompt:` boundary. Treat the final call as complete
  only when it has reconstructed output and its latest minilog timestamp is at
  least five minutes older than the parser's supplied clock; otherwise keep it
  incomplete.
- Leave existing LM Studio record parsing and live behavior unchanged.

## Non-goals

- Decode token IDs or infer text that is not present after `token:`.
- Treat diagnostic lines such as `Preserved token:`, `Not preserved because`, or
  `Resampling because` as generated output.
- Add a new server, dependency, or persistence layer.
- Infer a response finish reason or usage values that minilog did not log.

## Approaches considered

1. Translate minilog text into synthetic existing request/response records.
   This minimizes new concepts, but it loses the natural token boundary and is
   difficult to update one response as new bytes arrive.
2. Build a separate minilog parser and live reducer. This is locally simple,
   but duplicates call construction, status calculation, and UI-facing data
   shaping.
3. Add minilog-specific normalized events to the existing parser and live
   reducer contracts. This keeps static import and live watching on one event
   model while preserving the existing call shape. This is the selected
   approach.

## Architecture

### Format recognition and parsing

The parser will recognize a source as minilog when it contains a line matching
the minilog prompt header. The header grammar is:

```text
^\\[(\\d+(?:\\.\\d+)?)\\]\\s+Prompt:\\s*$
```

Token lines use:

```text
^\\[(\\d+(?:\\.\\d+)?)\\]\\s+token:(.*)$
```

The parser will preserve the token payload exactly, including an empty payload,
leading spaces, punctuation, and special tokens. The numeric timestamp is
interpreted as Unix seconds and exposed in both its original form and the
existing millisecond timestamp field.

Prompt JSON is scanned with the existing string-aware balanced-object logic.
Only the JSON object following `Prompt:` is parsed as the request body. A
prompt with incomplete JSON remains buffered in incremental mode; a completed
but malformed object produces a warning and does not create a request.

### Normalized events

Minilog parsing will emit events compatible with the live reducer:

- A normal `request` event containing the parsed prompt body, marked with
  minilog format metadata and a stable per-prompt correlation ID.
- A `minilog-token` event for each complete token line, carrying the exact text,
  timestamp, line range, and the active prompt correlation ID.

When a new minilog request arrives, the reducer closes the previous active
minilog call for that source. Token events remain separate so each appended
line can update the same call without re-emitting or replacing prior events.

### Static parsing

`parseSource` will route minilog sources through the same normalized event
semantics used by live parsing. Each prompt becomes one call with the existing
fields:

- `request` and `requestRaw` from the prompt JSON;
- `model`, `stream`, `messages`, and the existing normalized message objects;
- `outputMessage: { role: "assistant", content: <concatenated token text> }`
  when at least one token was present;
- a synthetic OpenAI-compatible `response` containing that message, with
  unknown `usage` and `finish_reason` left null;
- `responseRaw` containing the token evidence and `responseLineStart` at the
  first token line;
- `streamPackets: []`, because minilog token lines are not OpenAI packet JSON.

Calls closed by a later prompt are complete when output exists. The final call
uses the five-minute stale rule. A final prompt with no output remains
incomplete even if it is old, because the log does not prove that generation
finished.

### Incremental parsing and live reduction

`createIncrementalParser` will retain its current buffer until it has enough
bytes to parse a complete prompt object or a complete newline-terminated token
line. This handles JSON split across reads and a token line that is still being
written. Each emitted token event has a unique event ID, while its correlation
ID points to the prompt that owns it.

`createLiveReducer` will maintain active minilog calls by source and
correlation ID. On each token event it will append text, rebuild the synthetic
response view, and update the existing call ID. On a later prompt it will mark
the previous call complete when output exists. Status rebuilding will apply the
five-minute stale rule using an injectable `now` value so tests remain
deterministic. Existing packet-stream association and ordinary prediction
association remain separate paths.

The directory tail source already accepts names ending in `.log`, so
`request.log.log` requires no file-filter change. Its existing byte offsets,
rotation reset, and retry behavior will be reused unchanged.

## Error handling

- Incomplete prompt JSON at the live read boundary is buffered silently until
  more bytes arrive.
- Malformed completed prompt JSON produces the existing persistent parse warning
  shape with source and line information.
- Non-token diagnostic lines are ignored and do not close or mutate a call.
- A token line without an active prompt is ignored with a warning rather than
  being attached to an arbitrary request.
- A source containing only minilog diagnostics still parses successfully with
  zero calls.

## Testing strategy

Parser tests will cover:

- multiline minilog prompt JSON and Unix-second timestamp conversion;
- exact concatenation of multiple token lines, including spaces and empty
  tokens;
- prompt-boundary completion and final-call incompleteness;
- final-call completion when the injected clock is at least five minutes past
  the latest token timestamp;
- malformed and truncated prompt JSON without exceptions;
- ignored diagnostic lines and orphan token warnings;
- a prompt or token line split across incremental `push` calls;
- incremental updates that preserve one call ID while appending output.

Existing parser and live-source tests will continue to run unchanged. The live
source test suite will also verify that a `.log.log` entry is discovered and
tailed like other `.log` files.

## Acceptance criteria

- Opening the supplied `request.log.log` shows its prompt calls and reconstructed
  assistant outputs without requiring conversion.
- Watching its containing folder shows the current call update as new token
  lines arrive and creates the next call when a new prompt appears.
- A partially written prompt or token line does not create duplicate calls or
  throw an error.
- The final call follows the five-minute stale rule described above.
- All existing tests pass and the new tests fail before implementation and pass
  after the minimal implementation.
