const test = require("node:test");
const assert = require("node:assert/strict");
const explorer = require("../tool-explorer.js");

function tool(id, name, args) {
  return { id, type: "function", function: { name, arguments: args } };
}

function records(name, ids) {
  return ids.map((id, index) => ({
    id,
    identity: "id:" + id,
    threadId: "thread-root",
    name,
    arguments: "{}",
    parsedArguments: {},
    logicalMessageIndex: index,
    toolIndex: 0,
    timestamp: index,
    timestampRaw: null,
    model: "model",
    target: { callId: "call-" + id, source: "request", messageIndex: index, toolIndex: 0, domId: "tool-" + id },
  }));
}

function resultWith(calls) {
  return {
    calls,
    threads: [{ id: "thread-root", calls }],
  };
}

const twoThreadResult = {
  sidebarFilters: { status: "error", model: "hidden-model", search: "nothing" },
  visibleCallIds: ["call-a"],
  threads: [
    {
      id: "thread-a",
      calls: [
        {
          id: "call-a",
          timestamp: 10,
          messages: [{ index: 0, role: "assistant", toolCalls: [tool("tool-a", "read", "{}")], }],
        },
        {
          id: "call-c",
          timestamp: 30,
          messages: [{ index: 0, role: "assistant", toolCalls: [tool("tool-c", "write", '{"path":"log"}')], }],
        },
      ],
    },
    {
      id: "thread-b",
      calls: [{
        id: "call-b",
        timestamp: 20,
        messages: [{ index: 0, role: "assistant", toolCalls: [tool("tool-b", "search", '{"q":"first"}')], }],
      }],
    },
  ],
};

const inventoryResult = resultWith([
  {
    id: "call-1",
    timestamp: 10,
    messages: [{ index: 0, role: "assistant", toolCalls: [tool("tool-1", "search", '{"q":"one"}')], }],
  },
  {
    id: "call-2",
    timestamp: 20,
    messages: [{ index: 0, role: "assistant", toolCalls: [tool("tool-2", "read", '{"path":"one"}')], }],
  },
  {
    id: "call-3",
    timestamp: 30,
    messages: [{ index: 0, role: "assistant", toolCalls: [tool("tool-3", "search", '{"q":"two"}')], }],
  },
  {
    id: "call-4",
    timestamp: 40,
    messages: [{ index: 0, role: "assistant", toolCalls: [tool("tool-4", "write", '{"path":"two"}')], }],
  },
]);

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

test("fallback identity joins a response to its later request copy", () => {
  const invocation = tool(null, "search", '{"q":"logs"}');
  const fixture = resultWith([
    { id: "call-1", timestamp: 10, messages: [{ index: 0, role: "user" }], outputMessage: { tool_calls: [invocation] } },
    { id: "call-2", predecessorId: "call-1", timestamp: 20, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [invocation] },
    ], outputMessage: null },
  ]);

  const records = explorer.buildInvocationIndex(fixture);
  assert.equal(records.length, 1);
  assert.equal(records[0].target.source, "response");
});

test("pairs a tool invocation with its result from the conversation history", () => {
  const invocation = tool("tool-1", "search", '{"q":"logs"}');
  const fixture = resultWith([
    { id: "call-1", timestamp: 10, messages: [{ index: 0, role: "user" }], outputMessage: { tool_calls: [invocation] } },
    { id: "call-2", predecessorId: "call-1", timestamp: 20, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [invocation] },
      { index: 2, role: "tool", toolCallId: "tool-1", content: "search result" },
    ], outputMessage: null },
  ]);

  const record = explorer.buildInvocationIndex(fixture)[0];

  assert.equal(record.result, "search result");
});

test("fallback identity distinguishes identical generated retries and joins their descendant request copies", () => {
  const invocation = () => tool(null, "search", "{}");
  const fixture = resultWith([
    { id: "call-1", timestamp: 10, messages: [{ index: 0, role: "user" }], outputMessage: { tool_calls: [invocation()] } },
    { id: "copy-1", predecessorId: "call-1", timestamp: 15, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [invocation()] },
    ], outputMessage: null },
    { id: "call-2", predecessorId: "call-1", timestamp: 20, messages: [{ index: 0, role: "user" }], outputMessage: { tool_calls: [invocation()] } },
    { id: "copy-2", predecessorId: "call-2", timestamp: 25, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [invocation()] },
    ], outputMessage: null },
  ]);

  const records = explorer.buildInvocationIndex(fixture);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.target.callId), ["call-1", "call-2"]);
  assert.notEqual(records[0].identity, records[1].identity);
});

test("fallback identity keeps identical calls at different message positions", () => {
  const invocation = tool(null, "search", '{"q":"logs"}');
  const fixture = resultWith([
    { id: "call-1", timestamp: 10, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [invocation] },
      { index: 2, role: "assistant", toolCalls: [invocation] },
    ], outputMessage: null },
  ]);

  assert.equal(explorer.buildInvocationIndex(fixture).length, 2);
});

