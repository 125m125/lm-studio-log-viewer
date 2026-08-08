# Ollama.cpp/llama.cpp Minilog Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (recommended) to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Parse llama.cpp \`--minilog\` prompt/token records through file import and live folder watching, including the five-minute stale-final rule.

**Architecture:** Add minilog request/token events to \`parser.js\`. Static parsing and \`createIncrementalParser\` share the event format; \`createLiveReducer\` aggregates token events into one existing call. The current \`.log\` suffix filter already accepts \`request.log.log\`.

**Tech Stack:** Dependency-free browser JavaScript; Node.js \`node:test\`; existing File System Access API tailer.

## Global Constraints

- Preserve prompt JSON, exact token text, timestamps, and raw evidence.
- Buffer incomplete JSON and unterminated token lines during live reads.
- Close a call at the next \`Prompt:\`; close the final call only if output exists and its newest timestamp is at least five minutes before the supplied clock.
- Ignore \`Preserved token:\`, \`Not preserved because\`, and \`Resampling because\` diagnostics.
- Do not modify the growing sample file or add dependencies.
- Write production code only after a focused test fails.

---

### Task 1: Static minilog parsing

**Files:** Modify \`tests/parser.test.js\`, \`parser.js\`, and \`README.md\`.

**Interfaces:** Add optional \`options.now\` to \`parseSource(source, options = {})\` and \`parseFiles(files, options = {})\`; it accepts a number or zero-argument function. Minilog requests are \`kind: "request"\`, \`format: "minilog"\`, with a prompt correlation ID. Token events are \`kind: "minilog-token"\` with \`payload: { text }\`.

- [ ] **Step 1: Write the failing static test.**

~~~
function minilogPrompt(time, body) {
  return "[" + time + "] Prompt:\\n" + JSON.stringify(body, null, 2);
}
function minilogToken(time, text) {
  return "[" + time + "] token:" + text;
}

test("parses minilog prompts and reconstructs token responses", () => {
  const text = [
    minilogPrompt("1786211394", {
      model: "m", stream: false,
      messages: [{ role: "user", content: "first" }],
    }),
    minilogToken("1786211395", "Hello"),
    minilogToken("1786211395", " world"),
    "[1786211395] Preserved token: 42",
    minilogPrompt("1786211400", {
      model: "m", stream: true,
      messages: [{ role: "user", content: "second" }],
    }),
    minilogToken("1786211401", "working"),
  ].join("\\n");
  const result = parser.parseFiles([{ name: "request.log.log", text }], {
    now: 1786211402 * 1000,
  });
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].outputMessage.content, "Hello world");
  assert.equal(result.calls[0].status, "matched");
  assert.equal(result.calls[1].outputMessage.content, "working");
  assert.equal(result.calls[1].status, "incomplete");
});
~~~

- [ ] **Step 2: Run the focused test and confirm it fails.**

~~~
node --test tests\\parser.test.js --test-name-pattern "parses minilog prompts"
~~~

Expected: failure because the current parser returns zero minilog calls.

- [ ] **Step 3: Implement the smallest static path.**

Add these constants/helpers in \`parser.js\`:

~~~
const MINILOG_PROMPT_RE = /^\\[(\\d+(?:\\.\\d+)?)\\]\\s+Prompt:\\s*$/;
const MINILOG_TOKEN_RE = /^\\[(\\d+(?:\\.\\d+)?)\\]\\s+token:(.*)$/;
const MINILOG_STALE_MS = 5 * 60 * 1000;

function parseUnixTimestamp(raw) {
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}
function getParserNow(options) {
  if (options && typeof options.now === "function") return options.now();
  if (options && Number.isFinite(options.now)) return options.now;
  return Date.now();
}
~~~

Route sources containing a \`Prompt:\` header through the normalized event scanner
implemented in this plan, group events by prompt correlation ID, and build the
existing call shape. Concatenate token
payloads exactly. For non-empty output, create:

~~~
const outputMessage = { role: "assistant", content: tokenText };
const response = {
  id: "minilog-response-" + request.id,
  object: "chat.completion",
  model: request.data.model || null,
  choices: [{ index: 0, message: outputMessage, finish_reason: null }],
  usage: null,
};
~~~

Set \`streamComplete\` and \`status\` from the boundary/stale rules, preserve
raw prompt/token evidence, and leave ordinary LM Studio parsing unchanged.

- [ ] **Step 4: Run focused then full parser tests.**

~~~
node --test tests\\parser.test.js --test-name-pattern "parses minilog prompts"
node --test tests\\parser.test.js
~~~

Expected: both commands pass.

- [ ] **Step 5: Document import/live support and commit.**

~~~
git add parser.js tests\\parser.test.js README.md
git commit -m "feat: parse llama cpp minilogs"
~~~

### Task 2: Incremental minilog parser

**Files:** Modify \`tests/parser.test.js\` and \`parser.js\` inside
\`createIncrementalParser\`.

**Interfaces:** Keep \`createIncrementalParser(sourceId)\` returning
\`{ push(chunk), finish() }\`. \`push\` emits complete events only;
\`finish\` may consume a final unterminated EOF line.

- [ ] **Step 1: Write the failing split-record tests.**

~~~
test("incremental minilog parser buffers split prompts and tokens", () => {
  const stream = parser.createIncrementalParser("request.log.log");
  assert.deepEqual(stream.push(
    "[1786211394] Prompt:\\n{\\n  " +
    "\\"model\\": \\"m\\", \\"messages\\": [{",
  ).events, []);
  const second = stream.push(
    "\\"role\\":\\"user\\",\\"content\\":\\"hello\\"}]}\\n}\\n" +
    "[1786211395] token:Hel",
  );
  assert.deepEqual(second.events.map((event) => event.kind), ["request"]);
  const third = stream.push("lo\\n");
  assert.deepEqual(third.events.map((event) => event.kind), ["minilog-token"]);
  assert.equal(third.events[0].payload.text, "Hello");
  assert.equal(third.events[0].correlationId, second.events[0].correlationId);
});

test("incremental minilog parser warns on orphan token lines", () => {
  const stream = parser.createIncrementalParser("orphan.log");
  const result = stream.push("[1786211395] token:orphan\\n");
  assert.deepEqual(result.events, []);
  assert.match(result.warnings[0].message, /active Prompt/i);
});
~~~

- [ ] **Step 2: Run and confirm the focused tests fail.**

~~~
node --test tests\\parser.test.js --test-name-pattern "incremental minilog"
~~~

- [ ] **Step 3: Implement the minilog branches.**

Before ordinary markers, inspect a complete first line with
\`MINILOG_PROMPT_RE\`. Scan the first \`{\` using the existing string-aware
depth logic. Buffer incomplete JSON during \`push\`; warn on truncation at
\`finish\`. Emit a request event with \`format: "minilog"\`, stable source/line
ID, timestamp, raw JSON, and set the active correlation ID. For
\`MINILOG_TOKEN_RE\`, buffer an incomplete line during \`push\`, consume it at
EOF, and emit the exact capture as \`{ text }\`. Ignore diagnostic lines. Warn
and emit nothing for a token without an active prompt. Preserve ordinary event
line numbering and multiline \`lineEnd\`.

- [ ] **Step 4: Run the parser suite and commit.**

~~~
node --test tests\\parser.test.js
git add parser.js tests\\parser.test.js
git commit -m "feat: stream minilog records incrementally"
~~~

### Task 3: Live reducer aggregation

**Files:** Modify \`tests/parser.test.js\` and \`parser.js\` inside
\`createLiveReducer\`.

**Interfaces:** Add \`createLiveReducer(sourceId, options = {})\` with the same
\`options.now\` contract. A minilog request starts one incomplete call;
\`minilog-token\` appends to its correlation; a later request closes the prior
active call when output exists.

- [ ] **Step 1: Write failing reducer tests.**

Use real normalized events:

~~~
const reducer = parser.createLiveReducer("request.log.log", {
  now: 1786211402 * 1000,
});
const request = {
  id: "prompt-1", sourceId: "request.log.log", correlationId: "prompt-1",
  kind: "request", format: "minilog", lineStart: 1, lineEnd: 4,
  timestampRaw: "1786211394", timestamp: 1786211394 * 1000,
  payload: { model: "m", stream: true, messages: [] }, raw: "Prompt",
};
const token = {
  id: "token-1", sourceId: "request.log.log", correlationId: "prompt-1",
  kind: "minilog-token", lineStart: 5, lineEnd: 5,
  timestampRaw: "1786211395", timestamp: 1786211395 * 1000,
  payload: { text: "Hello" }, raw: "token:Hello",
};
let update = reducer.apply([request]);
const callId = update.result.calls[0].id;
update = reducer.apply([token]);
assert.equal(update.result.calls[0].id, callId);
assert.equal(update.result.calls[0].outputMessage.content, "Hello");
assert.equal(update.result.calls[0].status, "incomplete");
~~~

Then apply a second minilog request and assert the first call is
\`matched\` with the same ID and that two calls exist. Add a second test with an
old token and \`reducer.apply([])\` that asserts the final call becomes
\`matched\` after the five-minute rule.

- [ ] **Step 2: Run and confirm the focused reducer tests fail.**

~~~
node --test tests\\parser.test.js --test-name-pattern "minilog call|old final"
~~~

Expected: failure because the reducer ignores \`minilog-token\` and lacks the
clock option.

- [ ] **Step 3: Implement the reducer path.**

Maintain \`minilogCalls\` by source/correlation ID and an active-call map by
source. Add helpers to create the synthetic response and refresh
\`response\`, \`responseRaw\`, \`outputMessage\`, \`responseLineStart\`,
\`streamComplete\`, \`durationMs\`, and status. On a request, close the prior
active call for that source if output exists, then index the new call. On a
token, append its text, update latest timestamp/raw evidence, and mark the
existing call updated. Recompute final-call status on every \`apply\`, including
\`apply([])\`, using \`getParserNow(options)\`. Keep ordinary packet and
prediction association untouched.

- [ ] **Step 4: Run the full parser suite and commit.**

~~~
node --test tests\\parser.test.js
git add parser.js tests\\parser.test.js
git commit -m "feat: aggregate live minilog responses"
~~~

### Task 4: Discovery and integration verification

**Files:** Modify \`tests/live-source.test.js\`; do not modify
\`C:\\Users\\fabia\\.lmstudio\\server-logs\\request.log.log\`.

- [ ] **Step 1: Add a double-extension tail test.**

~~~
test("tails a double-extension minilog file", async () => {
  const directory = memoryDirectory();
  directory.files.set("request.log.log", {
    name: "request.log.log", modified: 1,
    text: "[1786211394] Prompt:\\n{}\\n",
  });
  const chunks = [];
  const source = new DirectoryTailSource({
    directory, onText: (chunk) => chunks.push(chunk),
  });
  await source.readNow();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].fileName, "request.log.log");
});
~~~

- [ ] **Step 2: Run the focused live-source test.**

~~~
node --test tests\\live-source.test.js --test-name-pattern "double-extension"
~~~

Expected: pass without production changes because the existing \`/\\.log$/i\`
filter accepts \`.log.log\`. Change only that predicate if the test disproves
this.

- [ ] **Step 3: Run a read-only smoke parse against the supplied sample.**

~~~
node -e "const fs=require('fs'); const p=require('./parser.js'); const f='C:\\\\Users\\\\fabia\\\\.lmstudio\\\\server-logs\\\\request.log.log'; const r=p.parseFiles([{name:'request.log.log',text:fs.readFileSync(f,'utf8')}]); console.log(JSON.stringify({calls:r.calls.length,withOutput:r.calls.filter(c=>c.outputMessage).length,models:[...new Set(r.calls.map(c=>c.model))]},null,2));"
~~~

Expected: exit code \`0\`, at least one call, at least one output, and the Qwen
model name in the summary. Counts may change while the file grows.

- [ ] **Step 4: Run the complete suite and inspect the diff.**

~~~
node --test tests\\parser.test.js tests\\live-source.test.js tests\\static.test.js
git status --short
git diff HEAD~3..HEAD --stat
~~~

Expected: exit code \`0\`, zero failed tests, only intended files changed, and no
external sample path in the diff.

- [ ] **Step 5: Commit integration coverage.**

~~~
git add tests\\live-source.test.js
git commit -m "test: verify minilog file watching"
~~~
