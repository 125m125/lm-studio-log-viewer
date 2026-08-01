(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LMStudioLiveSource = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  function isLogEntry(entry) {
    return entry && typeof entry.name === "string" && /\.log$/i.test(entry.name);
  }

  function newestEntry(entries) {
    return entries
      .filter(isLogEntry)
      .sort(
        (a, b) =>
          (Number(b.modified) || 0) - (Number(a.modified) || 0) ||
          b.name.localeCompare(a.name),
      )[0] || null;
  }

  class DirectoryTailSource {
    constructor(options) {
      options = options || {};
      this.directory = options.directory;
      this.intervalMs = options.intervalMs || 750;
      this.onText = options.onText || function () {};
      this.onStatus = options.onStatus || function () {};
      this.onWarning = options.onWarning || function () {};
      this.activeName = null;
      this.offset = 0;
      this.timer = null;
      this.reading = false;
      this.stopped = false;
      this.status = "idle";
    }

    setStatus(status) {
      this.status = status;
      this.onStatus(status);
    }

    async readNow() {
      if (this.reading || this.stopped || !this.directory) return;
      this.reading = true;
      try {
        const entries = await this.directory.list();
        const entry = newestEntry(entries);
        if (!entry) {
          this.setStatus("live");
          return;
        }
        if (entry.name !== this.activeName) {
          this.activeName = entry.name;
          this.offset = 0;
        } else if (entry.size < this.offset) {
          this.onWarning({
            kind: "truncated",
            message: "Active log was truncated; restarting from the beginning.",
            fileName: entry.name,
          });
          this.offset = 0;
        }
        if (entry.size > this.offset) {
          const offset = this.offset;
          const text = await entry.read(offset, entry.size);
          this.offset = entry.size;
          if (text) {
            this.onText({
              sourceId: entry.name,
              fileName: entry.name,
              text,
              offset,
            });
          }
        }
        this.setStatus("live");
      } catch (error) {
        this.setStatus("error");
        this.onWarning({
          kind: "read-error",
          message: error && error.message ? error.message : String(error),
        });
      } finally {
        this.reading = false;
      }
    }

    start() {
      if (this.timer || this.stopped) return;
      this.stopped = false;
      this.setStatus("live");
      this.readNow();
      this.timer = setInterval(() => this.readNow(), this.intervalMs);
    }

    pause() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (!this.stopped) this.setStatus("paused");
    }

    resume() {
      if (!this.stopped) this.start();
    }

    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.stopped = true;
      this.setStatus("stopped");
    }
  }

  async function openLogDirectoryHandle() {
    if (typeof window === "undefined" || !window.showDirectoryPicker)
      return { supported: false, directory: null };
    const handle = await window.showDirectoryPicker({ mode: "read" });
    return {
      supported: true,
      directory: {
        async list() {
          const entries = [];
          for await (const [name, child] of handle.entries()) {
            if (child.kind !== "file" || !/\.log$/i.test(name)) continue;
            const file = await child.getFile();
            entries.push({
              name,
              modified: file.lastModified,
              size: file.size,
              read: (start, end) => file.slice(start, end).text(),
            });
          }
          return entries;
        },
      },
    };
  }

  return { DirectoryTailSource, openLogDirectoryHandle };
});
