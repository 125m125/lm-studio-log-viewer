const test = require("node:test");
const assert = require("node:assert/strict");
const parser = require("../parser.js");

function request(time, body) {
  return `[${time}][DEBUG] Received request: POST to /v1/chat/completions with body ${JSON.stringify(body, null, 2)}`;
}
function run(time, model, count) {
  return `[${time}][INFO][${model}] Running chat completion on conversation with ${count} messages.`;
}
function response(time, body) {
  return `[${time}][INFO][${body.model}] Generated prediction: ${JSON.stringify(body, null, 2)}`;
}
function packet(time, model, body) {
  return `[${time}][INFO][${model}] Generated packet: ${JSON.stringify(body, null, 2)}`;
}
function finished(time, model) {
  return `[${time}][INFO][${model}] Finished streaming response`;
}
function prediction(model, content = "ok") {
  return { model, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
}

test("parses and matches multiline request and prediction", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 10:00:00", { model, stream: false, messages: [{ role: "user", content: "brace } and quote \" survive" }] }),
    run("2026-06-27 10:00:01", model, 1),
    response("2026-06-27 10:00:02", prediction(model, "done"))
  ].join("\n");
  const result = parser.parseFiles([{ name: "one.log", text }]);
  assert.equal(result.stats.calls, 1);
  assert.equal(result.stats.matched, 1);
  assert.equal(result.calls[0].messages[0].content, "brace } and quote \" survive");
  assert.equal(result.calls[0].outputMessage.content, "done");
  assert.equal(result.calls[0].matchMethod, "lifecycle");
  assert.equal(result.calls[0].endpoint, "POST to /v1/chat/completions");
});

test("reconstructs a complete streamed response and keeps its packets", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 11:00:00", { model, stream: true, messages: [{ role: "user", content: "say hello" }] }),
    run("2026-06-27 11:00:01", model, 1),
    packet("2026-06-27 11:00:02", model, { id: "stream-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] }),
    packet("2026-06-27 11:00:02", model, { id: "stream-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] }),
    packet("2026-06-27 11:00:03", model, { id: "stream-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    packet("2026-06-27 11:00:03", model, { id: "stream-1", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }),
    finished("2026-06-27 11:00:03", model)
  ].join("\n");

  const result = parser.parseFiles([{ name: "stream.log", text }]);
  const call = result.calls[0];
  assert.equal(result.stats.calls, 1);
  assert.equal(call.status, "matched");
  assert.equal(call.stream, true);
  assert.equal(call.streamComplete, true);
  assert.equal(call.streamPackets.length, 4);
  assert.equal(call.outputMessage.content, "Hello world");
  assert.equal(call.finishReason, "stop");
  assert.deepEqual(call.usage, { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 });
});

test("preserves streamed reasoning and tool-call deltas while assembling output", () => {
  const model = "test/model";
  const firstToolDelta = { index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: '{"q":' } };
  const secondToolDelta = { index: 0, function: { arguments: '"weather"}' } };
  const text = [
    request("2026-06-27 12:00:00", { model, stream: true, messages: [{ role: "user", content: "weather" }] }),
    run("2026-06-27 12:00:01", model, 1),
    packet("2026-06-27 12:00:02", model, { id: "stream-2", model, choices: [{ index: 0, delta: { reasoning_content: "Need " }, finish_reason: null }] }),
    packet("2026-06-27 12:00:02", model, { id: "stream-2", model, choices: [{ index: 0, delta: { reasoning_content: "data", tool_calls: [firstToolDelta] }, finish_reason: null }] }),
    packet("2026-06-27 12:00:02", model, { id: "stream-2", model, choices: [{ index: 0, delta: { content: "Done", tool_calls: [secondToolDelta] }, finish_reason: null }] }),
    packet("2026-06-27 12:00:03", model, { id: "stream-2", model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    finished("2026-06-27 12:00:03", model)
  ].join("\n");

  const call = parser.parseFiles([{ name: "delta.log", text }]).calls[0];
  assert.equal(call.outputMessage.reasoning_content, "Need data");
  assert.equal(call.outputMessage.content, "Done");
  assert.equal(call.outputMessage.tool_calls[0].function.arguments, '{"q":"weather"}');
  assert.deepEqual(call.streamPackets[1].data.choices[0].delta.tool_calls, [firstToolDelta]);
  assert.equal(call.finishReason, "tool_calls");
});

test("keeps a partial streamed response visible and incomplete", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 13:00:00", { model, stream: true, messages: [{ role: "user", content: "continue" }] }),
    run("2026-06-27 13:00:01", model, 1),
    packet("2026-06-27 13:00:02", model, { id: "stream-partial", model, choices: [{ index: 0, delta: { content: "Still working" }, finish_reason: null }] })
  ].join("\n");

  const call = parser.parseFiles([{ name: "partial.log", text }]).calls[0];
  assert.equal(call.outputMessage.content, "Still working");
  assert.equal(call.streamComplete, false);
  assert.equal(call.status, "incomplete");
});

test("reports malformed streamed packet JSON without throwing", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 14:00:00", { model, stream: true, messages: [{ role: "user", content: "broken" }] }),
    run("2026-06-27 14:00:01", model, 1),
    `[2026-06-27 14:00:02][INFO][${model}] Generated packet: {\n  "id": "stream-broken",\n  "choices": [`
  ].join("\n");

  const result = parser.parseFiles([{ name: "broken-stream.log", text }]);
  assert.equal(result.calls.length, 1);
  assert.match(result.warnings.map(warning => warning.message).join("\n"), /truncated/i);
});

test("keeps a usage-bearing stream incomplete without a terminal chunk or finished boundary", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 11:05:00", { model, stream: true, messages: [{ role: "user", content: "partial please" }] }),
    run("2026-06-27 11:05:01", model, 1),
    packet("2026-06-27 11:05:02", model, { id: "stream-usage-open", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "tool", content: "Partial" }, finish_reason: null }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })
  ].join("\n");

  const result = parser.parseFiles([{ name: "stream-open.log", text }]);
  const call = result.calls[0];
  assert.equal(call.status, "incomplete");
  assert.equal(call.streamComplete, false);
  assert.equal(call.outputMessage.role, "tool");
  assert.equal(call.outputMessage.content, "Partial");
  assert.deepEqual(call.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
});

