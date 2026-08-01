const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("author styles preserve the HTML hidden state", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
  assert.match(css, /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/i);
});

test("welcome and workspace use distinct initial hidden states", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /id="drop-zone"/);
  assert.match(html, /id="workspace"[^>]*hidden/);
});

test("desktop panes establish independently scrollable flex children", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");
  assert.match(css, /\.thread-list\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/is);
  assert.match(css, /\.detail\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/is);
  assert.match(css, /\.content\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/is);
});

test("detail rendering exposes streamed packet evidence", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /call\.streamPackets/);
  assert.match(app, /Stream packets/);
  assert.match(app, /streamComplete/);
});

test("detail rendering wires streamed packet evidence from the call fields", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(app, /call\.stream\s*\?\s*\(\(call\.finishReason\s*\?\s*call\.finishReason\s*\+\s*"[^"]*"\s*:\s*""\)\s*\+\s*call\.streamPackets\.length\s*\+\s*" packets"\)/s);
  assert.match(app, /call\.stream\s*&&\s*!call\.streamComplete\s*\?\s*'<p class="stream-note">Partial stream: logging ended before the terminal packet\.<\/p>'\s*:\s*""/s);
  assert.match(app, /detailBlock\("Stream packets \("\s*\+\s*call\.streamPackets\.length\s*\+\s*"\)",\s*call\.streamPackets,\s*\{\s*copyKey:\s*"stream-packets"\s*\}\)/s);
  assert.match(app, /const copyMap = \{[^}]*"stream-packets": call\.streamPackets[^}]*\}/s);
});

test("live folder watching is wired through the source-neutral reducer", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(html, /id="watch-folder"/);
  assert.match(html, /id="stop-watch"/);
  assert.match(html, /id="live-status"/);
  assert.match(app, /DirectoryTailSource/);
  assert.match(app, /createLiveReducer/);
  assert.match(app, /state\.query/);
  assert.match(app, /state\.selectedId/);
});

test("live diagnostics are rendered persistently", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(html, /id="live-diagnostics"/);
  assert.match(html, /id="live-diagnostics-output"/);
  assert.match(app, /console\.warn/);
  assert.match(app, /live-diagnostics-output/);
});

test("live updates avoid full-history replay and batch UI work", () => {
  const parser = fs.readFileSync(path.join(__dirname, "..", "parser.js"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const reducer = parser.slice(parser.indexOf("function createLiveReducer"), parser.indexOf("function lcsPairs"));
  const incremental = parser.slice(parser.indexOf("function createIncrementalParser"), parser.indexOf("function createLiveReducer"));
  assert.doesNotMatch(reducer, /parseFiles\(/);
  assert.doesNotMatch(incremental, /parseSource\(/);
  assert.match(app, /pendingEvents/);
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /renderStats\(\); renderDetail\(\)/);
});
