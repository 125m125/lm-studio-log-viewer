# Tool Call Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible exploration tray that inventories deduplicated assistant tool invocations and navigates between invocations in the selected conversation or all loaded history.

**Architecture:** Add a dependency-free `tool-explorer.js` UMD module containing pure indexing, scoping, inventory, and state-reconciliation functions that can be tested directly in Node. Keep DOM rendering and navigation in `app.js`, using stable record and target IDs from the module to render individually addressable tool-call entries and drive the collapsible tray.

**Tech Stack:** Plain HTML, CSS, browser JavaScript, CommonJS-compatible Node.js modules, and the built-in `node:test` runner; no build process or external dependencies.

## Global Constraints

- The first version covers assistant tool invocations only; tool-role result messages are not separate occurrences.
- Do not change parser behavior or add result pairing, argument search, aggregate dashboards, or simultaneous explorer modules.
- Current-conversation scope means every call in the selected reconstructed thread; all-history scope means the full parsed result, independent of sidebar filters.
- Prefer tool-call IDs for deduplication and use thread, logical assistant-message position, invocation ordinal, function name, and normalized arguments as the fallback identity.
- Prefer a generated-response source as a logical invocation's jump target; otherwise use the earliest request-context source.
- Previous and Next stop at sequence boundaries rather than wrapping.
- Preserve tray state across logged-call navigation and live updates whenever the referenced type and occurrence still exist.
- Keep the viewer dependency-free, client-side, keyboard accessible, and usable at narrow viewport widths.

---

## File Structure

- Create `tool-explorer.js`: pure normalized invocation indexing, deduplication, scope selection, inventory, and explorer-state reconciliation.
- Create `tests/tool-explorer.test.js`: focused unit tests for the module's public contract and edge cases.
- Modify `index.html`: load `tool-explorer.js` before `app.js`.
- Modify `app.js`: exploration state, tray rendering, individually addressable invocation rendering, event handling, and jump/focus behavior.
- Modify `styles.css`: collapsed/expanded tray, tool chips, invocation cards, highlight, focus, and responsive styles.
- Modify `tests/static.test.js`: integration assertions for script order, accessible controls, stable render targets, and live-update wiring.
- Modify `README.md`: mention tool inventory and navigation in the feature list.

### Public Module Contract

`tool-explorer.js` exposes `window.LMStudioToolExplorer` in the browser and `module.exports` in Node with these functions:

```js
buildInvocationIndex(result)
// => Array<InvocationRecord>

getThreadIdForCall(result, callId)
// => string | null

getScopedInvocations(records, result, selectedCallId, scope)
// scope: "conversation" | "history"
// => Array<InvocationRecord>

summarizeToolTypes(records)
// => Array<{ name: string, count: number }>

reconcileSelection(records, selectedType, selectedRecordId, previousPosition = 0)
// => { selectedType: string | null, selectedRecordId: string | null, position: number, matching: Array<InvocationRecord> }
```

Each `InvocationRecord` has this stable shape:

```js
{
  id: "thread-call-1:id:tool-17",
  identity: "id:tool-17",
  threadId: "thread-call-1",
  name: "search",
  arguments: "{\"query\":\"logs\"}",
  parsedArguments: { query: "logs" },
  logicalMessageIndex: 3,
  toolIndex: 0,
  timestamp: 1723400000000,
  timestampRaw: "2026-08-11 12:00:00",
  model: "example-model",
  target: {
    callId: "call-0-2",
    source: "response", // or "request"
    messageIndex: null, // number for request sources
    toolIndex: 0,
    domId: "tool-invocation-1abc23"
  }
}
```

---

### Task 1: Build and deduplicate the invocation index

**Files:**
- Create: `tool-explorer.js`
- Create: `tests/tool-explorer.test.js`

**Interfaces:**
- Consumes: parsed results with `result.calls`, `result.threads`, normalized request `message.toolCalls`, and response `call.outputMessage.tool_calls`.
- Produces: `buildInvocationIndex(result)`, `getThreadIdForCall(result, callId)`, and the `InvocationRecord` contract above.

