(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const state = {
    result: null,
    selectedId: null,
    query: "",
    status: "all",
    model: "all",
    loading: false,
    live: null,
    explorer: {
      open: false,
      module: "tool-calls",
      scope: "conversation",
      records: [],
      selectedType: null,
      selectedRecordId: null,
      position: 0,
    },
  };
  const els = {
    shell: $("app-shell"), welcome: $("drop-zone"), workspace: $("workspace"), input: $("file-input"),
    open: $("open-files"), welcomeOpen: $("welcome-open"), watch: $("watch-folder"), stopWatch: $("stop-watch"), liveStatus: $("live-status"), diagnostics: $("live-diagnostics"), diagnosticsOutput: $("live-diagnostics-output"), clear: $("clear-files"), search: $("search"),
    status: $("status-filter"), model: $("model-filter"), list: $("thread-list"), stats: $("stats"),
    detail: $("detail"), toast: $("toast")
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch]);
  }
  function contentText(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }
  function invocationRecords() { return state.explorer.records; }
  function rebuildExplorerIndex() {
    const records = state.result ? window.LMStudioToolExplorer.buildInvocationIndex(state.result) : [];
    state.explorer = window.LMStudioToolExplorer.reconcileExplorerUpdate(state.explorer, records);
  }
  function recordsForTarget(callId, source, messageIndex) {
    return invocationRecords().filter(record =>
      record.target.callId === callId &&
      record.target.source === source &&
      record.target.messageIndex === messageIndex
    );
  }
  function compact(value) { return contentText(value).replace(/\s+/g, " ").trim(); }
  function formatNumber(n) { return new Intl.NumberFormat().format(n || 0); }
  function formatTime(call) {
    if (call.timestamp == null) return call.timestampRaw || "Unknown time";
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(call.timestamp);
  }
  function getExplorerView() {
    const scoped = state.result
      ? window.LMStudioToolExplorer.getScopedInvocations(invocationRecords(), state.result, state.selectedId, state.explorer.scope)
      : [];
    const types = window.LMStudioToolExplorer.summarizeToolTypes(scoped);
    const selection = window.LMStudioToolExplorer.reconcileSelection(
      scoped,
      state.explorer.selectedType,
      state.explorer.selectedRecordId,
      state.explorer.position,
    );
    state.explorer.selectedType = selection.selectedType;
    state.explorer.selectedRecordId = selection.selectedRecordId;
    state.explorer.position = selection.position;
    const record = selection.matching[selection.position] || null;
    return {
      open: state.explorer.open,
      scope: state.explorer.scope,
      types,
      selectedType: selection.selectedType,
      position: selection.position,
      total: selection.matching.length,
      matching: selection.matching,
      preview: record ? {
        name: record.name,
        arguments: record.parsedArguments == null ? record.arguments : JSON.stringify(record.parsedArguments, null, 2),
        time: formatTime(record),
        model: record.model || "Unknown model",
        callId: record.target.callId,
      } : null,
    };
  }
  function formatDuration(ms) {
    if (ms == null) return "—";
    if (ms < 1000) return ms + " ms";
    const seconds = ms / 1000;
    return seconds < 60 ? seconds.toFixed(1) + " s" : Math.floor(seconds / 60) + "m " + Math.round(seconds % 60) + "s";
  }
  function statusLabel(status) { return status === "matched" ? "Matched" : status === "uncertain" ? "Uncertain match" : "Incomplete"; }
  function toast(message) {
    els.toast.textContent = message; els.toast.classList.add("show");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => els.toast.classList.remove("show"), 2400);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const area = document.createElement("textarea"); area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
      document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
    }
    toast("Copied to clipboard");
  }

  function runParser(files) {
    if (location.protocol !== "file:" && typeof Worker !== "undefined") {
      return new Promise((resolve, reject) => {
        const worker = new Worker("worker.js");
        worker.onmessage = event => { worker.terminate(); event.data.ok ? resolve(event.data.result) : reject(new Error(event.data.error)); };
        worker.onerror = event => { worker.terminate(); reject(new Error(event.message || "Worker failed")); };
        worker.postMessage({ files });
      });
    }
    return new Promise(resolve => setTimeout(() => resolve(window.LMStudioLogParser.parseFiles(files)), 20));
  }

  async function loadFiles(fileList) {
    stopWatching();
    const chosen = Array.from(fileList || []).filter(file => file && (file.name.endsWith(".log") || file.type.startsWith("text/") || !file.type));
    if (!chosen.length) return toast("Choose one or more text log files");
    state.loading = true;
    els.open.textContent = "Reading…"; els.open.disabled = true; els.welcomeOpen.disabled = true;
    try {
      const files = await Promise.all(chosen.map(async file => ({ name: file.name, text: await file.text() })));
      state.result = await runParser(files);
      rebuildExplorerIndex();
      state.selectedId = state.result.threads[0] && state.result.threads[0].calls.at(-1).id || null;
      state.query = ""; state.status = "all"; state.model = "all";
      els.search.value = ""; els.status.value = "all";
      populateModels(); render();
      toast("Parsed " + state.result.stats.calls + " requests from " + chosen.length + " file" + (chosen.length === 1 ? "" : "s"));
    } catch (error) {
      console.error(error); toast("Could not parse these logs: " + error.message);
    } finally {
      state.loading = false; els.open.textContent = "Open log files"; els.open.disabled = false; els.welcomeOpen.disabled = false;
    }
  }

  function populateModels() {
    const previous = state.model;
    const models = [...new Set(state.result.calls.map(call => call.model))].sort();
    els.model.innerHTML = '<option value="all">All models</option>' + models.map(model => '<option value="' + escapeHtml(model) + '">' + escapeHtml(model) + "</option>").join("");
    els.model.value = models.includes(previous) ? previous : "all";
  }

  function clearAll() {
    stopWatching();
    state.result = null; state.selectedId = null; els.input.value = "";
    state.explorer = { ...state.explorer, module: "tool-calls", scope: "conversation" };
    rebuildExplorerIndex();
    els.shell.classList.add("empty"); els.workspace.hidden = true; els.welcome.hidden = false; els.clear.disabled = true;
    els.detail.textContent = ""; els.list.textContent = "";
  }

  function setLiveStatus(status, detail) {
    els.liveStatus.textContent = detail || (status === "live" ? "Watching folder" : status === "paused" ? "Watch paused" : status === "error" ? "Watch error" : "Snapshot mode");
    els.liveStatus.className = "live-status " + status;
    els.stopWatch.disabled = !state.live;
  }

  function stopWatching() {
    if (state.live && state.live.source) state.live.source.stop();
    state.live = null;
    els.diagnostics.hidden = true;
    setLiveStatus("idle", "Snapshot mode");
  }

  function recordLiveDiagnostic(entry) {
    if (!state.live) return;
    const stamp = new Date().toLocaleTimeString();
    const file = entry.fileName ? " [" + entry.fileName + "]" : "";
    const line = "[" + stamp + "] " + (entry.kind || "info") + file + ": " + entry.message;
    state.live.diagnostics.push(line);
    state.live.diagnostics = state.live.diagnostics.slice(-100);
    els.diagnostics.hidden = false;
    els.diagnosticsOutput.textContent = state.live.diagnostics.join("\n");
    console.warn("LM Studio live watcher", entry);
  }

  function flushLiveUpdates() {
    if (!state.live) return;
    state.live.flushScheduled = false;
    const events = state.live.pendingEvents.splice(0);
    if (!events.length) return;
    const update = state.live.reducer.apply(events);
    state.result = update.result;
    rebuildExplorerIndex();
    if (!state.selectedId && state.result.calls[0]) state.selectedId = state.result.calls[0].id;
    populateModels();
    if (update.changes.addedCallIds.length) render();
    else { renderStats(); renderDetail(); }
  }

  function scheduleLiveFlush() {
    if (!state.live || state.live.flushScheduled) return;
    state.live.flushScheduled = true;
    const schedule = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame
      : callback => setTimeout(callback, 0);
    schedule(flushLiveUpdates);
  }

  function applyLiveText(chunk) {
    if (!state.live || state.live.fileName !== chunk.fileName) {
      if (state.live) state.live.parser = state.live.parsers.get(chunk.fileName) || window.LMStudioLogParser.createIncrementalParser(chunk.fileName);
      if (state.live) state.live.fileName = chunk.fileName;
    }
    if (!state.live.parser) return;
    state.live.parsers.set(chunk.fileName, state.live.parser);
    const parsed = state.live.parser.push(chunk.text);
    state.live.pendingEvents.push(...parsed.events);
    parsed.warnings.forEach(warning => recordLiveDiagnostic({ kind: "parse-warning", fileName: chunk.fileName, message: warning.message }));
    state.live.lastUpdate = Date.now();
    setLiveStatus("live", "Watching " + chunk.fileName + " · updated " + new Date(state.live.lastUpdate).toLocaleTimeString());
    scheduleLiveFlush();
  }

  async function startWatching() {
    stopWatching();
    if (!window.LMStudioLiveSource || !window.LMStudioLiveSource.openLogDirectoryHandle) return toast("Live folder watching is unavailable in this browser");
    let picked;
    try { picked = await window.LMStudioLiveSource.openLogDirectoryHandle(); }
    catch (error) { if (error && error.name === "AbortError") return; return toast("Could not open that folder: " + error.message); }
    if (!picked.supported) {
      if (picked.reason === "insecure-context") return toast("Live folder watching requires HTTPS or localhost; check the Live Server URL");
      return toast("This browser does not support live folder watching; use desktop Chrome or Edge");
    }
    state.result = { calls: [], threads: [], warnings: [], stats: { files: 1, calls: 0, matched: 0, incomplete: 0, uncertain: 0, threads: 0, promptTokens: 0, completionTokens: 0 } };
    rebuildExplorerIndex();
    state.selectedId = null; state.query = ""; state.status = "all"; state.model = "all";
    els.search.value = ""; els.status.value = "all";
    const live = { parser: null, parsers: new Map(), reducer: window.LMStudioLogParser.createLiveReducer("live-folder"), fileName: null, lastUpdate: null, diagnostics: [], pendingEvents: [], flushScheduled: false, source: null };
    live.source = new window.LMStudioLiveSource.DirectoryTailSource({
      directory: picked.directory,
      onText: applyLiveText,
      onStatus: status => setLiveStatus(status),
      onWarning: warning => { if (state.result) state.result.warnings.push(warning); recordLiveDiagnostic(warning); toast(warning.message); }
    });
    state.live = live;
    setLiveStatus("live");
    render();
    live.source.start();
  }

  function matches(call) {
    if (state.status !== "all" && call.status !== state.status) return false;
    if (state.model !== "all" && call.model !== state.model) return false;
    if (!state.query) return true;
    const haystack = [call.model, call.endpoint, call.sourceName, call.requestRaw, call.responseRaw].join("\n").toLowerCase();
    return haystack.includes(state.query);
  }

  function callTitle(call) {
    const user = call.messages.slice().reverse().find(message => message.role === "user");
    const text = user ? compact(user.content) : call.endpoint;
    return text || "Empty request";
  }

  function renderStats() {
    const s = state.result.stats;
    const items = [
      [s.calls, "requests", "accent"], [s.matched, "matched", "good"], [s.incomplete, "incomplete", "warn"],
      [s.threads, "threads", ""], [formatNumber(s.promptTokens + s.completionTokens), "tokens", ""]
    ];
    els.stats.innerHTML = items.map(([value, label, tone]) => '<div class="stat ' + tone + '"><strong>' + value + '</strong><span>' + label + "</span></div>").join("");
  }

  function renderList() {
    const visibleThreads = state.result.threads.map(thread => ({ ...thread, visible: thread.calls.filter(matches) })).filter(thread => thread.visible.length);
    if (!visibleThreads.length) {
      els.list.innerHTML = '<div class="empty-filter"><strong>No matching calls</strong><span>Try a wider search or filter.</span></div>';
      return;
    }
    els.list.innerHTML = visibleThreads.map((thread, threadIndex) => {
      const root = thread.calls[0];
      const calls = thread.visible.map((call, index) => {
        const active = call.id === state.selectedId ? " active" : "";
        const relation = call.predecessorId ? '<span class="turn-connector" aria-hidden="true"></span>' : "";
        return '<button class="call-item' + active + '" data-call-id="' + escapeHtml(call.id) + '" type="button">' + relation +
          '<span class="call-top"><span class="status-dot ' + call.status + '"></span><span>' + escapeHtml(formatTime(call)) + '</span><span class="message-count">' + call.messages.length + ' msg</span></span>' +
          '<strong>' + escapeHtml(callTitle(call)) + '</strong><span class="call-meta">' + escapeHtml(call.sourceName) + ' · ' + escapeHtml(formatDuration(call.durationMs)) + "</span></button>";
      }).join("");
      return '<section class="thread-group"><div class="thread-heading"><span>Thread ' + String(threadIndex + 1).padStart(2, "0") + '</span><span>' + thread.calls.length + ' call' + (thread.calls.length === 1 ? "" : "s") + '</span></div>' + calls + "</section>";
    }).join("");
    els.list.querySelectorAll("[data-call-id]").forEach(button => button.addEventListener("click", () => { state.selectedId = button.dataset.callId; renderList(); renderDetail(); }));
  }

  function detailBlock(label, value, options) {
    options = options || {};
    const text = contentText(value);
    if (!text && !options.showEmpty) return "";
    return '<details class="payload"' + (options.open ? " open" : "") + '><summary><span>' + escapeHtml(label) + '</span><span class="payload-info">' + formatNumber(text.length) + ' chars</span></summary><div class="payload-body"><button class="copy-button" type="button" data-copy="' + escapeHtml(options.copyKey || label) + '" aria-label="Copy ' + escapeHtml(label) + '">Copy</button><pre>' + escapeHtml(text || "(empty)") + "</pre></div></details>";
  }

  function renderInvocationBlock(toolCalls, records, copyPrefix, toolCopies) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return "";
    toolCalls.forEach((toolCall, index) => toolCopies.set(copyPrefix + ":" + index, toolCall));
    return window.LMStudioToolExplorerView.renderToolInvocations(toolCalls, records, copyPrefix);
  }

  function renderMessage(message, call, toolCopies) {
    const delta = call.delta || { added: [] };
    const isAdded = delta.added.includes(message.index);
    const text = contentText(message.content);
    const reasoning = contentText(message.reasoningContent);
    const preview = compact(message.content) || (reasoning ? "Reasoning: " + compact(message.reasoningContent) : "");
    const roleTone = ["system", "user", "assistant", "tool"].includes(message.role) ? message.role : "other";
    const reasoningBlock = reasoning
      ? '<div class="subpayload"><span>Reasoning</span><pre>' + escapeHtml(reasoning) + "</pre></div>"
      : "";
    const toolCallsBlock = Array.isArray(message.toolCalls) && message.toolCalls.length
      ? '<div class="subpayload"><span>Tool calls</span>' + renderInvocationBlock(message.toolCalls, recordsForTarget(call.id, "request", message.index), "request:" + call.id + ":" + message.index, toolCopies) + "</div>"
      : "";
    return '<details class="message-card ' + roleTone + (isAdded && call.predecessorId ? " added" : "") + '"' + (message.index === call.messages.length - 1 ? " open" : "") + '><summary><span class="role-badge">' + escapeHtml(message.role) + '</span><span class="message-preview">' + escapeHtml(preview.slice(0, 150) || "(empty content)") + '</span><span class="message-size">' + formatNumber(text.length) + ' chars</span></summary><div class="message-body"><button class="copy-button" data-copy-message="' + message.index + '" type="button">Copy</button><pre>' + escapeHtml(text || "(empty)") + "</pre>" + reasoningBlock + toolCallsBlock + "</div></details>";
  }

  function handleStaleExplorerTarget(record, direction) {
    const previousView = getExplorerView();
    const fallback = window.LMStudioToolExplorer.getStaleTargetFallback(previousView.matching, record.id, direction);
    state.explorer.records = invocationRecords().filter(item => item.id !== record.id);
    toast("That tool invocation is no longer available");
    if (fallback) {
      state.explorer.selectedType = fallback.name;
      state.explorer.selectedRecordId = fallback.id;
      return jumpToInvocation(fallback, direction);
    }
    const explorerView = getExplorerView();
    const typeFallback = explorerView.selectedType !== record.name
      ? explorerView.matching[explorerView.position] || null
      : null;
    if (typeFallback) return jumpToInvocation(typeFallback, direction);
    renderDetail();
  }

  function jumpToInvocation(record, direction) {
    if (!record) return;
    state.selectedId = record.target.callId;
    renderList();
    renderDetail();
    requestAnimationFrame(() => {
      const target = document.getElementById(record.target.domId);
      if (!window.LMStudioToolExplorer.isInvocationTargetForRecord(target, record)) return handleStaleExplorerTarget(record, direction);
      const details = target.closest("details");
      if (details) details.open = true;
      const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
      target.focus({ preventScroll: true });
      target.classList.add("tool-jump-highlight");
      setTimeout(() => target.classList.remove("tool-jump-highlight"), 1400);
    });
  }

  function wireExplorerControls() {
    const toggle = els.detail.querySelector("[data-explorer-toggle]");
    if (toggle) toggle.addEventListener("click", () => {
      state.explorer.open = !state.explorer.open;
      renderDetail();
      window.LMStudioToolExplorerView.restoreExplorerControlFocus(els.detail, { kind: "toggle" });
    });
    els.detail.querySelectorAll("[data-explorer-scope]").forEach(button => button.addEventListener("click", () => {
      state.explorer.scope = button.dataset.explorerScope;
      renderDetail();
      window.LMStudioToolExplorerView.restoreExplorerControlFocus(els.detail, { kind: "scope", value: state.explorer.scope });
    }));
    els.detail.querySelectorAll("[data-explorer-type]").forEach(button => button.addEventListener("click", () => {
      state.explorer.selectedType = button.dataset.explorerType;
      state.explorer.selectedRecordId = null;
      state.explorer.position = 0;
      const explorerView = getExplorerView();
      jumpToInvocation(explorerView.matching[0], 1);
    }));
    const previous = els.detail.querySelector("[data-explorer-previous]");
    if (previous) previous.addEventListener("click", () => {
      const explorerView = getExplorerView();
      if (explorerView.position <= 0) return;
      const position = explorerView.position - 1;
      state.explorer.position = position;
      state.explorer.selectedRecordId = explorerView.matching[position].id;
      jumpToInvocation(explorerView.matching[position], -1);
    });
    const next = els.detail.querySelector("[data-explorer-next]");
    if (next) next.addEventListener("click", () => {
      const explorerView = getExplorerView();
      if (explorerView.position >= explorerView.matching.length - 1) return;
      const position = explorerView.position + 1;
      state.explorer.position = position;
      state.explorer.selectedRecordId = explorerView.matching[position].id;
      jumpToInvocation(explorerView.matching[position], 1);
    });
  }

  function renderDetail() {
    const call = state.result.calls.find(item => item.id === state.selectedId) || state.result.calls[0];
    if (call) state.selectedId = call.id;
    const explorerTray = window.LMStudioToolExplorerView.renderExplorerTray(getExplorerView());
    if (!call) {
      els.detail.innerHTML = explorerTray + '<div class="detail-empty">No request selected.</div>';
      wireExplorerControls();
      return;
    }
    const output = call.outputMessage || {};
    const toolCopies = new Map();
    const delta = call.delta || { retained: 0, removed: [], added: [] };
    const responseMeta = call.stream ? ((call.finishReason ? call.finishReason + " · " : "") + call.streamPackets.length + " packets") : (call.finishReason || statusLabel(call.status));
    const streamNote = call.stream && !call.streamComplete ? '<p class="stream-note">Partial stream: logging ended before the terminal packet.</p>' : "";
    const streamPacketsBlock = call.stream ? detailBlock("Stream packets (" + call.streamPackets.length + ")", call.streamPackets, { copyKey: "stream-packets" }) : "";
    const ancestry = call.predecessorId ? '<div class="ancestry"><span>Conversation continuation · ' + escapeHtml(call.threadConfidence) + ' confidence</span><span>' + delta.retained + ' retained</span><span class="plus">+' + delta.added.length + ' added</span><span class="minus">−' + delta.removed.length + ' removed</span></div>' : '<div class="ancestry root"><span>Conversation root</span><span>' + call.messages.length + " initial messages</span></div>";
    els.detail.innerHTML = explorerTray +
      '<header class="detail-head"><div><div class="detail-kicker"><span class="status-pill ' + call.status + '">' + statusLabel(call.status) + '</span><span>' + escapeHtml(call.timestampRaw) + '</span></div><h2>' + escapeHtml(call.model) + '</h2><p>' + escapeHtml(call.endpoint) + ' · ' + escapeHtml(call.sourceName) + ':' + call.lineStart + '</p></div><div class="duration"><span>Round trip</span><strong>' + escapeHtml(formatDuration(call.durationMs)) + "</strong></div></header>" +
      ancestry +
      '<section class="section"><div class="section-title"><div><span>01</span><h3>Request messages</h3></div><small>' + call.messages.length + ' total</small></div><div class="messages">' + call.messages.map(message => renderMessage(message, call, toolCopies)).join("") + "</div></section>" +
      '<section class="section response-section"><div class="section-title"><div><span>02</span><h3>Response</h3></div><small>' + escapeHtml(responseMeta) + "</small></div>" +
      (call.response ? '<div class="response-grid">' + detailBlock("Content", output.content, { open: true, showEmpty: true, copyKey: "response-content" }) + detailBlock("Reasoning", output.reasoning_content, { open: !!output.reasoning_content, copyKey: "response-reasoning" }) + (Array.isArray(output.tool_calls) && output.tool_calls.length ? '<details class="payload" open><summary><span>Tool calls</span><span class="payload-info">' + output.tool_calls.length + ' invocation' + (output.tool_calls.length === 1 ? "" : "s") + '</span></summary>' + renderInvocationBlock(output.tool_calls, recordsForTarget(call.id, "response", null), "response:" + call.id, toolCopies) + "</details>" : "") + '</div>' + streamNote + '<div class="usage-row"><span>Prompt <strong>' + formatNumber(call.usage && call.usage.prompt_tokens) + '</strong></span><span>Completion <strong>' + formatNumber(call.usage && call.usage.completion_tokens) + '</strong></span><span>Total <strong>' + formatNumber(call.usage && call.usage.total_tokens) + "</strong></span></div>" : '<div class="incomplete-panel"><strong>No prediction was recorded.</strong><p>The request may have been rejected, cancelled, interrupted, or still pending when logging stopped.</p></div>') + "</section>" +
      '<section class="section"><div class="section-title"><div><span>03</span><h3>Evidence</h3></div><small>Original log data</small></div>' + detailBlock("Request JSON", call.request, { copyKey: "request-json" }) + detailBlock("Response JSON", call.response, { copyKey: "response-json" }) + streamPacketsBlock + detailBlock("Linked raw context · lines " + call.rawContext.from + "–" + call.rawContext.to, call.rawContext.text, { copyKey: "raw-context" }) + "</section>";

    wireExplorerControls();
    els.detail.querySelectorAll("[data-copy-message]").forEach(button => button.addEventListener("click", event => { event.preventDefault(); copyText(contentText(call.messages[Number(button.dataset.copyMessage)].content)); }));
    const copyMap = { "response-content": output.content, "response-reasoning": output.reasoning_content, "request-json": call.request, "response-json": call.response, "stream-packets": call.streamPackets, "raw-context": call.rawContext.text };
    els.detail.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", event => { event.preventDefault(); copyText(contentText(copyMap[button.dataset.copy])); }));
    els.detail.querySelectorAll("[data-copy-tool]").forEach(button => button.addEventListener("click", event => { event.preventDefault(); copyText(contentText(toolCopies.get(button.dataset.copyTool))); }));
  }

  function render() {
    if (!state.result) return clearAll();
    els.shell.classList.remove("empty"); els.welcome.hidden = true; els.workspace.hidden = false; els.clear.disabled = false;
    renderStats(); renderList(); renderDetail();
  }

  [els.open, els.welcomeOpen].forEach(button => button.addEventListener("click", () => els.input.click()));
  els.watch.addEventListener("click", startWatching);
  els.stopWatch.addEventListener("click", stopWatching);
  els.input.addEventListener("change", () => loadFiles(els.input.files));
  els.clear.addEventListener("click", clearAll);
  els.search.addEventListener("input", () => { state.query = els.search.value.trim().toLowerCase(); renderList(); });
  els.status.addEventListener("change", () => { state.status = els.status.value; renderList(); });
  els.model.addEventListener("change", () => { state.model = els.model.value; renderList(); });
  ["dragenter", "dragover"].forEach(type => document.addEventListener(type, event => { event.preventDefault(); els.shell.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach(type => document.addEventListener(type, event => { event.preventDefault(); els.shell.classList.remove("dragging"); }));
  document.addEventListener("drop", event => loadFiles(event.dataTransfer.files));
  window.addEventListener("beforeunload", stopWatching);
})();