test("fallback identity stabilizes structured keys but preserves invalid text", () => {
  const equivalentJson = resultWith([
    { id: "call-1", timestamp: 10, messages: [{ index: 0, role: "user" }], outputMessage: { tool_calls: [tool(null, "search", '{"b":2,"a":1}')] } },
    { id: "call-2", predecessorId: "call-1", timestamp: 20, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [tool(null, "search", '{"a":1,"b":2}')] },
    ], outputMessage: null },
  ]);
  const differentInvalidText = resultWith([
    { id: "call-3", timestamp: 30, messages: [{ index: 0, role: "user" }], outputMessage: { tool_calls: [tool(null, "search", "invalid one")] } },
    { id: "call-4", predecessorId: "call-3", timestamp: 40, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [tool(null, "search", "invalid two")] },
    ], outputMessage: null },
  ]);

  assert.equal(explorer.buildInvocationIndex(equivalentJson).length, 1);
  assert.equal(explorer.buildInvocationIndex(differentInvalidText).length, 2);
});

test("fallback identity ignores boundary whitespace in structured argument strings", () => {
  const responseArguments = JSON.stringify({ claim: "\nclaim text\n", severity: "\nmajor\n" });
  const requestArguments = JSON.stringify({ claim: "claim text", severity: "major" });
  const responseTool = tool(null, "report_candidate", responseArguments);
  const requestTool = tool(null, "report_candidate", requestArguments);
  const fixture = resultWith([
    { id: "call-1", timestamp: 10, messages: [{ index: 0, role: "user" }], outputMessage: { tool_calls: [responseTool] } },
    { id: "call-2", predecessorId: "call-1", timestamp: 20, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [requestTool] },
    ], outputMessage: null },
  ]);

  const records = explorer.buildInvocationIndex(fixture);

  assert.equal(records.length, 1);
  assert.equal(records[0].arguments, responseArguments);
});

test("fallback identity joins an unassigned response to a reidentified request copy", () => {
  const responseArguments = JSON.stringify({ claim: "\nclaim text\n", severity: "\nmajor\n" });
  const requestArguments = JSON.stringify({ claim: "claim text", severity: "major" });
  const responseTool = tool(null, "report_candidate", responseArguments);
  const requestTool = tool("new-request-id", "report_candidate", requestArguments);
  const fixture = resultWith([
    { id: "call-1", timestamp: 10, messages: [{ index: 0, role: "user" }], outputMessage: { tool_calls: [responseTool] } },
    { id: "call-2", predecessorId: "call-1", timestamp: 20, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [requestTool] },
      { index: 2, role: "tool", toolCallId: "new-request-id", content: "candidate result" },
    ], outputMessage: null },
  ]);

  const records = explorer.buildInvocationIndex(fixture);

  assert.equal(records.length, 1);
  assert.equal(records[0].target.callId, "call-1");
  assert.equal(records[0].result, "candidate result");
});

test("fallback identity joins equivalent JSON-string and structured argument values", () => {
  const responseArguments = JSON.stringify({
    claim: "\nclaim text\n",
    supporting_evidence_ids: "\n[\"evidence:a\"]\n",
    contradicting_evidence_ids: "\n[]\n",
    related_targets: "\n[\"O1\"]\n",
  });
  const requestArguments = JSON.stringify({
    claim: "claim text",
    supporting_evidence_ids: ["evidence:a"],
    contradicting_evidence_ids: [],
    related_targets: ["O1"],
  });
  const responseTool = tool(null, "report_candidate", responseArguments);
  const requestTool = tool("new-request-id", "report_candidate", requestArguments);
  const fixture = resultWith([
    { id: "call-1", timestamp: 10, messages: [{ index: 0, role: "user" }], outputMessage: { tool_calls: [responseTool] } },
    { id: "call-2", predecessorId: "call-1", timestamp: 20, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [requestTool] },
    ], outputMessage: null },
  ]);

  assert.equal(explorer.buildInvocationIndex(fixture).length, 1);
});

test("fallback identity joins newline-wrapped scalar arguments to native values", () => {
  const responseTool = tool(null, "read_file", JSON.stringify({
    path: "\naction.yml\n",
    offset: "\n800\n",
    limit: "\n80\n",
  }));
  const requestTool = tool("new-request-id", "read_file", JSON.stringify({
    path: "action.yml",
    offset: 800,
    limit: 80,
  }));
  const fixture = resultWith([
    { id: "call-1", timestamp: 10, messages: [{ index: 0, role: "user" }], outputMessage: { tool_calls: [responseTool] } },
    { id: "call-2", predecessorId: "call-1", timestamp: 20, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [requestTool] },
    ], outputMessage: null },
  ]);

  assert.equal(explorer.buildInvocationIndex(fixture).length, 1);
});