- [ ] **Step 1: Write failing tests for extraction, ordering, and ID-based deduplication**

Create fixtures inline so the tests do not depend on parser logs:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const explorer = require("../tool-explorer.js");

function tool(id, name, args) {
  return { id, type: "function", function: { name, arguments: args } };
}

function resultWith(calls) {
  return {
    calls,
    threads: [{ id: "thread-root", calls }],
  };
}

test("indexes response and request tool invocations in conversation order", () => {
  const responseTool = tool("tool-1", "search", '{"q":"logs"}');
  const calls = [
    { id: "call-1", timestamp: 10, timestampRaw: "t1", model: "m", messages: [], outputMessage: { tool_calls: [responseTool] } },
    { id: "call-2", timestamp: 20, timestampRaw: "t2", model: "m", messages: [
      { index: 0, role: "assistant", toolCalls: [responseTool] },
      { index: 1, role: "assistant", toolCalls: [tool("tool-2", "write", "raw arguments")] },
    ], outputMessage: null },
  ];

  const records = explorer.buildInvocationIndex(resultWith(calls));
  assert.deepEqual(records.map(record => record.name), ["search", "write"]);
  assert.equal(records[0].target.source, "response");
  assert.equal(records[0].target.callId, "call-1");
  assert.equal(records[1].parsedArguments, null);
});
```

- [ ] **Step 2: Run the new test and verify the module is missing**

Run: `node --test tests/tool-explorer.test.js`

Expected: FAIL because `../tool-explorer.js` cannot be resolved.

- [ ] **Step 3: Implement the UMD shell, argument normalization, source extraction, ordering, and ID-based deduplication**

Use a browser/Node wrapper matching the parser's established pattern:

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LMStudioToolExplorer = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  }

  function normalizeArguments(raw) {
    const text = typeof raw === "string" ? raw : stableStringify(raw);
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return { text: stableStringify(parsed), parsed };
    } catch (_) {
      return { text, parsed: null };
    }
  }

  function getThreadIdForCall(result, callId) {
    const thread = (result.threads || []).find(item => item.calls.some(call => call.id === callId));
    return thread ? thread.id : null;
  }

  function hash(text) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index++) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(36);
  }

  function buildInvocationIndex(result) {
    const preferred = new Map();
    for (const thread of result.threads || []) {
      const calls = thread.calls.slice().sort((a, b) =>
        (a.timestamp ?? 0) - (b.timestamp ?? 0) ||
        (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0) ||
        (a.lineStart ?? 0) - (b.lineStart ?? 0));

      function add(call, toolCall, logicalMessageIndex, toolIndex, source, messageIndex) {
        const fn = toolCall && toolCall.function || {};
        const name = fn.name || "Unknown tool";
        const normalized = normalizeArguments(fn.arguments == null ? "" : fn.arguments);
        const identity = toolCall && toolCall.id
          ? "id:" + toolCall.id
          : "fallback:" + [logicalMessageIndex, toolIndex, name, normalized.text].join("\u0000");
        const id = thread.id + ":" + identity;
        const candidate = {
          id,
          identity,
          threadId: thread.id,
          name,
          arguments: normalized.text,
          parsedArguments: normalized.parsed,
          logicalMessageIndex,
          toolIndex,
          timestamp: call.timestamp,
          timestampRaw: call.timestampRaw,
          model: call.model,
          target: {
            callId: call.id,
            source,
            messageIndex,
            toolIndex,
            domId: "tool-invocation-" + hash(id),
          },
          sortKey: [call.timestamp ?? 0, call.sourceIndex ?? 0, call.lineStart ?? 0, logicalMessageIndex, toolIndex],
        };
        const current = preferred.get(id);
        if (!current || (current.target.source === "request" && source === "response")) preferred.set(id, candidate);
      }

      for (const call of calls) {
        (call.messages || []).forEach((message, messagePosition) => {
          if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) return;
          const logicalMessageIndex = Number.isInteger(message.index) ? message.index : messagePosition;
          message.toolCalls.forEach((toolCall, toolIndex) =>
            add(call, toolCall, logicalMessageIndex, toolIndex, "request", logicalMessageIndex));
        });
        const responseCalls = call.outputMessage && call.outputMessage.tool_calls;
        if (Array.isArray(responseCalls)) {
          responseCalls.forEach((toolCall, toolIndex) =>
            add(call, toolCall, (call.messages || []).length, toolIndex, "response", null));
        }
      }
    }
    return [...preferred.values()]
      .sort((a, b) => {
        for (let index = 0; index < a.sortKey.length; index++) {
          if (a.sortKey[index] !== b.sortKey[index]) return a.sortKey[index] - b.sortKey[index];
        }
        return a.id.localeCompare(b.id);
      })
      .map(record => {
        const clean = { ...record };
        delete clean.sortKey;
        return clean;
      });
  }

  return { buildInvocationIndex, getThreadIdForCall };
});
```

