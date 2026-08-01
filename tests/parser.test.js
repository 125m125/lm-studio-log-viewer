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
  return {
    model,
    choices: [
      { message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
}

test("parses and matches multiline request and prediction", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 10:00:00", {
      model,
      stream: false,
      messages: [{ role: "user", content: 'brace } and quote " survive' }],
    }),
    run("2026-06-27 10:00:01", model, 1),
    response("2026-06-27 10:00:02", prediction(model, "done")),
  ].join("\n");
  const result = parser.parseFiles([{ name: "one.log", text }]);
  assert.equal(result.stats.calls, 1);
  assert.equal(result.stats.matched, 1);
  assert.equal(
    result.calls[0].messages[0].content,
    'brace } and quote " survive',
  );
  assert.equal(result.calls[0].outputMessage.content, "done");
  assert.equal(result.calls[0].matchMethod, "lifecycle");
  assert.equal(result.calls[0].endpoint, "POST to /v1/chat/completions");
});

test("matches a streamed response whose packets cross file boundaries", () => {
  const model = "test/model";
  const first = [
    request("2026-06-27 10:00:00", {
      model,
      stream: true,
      messages: [{ role: "user", content: "cross files" }],
    }),
    run("2026-06-27 10:00:01", model, 1),
    packet("2026-06-27 10:00:02", model, {
      id: "cross-file-stream",
      model,
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    }),
  ].join("\n");
  const second = [
    packet("2026-06-27 10:00:03", model, {
      id: "cross-file-stream",
      model,
      choices: [
        { index: 0, delta: { content: " world" }, finish_reason: "stop" },
      ],
    }),
    finished("2026-06-27 10:00:03", model),
  ].join("\n");

  const call = parser.parseFiles([
    { name: "first.log", text: first },
    { name: "second.log", text: second },
  ]).calls[0];
  assert.equal(call.stream, true);
  assert.equal(call.outputMessage.content, "Hello world");
  assert.equal(call.streamPackets.length, 2);
  assert.equal(call.streamComplete, true);
  assert.equal(call.status, "matched");
});

test("matches a non-streaming response whose request and prediction cross file boundaries", () => {
  const model = "test/model";
  const first = request("2026-06-27 10:00:00", {
    model,
    stream: false,
    messages: [{ role: "user", content: "ordinary cross files" }],
  });
  const second = [
    run("2026-06-27 10:00:01", model, 1),
    response("2026-06-27 10:00:02", prediction(model, "done across files")),
  ].join("\n");

  const call = parser.parseFiles([
    { name: "first.log", text: first },
    { name: "second.log", text: second },
  ]).calls[0];
  assert.equal(call.stream, false);
  assert.equal(call.outputMessage.content, "done across files");
  assert.equal(call.status, "matched");
});

test("prefers the complete boundary copy when rotation truncates a request", () => {
  const model = "test/model";
  const completeRequest = request("2026-06-27 10:00:00", {
    model,
    stream: false,
    messages: [{ role: "user", content: "rotated request" }],
  });
  const first =
    completeRequest.slice(0, completeRequest.lastIndexOf("\n") + 1) +
    '  "partial"';
  const second = [
    completeRequest,
    run("2026-06-27 10:00:01", model, 1),
    response("2026-06-27 10:00:02", prediction(model, "complete copy")),
  ].join("\n");

  const result = parser.parseFiles([
    { name: "rotated-a.log", text: first },
    { name: "rotated-b.log", text: second },
  ]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].outputMessage.content, "complete copy");
  assert.equal(result.calls[0].status, "matched");
});

test("deduplicates a complete request copied across a rotation boundary", () => {
  const model = "test/model";
  const duplicatedRequest = request("2026-06-27 10:00:00", {
    model,
    stream: false,
    messages: [{ role: "user", content: "copied request" }],
  });
  const result = parser.parseFiles([
    { name: "rotation-a.log", text: duplicatedRequest },
    {
      name: "rotation-b.log",
      text: [
        duplicatedRequest,
        run("2026-06-27 10:00:01", model, 1),
        response("2026-06-27 10:00:02", prediction(model, "one response")),
      ].join("\n"),
    },
  ]);

  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].outputMessage.content, "one response");
  assert.equal(result.calls[0].status, "matched");
});

