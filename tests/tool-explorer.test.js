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