test("keeps a usage-only packet stream incomplete without a finish chunk or boundary", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 11:06:00", { model, stream: true, messages: [{ role: "user", content: "usage only please" }] }),
    run("2026-06-27 11:06:01", model, 1),
    packet("2026-06-27 11:06:02", model, { id: "stream-usage-only-open", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 2, completion_tokens: 0, total_tokens: 2 } })
  ].join("\n");

  const result = parser.parseFiles([{ name: "stream-usage-only-open.log", text }]);
  const call = result.calls[0];
  assert.equal(call.streamComplete, false);
  assert.equal(call.status, "incomplete");
  assert.deepEqual(call.usage, { prompt_tokens: 2, completion_tokens: 0, total_tokens: 2 });
});

test("matches ordinary and streamed responses by source order", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 12:00:00", { model, messages: [{ role: "user", content: "ordinary request" }] }),
    run("2026-06-27 12:00:01", model, 1),
    request("2026-06-27 12:00:02", { model, stream: true, messages: [{ role: "user", content: "stream request" }] }),
    run("2026-06-27 12:00:03", model, 1),
    packet("2026-06-27 12:00:04", model, { id: "stream-ordered", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "streamed first" }, finish_reason: "stop" }] }),
    response("2026-06-27 12:00:05", prediction(model, "ordinary second"))
  ].join("\n");

  const result = parser.parseFiles([{ name: "mixed.log", text }]);
  assert.equal(result.calls[0].stream, false);
  assert.equal(result.calls[0].outputMessage.content, "ordinary second");
  assert.equal(result.calls[1].stream, true);
  assert.equal(result.calls[1].outputMessage.content, "streamed first");
  assert.equal(result.calls[1].status, "matched");
});

test("prefers ordinary requests for ordinary responses when a streamed request is newer", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 12:10:00", { model, messages: [{ role: "user", content: "ordinary first" }] }),
    run("2026-06-27 12:10:01", model, 1),
    request("2026-06-27 12:10:02", { model, stream: true, messages: [{ role: "user", content: "stream second" }] }),
    run("2026-06-27 12:10:03", model, 1),
    response("2026-06-27 12:10:04", prediction(model, "ordinary result")),
    packet("2026-06-27 12:10:05", model, { id: "stream-later", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "stream result" }, finish_reason: "stop" }] })
  ].join("\n");

  const result = parser.parseFiles([{ name: "inverse-mixed.log", text }]);
  assert.equal(result.calls[0].stream, false);
  assert.equal(result.calls[0].outputMessage.content, "ordinary result");
  assert.equal(result.calls[1].stream, true);
  assert.equal(result.calls[1].outputMessage.content, "stream result");
  assert.equal(result.calls[0].status, "matched");
  assert.equal(result.calls[1].status, "matched");
});

test("leaves a rejected request incomplete instead of shifting matches", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 10:00:00", { model, messages: [{ role: "user", content: "rejected" }] }),
    request("2026-06-27 10:00:01", { model, messages: [{ role: "user", content: "accepted" }] }),
    run("2026-06-27 10:00:02", model, 1),
    response("2026-06-27 10:00:03", prediction(model, "accepted result"))
  ].join("\n");
  const result = parser.parseFiles([{ name: "two.log", text }]);
  assert.equal(result.calls[0].status, "incomplete");
  assert.equal(result.calls[1].status, "matched");
  assert.equal(result.calls[1].outputMessage.content, "accepted result");
});