test("deduplicates a retry with the same logical request and changed options", () => {
  const model = "test/model";
  const logicalRequest = {
    model,
    stream: false,
    messages: [{ role: "user", content: "retry me" }],
    max_tokens: 4096,
    temperature: 0.6,
  };
  const firstRequest = request("2026-06-27 10:00:00", {
    ...logicalRequest,
    response_format: { type: "json_object" },
  });
  const retryRequest = request("2026-06-27 10:00:00", logicalRequest);
  const result = parser.parseFiles([
    { name: "retry-a.log", text: firstRequest },
    {
      name: "retry-b.log",
      text: [
        retryRequest,
        run("2026-06-27 10:00:01", model, 1),
        response("2026-06-27 10:00:02", prediction(model, "retry response")),
      ].join("\n"),
    },
  ]);

  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].outputMessage.content, "retry response");
  assert.equal(result.calls[0].status, "matched");
});

test("deduplicates same-timestamp logical request copies within one file", () => {
  const model = "test/model";
  const logicalRequest = {
    model,
    stream: false,
    messages: [{ role: "user", content: "same timestamp" }],
  };
  const result = parser.parseFiles([
    {
      name: "same-file.log",
      text: [
        request("2026-06-27 10:00:00", {
          ...logicalRequest,
          response_format: { type: "json_object" },
        }),
        request("2026-06-27 10:00:00", logicalRequest),
        run("2026-06-27 10:00:01", model, 1),
        response("2026-06-27 10:00:02", prediction(model, "single result")),
      ].join("\n"),
    },
  ]);

  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].outputMessage.content, "single result");
});

test("reconstructs a complete streamed response and keeps its packets", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 11:00:00", {
      model,
      stream: true,
      messages: [{ role: "user", content: "say hello" }],
    }),
    run("2026-06-27 11:00:01", model, 1),
    packet("2026-06-27 11:00:02", model, {
      id: "stream-1",
      object: "chat.completion.chunk",
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Hello" },
          finish_reason: null,
        },
      ],
    }),
    packet("2026-06-27 11:00:02", model, {
      id: "stream-1",
      object: "chat.completion.chunk",
      model,
      choices: [
        { index: 0, delta: { content: " world" }, finish_reason: null },
      ],
    }),
    packet("2026-06-27 11:00:03", model, {
      id: "stream-1",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
    packet("2026-06-27 11:00:03", model, {
      id: "stream-1",
      object: "chat.completion.chunk",
      model,
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    }),
    finished("2026-06-27 11:00:03", model),
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
  assert.deepEqual(call.usage, {
    prompt_tokens: 2,
    completion_tokens: 2,
    total_tokens: 4,
  });
});

