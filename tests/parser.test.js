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