test("reports truncated JSON without throwing", () => {
  const result = parser.parseFiles([{ name: "broken.log", text: "[2026-06-27 10:00:00][DEBUG] Received request: POST to /v1/chat/completions with body {\n  \"model\": \"x\"" }]);
  assert.equal(result.stats.calls, 1);
  assert.equal(result.calls[0].status, "incomplete");
  assert.match(result.calls[0].parseError, /truncated/i);
  assert.equal(result.warnings.length, 1);
});

test("keeps matching null-safe when a malformed request precedes a valid one", () => {
  const model = "test/model";
  const text = [
    "[2026-06-27 10:20:00][DEBUG] Received request: POST to /v1/chat/completions with body { invalid }",
    request("2026-06-27 10:20:01", { model, messages: [{ role: "user", content: "valid request" }] }),
    run("2026-06-27 10:20:02", model, 1),
    response("2026-06-27 10:20:03", prediction(model, "valid result"))
  ].join("\n");

  const result = parser.parseFiles([{ name: "null-safe.log", text }]);
  assert.equal(result.stats.calls, 2);
  assert.equal(result.calls[0].status, "incomplete");
  assert.equal(result.calls[1].status, "matched");
  assert.equal(result.calls[1].outputMessage.content, "valid result");
});

test("groups continuations and describes removed and added messages", () => {
  const base = [{ role: "system", content: "rules" }, { role: "user", content: "start" }, { role: "assistant", content: "answer" }];
  const calls = [
    { id: "a", timestamp: 1, sourceIndex: 0, lineStart: 1, model: "m", endpoint: "e", messages: base.map((m, i) => ({ ...m, index: i, fingerprint: parser.stableStringify(m) })) },
    { id: "b", timestamp: 2, sourceIndex: 0, lineStart: 2, model: "m", endpoint: "e", messages: [base[0], base[1], base[2], { role: "user", content: "next" }].map((m, i) => ({ ...m, index: i, fingerprint: parser.stableStringify(m) })) },
    { id: "c", timestamp: 3, sourceIndex: 0, lineStart: 3, model: "m", endpoint: "e", messages: [base[0], base[1], { role: "user", content: "replacement" }].map((m, i) => ({ ...m, index: i, fingerprint: parser.stableStringify(m) })) }
  ];
  const threads = parser.buildThreads(calls);
  assert.equal(threads.length, 1);
  assert.equal(calls[1].predecessorId, "a");
  assert.deepEqual(calls[1].delta.added, [3]);
  assert.equal(calls[2].predecessorId, "a");
  assert.deepEqual(calls[2].delta.removed, [2]);
  assert.deepEqual(calls[2].delta.added, [2]);
});

test("does not group unrelated calls sharing only a system message", () => {
  const make = (id, user, timestamp) => ({ id, timestamp, sourceIndex: 0, lineStart: timestamp, model: "m", endpoint: "e", messages: [
    { index: 0, role: "system", content: "generic", fingerprint: "same" },
    { index: 1, role: "user", content: user, fingerprint: user }
  ] });
  const calls = [make("a", "alpha", 1), make("b", "beta", 2)];
  assert.equal(parser.buildThreads(calls).length, 2);
});

test("separates sub-agents with the same system prompt but different first user assignments", () => {
  const message = (index, role, content, fingerprint) => ({ index, role, content, fingerprint });
  const calls = [
    { id: "agent-a", timestamp: 1, sourceIndex: 0, lineStart: 1, model: "m", endpoint: "e", messages: [
      message(0, "system", "shared agent rules", "system"),
      message(1, "user", "inspect backend correctness", "assignment-a"),
      message(2, "user", "shared exploration budget", "budget")
    ] },
    { id: "agent-b", timestamp: 2, sourceIndex: 0, lineStart: 2, model: "m", endpoint: "e", messages: [
      message(0, "system", "shared agent rules", "system"),
      message(1, "user", "inspect frontend state", "assignment-b"),
      message(2, "user", "shared exploration budget", "budget")
    ] }
  ];
  assert.equal(parser.buildThreads(calls).length, 2);
  assert.equal(calls[1].predecessorId, undefined);
});

test("keeps follow-ups with identical initial system and user prompts in one thread", () => {
  const base = [
    { index: 0, role: "system", content: "rules", fingerprint: "system" },
    { index: 1, role: "user", content: "assigned task", fingerprint: "assignment" }
  ];
  const calls = [
    { id: "start", timestamp: 1, sourceIndex: 0, lineStart: 1, model: "m", endpoint: "e", messages: base },
    { id: "follow-up", timestamp: 2, sourceIndex: 0, lineStart: 2, model: "m", endpoint: "e", messages: [...base, { index: 2, role: "assistant", content: "work", fingerprint: "work" }, { index: 3, role: "user", content: "continue", fingerprint: "continue" }] }
  ];
  assert.equal(parser.buildThreads(calls).length, 1);
  assert.equal(calls[1].predecessorId, "start");
});