test("preserves streamed reasoning and tool-call deltas while assembling output", () => {
  const model = "test/model";
  const firstToolDelta = {
    index: 0,
    id: "call-1",
    type: "function",
    function: { name: "lookup", arguments: '{"q":' },
  };
  const secondToolDelta = { index: 0, function: { arguments: '"weather"}' } };
  const text = [
    request("2026-06-27 12:00:00", {
      model,
      stream: true,
      messages: [{ role: "user", content: "weather" }],
    }),
    run("2026-06-27 12:00:01", model, 1),
    packet("2026-06-27 12:00:02", model, {
      id: "stream-2",
      model,
      choices: [
        {
          index: 0,
          delta: { reasoning_content: "Need " },
          finish_reason: null,
        },
      ],
    }),
    packet("2026-06-27 12:00:02", model, {
      id: "stream-2",
      model,
      choices: [
        {
          index: 0,
          delta: { reasoning_content: "data", tool_calls: [firstToolDelta] },
          finish_reason: null,
        },
      ],
    }),
    packet("2026-06-27 12:00:02", model, {
      id: "stream-2",
      model,
      choices: [
        {
          index: 0,
          delta: { content: "Done", tool_calls: [secondToolDelta] },
          finish_reason: null,
        },
      ],
    }),
    packet("2026-06-27 12:00:03", model, {
      id: "stream-2",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }),
    finished("2026-06-27 12:00:03", model),
  ].join("\n");

  const call = parser.parseFiles([{ name: "delta.log", text }]).calls[0];
  assert.equal(call.outputMessage.reasoning_content, "Need data");
  assert.equal(call.outputMessage.content, "Done");
  assert.equal(
    call.outputMessage.tool_calls[0].function.arguments,
    '{"q":"weather"}',
  );
  assert.deepEqual(call.streamPackets[1].choices[0].delta.tool_calls, [
    firstToolDelta,
  ]);
  assert.deepEqual(call.streamPackets[1].data.choices[0].delta.tool_calls, [
    firstToolDelta,
  ]);
  assert.equal(call.finishReason, "tool_calls");
});

test("keeps a partial streamed response visible and incomplete", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 13:00:00", {
      model,
      stream: true,
      messages: [{ role: "user", content: "continue" }],
    }),
    run("2026-06-27 13:00:01", model, 1),
    packet("2026-06-27 13:00:02", model, {
      id: "stream-partial",
      model,
      choices: [
        { index: 0, delta: { content: "Still working" }, finish_reason: null },
      ],
    }),
  ].join("\n");

  const call = parser.parseFiles([{ name: "partial.log", text }]).calls[0];
  assert.equal(call.outputMessage.content, "Still working");
  assert.equal(call.streamComplete, false);
  assert.equal(call.status, "incomplete");
});

test("reports malformed streamed packet JSON without throwing", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 14:00:00", {
      model,
      stream: true,
      messages: [{ role: "user", content: "broken" }],
    }),
    run("2026-06-27 14:00:01", model, 1),
    `[2026-06-27 14:00:02][INFO][${model}] Generated packet: {\n  "id": "stream-broken",\n  "choices": [`,
  ].join("\n");

  const result = parser.parseFiles([{ name: "broken-stream.log", text }]);
  assert.equal(result.calls.length, 1);
  assert.match(
    result.warnings.map((warning) => warning.message).join("\n"),
    /truncated/i,
  );
});

test("keeps a usage-bearing stream incomplete without a terminal chunk or finished boundary", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 11:05:00", {
      model,
      stream: true,
      messages: [{ role: "user", content: "partial please" }],
    }),
    run("2026-06-27 11:05:01", model, 1),
    packet("2026-06-27 11:05:02", model, {
      id: "stream-usage-open",
      object: "chat.completion.chunk",
      model,
      choices: [
        {
          index: 0,
          delta: { role: "tool", content: "Partial" },
          finish_reason: null,
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
  ].join("\n");

  const result = parser.parseFiles([{ name: "stream-open.log", text }]);
  const call = result.calls[0];
  assert.equal(call.status, "incomplete");
  assert.equal(call.streamComplete, false);
  assert.equal(call.outputMessage.role, "tool");
  assert.equal(call.outputMessage.content, "Partial");
  assert.deepEqual(call.usage, {
    prompt_tokens: 2,
    completion_tokens: 1,
    total_tokens: 3,
  });
});

test("keeps a usage-only packet stream incomplete without a finish chunk or boundary", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 11:06:00", {
      model,
      stream: true,
      messages: [{ role: "user", content: "usage only please" }],
    }),
    run("2026-06-27 11:06:01", model, 1),
    packet("2026-06-27 11:06:02", model, {
      id: "stream-usage-only-open",
      object: "chat.completion.chunk",
      model,
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 0, total_tokens: 2 },
    }),
  ].join("\n");

  const result = parser.parseFiles([
    { name: "stream-usage-only-open.log", text },
  ]);
  const call = result.calls[0];
  assert.equal(call.streamComplete, false);
  assert.equal(call.status, "incomplete");
  assert.deepEqual(call.usage, {
    prompt_tokens: 2,
    completion_tokens: 0,
    total_tokens: 2,
  });
});