In `buildInvocationIndex`, ignore non-assistant request messages and non-array tool-call fields. Normalize missing names to `"Unknown tool"`. Escape unsafe characters when deriving `target.domId`; do not place raw IDs into CSS selectors.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test tests/tool-explorer.test.js`

Expected: PASS with 1 test and 0 failures.

- [ ] **Step 5: Add failing fallback-identity tests**

Add separate tests proving that:

```js
test("fallback identity joins a response to its later request copy", () => {
  // call-1 response is logical message 1; call-2 repeats that assistant message
  // at message.index 1 with the same tool ordinal, name, and normalized args.
  assert.equal(explorer.buildInvocationIndex(fixture).length, 1);
  assert.equal(explorer.buildInvocationIndex(fixture)[0].target.source, "response");
});

test("fallback identity keeps identical calls at different message positions", () => {
  assert.equal(explorer.buildInvocationIndex(fixture).length, 2);
});

test("fallback identity stabilizes structured keys but preserves invalid text", () => {
  assert.equal(recordsForEquivalentJson.length, 1);
  assert.equal(recordsForDifferentInvalidText.length, 2);
});
```

- [ ] **Step 6: Run the fallback tests and verify they fail**

Run: `node --test --test-name-pattern="fallback identity" tests/tool-explorer.test.js`

Expected: FAIL because fallback candidates are not yet deduplicated correctly.

- [ ] **Step 7: Implement the deterministic fallback identity**

Construct the candidate identity exactly as:

```js
const identity = toolCall.id
  ? "id:" + toolCall.id
  : "fallback:" + [
      logicalMessageIndex,
      toolIndex,
      name,
      normalizedArguments.text,
    ].join("\u0000");
const recordId = thread.id + ":" + identity;
```

The record ID is thread-scoped even when a tool-call ID exists, preventing unrelated conversations with reused provider IDs from merging.

- [ ] **Step 8: Run the module tests and the full suite**

Run: `node --test tests/tool-explorer.test.js`

Expected: PASS with all tool-explorer tests and 0 failures.

Run: `node --test`

Expected: PASS with 0 failures.

- [ ] **Step 9: Commit the pure invocation index**

```powershell
git add -- tool-explorer.js tests/tool-explorer.test.js
git commit -m "feat: index tool invocations"
```

---

### Task 2: Add scope, inventory, and selection reconciliation

**Files:**
- Modify: `tool-explorer.js`
- Modify: `tests/tool-explorer.test.js`

**Interfaces:**
- Consumes: `InvocationRecord[]`, parsed result, selected call ID, `"conversation" | "history"`, selected type, and selected record ID.
- Produces: `getScopedInvocations`, `summarizeToolTypes`, and `reconcileSelection` with the public signatures documented above.

- [ ] **Step 1: Write failing tests for conversation and history scope**

```js
test("conversation scope follows the selected call's thread", () => {
  const records = explorer.buildInvocationIndex(twoThreadResult);
  assert.deepEqual(
    explorer.getScopedInvocations(records, twoThreadResult, "call-b", "conversation").map(record => record.threadId),
    ["thread-b"],
  );
  assert.equal(explorer.getScopedInvocations(records, twoThreadResult, "call-b", "history").length, 3);
});
```

The fixture must include sidebar-filter-like properties on the result but no scope input for them, proving scope uses `result.threads` only.

- [ ] **Step 2: Write failing tests for inventory order and selection reconciliation**

```js
test("summarizes types by count and then name", () => {
  assert.deepEqual(explorer.summarizeToolTypes(records), [
    { name: "search", count: 2 },
    { name: "read", count: 1 },
    { name: "write", count: 1 },
  ]);
});

