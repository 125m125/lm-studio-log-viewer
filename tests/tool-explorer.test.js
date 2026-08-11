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
    { id: "call-2", timestamp: 20, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [invocation] },
    ], outputMessage: null },
  ]);

  const records = explorer.buildInvocationIndex(fixture);
  assert.equal(records.length, 1);
  assert.equal(records[0].target.source, "response");
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
    { id: "call-2", timestamp: 20, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [tool(null, "search", '{"a":1,"b":2}')] },
    ], outputMessage: null },
  ]);
  const differentInvalidText = resultWith([
    { id: "call-3", timestamp: 30, messages: [{ index: 0, role: "user" }], outputMessage: { tool_calls: [tool(null, "search", "invalid one")] } },
    { id: "call-4", timestamp: 40, messages: [
      { index: 0, role: "user" },
      { index: 1, role: "assistant", toolCalls: [tool(null, "search", "invalid two")] },
    ], outputMessage: null },
  ]);

  assert.equal(explorer.buildInvocationIndex(equivalentJson).length, 1);
  assert.equal(explorer.buildInvocationIndex(differentInvalidText).length, 2);
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