test("matches ordinary and streamed responses by source order", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 12:00:00", {
      model,
      messages: [{ role: "user", content: "ordinary request" }],
    }),
    run("2026-06-27 12:00:01", model, 1),
    request("2026-06-27 12:00:02", {
      model,
      stream: true,
      messages: [{ role: "user", content: "stream request" }],
    }),
    run("2026-06-27 12:00:03", model, 1),
    packet("2026-06-27 12:00:04", model, {
      id: "stream-ordered",
      object: "chat.completion.chunk",
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "streamed first" },
          finish_reason: "stop",
        },
      ],
    }),
    response("2026-06-27 12:00:05", prediction(model, "ordinary second")),
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
    request("2026-06-27 12:10:00", {
      model,
      messages: [{ role: "user", content: "ordinary first" }],
    }),
    run("2026-06-27 12:10:01", model, 1),
    request("2026-06-27 12:10:02", {
      model,
      stream: true,
      messages: [{ role: "user", content: "stream second" }],
    }),
    run("2026-06-27 12:10:03", model, 1),
    response("2026-06-27 12:10:04", prediction(model, "ordinary result")),
    packet("2026-06-27 12:10:05", model, {
      id: "stream-later",
      object: "chat.completion.chunk",
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "stream result" },
          finish_reason: "stop",
        },
      ],
    }),
  ].join("\n");

  const result = parser.parseFiles([{ name: "inverse-mixed.log", text }]);
  assert.equal(result.calls[0].stream, false);
  assert.equal(result.calls[0].outputMessage.content, "ordinary result");
  assert.equal(result.calls[1].stream, true);
  assert.equal(result.calls[1].outputMessage.content, "stream result");
  assert.equal(result.calls[0].status, "matched");
  assert.equal(result.calls[1].status, "matched");
});

test("matches overlapping ordinary responses FIFO instead of newest-first", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 12:20:00", {
      model,
      messages: [{ role: "user", content: "ordinary first" }],
    }),
    run("2026-06-27 12:20:01", model, 1),
    request("2026-06-27 12:20:02", {
      model,
      messages: [{ role: "user", content: "ordinary second" }],
    }),
    run("2026-06-27 12:20:03", model, 1),
    response("2026-06-27 12:20:04", prediction(model, "first result")),
    response("2026-06-27 12:20:05", prediction(model, "second result")),
  ].join("\n");

  const result = parser.parseFiles([{ name: "ordinary-fifo.log", text }]);
  assert.equal(result.calls[0].outputMessage.content, "first result");
  assert.equal(result.calls[1].outputMessage.content, "second result");
  assert.equal(result.calls[0].status, "matched");
  assert.equal(result.calls[1].status, "matched");
});

test("warns on orphan streamed packets instead of fabricating an ordinary match", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 12:30:00", {
      model,
      messages: [{ role: "user", content: "ordinary only" }],
    }),
    run("2026-06-27 12:30:01", model, 1),
    packet("2026-06-27 12:30:02", model, {
      id: "orphan-stream",
      object: "chat.completion.chunk",
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "streamed orphan" },
          finish_reason: "stop",
        },
      ],
    }),
    finished("2026-06-27 12:30:03", model),
  ].join("\n");

  const result = parser.parseFiles([{ name: "orphan-stream.log", text }]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].stream, false);
  assert.equal(result.calls[0].status, "incomplete");
  assert.equal(result.calls[0].outputMessage, null);
  assert.match(
    result.warnings.map((warning) => warning.message).join("\n"),
    /Response has no preceding request/,
  );
});

