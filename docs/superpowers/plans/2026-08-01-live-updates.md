# Live Log Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-file live log tailing with incremental rendering while keeping the frontend independent from the eventual HTTP proxy source.

**Architecture:** Add a stateful incremental log parser and a source-neutral event/reducer boundary. A `FileTailSource` polls a File System Access API handle, emits appended text batches and source warnings, and the reducer updates the existing call/thread result. Request-to-stream association remains definitive only when evidence supports it; ambiguous log-only matches remain uncertain or unassigned.

**Tech Stack:** Dependency-free browser JavaScript, File System Access API with fallback, CommonJS-compatible parser modules, browser Web Worker where applicable, Node built-in `node:test`.

## Global Constraints

- Preserve existing one-shot multi-file import and streamed-response behavior.
- Watch one file at a time; existing multi-file loading remains snapshot-only.
- Do not add a backend, HTTP proxy, network dependency, persistence, or third-party package.
- Never silently attach a stream to a request when multiple associations are plausible.
- Buffer incomplete trailing lines and multiline JSON records until more bytes arrive.
- Keep the source-neutral event fields `sourceId`, optional `correlationId`, `kind`, `timestamp`, `payload`, and `confidence`.

---

## File map

- Create `live-source.js`: source-neutral live source contract and `FileTailSource` polling implementation. No UI rendering.
- Modify `parser.js`: expose stateful incremental record parsing and normalized event application while retaining `parseFiles()` as the complete-file API.
- Modify `app.js`: manage live source lifecycle, merge live reducer results into UI state, preserve filters/selection, and render live status.
- Modify `index.html`: add watch controls and live status elements.
- Modify `styles.css`: style live controls, status, warnings, and uncertain/unassigned stream presentation.
- Modify `tests/parser.test.js`: incremental parser and correlation contracts.
- Create `tests/live-source.test.js`: source polling and file-boundary behavior using injected file readers/timers.
- Modify `tests/static.test.js`: static contracts for live controls and update-safe rendering.
- Modify `README.md`: document watch mode, browser support fallback, and attribution limitations.

### Task 1: Define incremental parser and normalized event contracts

**Files:**
- Modify: `tests/parser.test.js`
- Modify: `parser.js`

**Interfaces:**
- Consumes: appended text chunks and per-source parser state.
- Produces: `createIncrementalParser(sourceId)`, whose `push(text, options)` returns `{ events, warnings }` and whose `finish()` returns buffered-record warnings; events use `{ sourceId, correlationId, kind, timestamp, payload, confidence }`.

- [ ] **Step 1: Add failing tests for split records and duplicate-safe event output**

Add tests that construct one parser and split a request record between calls to `push()`, then split a `Generated packet:` JSON body across calls. Assert that no event is emitted before the JSON closes, the completed event is emitted exactly once, and `finish()` reports an incomplete record only when the source is ended with buffered content.

Use this contract shape:

```js
const stream = parser.createIncrementalParser("tail.log");
const first = stream.push('[2026-08-01 10:00:00][DEBUG] Received request: POST to /v1/chat/completions with body {"model":"m"');
assert.deepEqual(first.events, []);
const second = stream.push('}\n[2026-08-01 10:00:01][INFO][m] Generated packet: {"id":"s-1","choices":[]}\n');
assert.deepEqual(second.events.map(event => event.kind), ["request", "packet"]);
assert.equal(stream.push("").events.length, 0);
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test tests/parser.test.js --test-name-pattern="incremental|split records|duplicate-safe"`

Expected: FAIL because `createIncrementalParser` is not exported.

- [ ] **Step 3: Implement the stateful parser with existing marker/scanner logic**

Refactor the existing line/event discovery so the complete parser and incremental parser share marker parsing. Keep a `remainder` string and absolute line counter per parser. Split only at complete newline boundaries; pass complete logical lines through the existing multiline JSON scanner, and retain a pending marker record when its closing brace has not arrived. Emit normalized events for request, run, prediction, packet, and finished records. Use `confidence: "inferred"` for log-derived events and set `correlationId` to the stream ID for packet events when available.

Do not change `parseFiles()` output or matching behavior in this task; adapt it to use the new parser internally only if that avoids duplicated parsing code.

- [ ] **Step 4: Run the focused and full parser tests**