test("reconciles missing type and record deterministically", () => {
  assert.deepEqual(explorer.reconcileSelection(records, "missing", "gone"), {
    selectedType: "search",
    selectedRecordId: recordsForSearch[0].id,
    position: 0,
    matching: recordsForSearch,
  });
  assert.equal(explorer.reconcileSelection([], "search", "gone").selectedType, null);
});
```

Also test that a valid selected type is retained, a stale record chooses the nearest valid occurrence by prior position when supplied, and navigation callers can derive disabled boundaries from `position === 0` and `position === matching.length - 1`.

- [ ] **Step 3: Run the focused tests and verify missing exports fail**

Run: `node --test --test-name-pattern="scope|summarizes|reconciles" tests/tool-explorer.test.js`

Expected: FAIL because the three functions are not exported.

- [ ] **Step 4: Implement the three pure functions**

```js
function getScopedInvocations(records, result, selectedCallId, scope) {
  if (scope === "history") return records.slice();
  const threadId = getThreadIdForCall(result, selectedCallId);
  return threadId ? records.filter(record => record.threadId === threadId) : [];
}

function summarizeToolTypes(records) {
  const counts = new Map();
  records.forEach(record => counts.set(record.name, (counts.get(record.name) || 0) + 1));
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function reconcileSelection(records, selectedType, selectedRecordId, previousPosition) {
  const types = summarizeToolTypes(records);
  const type = types.some(item => item.name === selectedType) ? selectedType : (types[0] && types[0].name) || null;
  const matching = type ? records.filter(record => record.name === type) : [];
  let position = matching.findIndex(record => record.id === selectedRecordId);
  if (position < 0) position = Math.min(Math.max(previousPosition || 0, 0), Math.max(matching.length - 1, 0));
  return { selectedType: type, selectedRecordId: matching[position] ? matching[position].id : null, position, matching };
}
```

Update the public signature comment to include optional `previousPosition` and export all functions.

- [ ] **Step 5: Run module and full tests**

Run: `node --test tests/tool-explorer.test.js`

Expected: PASS with all module tests and 0 failures.

Run: `node --test`

Expected: PASS with 0 failures.

- [ ] **Step 6: Commit scope and selection logic**

```powershell
git add -- tool-explorer.js tests/tool-explorer.test.js
git commit -m "feat: derive tool explorer views"
```

---

### Task 3: Render individually addressable tool invocations

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `styles.css`
- Modify: `tests/static.test.js`

**Interfaces:**
- Consumes: `window.LMStudioToolExplorer.buildInvocationIndex(state.result)` and `InvocationRecord.target`.
- Produces: DOM elements whose IDs equal `record.target.domId`, with `data-tool-record-id`, a focusable destination, per-invocation copy controls, and expandable request/response containers.

- [ ] **Step 1: Write failing static integration tests**

Add tests that require:

```js
test("tool explorer loads before the application", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /<script src="tool-explorer\.js"><\/script>\s*<script src="app\.js"><\/script>/);
});

test("tool invocations render as individually addressable entries", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /function renderToolInvocations/);
  assert.match(app, /data-tool-record-id/);
  assert.match(app, /data-copy-tool/);
  assert.match(app, /target\.domId/);
});
```

- [ ] **Step 2: Run the static tests and verify they fail**

Run: `node --test tests/static.test.js`

Expected: FAIL because the module script and granular renderer are absent.

- [ ] **Step 3: Load the module and add explorer-derived render lookup**

Insert `<script src="tool-explorer.js"></script>` after `live-source.js` and before `app.js`.

In `app.js`, create one index per render/result update rather than recomputing it per tool entry:

```js
function invocationRecords() {
  return state.result ? window.LMStudioToolExplorer.buildInvocationIndex(state.result) : [];
}

