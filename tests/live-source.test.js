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
        size: file.size == null ? file.text.length : file.size,
        read: async (start, end) => {
          if (file.read) return file.read(start, end);
          return file.text.slice(start, end);
        },
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

test("reports why directory watching is unavailable", async () => {
  const capability = await require("../live-source.js").openLogDirectoryHandle();
  assert.equal(capability.supported, false);
  assert.equal(capability.reason, "browser-api-unavailable");
});

test("loads all existing logs and then tails only new bytes", async () => {
  const directory = memoryDirectory();
  directory.files.set("2026-08-01.1.log", { name: "2026-08-01.1.log", modified: 1, text: "old\n" });
  const current = { name: "2026-08-01.2.log", modified: 2, text: "current\n" };
  directory.files.set(current.name, current);
  const chunks = [];
  const source = new DirectoryTailSource({ directory, onText: (chunk) => chunks.push(chunk) });

  await source.readNow();
  current.text += "next\n";
  current.modified = 3;
  await source.readNow();

  assert.deepEqual(chunks.map((chunk) => chunk.fileName), [
    "2026-08-01.1.log",
    "2026-08-01.2.log",
    "2026-08-01.2.log",
  ]);
  assert.equal(chunks[2].text, "next\n");
});

test("keeps watching after a file read error and retries it", async () => {
  const directory = memoryDirectory();
  let attempts = 0;
  directory.files.set("broken.log", {
    name: "broken.log",
    modified: 1,
    text: "recovered\n",
    read: async (start, end) => {
      attempts += 1;
      if (attempts === 1) throw new Error("file temporarily unavailable");
      return "recovered\n".slice(start, end);
    },
  });
  const chunks = [];
  const warnings = [];
  const source = new DirectoryTailSource({
    directory,
    onText: (chunk) => chunks.push(chunk),
    onWarning: (warning) => warnings.push(warning),
  });

  await source.readNow();
  await source.readNow();

  assert.equal(chunks.length, 1);
  assert.equal(warnings[0].fileName, "broken.log");
  assert.equal(warnings[0].kind, "read-error");
});

test("uses the file byte size as the next read offset", async () => {
  const directory = memoryDirectory();
  let reads = 0;
  directory.files.set("unicode.log", {
    name: "unicode.log",
    modified: 1,
    text: "ä\n",
    size: 3,
    read: async (start, end) => {
      reads += 1;
      return "ä\n".slice(start, end);
    },
  });
  const source = new DirectoryTailSource({ directory });
  await source.readNow();
  await source.readNow();
  assert.equal(reads, 1);
});

test("tails a double-extension minilog file", async () => {
  const directory = memoryDirectory();
  directory.files.set("request.log.log", {
    name: "request.log.log",
    modified: 1,
    text: "[1786211394] Prompt:\n{}\n",
  });
  const chunks = [];
  const source = new DirectoryTailSource({
    directory,
    onText: (chunk) => chunks.push(chunk),
  });

  await source.readNow();

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].fileName, "request.log.log");
});
