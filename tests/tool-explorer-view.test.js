const test = require("node:test");
const assert = require("node:assert/strict");
const view = require("../tool-explorer-view.js");

test("renders an addressable and focusable invocation with safe content", () => {
  const html = view.renderToolInvocations(
    [{ function: { name: "<search>", arguments: '{"q":"<logs>"}' } }],
    [{ id: "record-1", target: { domId: "tool-invocation-abc", toolIndex: 0 } }],
    "response",
  );
  assert.match(html, /id="tool-invocation-abc"/);
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /data-tool-record-id="record-1"/);
  assert.match(html, /data-copy-tool="response:0"/);
  assert.match(html, /&lt;search&gt;/);
  assert.doesNotMatch(html, /<search>/);
});

test("labels each invocation copy control with its tool name", () => {
  const html = view.renderToolInvocations(
    [{ function: { name: "search", arguments: "{}" } }],
    [{ id: "record-1", target: { domId: "tool-invocation-abc", toolIndex: 0 } }],
    "response",
  );
  assert.match(html, /aria-label="Copy search tool invocation"/);
});

test("renders accessible scope type and bounded navigation controls", () => {
  const html = view.renderExplorerTray({
    open: true,
    scope: "conversation",
    types: [{ name: "search", count: 2 }],
    selectedType: "search",
    position: 0,
    total: 2,
    preview: { name: "search", arguments: "{}", time: "12:00", model: "m", callId: "call-1" },
  });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /data-explorer-scope="conversation" aria-pressed="true"/);
  assert.match(html, /data-explorer-type="search" aria-pressed="true"/);
  assert.match(html, /data-explorer-previous[^>]*disabled/);
  assert.match(html, /data-explorer-next/);
  assert.match(html, /1 of 2/);
});

test("renders an empty collapsed tray without phantom navigation", () => {
  const html = view.renderExplorerTray({
    open: false,
    scope: "history",
    types: [],
    selectedType: null,
    position: 0,
    total: 0,
    preview: null,
  });
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /class="explorer-panel" hidden/);
  assert.match(html, /No tool invocations found in this scope\./);
  assert.doesNotMatch(html, /1 of 0/);
});