function recordsForTarget(callId, source, messageIndex) {
  return invocationRecords().filter(record =>
    record.target.callId === callId &&
    record.target.source === source &&
    record.target.messageIndex === messageIndex
  );
}
```

Cache the array on `state.explorer.records` and rebuild it only after file load or live-result mutation. Do not call `buildInvocationIndex` from each message renderer.

- [ ] **Step 4: Implement one shared tool-invocation renderer**

```js
function renderToolInvocations(toolCalls, records, copyPrefix) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return "";
  return '<div class="tool-invocations">' + toolCalls.map((toolCall, index) => {
    const record = records.find(item => item.target.toolIndex === index);
    const fn = toolCall && toolCall.function || {};
    const args = fn.arguments == null ? "" : contentText(fn.arguments);
    return '<article class="tool-invocation" id="' + escapeHtml(record ? record.target.domId : "") + '" tabindex="-1" data-tool-record-id="' + escapeHtml(record ? record.id : "") + '">' +
      '<div class="tool-invocation-head"><strong>' + escapeHtml(fn.name || "Unknown tool") + '</strong>' +
      '<button type="button" data-copy-tool="' + escapeHtml(copyPrefix + ":" + index) + '">Copy</button></div>' +
      '<pre>' + escapeHtml(args || "(empty arguments)") + '</pre></article>';
  }).join("") + "</div>";
}
```

Use it for `message.toolCalls` inside an expandable request message and for `output.tool_calls` inside a dedicated open response payload. Keep the existing whole-array `response-tools` copy behavior only if it remains useful; each invocation must have its own copy action.

- [ ] **Step 5: Wire invocation copy controls and styles**

Build a per-render `Map` from `copyPrefix:index` to the original tool-call object, then call `copyText(contentText(value))`. Style `.tool-invocation`, `.tool-invocation-head`, and argument `<pre>` consistently with existing payloads. Add visible `:focus` styling.

- [ ] **Step 6: Run static and full tests**

Run: `node --test tests/static.test.js`

Expected: PASS with 0 failures.

Run: `node --test`

Expected: PASS with 0 failures.

- [ ] **Step 7: Commit granular tool rendering**

```powershell
git add -- index.html app.js styles.css tests/static.test.js
git commit -m "feat: render addressable tool invocations"
```

---

### Task 4: Add the collapsible exploration tray and navigation

**Files:**
- Modify: `app.js`
- Modify: `styles.css`
- Modify: `tests/static.test.js`

**Interfaces:**
- Consumes: all five `LMStudioToolExplorer` public functions and stable invocation DOM targets.
- Produces: persistent `state.explorer`, tray markup, scope/type controls, preview, bounded Previous/Next navigation, and exact jump behavior.

- [ ] **Step 1: Write failing static tests for tray controls and state**

```js
test("exploration tray exposes accessible persistent controls", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /explorer:\s*\{[^}]*open:\s*false[^}]*scope:\s*"conversation"/s);
  assert.match(app, /aria-expanded/);
  assert.match(app, /aria-pressed/);
  assert.match(app, /Current conversation/);
  assert.match(app, /All loaded history/);
  assert.match(app, /data-explorer-previous/);
  assert.match(app, /data-explorer-next/);
});