test("leaves a rejected request incomplete instead of shifting matches", () => {
  const model = "test/model";
  const text = [
    request("2026-06-27 10:00:00", {
      model,
      messages: [{ role: "user", content: "rejected" }],
    }),
    request("2026-06-27 10:00:01", {
      model,
      messages: [{ role: "user", content: "accepted" }],
    }),
    run("2026-06-27 10:00:02", model, 1),
    response("2026-06-27 10:00:03", prediction(model, "accepted result")),
  ].join("\n");
  const result = parser.parseFiles([{ name: "two.log", text }]);
  assert.equal(result.calls[0].status, "incomplete");
  assert.equal(result.calls[1].status, "matched");
  assert.equal(result.calls[1].outputMessage.content, "accepted result");
});

test("reports truncated JSON without throwing", () => {
  const result = parser.parseFiles([
    {
      name: "broken.log",
      text: '[2026-06-27 10:00:00][DEBUG] Received request: POST to /v1/chat/completions with body {\n  "model": "x"',
    },
  ]);
  assert.equal(result.stats.calls, 1);
  assert.equal(result.calls[0].status, "incomplete");
  assert.match(result.calls[0].parseError, /truncated/i);
  assert.equal(result.warnings.length, 1);
});

test("keeps matching null-safe when a malformed request precedes a valid one", () => {
  const model = "test/model";
  const text = [
    "[2026-06-27 10:20:00][DEBUG] Received request: POST to /v1/chat/completions with body { invalid }",
    request("2026-06-27 10:20:01", {
      model,
      messages: [{ role: "user", content: "valid request" }],
    }),
    run("2026-06-27 10:20:02", model, 1),
    response("2026-06-27 10:20:03", prediction(model, "valid result")),
  ].join("\n");

  const result = parser.parseFiles([{ name: "null-safe.log", text }]);
  assert.equal(result.stats.calls, 2);
  assert.equal(result.calls[0].status, "incomplete");
  assert.equal(result.calls[1].status, "matched");
  assert.equal(result.calls[1].outputMessage.content, "valid result");
});

