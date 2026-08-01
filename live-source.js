(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LMStudioLiveSource = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  function isLogEntry(entry) {
    return entry && typeof entry.name === "string" && /\.log$/i.test(entry.name);
  }

  function orderedEntries(entries) {
    return entries
      .filter(isLogEntry)
      .sort(
        (a, b) =>
          (Number(a.modified) || 0) - (Number(b.modified) || 0) ||
          a.name.localeCompare(b.name),
      );
  }

  class DirectoryTailSource {
    constructor(options) {
      options = options || {};
      this.directory = options.directory;
      this.intervalMs = options.intervalMs || 750;
      this.onText = options.onText || function () {};
      this.onStatus = options.onStatus || function () {};
      this.onWarning = options.onWarning || function () {};
      this.offsets = new Map();
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
        const logEntries = orderedEntries(entries);
        if (!logEntries.length) {
          this.setStatus("live");
          return;
        }
        for (const entry of logEntries) {
          let offset = this.offsets.get(entry.name) || 0;
          if (entry.size < offset) {
            this.onWarning({
              kind: "truncated",
              message: "Log was truncated; restarting from the beginning.",
              fileName: entry.name,
            });
            offset = 0;
          }
          if (entry.size <= offset) {
            this.offsets.set(entry.name, entry.size);
            continue;
          }
          try {
            const text = await entry.read(offset, entry.size);
            this.offsets.set(entry.name, entry.size);
            if (text) {
              this.onText({
                sourceId: entry.name,
                fileName: entry.name,
                text,
                offset,
              });
            }
          } catch (error) {
            this.onWarning({
              kind: "read-error",
              fileName: entry.name,
              operation: "read",
              message: error && error.message ? error.message : String(error),
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
    if (typeof window === "undefined")
      return { supported: false, reason: "browser-api-unavailable", directory: null };
    if (!window.isSecureContext)
      return { supported: false, reason: "insecure-context", directory: null };
    if (!window.showDirectoryPicker)
      return { supported: false, reason: "browser-api-unavailable", directory: null };
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
              read: async (start, end) => {
                const current = await child.getFile();
                return current.slice(start, end).text();
              },
            });
          }
          return entries;
        },
      },
    };
  }

  return { DirectoryTailSource, openLogDirectoryHandle };
});