Run: `node --test tests/parser.test.js --test-name-pattern="incremental|parses and matches multiline|streamed response"`

Expected: all selected tests PASS.

Run: `node --test tests/parser.test.js`

Expected: all parser tests PASS with existing call fields unchanged.

- [ ] **Step 5: Commit the parser contract**

```powershell
git add tests/parser.test.js parser.js
git commit -m "feat: expose incremental log parsing"
```

### Task 2: Build the file tail source

**Files:**
- Create: `live-source.js`
- Create: `tests/live-source.test.js`

**Interfaces:**
- Consumes: a file handle or injected `{ getSize(), read(start, end) }` reader, polling interval, and callbacks.
- Produces: `new FileTailSource(options)` with `start()`, `pause()`, `resume()`, and `stop()`; callbacks `onText({ sourceId, text, offset })`, `onStatus(status)`, and `onWarning(warning)`.

- [ ] **Step 1: Add failing tests for append-only reads and unchanged polls**

Use an in-memory reader whose text changes between manually triggered polls. Assert that the first poll reads from offset `0`, the second poll reads only the appended suffix, and a poll with unchanged size calls no read operation. Inject `readNow()` or an equivalent clock-free poll method so tests do not wait on real timers.

- [ ] **Step 2: Add failing tests for truncation and partial append handling**

Assert that a smaller file size resets the offset to `0`, emits a `truncated` warning, and reads the new file content once. Assert that the source forwards a text chunk ending without a newline unchanged to the parser layer rather than discarding it.

- [ ] **Step 3: Implement `FileTailSource` with browser and test adapters**

Implement the source around an injected reader. For a browser `FileSystemFileHandle`, call `getFile()` on each poll and read the byte range with `File.slice(start, end).text()`. Track `offset`, expose `status` values `idle`, `live`, `paused`, `stopped`, and `error`, and serialize polls so a slow read cannot overlap the next read. Use `setInterval` only in `start()`; keep `readNow()` available for tests and manual fallback refresh.

Add `openLogFileHandle()` that uses `window.showOpenFilePicker({ multiple: false, types: [...] })` when available. If unsupported, return a fallback descriptor that requires the caller to provide a newly selected `File` for each refresh; do not claim it is live.

- [ ] **Step 4: Run source tests**

Run: `node --test tests/live-source.test.js`

Expected: all source tests PASS without browser APIs.

- [ ] **Step 5: Commit the source adapter**

```powershell
git add tests/live-source.test.js live-source.js
git commit -m "feat: add incremental file tail source"
```

### Task 3: Add the live call reducer and uncertainty handling

**Files:**
- Modify: `tests/parser.test.js`
- Modify: `parser.js`

**Interfaces:**
- Consumes: normalized events from `createIncrementalParser()`.
- Produces: `createLiveReducer(sourceId)` with `apply(events) -> { result, changes }`, where `result` has the existing `{ calls, threads, stats, warnings }` shape and `changes` reports `addedCallIds`, `updatedCallIds`, and `warnings`.

- [ ] **Step 1: Add failing tests for incremental calls and stream deltas**

Feed request/run events, then packet events in separate `apply()` calls. Assert that the first apply creates an incomplete call, the next apply updates the same call’s packet count/content, and a terminal packet/finished event changes the same call to matched without duplicating it.

- [ ] **Step 2: Add failing tests for ambiguous and definitive associations**

Create two open streamed requests with the same model and then emit a packet group without a definitive request correlation ID. Assert that the resulting stream is not silently assigned to either request and has `status: "uncertain"` or an explicit unassigned-call marker. Add a second case with a normalized event carrying `correlationId: "request-1"`; assert that it attaches to request 1 regardless of request order.

- [ ] **Step 3: Implement reducer state and deterministic updates**

Maintain per-source requests, runs, ordinary response matches, stream groups, event keys, and unassigned streams. Use an event key based on `sourceId`, source offset, and event kind to ignore retries. Reuse the existing aggregation/thread functions after each batch so `result` remains compatible with `app.js` and one-shot consumers.

For packet groups, group by `correlationId` when present. Otherwise use the existing lifecycle/model/order heuristics only when there is one eligible candidate; when there are multiple candidates, create or update an uncertain/unassigned stream and add a warning. Never convert an ambiguous association to `matched` merely because a finished packet arrived.