test("groups continuations and describes removed and added messages", () => {
  const base = [
    { role: "system", content: "rules" },
    { role: "user", content: "start" },
    { role: "assistant", content: "answer" },
  ];
  const calls = [
    {
      id: "a",
      timestamp: 1,
      sourceIndex: 0,
      lineStart: 1,
      model: "m",
      endpoint: "e",
      messages: base.map((m, i) => ({
        ...m,
        index: i,
        fingerprint: parser.stableStringify(m),
      })),
    },
    {
      id: "b",
      timestamp: 2,
      sourceIndex: 0,
      lineStart: 2,
      model: "m",
      endpoint: "e",
      messages: [
        base[0],
        base[1],
        base[2],
        { role: "user", content: "next" },
      ].map((m, i) => ({
        ...m,
        index: i,
        fingerprint: parser.stableStringify(m),
      })),
    },
    {
      id: "c",
      timestamp: 3,
      sourceIndex: 0,
      lineStart: 3,
      model: "m",
      endpoint: "e",
      messages: [
        base[0],
        base[1],
        { role: "user", content: "replacement" },
      ].map((m, i) => ({
        ...m,
        index: i,
        fingerprint: parser.stableStringify(m),
      })),
    },
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
  const make = (id, user, timestamp) => ({
    id,
    timestamp,
    sourceIndex: 0,
    lineStart: timestamp,
    model: "m",
    endpoint: "e",
    messages: [
      { index: 0, role: "system", content: "generic", fingerprint: "same" },
      { index: 1, role: "user", content: user, fingerprint: user },
    ],
  });
  const calls = [make("a", "alpha", 1), make("b", "beta", 2)];
  assert.equal(parser.buildThreads(calls).length, 2);
});

test("separates sub-agents with the same system prompt but different first user assignments", () => {
  const message = (index, role, content, fingerprint) => ({
    index,
    role,
    content,
    fingerprint,
  });
  const calls = [
    {
      id: "agent-a",
      timestamp: 1,
      sourceIndex: 0,
      lineStart: 1,
      model: "m",
      endpoint: "e",
      messages: [
        message(0, "system", "shared agent rules", "system"),
        message(1, "user", "inspect backend correctness", "assignment-a"),
        message(2, "user", "shared exploration budget", "budget"),
      ],
    },
    {
      id: "agent-b",
      timestamp: 2,
      sourceIndex: 0,
      lineStart: 2,
      model: "m",
      endpoint: "e",
      messages: [
        message(0, "system", "shared agent rules", "system"),
        message(1, "user", "inspect frontend state", "assignment-b"),
        message(2, "user", "shared exploration budget", "budget"),
      ],
    },
  ];
  assert.equal(parser.buildThreads(calls).length, 2);
  assert.equal(calls[1].predecessorId, undefined);
});

test("keeps follow-ups with identical initial system and user prompts in one thread", () => {
  const base = [
    { index: 0, role: "system", content: "rules", fingerprint: "system" },
    {
      index: 1,
      role: "user",
      content: "assigned task",
      fingerprint: "assignment",
    },
  ];
  const calls = [
    {
      id: "start",
      timestamp: 1,
      sourceIndex: 0,
      lineStart: 1,
      model: "m",
      endpoint: "e",
      messages: base,
    },
    {
      id: "follow-up",
      timestamp: 2,
      sourceIndex: 0,
      lineStart: 2,
      model: "m",
      endpoint: "e",
      messages: [
        ...base,
        { index: 2, role: "assistant", content: "work", fingerprint: "work" },
        {
          index: 3,
          role: "user",
          content: "continue",
          fingerprint: "continue",
        },
      ],
    },
  ];
  assert.equal(parser.buildThreads(calls).length, 1);
  assert.equal(calls[1].predecessorId, "start");
});

// ── Messages API format tests ────────────────────────────────────────────────

function msgStart(time, model, id) {
  return `[${time}][INFO][${model}] Generated packet: ${JSON.stringify({ type: "message_start", message: { id, role: "assistant", type: "message", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 90 } } }, null, 2)}`;
}
function textDelta(time, model, text) {
  return `[${time}][INFO][${model}] Generated packet: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`;
}
function blockStop(time, model) {
  return `[${time}][INFO][${model}] Generated packet: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`;
}
function msgDelta(time, model, stopReason, usage) {
  const obj = {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
  };
  if (usage) obj.usage = usage;
  return `[${time}][INFO][${model}] Generated packet: ${JSON.stringify(obj)}`;
}
function msgStop(time, model) {
  return `[${time}][INFO][${model}] Generated packet: {"type":"message_stop"}`;
}

test("aggregates a complete messages-api stream into one response", () => {
  const model = "anthropic/claude-sonnet-4-20250514";
  const text = [
    request("2026-07-30 10:00:00", {
      model,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
    run("2026-07-30 10:00:01", model, 1),
    msgStart("2026-07-30 10:00:02", model, "msg-abc"),
    textDelta("2026-07-30 10:00:02", model, "Hello"),
    textDelta("2026-07-30 10:00:03", model, " world"),
    blockStop("2026-07-30 10:00:03", model),
    msgDelta("2026-07-30 10:00:04", model, "end_turn", {
      input_tokens: 50,
      output_tokens: 10,
      cache_read_input_tokens: 45,
    }),
    msgStop("2026-07-30 10:00:04", model),
  ].join("\n");

  const result = parser.parseFiles([{ name: "msgs.log", text }]);
  assert.equal(result.stats.calls, 1);
  const call = result.calls[0];
  assert.equal(call.stream, true);
  assert.equal(call.outputMessage.content, "Hello world");
  assert.equal(call.finishReason, "end_turn");
  assert.deepEqual(call.usage, {
    input_tokens: 50,
    output_tokens: 10,
    cache_read_input_tokens: 45,
  });
});

test("aggregates a messages-api stream with tool_use content blocks", () => {
  const model = "anthropic/claude-sonnet-4-20250514";
  const text = [
    request("2026-07-30 11:00:00", {
      model,
      stream: true,
      messages: [{ role: "user", content: "run command" }],
    }),
    run("2026-07-30 11:00:01", model, 1),
    msgStart("2026-07-30 11:00:02", model, "msg-def"),
    textDelta("2026-07-30 11:00:02", model, "I'll "),
    blockStop("2026-07-30 11:00:02", model),
    // tool_use content_block_start + deltas + stop (index 1)
    `[2026-07-30 11:00:03][INFO][${model}] Generated packet: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-xyz","name":"run_in_terminal"}}`,
    textDelta("2026-07-30 11:00:03", model, '{"command":"ls"}'),
    blockStop("2026-07-30 11:00:03", model),
    msgDelta("2026-07-30 11:00:04", model, "tool_use"),
    msgStop("2026-07-30 11:00:04", model),
  ].join("\n");

  const result = parser.parseFiles([{ name: "msgs-tools.log", text }]);
  const call = result.calls[0];
  assert.equal(call.stream, true);
  assert.ok(call.outputMessage.content.indexOf("I'll") >= 0);
  assert.equal(call.finishReason, "tool_use");
});

test("keeps a partial messages-api stream incomplete", () => {
  const model = "anthropic/claude-sonnet-4-20250514";
  const text = [
    request("2026-07-30 12:00:00", {
      model,
      stream: true,
      messages: [{ role: "user", content: "partial" }],
    }),
    run("2026-07-30 12:00:01", model, 1),
    msgStart("2026-07-30 12:00:02", model, "msg-partial"),
    textDelta("2026-07-30 12:00:02", model, "still working"),
    blockStop("2026-07-30 12:00:02", model),
  ].join("\n");

  const result = parser.parseFiles([{ name: "msgs-partial.log", text }]);
  const call = result.calls[0];
  assert.equal(call.stream, true);
  assert.equal(call.outputMessage.content, "still working");
  assert.equal(call.finishReason, null);
});

test("incremental parser buffers split records and emits normalized events once", () => {
  const stream = parser.createIncrementalParser("tail.log");
  const first = stream.push(
    '[2026-08-01 10:00:00][DEBUG] Received request: POST to /v1/chat/completions with body {"model":"m"',
  );
  assert.deepEqual(first.events, []);

  const second = stream.push(
    '}\n[2026-08-01 10:00:01][INFO][m] Generated packet: {"id":"s-1","choices":[]}',
  );
  assert.deepEqual(
    second.events.map((event) => event.kind),
    ["request", "packet"],
  );
  assert.equal(second.events[1].correlationId, "s-1");
  assert.equal(stream.push("").events.length, 0);
});

test("live reducer updates one call as streamed events arrive", () => {
  const reducer = parser.createLiveReducer("tail.log");
  const model = "test/model";
  const requestEvent = {
    id: "request-1",
    sourceId: "tail.log",
    kind: "request",
    lineStart: 1,
    lineEnd: 1,
    timestampRaw: "2026-08-01 10:00:00",
    timestamp: Date.parse("2026-08-01T10:00:00"),
    payload: {
      model,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    },
  };
  const runEvent = {
    id: "run-1",
    sourceId: "tail.log",
    kind: "run",
    lineStart: 2,
    lineEnd: 2,
    timestampRaw: "2026-08-01 10:00:01",
    timestamp: Date.parse("2026-08-01T10:00:01"),
    payload: { model },
  };
  let update = reducer.apply([requestEvent, runEvent]);
  assert.equal(update.result.calls.length, 1);
  assert.equal(update.result.calls[0].status, "incomplete");
  const callId = update.result.calls[0].id;

  update = reducer.apply([
    {
      id: "packet-1",
      sourceId: "tail.log",
      correlationId: "stream-1",
      kind: "packet",
      lineStart: 3,
      lineEnd: 3,
      timestampRaw: "2026-08-01 10:00:02",
      timestamp: Date.parse("2026-08-01T10:00:02"),
      payload: {
        id: "stream-1",
        model,
        choices: [
          { delta: { role: "assistant", content: "Hello" }, finish_reason: null },
        ],
      },
    },
  ]);
  assert.equal(update.result.calls[0].id, callId);
  assert.equal(update.result.calls[0].outputMessage.content, "Hello");
  assert.equal(update.result.calls[0].streamPackets.length, 1);

  update = reducer.apply([
    {
      id: "packet-2",
      sourceId: "tail.log",
      correlationId: "stream-1",
      kind: "packet",
      lineStart: 4,
      lineEnd: 4,
      timestampRaw: "2026-08-01 10:00:03",
      timestamp: Date.parse("2026-08-01T10:00:03"),
      payload: {
        id: "stream-1",
        model,
        choices: [{ delta: {}, finish_reason: "stop" }],
      },
    },
  ]);
  assert.equal(update.result.calls[0].status, "matched");
  assert.equal(update.result.calls[0].streamComplete, true);
});

test("live reducer marks ambiguous stream attribution uncertain", () => {
  const reducer = parser.createLiveReducer("ambiguous.log");
  const base = (id, lineStart, content) => ({
    id,
    sourceId: "ambiguous.log",
    kind: "request",
    lineStart,
    lineEnd: lineStart,
    timestampRaw: "2026-08-01 10:00:0" + lineStart,
    timestamp: Date.parse("2026-08-01T10:00:0" + lineStart),
    payload: {
      model: "test/model",
      stream: true,
      messages: [{ role: "user", content }],
    },
  });
  const update = reducer.apply([
    base("request-1", 1, "one"),
    base("request-2", 2, "two"),
    {
      id: "packet-1",
      sourceId: "ambiguous.log",
      correlationId: "stream-1",
      kind: "packet",
      lineStart: 3,
      lineEnd: 3,
      timestampRaw: "2026-08-01 10:00:03",
      timestamp: Date.parse("2026-08-01T10:00:03"),
      payload: {
        id: "stream-1",
        model: "test/model",
        choices: [{ delta: { content: "uncertain" }, finish_reason: "stop" }],
      },
    },
  ]);
  assert.equal(update.result.calls.filter((call) => call.stream).length, 2);
  assert.ok(update.result.calls.some((call) => call.status === "uncertain"));
  assert.match(
    update.result.warnings.map((warning) => warning.message).join("\n"),
    /ambiguous/i,
  );
});

test("live reducer preserves event order across rotated files", () => {
  const reducer = parser.createLiveReducer("live-folder");
  const request = (sourceId, id, content) => ({
    id,
    sourceId,
    kind: "request",
    lineStart: 1,
    lineEnd: 1,
    timestampRaw: "2026-08-01 10:00:00",
    timestamp: Date.parse("2026-08-01T10:00:00"),
    payload: {
      model: "test/model",
      stream: true,
      messages: [{ role: "user", content }],
    },
  });
  reducer.apply([request("old.log", "old-request", "old")]);
  const update = reducer.apply([
    request("new.log", "new-request", "new"),
    {
      id: "new-packet",
      sourceId: "new.log",
      correlationId: "new-stream",
      kind: "packet",
      lineStart: 2,
      lineEnd: 2,
      timestampRaw: "2026-08-01 10:00:01",
      timestamp: Date.parse("2026-08-01T10:00:01"),
      payload: {
        id: "new-stream",
        model: "test/model",
        choices: [{ delta: { content: "new response" }, finish_reason: "stop" }],
      },
    },
  ]);
  const newCall = update.result.calls.find(
    (call) => call.messages[0].content === "new",
  );
  assert.equal(newCall.outputMessage.content, "new response");
});
