const test = require("node:test");
const assert = require("node:assert/strict");
const { DirectoryTailSource } = require("../live-source.js");

function memoryDirectory() {
  const files = new Map();
  return {
    files,
    async list() {
      return [...files.values()].map((file) => ({
        name: file.name,
        modified: file.modified,
        size: file.text.length,
        read: async (start) => file.text.slice(start),
      }));
    },
  };
}

test("tails the newest log and reads only appended text", async () => {
  const directory = memoryDirectory();
  const file = { name: "2026-08-01.1.log", modified: 1, text: "first\n" };
  directory.files.set(file.name, file);
  const chunks = [];
  const source = new DirectoryTailSource({
    directory,
    onText: (chunk) => chunks.push(chunk),
  });

  await source.readNow();
  file.text += "second\n";
  file.modified = 2;
  await source.readNow();
  await source.readNow();

  assert.deepEqual(chunks.map((chunk) => chunk.text), ["first\n", "second\n"]);
  assert.equal(chunks[1].offset, 6);
});

test("switches to a newer log on rotation and warns on truncation", async () => {
  const directory = memoryDirectory();
  const oldFile = { name: "2026-08-01.1.log", modified: 1, text: "old\n" };
  directory.files.set(oldFile.name, oldFile);
  const chunks = [];
  const warnings = [];
  const source = new DirectoryTailSource({
    directory,
    onText: (chunk) => chunks.push(chunk),
    onWarning: (warning) => warnings.push(warning),
  });

  await source.readNow();
  const newFile = { name: "2026-08-01.2.log", modified: 2, text: "new\n" };
  directory.files.set(newFile.name, newFile);
  await source.readNow();
  newFile.text = "r\n";
  newFile.modified = 3;
  await source.readNow();

  assert.deepEqual(chunks.map((chunk) => chunk.fileName), [
    "2026-08-01.1.log",
    "2026-08-01.2.log",
    "2026-08-01.2.log",
  ]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "truncated");
});
