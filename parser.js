(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LMStudioLogParser = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const REQUEST_MARKER = "Received request:";
  const RESPONSE_MARKER = "Generated prediction:";
  const STREAM_PACKET_MARKER = "Generated packet:";
  const STREAM_FINISHED_MARKER = "Finished streaming response";
  const RUN_RE = /^\[([^\]]+)\]\[INFO\]\[([^\]]+)\] Running chat completion on conversation with (\d+) messages\./;
  const HEADER_RE = /^\[([^\]]+)\]\[([A-Z]+)\](?:\[([^\]]+)\])?\s?(.*)$/;

  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
  }

  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function parseTimestamp(raw) {
    const normalized = raw.replace(" ", "T");
    const value = Date.parse(normalized);
    return Number.isNaN(value) ? null : value;
  }

  function scanJson(lines, startLine, braceColumn) {
    let depth = 0, inString = false, escaped = false, started = false, text = "";
    for (let lineIndex = startLine; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const from = lineIndex === startLine ? braceColumn : 0;
      for (let column = from; column < line.length; column++) {
        const ch = line[column];
        text += ch;
        if (!started) {
          if (ch !== "{") continue;
          started = true;
          depth = 1;
          continue;
        }
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') inString = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) return { text, endLine: lineIndex, complete: true };
        }
      }
      text += "\n";
    }
    return { text, endLine: lines.length - 1, complete: false };
  }

  function eventFromMarker(lines, lineIndex, marker, kind, source) {
    const line = lines[lineIndex];
    const markerIndex = line.indexOf(marker);
    if (markerIndex < 0) return null;
    const braceColumn = line.indexOf("{", markerIndex + marker.length);
    if (braceColumn < 0) return null;
    const scanned = scanJson(lines, lineIndex, braceColumn);
    let data = null, error = null;
    try { data = JSON.parse(scanned.text); }
    catch (e) { error = scanned.complete ? e.message : "JSON record is truncated"; }
    const header = HEADER_RE.exec(line);
    return {
      id: kind + "-" + source.index + "-" + (lineIndex + 1), kind, data, error,
      sourceName: source.name, sourceIndex: source.index,
      markerLine: line,
      lineStart: lineIndex + 1, lineEnd: scanned.endLine + 1,
      timestampRaw: header ? header[1] : "", timestamp: header ? parseTimestamp(header[1]) : null,
      raw: scanned.text, complete: scanned.complete
    };
  }

  function normalizeMessage(message, index) {
    const normalized = {
      index, role: message && message.role || "unknown",
      name: message && message.name || null,
      content: message && Object.prototype.hasOwnProperty.call(message, "content") ? message.content : null,
      toolCallId: message && message.tool_call_id || null,
      toolCalls: message && message.tool_calls || null,
      raw: message || {}
    };
    normalized.fingerprint = hash(stableStringify({ role: normalized.role, name: normalized.name, content: normalized.content, toolCallId: normalized.toolCallId, toolCalls: normalized.toolCalls }));
    return normalized;
  }

  function appendStringField(target, field, value) {
    if (typeof value !== "string" || !value) return;
    target[field] = (target[field] || "") + value;
  }

  function aggregateStream(group) {
    const message = {};
    let finishReason = null;
    let usage = null;
    for (const packet of group.packets) {
      const choice = packet && Array.isArray(packet.choices) ? packet.choices[0] : null;
      const delta = choice && choice.delta || null;
      if (delta) {
        if (delta.role && !message.role) message.role = delta.role;
        appendStringField(message, "content", delta.content);
        appendStringField(message, "reasoning_content", delta.reasoning_content);
      }
      if (choice && choice.finish_reason != null) finishReason = choice.finish_reason;
      if (packet && packet.usage) usage = packet.usage;
    }
    if (!message.role) message.role = "assistant";
    const response = {
      id: group.id || null,
      object: "chat.completion",
      model: group.model || null,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage
    };
    return { response, outputMessage: message, finishReason, usage };
  }

  function contextFor(lines, start, end, radius) {
    const from = Math.max(0, start - 1 - radius);
    const to = Math.min(lines.length, end + radius);
    return { from: from + 1, to, text: lines.slice(from, to).join("\n") };
  }

  function isStreamRequest(request) {
    return Boolean(request && request.data && request.data.stream === true);
  }

  function parseSource(source) {
    const lines = source.text.replace(/^\uFEFF/, "").split(/\r?\n/);
    const requests = [], responses = [], runs = [], streamPackets = [], streamFinished = [], warnings = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(REQUEST_MARKER)) {
        const event = eventFromMarker(lines, i, REQUEST_MARKER, "request", source);
        if (event) {
          requests.push(event);
          if (event.error) warnings.push({ sourceName: source.name, line: event.lineStart, message: event.error });
          i = event.lineEnd - 1;
        }
      } else if (line.includes(RESPONSE_MARKER)) {
        const event = eventFromMarker(lines, i, RESPONSE_MARKER, "response", source);
        if (event) {
          responses.push(event);
          if (event.error) warnings.push({ sourceName: source.name, line: event.lineStart, message: event.error });
          i = event.lineEnd - 1;
        }
      } else if (line.includes(STREAM_PACKET_MARKER)) {
        const event = eventFromMarker(lines, i, STREAM_PACKET_MARKER, "stream-packet", source);
        if (event) {
          streamPackets.push(event);
          if (event.error) warnings.push({ sourceName: source.name, line: event.lineStart, message: event.error });
          i = event.lineEnd - 1;
        }
      } else if (line.includes(STREAM_FINISHED_MARKER)) {
        const header = HEADER_RE.exec(line);
        if (header) streamFinished.push({
          line: i + 1,
          timestampRaw: header[1],
          timestamp: parseTimestamp(header[1]),
          model: header[3] || null
        });
      } else {
        const run = RUN_RE.exec(line);
        if (run) runs.push({ line: i + 1, timestampRaw: run[1], timestamp: parseTimestamp(run[1]), model: run[2], messageCount: Number(run[3]) });
      }
    }

    const streamGroups = [];
    const streamGroupsById = new Map();
    for (const packetEvent of streamPackets) {
      const packet = packetEvent.data || {};
      const id = packet.id || packetEvent.id;
      let group = streamGroupsById.get(id);
      if (!group) {
        group = {
          id,
          model: packet.model || null,
          packets: [],
          packetEvents: [],
          lineStart: packetEvent.lineStart,
          lineEnd: packetEvent.lineEnd,
          timestampRaw: packetEvent.timestampRaw,
          timestamp: packetEvent.timestamp,
          latestTimestampRaw: packetEvent.timestampRaw,
          latestTimestamp: packetEvent.timestamp,
          finished: null,
          complete: false
        };
        streamGroupsById.set(id, group);
        streamGroups.push(group);
      }
      group.model = group.model || packet.model || null;
      group.packets.push(packet);
      group.packetEvents.push(packetEvent);
      group.lineEnd = packetEvent.lineEnd;
      group.latestTimestampRaw = packetEvent.timestampRaw;
      group.latestTimestamp = packetEvent.timestamp;
      const choice = Array.isArray(packet.choices) ? packet.choices[0] : null;
      const usageOnlyTerminal = Boolean(packet.usage) && Array.isArray(packet.choices) && packet.choices.length === 0;
      if (choice && choice.finish_reason != null) group.complete = true;
      if (usageOnlyTerminal) group.complete = true;
    }

    for (const finished of streamFinished) {
      const candidates = streamGroups.filter(group =>
        !group.finished &&
        group.lineEnd < finished.line &&
        (!finished.model || !group.model || group.model === finished.model)
      );
      if (candidates.length) {
        const group = candidates[candidates.length - 1];
        group.finished = finished;
      }
    }

    for (const group of streamGroups) {
      const aggregate = aggregateStream(group);
      responses.push({
        id: "stream-response-" + source.index + "-" + group.id,
        kind: "response",
        data: aggregate.response,
        error: group.packetEvents.find(event => event.error)?.error || null,
        sourceName: source.name,
        sourceIndex: source.index,
        markerLine: group.packetEvents[0] ? group.packetEvents[0].markerLine : "",
        lineStart: group.lineStart,
        lineEnd: group.finished ? group.finished.line : group.lineEnd,
        timestampRaw: group.finished ? group.finished.timestampRaw : group.latestTimestampRaw,
        timestamp: group.finished ? group.finished.timestamp : group.latestTimestamp,
        raw: group.packetEvents.map(event => event.raw).join("\n"),
        complete: Boolean(group.complete || group.finished),
        stream: {
          id: group.id,
          packets: group.packets,
          packetEvents: group.packetEvents,
          finished: group.finished,
          aggregate,
          complete: Boolean(group.complete),
          hasFinishedMarker: Boolean(group.finished)
        }
      });
    }
    responses.sort((a, b) => (a.lineStart - b.lineStart) || (a.sourceIndex - b.sourceIndex) || (a.timestamp ?? 0) - (b.timestamp ?? 0));

    // A run marker appears after the complete request body. Associate it with the
    // nearest preceding request that has not already started; this correctly leaves
    // requests rejected before inference unmatched.
    for (const run of runs) {
      const candidates = requests.filter(r => !r.run && r.lineEnd < run.line && (!r.data || !r.data.model || r.data.model === run.model));
      if (candidates.length) candidates[candidates.length - 1].run = run;
    }

    const pendingStarted = requests.filter(r => r.run).sort((a, b) => a.run.line - b.run.line);
    const fallbackPending = requests.filter(r => !r.run);
    for (const response of responses) {
      const isStreamResponse = Boolean(response.stream);
      const baseStarted = pendingStarted.filter(r =>
        !r.response &&
        r.lineStart < response.lineStart &&
        (!response.data || !response.data.model || !r.data.model || r.data.model === response.data.model)
      );
      const preferredStarted = baseStarted.filter(r => isStreamResponse ? isStreamRequest(r) : !isStreamRequest(r));
      let request = (preferredStarted.length ? preferredStarted : baseStarted).at(-1) || null;
      let method = "lifecycle", confidence = "high";
      if (!request) {
        const baseFallback = fallbackPending.filter(r =>
          !r.response &&
          r.lineStart < response.lineStart &&
          (!response.data || !response.data.model || !r.data.model || r.data.model === response.data.model)
        );
        const preferredFallback = baseFallback.filter(r => isStreamResponse ? isStreamRequest(r) : !isStreamRequest(r));
        request = (preferredFallback.length ? preferredFallback : baseFallback).at(-1) || null;
        method = "chronological"; confidence = "uncertain";
      }
      if (request) { request.response = response; request.matchMethod = method; request.matchConfidence = confidence; }
      else warnings.push({ sourceName: source.name, line: response.lineStart, message: "Response has no preceding request" });
    }

    const calls = requests.map((request, index) => {
      const body = request.data || {};
      const response = request.response || null;
      const messages = Array.isArray(body.messages) ? body.messages.map(normalizeMessage) : [];
      const responseBody = response && response.data;
      const choice = responseBody && Array.isArray(responseBody.choices) ? responseBody.choices[0] : null;
      const streamInfo = response && response.stream || null;
      const streamComplete = streamInfo ? Boolean(streamInfo.complete || streamInfo.hasFinishedMarker) : false;
      const status = !response ? "incomplete" : streamInfo && !streamComplete ? "incomplete" : request.matchConfidence === "uncertain" ? "uncertain" : "matched";
      const endTime = response && response.timestamp;
      return {
        id: "call-" + source.index + "-" + (index + 1), sourceName: source.name, sourceIndex: source.index,
        endpoint: ((request.markerLine.match(/Received request:\s*(.+?)\s+with body\s+\{/) || [])[1] || "POST to /v1/chat/completions").trim(),
        timestamp: request.timestamp, timestampRaw: request.timestampRaw, lineStart: request.lineStart,
        model: body.model || (responseBody && responseBody.model) || "Unknown model", stream: body.stream === true,
        request: body, requestRaw: request.raw, messages, response: responseBody,
        responseRaw: response ? response.raw : null, responseLineStart: response ? response.lineStart : null,
        outputMessage: choice && choice.message || null, finishReason: choice && choice.finish_reason || null,
        usage: responseBody && responseBody.usage || null, status,
        streamPackets: streamInfo ? streamInfo.packets : [],
        streamComplete,
        matchMethod: request.matchMethod || null, matchConfidence: request.matchConfidence || null,
        durationMs: request.timestamp != null && endTime != null ? Math.max(0, endTime - request.timestamp) : null,
        rawContext: contextFor(lines, request.lineStart, response ? response.lineEnd : request.lineEnd, 12),
        parseError: request.error || (response && response.error) || null
      };
    });
    return { calls, warnings, lineCount: lines.length, source: { name: source.name, size: source.text.length, index: source.index } };
  }

  function lcsPairs(a, b) {
    const rows = a.length + 1, cols = b.length + 1;
    const table = Array.from({ length: rows }, () => new Uint16Array(cols));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
      table[i][j] = a[i].fingerprint === b[j].fingerprint ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    const pairs = []; let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i].fingerprint === b[j].fingerprint) { pairs.push([i++, j++]); }
      else if (table[i + 1][j] >= table[i][j + 1]) i++; else j++;
    }
    return pairs;
  }

  function sameConversationIdentity(previous, current) {
    const previousSystem = previous.messages.find(message => message.role === "system") || null;
    const currentSystem = current.messages.find(message => message.role === "system") || null;
    const previousUser = previous.messages.find(message => message.role === "user") || null;
    const currentUser = current.messages.find(message => message.role === "user") || null;
    if (!previousUser || !currentUser || previousUser.fingerprint !== currentUser.fingerprint) return false;
    if (!previousSystem && !currentSystem) return true;
    return Boolean(previousSystem && currentSystem && previousSystem.fingerprint === currentSystem.fingerprint);
  }

  function buildThreads(calls) {
    const ordered = calls.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.sourceIndex - b.sourceIndex || a.lineStart - b.lineStart);
    const byId = new Map(ordered.map(c => [c.id, c]));
    for (let i = 0; i < ordered.length; i++) {
      const current = ordered[i];
      let best = null;
      for (let j = 0; j < i; j++) {
        const previous = ordered[j];
        if (previous.model !== current.model || previous.endpoint !== current.endpoint || !previous.messages.length || !current.messages.length) continue;
        if (!sameConversationIdentity(previous, current)) continue;
        const pairs = lcsPairs(previous.messages, current.messages);
        const shared = pairs.length;
        const score = shared / Math.max(previous.messages.length, current.messages.length);
        // Exact initial system/user identity is the thread boundary. Overlap is
        // only used to choose the most plausible parent within that thread.
        const hasSystem = previous.messages.some(message => message.role === "system");
        const eligible = shared >= (hasSystem ? 2 : 1);
        if (eligible && (!best || score > best.score || (score === best.score && j > best.order))) best = { previous, pairs, score, order: j };
      }
      if (best) {
        current.predecessorId = best.previous.id;
        current.threadConfidence = best.score >= 0.8 ? "high" : "medium";
        const oldKept = new Set(best.pairs.map(p => p[0])), newKept = new Set(best.pairs.map(p => p[1]));
        current.delta = {
          retained: best.pairs.length,
          removed: best.previous.messages.filter((_, n) => !oldKept.has(n)).map(m => m.index),
          added: current.messages.filter((_, n) => !newKept.has(n)).map(m => m.index)
        };
      } else current.delta = { retained: 0, removed: [], added: current.messages.map(m => m.index) };
    }
    const roots = new Map();
    function rootId(call) { let cur = call, seen = new Set(); while (cur.predecessorId && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.predecessorId) || cur; } return cur.id; }
    for (const call of ordered) {
      const id = rootId(call);
      if (!roots.has(id)) roots.set(id, { id: "thread-" + id, rootId: id, calls: [] });
      roots.get(id).calls.push(call);
    }
    return Array.from(roots.values()).sort((a, b) => (b.calls.at(-1).timestamp ?? 0) - (a.calls.at(-1).timestamp ?? 0));
  }

  function parseFiles(files) {
    const parsed = files.map((file, index) => parseSource({ name: file.name || "log-" + (index + 1), text: file.text || "", index }));
    const calls = parsed.flatMap(p => p.calls);
    const threads = buildThreads(calls);
    return {
      calls, threads, warnings: parsed.flatMap(p => p.warnings), sources: parsed.map(p => p.source),
      stats: {
        files: parsed.length, calls: calls.length,
        matched: calls.filter(c => c.status === "matched").length,
        incomplete: calls.filter(c => c.status === "incomplete").length,
        uncertain: calls.filter(c => c.status === "uncertain").length,
        threads: threads.length,
        promptTokens: calls.reduce((n, c) => n + (c.usage && c.usage.prompt_tokens || 0), 0),
        completionTokens: calls.reduce((n, c) => n + (c.usage && c.usage.completion_tokens || 0), 0)
      }
    };
  }

  return { parseFiles, parseSource, buildThreads, stableStringify, lcsPairs, sameConversationIdentity };
});
