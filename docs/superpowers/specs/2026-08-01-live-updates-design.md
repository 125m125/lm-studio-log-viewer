# Live log updates design

## Goal

Add live updates to the viewer by tailing one selected LM Studio log file while keeping the frontend independent from the eventual event source. Preserve the existing one-shot multi-file import and make request/stream attribution honest when the logs do not contain a definitive correlation ID.

## Context and constraints

The current application reads complete files once and parses them into a snapshot. The parser already understands ordinary predictions and streamed `Generated packet:` records. LM Studio logs may interleave requests, but the available records do not reliably expose an ID linking every request to its response stream. Stream packet IDs can group packets within a stream, but they cannot necessarily identify the originating request.

The browser cannot reliably observe changes through an ordinary `File` snapshot. Live tailing therefore uses a File System Access API file handle where available, with a user re-selection fallback for unsupported browsers. The feature remains local-only and adds no network dependency.

## Design

### Source boundary

Introduce a source-neutral live event boundary between input acquisition and call aggregation:

```text
FileTailSource -> LogRecordParser -> CallReducer -> Frontend
ProxySource    -> CallReducer -> Frontend       (future)
```

The frontend consumes normalized call updates and source status, not file offsets or HTTP details. A source event contains:

- `sourceId`: file name or future connection identifier;
- `correlationId`: optional definitive ID, available to a future proxy;
- `kind`: request, run, prediction, packet, finished, or warning;
- `timestamp`;
- `payload`;
- `confidence`: definitive, inferred, or uncertain.

The initial implementation may keep the existing parser’s internal structures where practical, but the public boundary must make the source replaceable without changing UI rendering.

### File tailing

Add a one-file watch mode next to existing one-shot loading:

- obtain a persistent file handle through `showOpenFilePicker()` when available;
- poll the handle approximately every 750 ms while watching;
- compare the current file size with the last consumed byte offset;
- read only appended bytes and retain an incomplete trailing line or multiline JSON record until the next poll;
- detect truncation or rotation when the current size is smaller than the stored offset, reset the tail safely, and expose a warning;
- stop and release the polling loop when the user stops watching, clears the workspace, or the page unloads.

The fallback path reuses the existing file picker and explains that the user must reselect the file to refresh it. Existing complete-file import remains unchanged.

### Incremental parsing and aggregation

The tail parser maintains per-source state: byte offset, undecoded text remainder, current multiline JSON scan, parsed event position, and warnings. It emits only newly completed records. The call reducer applies events idempotently so a poll or source retry cannot duplicate packets or predictions.

Stream packets are grouped by their stable stream ID when present. A group is attached to a request only when the association is definitive or sufficiently unique based on existing lifecycle markers, model, ordering, and timing. If multiple requests are plausible, the reducer keeps the stream unassigned or marks the association uncertain. It must never silently choose a request merely because it is the nearest one.

An unassigned stream remains visible as a live stream item with partial reconstructed output. If later events make its association unique, the reducer may attach it and update the conversation model. If the source ends without enough evidence, the item remains explicitly uncertain.

### UI behavior

Add a compact live-control area with:

- `Watch log file` action;
- live/paused/stopped state;
- last update time;
- stop/pause control;
- append, truncation, permission, and parse warnings.

New calls and response deltas update the existing thread list, stats, and detail panel without resetting search/filter state. If the selected call is still active, its response content and packet count update in place. If the selected call is unrelated, selection remains stable. Newly detected calls may be selected only when no call was previously selected.

Uncertain associations are visible through the existing status language or a dedicated uncertainty label. The UI must distinguish “stream is still active” from “request association is uncertain.”

### Future proxy compatibility

A future local proxy source can emit the same normalized events with a definitive `correlationId`. The reducer can then bypass heuristic request association while the frontend and call/thread presentation remain unchanged. Proxy setup, authentication, TLS handling, and network permissions are explicitly out of scope for this change.

## Error handling

- Permission denial stops watch mode and leaves the imported snapshot intact.
- File truncation or rotation resets the tail offset and shows a warning rather than duplicating old records.
- Incomplete final lines and JSON records are buffered, not reported as malformed until the source is stopped or the file is otherwise known complete.
- Malformed completed records produce parser warnings without stopping subsequent updates.
- Ambiguous request/stream matches produce uncertain or unassigned calls, never fabricated definitive matches.
- A polling failure is reported in the live controls and can be retried without losing already parsed calls.

## Verification

Add tests for:

1. incremental parsing across chunks split at line and JSON boundaries;
2. no duplicate events when polling unchanged content;
3. append-only updates producing new calls and response deltas;
4. truncation/rotation resetting the tail safely;
5. interleaved streams grouped by stream ID;
6. ambiguous request association remaining uncertain/unassigned;
7. definitive correlation IDs taking precedence over heuristics;
8. UI preserving filters and selection during updates; and
9. existing one-shot parsing and streamed-response behavior remaining unchanged.

Run the complete Node test suite and perform a manual browser check using a copy of a log file that is appended in stages, including a partial multiline record and an ambiguous interleaved case.

## Scope boundaries

This change does not implement an HTTP proxy, guarantee concurrent request attribution from logs, add persistence, or introduce a backend. It watches one file at a time; multi-file import remains available as a snapshot feature.
