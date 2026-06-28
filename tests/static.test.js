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