test("tool navigation expands focuses scrolls and highlights its destination", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /scrollIntoView/);
  assert.match(app, /classList\.add\("tool-jump-highlight"\)/);
  assert.match(app, /\.focus\(/);
  assert.match(app, /closest\("details"\)/);
});
```

- [ ] **Step 2: Run static tests and verify they fail**

Run: `node --test --test-name-pattern="exploration tray|tool navigation" tests/static.test.js`

Expected: FAIL because the tray and jump logic do not exist.

- [ ] **Step 3: Add persistent explorer state and reconciliation**

Extend initial state without resetting it during ordinary call selection:

```js
explorer: {
  open: false,
  module: "tool-calls",
  scope: "conversation",
  records: [],
  selectedType: null,
  selectedRecordId: null,
  position: 0,
}
```

Add `rebuildExplorerIndex()` after snapshot parsing and each live reducer update. Add `getExplorerView()` that calls `getScopedInvocations`, `summarizeToolTypes`, and `reconcileSelection`, then writes the reconciled selection back to state.

- [ ] **Step 4: Render the collapsed and expanded tray above detail content**

Create `renderExplorerTray(call)` and prepend its result inside `els.detail`:

```html
<section class="explorer-tray">
  <button type="button" data-explorer-toggle aria-expanded="true">Explore</button>
  <div class="explorer-panel">
    <div class="explorer-toolbar">
      <span>Tool calls</span>
      <button data-explorer-scope="conversation" aria-pressed="true">Current conversation</button>
      <button data-explorer-scope="history" aria-pressed="false">All loaded history</button>
    </div>
    <div class="explorer-types" aria-label="Tool types"></div>
    <div class="explorer-navigation"></div>
  </div>
</section>
```

Type chips show `name` and `count`; the selected chip has `aria-pressed="true"`. The preview shows formatted arguments, time, model, and containing call ID. Empty scope copy is exactly `No tool invocations found in this scope.`

- [ ] **Step 5: Wire toggle, scope, type, and bounded navigation events**

Use delegated or post-render handlers. Selecting a type chooses its first chronological record. Previous/Next decrement or increment only inside `[0, matching.length - 1]`; disable them at those boundaries. Changing scope retains the type if available and otherwise accepts `reconcileSelection`'s first type.

- [ ] **Step 6: Implement exact jump behavior after render**

```js
function jumpToInvocation(record) {
  if (!record) return;
  state.selectedId = record.target.callId;
  renderList();
  renderDetail();
  requestAnimationFrame(() => {
    const target = document.getElementById(record.target.domId);
    if (!target) return handleStaleExplorerTarget(record);
    const details = target.closest("details");
    if (details) details.open = true;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    target.classList.add("tool-jump-highlight");
    setTimeout(() => target.classList.remove("tool-jump-highlight"), 1400);
  });
}
```

For request sources, ensure the containing message `<details>` is opened. For response sources, ensure the response tool-call `<details>` is opened. If the target is stale, remove that occurrence from the current view, reconcile to the nearest valid position, and show `toast("That tool invocation is no longer available")`; jump to the fallback only when it differs from the stale record.

- [ ] **Step 7: Style desktop, collapsed, focus, highlight, and narrow-screen states**

Add styles for `.explorer-tray`, `.explorer-panel`, `.explorer-toolbar`, `.explorer-types`, `.explorer-type`, `.explorer-navigation`, `.explorer-preview`, and `.tool-jump-highlight`. At `max-width: 800px`, keep the tray in normal flow, set `.explorer-types { overflow-x: auto; }`, stack preview metadata, and prevent page-width overflow. Under `@media (prefers-reduced-motion: reduce)`, set highlight transitions and animations to `none`; in `jumpToInvocation`, choose `behavior: "auto"` when `matchMedia("(prefers-reduced-motion: reduce)").matches` and `"smooth"` otherwise.

- [ ] **Step 8: Run static and full automated tests**

Run: `node --test tests/static.test.js`

Expected: PASS with 0 failures.

Run: `node --test`

Expected: PASS with 0 failures.

- [ ] **Step 9: Manually verify interaction and responsive behavior**

Serve the repository over localhost, load a log containing at least two tool types, and verify:

1. The tray opens and closes without losing scope/type/position.
2. Current conversation and all history show different counts when expected.
3. Sidebar search/status/model filters do not change all-history counts.
4. Selecting a type jumps to its first occurrence.
5. Previous and Next disable at the ends and never wrap.
6. Each jump selects the containing call, expands the source, centers the invocation, focuses it, and highlights it.
7. Keyboard-only operation reaches every control and destination.
8. At a viewport at or below 800 px, the tray and chips do not widen the page.

- [ ] **Step 10: Commit the exploration tray**

```powershell
git add -- app.js styles.css tests/static.test.js
git commit -m "feat: navigate tool invocations"
```

---

### Task 5: Harden live updates, empty states, and documentation

**Files:**
- Modify: `app.js`
- Modify: `tests/static.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: `rebuildExplorerIndex()`, `getExplorerView()`, existing `loadFiles`, `flushLiveUpdates`, `startWatching`, and `clearAll` lifecycle paths.
- Produces: deterministic explorer behavior for snapshot replacement, live mutation, empty results, stale selections, and clearing.