test("DOM targets stay unique for record IDs that collide under the previous 32-bit hash", () => {
  const fixture = resultWith([{
    id: "call-1",
    timestamp: 10,
    messages: [{
      index: 0,
      role: "assistant",
      toolCalls: [
        tool("tool-eeoj52-84e", "search", "{}"),
        tool("tool-sw1dll-leo", "search", "{}"),
      ],
    }],
  }]);

  const records = explorer.buildInvocationIndex(fixture);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].target.domId, records[1].target.domId);
  records.forEach(record => assert.match(record.target.domId, /^tool-invocation-[A-Za-z0-9_-]+$/));
});

test("accepts a located invocation target only when its record identity matches", () => {
  const record = { id: "record-a", target: { domId: "tool-invocation-a" } };

  assert.equal(explorer.isInvocationTargetForRecord({ dataset: { toolRecordId: "tool-invocation-a" } }, record), true);
  assert.equal(explorer.isInvocationTargetForRecord({ dataset: { toolRecordId: "tool-invocation-b" } }, record), false);
  assert.equal(explorer.isInvocationTargetForRecord(null, record), false);
});

test("stale Previous navigation continues backward past the missing occurrence", () => {
  const matching = records("search", ["a", "stale-b", "c"]);

  assert.equal(explorer.getStaleTargetFallback(matching, "stale-b", -1).id, "a");
  assert.equal(explorer.getStaleTargetFallback(matching, "stale-b", 1).id, "c");
});

test("conversation scope follows the selected call's thread", () => {
  const records = explorer.buildInvocationIndex(twoThreadResult);

  assert.deepEqual(
    explorer.getScopedInvocations(records, twoThreadResult, "call-b", "conversation").map(record => record.threadId),
    ["thread-b"],
  );
  assert.equal(explorer.getScopedInvocations(records, twoThreadResult, "call-b", "history").length, 3);
});

test("summarizes types by count and then name", () => {
  const records = explorer.buildInvocationIndex(inventoryResult);

  assert.deepEqual(explorer.summarizeToolTypes(records), [
    { name: "search", count: 2 },
    { name: "read", count: 1 },
    { name: "write", count: 1 },
  ]);
});

test("reconciles missing type and record deterministically", () => {
  const records = explorer.buildInvocationIndex(inventoryResult);
  const recordsForSearch = records.filter(record => record.name === "search");

  assert.deepEqual(explorer.reconcileSelection(records, "missing", "gone"), {
    selectedType: "search",
    selectedRecordId: recordsForSearch[0].id,
    position: 0,
    matching: recordsForSearch,
  });
  assert.equal(explorer.reconcileSelection([], "search", "gone").selectedType, null);
});

test("reconciles retained types and stale records to bounded navigation positions", () => {
  const records = explorer.buildInvocationIndex(inventoryResult);
  const recordsForSearch = records.filter(record => record.name === "search");
  const retained = explorer.reconcileSelection(records, "read", "gone");
  const nearest = explorer.reconcileSelection(records, "search", "gone", 1);
  const first = explorer.reconcileSelection(records, "search", recordsForSearch[0].id);
  const last = explorer.reconcileSelection(records, "search", recordsForSearch[1].id);

  assert.equal(retained.selectedType, "read");
  assert.equal(retained.selectedRecordId, records.find(record => record.name === "read").id);
  assert.equal(nearest.position, 1);
  assert.equal(nearest.selectedRecordId, recordsForSearch[1].id);
  assert.equal(first.position === 0, true);
  assert.equal(last.position === last.matching.length - 1, true);
});

test("reconciles an ID-stable invocation to its evolved tool name", () => {
  const updated = [
    ...records("alpha", ["other"]),
    ...records("search", ["earlier", "stable"]),
  ];

  const selection = explorer.reconcileSelection(updated, "Unknown tool", "stable", 0);
  assert.equal(selection.selectedType, "search");
  assert.equal(selection.selectedRecordId, "stable");
  assert.equal(selection.position, 1);
});

test("resets position when a vanished type falls back to a different type", () => {
  const updated = records("search", ["first", "second"]);

  const selection = explorer.reconcileSelection(updated, "write", "gone", 1);
  assert.equal(selection.selectedType, "search");
  assert.equal(selection.selectedRecordId, "first");
  assert.equal(selection.position, 0);
});

test("updates records while preserving tray state and reconciling a stale occurrence", () => {
  const after = records("search", ["one", "two"]);
  const updated = explorer.reconcileExplorerUpdate({
    open: true,
    module: "tool-calls",
    scope: "history",
    records: records("search", ["one", "two", "three"]),
    selectedType: "search",
    selectedRecordId: "three",
    position: 2,
  }, after);
  assert.equal(updated.open, true);
  assert.equal(updated.scope, "history");
  assert.equal(updated.records, after);
  assert.equal(updated.selectedRecordId, "two");
  assert.equal(updated.position, 1);
});
