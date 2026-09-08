const test = require("node:test");
const assert = require("node:assert/strict");
const explorer = require("../tool-explorer.js");
const view = require("../tool-explorer-view.js");

test("request targets stay unique across no-ID messages and history copies", () => {
  const invocation = { function: { name: "search", arguments: "{}" } };
  const call = { id: "call", messages: [0, 1].map(index => ({ index, role: "assistant", toolCalls: [invocation] })) };
  const records = explorer.buildInvocationIndex({ threads: [{ id: "thread", calls: [call] }] });
  const html = call.messages.map(message => view.renderToolInvocations(message.toolCalls, records, "request", {
    target: { callId: call.id, source: "request", messageIndex: message.index },
  })).join("");
  for (const record of records) {
    assert.equal(html.split(' id="' + record.target.domId + '"').length - 1, 1);
  }
  const history = view.renderToolInvocations([invocation], records, "history", {
    target: { callId: "later-call", source: "request", messageIndex: 0 },
  });
  assert.match(history, /search/);
  assert.doesNotMatch(history, /data-tool-record-id/);
});

test("renders an addressable and focusable invocation with safe content", () => {
  const html = view.renderToolInvocations(
    [{ function: { name: "<search>", arguments: '{"q":"<logs>"}' } }],
    [{ id: "record-1", target: { domId: "tool-invocation-abc", toolIndex: 0 } }],
    "response",
  );
  assert.match(html, /id="tool-invocation-abc"/);
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /data-tool-record-id="tool-invocation-abc"/);
  assert.match(html, /data-copy-tool="response:0"/);
  assert.match(html, /&lt;search&gt;/);
  assert.doesNotMatch(html, /<search>/);
});

test("renders a DOM-safe identity that validates a no-ID fallback invocation target", () => {
  const toolCall = { type: "function", function: { name: "read_file", arguments: '{"path":"request.log"}' } };
  const call = {
    id: "call-1",
    timestamp: 10,
    messages: [{ index: 0, role: "user" }],
    outputMessage: { tool_calls: [toolCall] },
  };
  const record = explorer.buildInvocationIndex({
    calls: [call],
    threads: [{ id: "thread-root", calls: [call] }],
  })[0];

  const html = view.renderToolInvocations([toolCall], [record], "response");
  const renderedIdentity = html.match(/data-tool-record-id="([^"]+)"/)[1];

  assert.equal(renderedIdentity, record.target.domId);
  assert.equal(renderedIdentity.includes("\u0000"), false);
  assert.equal(
    explorer.isInvocationTargetForRecord({ dataset: { toolRecordId: renderedIdentity } }, record),
    true,
  );
});

test("labels each invocation copy control with its tool name", () => {
  const html = view.renderToolInvocations(
    [{ function: { name: "search", arguments: "{}" } }],
    [{ id: "record-1", target: { domId: "tool-invocation-abc", toolIndex: 0 } }],
    "response",
  );
  assert.match(html, /aria-label="Copy search tool invocation"/);
});

test("names each focusable invocation jump target with its tool", () => {
  const html = view.renderToolInvocations(
    [{ function: { name: "search", arguments: "{}" } }],
    [{ id: "record-1", target: { domId: "tool-invocation-abc", toolIndex: 0 } }],
    "response",
  );

  assert.match(html, /<article[^>]*aria-label="search tool invocation"/);
});

test("omits empty identity attributes from nonpreferred source copies", () => {
  const html = view.renderToolInvocations(
    [
      { function: { name: "search", arguments: "{}" } },
      { function: { name: "write", arguments: "{}" } },
    ],
    [],
    "request",
  );

  assert.doesNotMatch(html, /\sid=""/);
  assert.doesNotMatch(html, /data-tool-record-id=""/);
});

test("can omit non-canonical invocation copies", () => {
  const html = view.renderToolInvocations(
    [
      { function: { name: "canonical", arguments: "{}" } },
      { function: { name: "duplicate", arguments: "{}" } },
    ],
    [{ id: "record-1", target: { domId: "tool-invocation-abc", toolIndex: 0 } }],
    "request",
    { onlyAddressable: true },
  );

  assert.match(html, /canonical/);
  assert.doesNotMatch(html, /duplicate/);
});

test("renders a paired result with the canonical invocation", () => {
  const html = view.renderToolInvocations(
    [{ function: { name: "search", arguments: "{}" } }],
    [{ id: "record-1", result: "found logs", target: { domId: "tool-invocation-abc", toolIndex: 0 } }],
    "response",
    { onlyAddressable: true },
  );

  assert.match(html, /Result/);
  assert.match(html, /found logs/);
});

test("matches a history copy to its canonical result by tool-call ID", () => {
  const html = view.renderToolInvocations(
    [{ id: "tool-1", function: { name: "search", arguments: "{}" } }],
    [{ id: "record-1", toolCallId: "tool-1", result: "history result", target: { domId: "tool-invocation-abc", toolIndex: 4 } }],
    "request",
  );

  assert.match(html, /history result/);
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

test("renders the selected tool request and result in the explorer preview", () => {
  const html = view.renderExplorerTray({
    open: true,
    scope: "conversation",
    types: [{ name: "search", count: 1 }],
    selectedType: "search",
    position: 0,
    total: 1,
    preview: { name: "search", arguments: '{"q":"logs"}', result: "found logs", time: "12:00", model: "m", callId: "call-1" },
  });

  assert.match(html, /Request/);
  assert.match(html, /\{&quot;q&quot;:&quot;logs&quot;\}/);
  assert.match(html, /Result/);
  assert.match(html, /found logs/);
});

test("relates the tray toggle to a named panel and groups scope and type controls", () => {
  const html = view.renderExplorerTray({
    open: true,
    scope: "conversation",
    types: [{ name: "search", count: 1 }],
    selectedType: "search",
    position: 0,
    total: 1,
    preview: { name: "search", arguments: "{}", time: "12:00", model: "m", callId: "call-1" },
  });

  assert.match(html, /<section class="explorer-tray" aria-labelledby="explorer-toggle">/);
  assert.match(html, /id="explorer-toggle"[^>]*aria-controls="explorer-panel"/);
  assert.match(html, /id="explorer-panel"[^>]*role="region"[^>]*aria-labelledby="explorer-module-title"/);
  assert.match(html, /class="explorer-scopes" role="group" aria-label="Tool call scope"/);
  assert.match(html, /class="explorer-types" role="group" aria-label="Tool types"/);
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

test("restores focus to the corresponding tray control after rerender", () => {
  const focused = [];
  const toggle = { focus: () => focused.push("toggle") };
  const conversation = { dataset: { explorerScope: "conversation" }, focus: () => focused.push("conversation") };
  const history = { dataset: { explorerScope: "history" }, focus: () => focused.push("history") };
  const root = {
    querySelector: selector => selector === "[data-explorer-toggle]" ? toggle : null,
    querySelectorAll: selector => selector === "[data-explorer-scope]" ? [conversation, history] : [],
  };

  assert.equal(view.restoreExplorerControlFocus(root, { kind: "toggle" }), true);
  assert.equal(view.restoreExplorerControlFocus(root, { kind: "scope", value: "history" }), true);
  assert.deepEqual(focused, ["toggle", "history"]);
});
