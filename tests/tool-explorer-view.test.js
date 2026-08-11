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