- [ ] **Step 1: Write failing lifecycle wiring tests**

```js
test("explorer index follows snapshot and live result changes", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const loadFiles = app.slice(app.indexOf("async function loadFiles"), app.indexOf("function populateModels"));
  const flush = app.slice(app.indexOf("function flushLiveUpdates"), app.indexOf("function scheduleLiveFlush"));
  assert.match(loadFiles, /rebuildExplorerIndex\(\)/);
  assert.match(flush, /rebuildExplorerIndex\(\)/);
  assert.match(app, /No tool invocations found in this scope\./);
});
```

Add an assertion that `clearAll` empties cached records and selected occurrence while retaining the default module contract.

- [ ] **Step 2: Run the lifecycle test and verify it fails if any path is unwired**

Run: `node --test --test-name-pattern="explorer index follows" tests/static.test.js`

Expected: FAIL until every lifecycle path explicitly updates explorer state.

- [ ] **Step 3: Wire and reconcile every result lifecycle**

Ensure:

- `loadFiles` rebuilds records after assigning `state.result` and then reconciles selection;
- `flushLiveUpdates` rebuilds records after applying events, retaining type and nearest position;
- `startWatching` initializes an empty index without closing the tray;
- `clearAll` clears records, selected type, selected record ID, and position, while leaving `module: "tool-calls"` and `scope: "conversation"` valid;
- selecting a sidebar call in another thread rerenders the tray and recomputes conversation scope;
- history scope remains unchanged by sidebar selection and all sidebar filters.

- [ ] **Step 4: Update the feature documentation**

Add this README feature bullet:

```markdown
- Collapsible tool-call explorer with per-function inventories and Previous/Next navigation across the selected conversation or all loaded history
```

- [ ] **Step 5: Run all automated tests**

Run: `node --test`

Expected: PASS with 0 failures.

- [ ] **Step 6: Perform final manual regression checks**

Verify one-shot file loading, folder watching, clearing, text search, status filtering, model filtering, call selection, request-message expansion, response payload expansion, and all copy buttons. Confirm a log without tool calls displays the explorer empty state and the rest of the viewer remains unchanged.

- [ ] **Step 7: Commit lifecycle hardening and documentation**

```powershell
git add -- app.js tests/static.test.js README.md
git commit -m "docs: finish tool explorer integration"
```

---

### Task 6: Final verification and review handoff

**Files:**
- Verify: `tool-explorer.js`
- Verify: `tests/tool-explorer.test.js`
- Verify: `index.html`
- Verify: `app.js`
- Verify: `styles.css`
- Verify: `tests/static.test.js`
- Verify: `README.md`

**Interfaces:**
- Consumes: the complete feature and all preceding commits.
- Produces: fresh evidence that the implementation satisfies the design and is ready for review.

- [ ] **Step 1: Run the complete automated suite**

Run: `node --test`

Expected: PASS with 0 failures.

- [ ] **Step 2: Check repository and patch hygiene**

Run: `git diff --check`

Expected: no output and exit code 0.

Run: `git status --short`

Expected: no unexpected or unrelated files.

- [ ] **Step 3: Review every design requirement against the implementation**

Check the design sections in `docs/superpowers/specs/2026-08-11-tool-call-explorer-design.md` against the working UI and tests. Record any gap as a failing test first, implement the smallest correction, rerun `node --test`, and commit the correction with a message describing that behavior.

- [ ] **Step 4: Request code review**

Invoke `superpowers:requesting-code-review` and provide the design spec, this plan, the implementation commit range, automated-test output, and manual-check results.