- [ ] **Step 4: Run reducer and regression tests**

Run: `node --test tests/parser.test.js`

Expected: all existing parser tests and new live reducer tests PASS.

- [ ] **Step 5: Commit the reducer**

```powershell
git add tests/parser.test.js parser.js
git commit -m "feat: reduce live log events safely"
```

### Task 4: Connect live source to the frontend

**Files:**
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `app.js`
- Modify: `tests/static.test.js`

**Interfaces:**
- Consumes: `FileTailSource`, `createIncrementalParser()`, and `createLiveReducer()`.
- Produces: watch controls that start/stop one selected file and update the existing result without resetting filters or selection.

- [ ] **Step 1: Add failing static contracts for controls and update preservation**

Assert that `index.html` contains `watch-log`, `stop-watch`, and `live-status` elements; `app.js` references `FileTailSource`, `createLiveReducer`, and preserves `state.query`, `state.status`, `state.model`, and `state.selectedId` while applying changes; and the UI renders an uncertainty label for uncertain live calls.

- [ ] **Step 2: Add the controls and status markup**

Add a `Watch log file` button, hidden single-file fallback input, `live-status` live region, last-update text, and stop/pause controls near the existing top actions. Keep `Open log files` and its multiple-file input unchanged.

- [ ] **Step 3: Implement lifecycle and update wiring in `app.js`**

Add `state.live` containing source, parser, reducer, `running`, and `lastUpdate`. Start the source from `showOpenFilePicker()` when supported, otherwise show the reselect fallback. On `onText`, pass text to the incremental parser, apply returned events to the reducer, assign `state.result`, repopulate models only when the model set changes, and call `render()` without clearing filters or selection. Keep the selected call ID if it still exists; select the first call only when no selection exists.

Stop the source in `clearAll()` and on `beforeunload`. Surface status/warnings through the existing toast plus the live status region. Keep watch mode and one-shot import mutually clear: starting a watch replaces the current snapshot; opening files stops an active watch.

- [ ] **Step 4: Style live controls and uncertain calls**

Add styles for live/paused/error states, compact status text, warning treatment, and uncertain/unassigned call items. Preserve the existing layout and accessibility contrast.

- [ ] **Step 5: Run static and parser tests**

Run: `node --test tests/static.test.js tests/parser.test.js tests/live-source.test.js`

Expected: all tests PASS.

- [ ] **Step 6: Commit the frontend integration**

```powershell
git add index.html styles.css app.js tests/static.test.js
git commit -m "feat: show live log updates"
```

### Task 5: Document and verify the complete feature

**Files:**
- Modify: `README.md`
- Modify: `tests/live-source.test.js` if verification exposes a reproducible defect

- [ ] **Step 1: Update user documentation**

Document `Watch log file`, the File System Access API requirement, the reselect fallback, one-file scope, polling behavior, and the fact that concurrent log-only request attribution is best-effort when no request ID is available.

- [ ] **Step 2: Run the complete automated suite and whitespace check**

Run: `node --test`

Expected: every test passes.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 3: Perform a manual append/rotation check**

Use a copy of an existing log, start watch mode, append a request and streamed packets in separate writes, and verify that the call appears incomplete first and updates in place as packets arrive. Append a deliberately split multiline JSON record and verify it is not warned about until completed. Replace/truncate the file and verify a warning plus safe restart at offset zero. Create two plausible open requests and verify the resulting stream is visibly uncertain rather than silently attached.

- [ ] **Step 4: Review final state and commit documentation**

Run: `git status --short`

Expected: only intended live-update files are changed; preserve the pre-existing `index.html` modification and unrelated `docs/superpowers/plans/` files.

```powershell
git add README.md
git commit -m "docs: describe live log watching"
```

## Self-review

- Spec coverage: source boundary and future proxy seam are covered by Tasks 1–2; incremental parsing and buffering by Task 1; tailing, pause/stop, and rotation by Task 2; correlation uncertainty by Task 3; UI state and warnings by Task 4; documentation and manual verification by Task 5.
- Placeholder scan: every task names files, interfaces, tests, and commands; no incomplete implementation step remains.
- Type consistency: `FileTailSource.onText` feeds `createIncrementalParser.push()`, whose normalized events feed `createLiveReducer.apply()`, and the reducer returns the existing `result` shape consumed by `app.js`.
