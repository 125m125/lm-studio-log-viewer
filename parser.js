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
  const MINILOG_PROMPT_RE = /^\[(\d+(?:\.\d+)?)\]\s+Prompt:\s*$/;
  const MINILOG_TOKEN_RE = /^\[(\d+(?:\.\d+)?)\]\s+token:(.*)$/;
  const MINILOG_STALE_MS = 5 * 60 * 1000;
  const RUN_RE =
    /^\[([^\]]+)\]\[INFO\]\[([^\]]+)\] Running chat completion on conversation with (\d+) messages\./;
  const HEADER_RE = /^\[([^\]]+)\]\[([A-Z]+)\](?:\[([^\]]+)\])?\s?(.*)$/;

  function stableStringify(value) {
    if (value === null || typeof value !== "object")
      return JSON.stringify(value);
    if (Array.isArray(value))
      return "[" + value.map(stableStringify).join(",") + "]";
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
        .join(",") +
      "}"
    );
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

  function parseUnixTimestamp(raw) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  function getParserNow(options) {
    if (options && typeof options.now === "function") return options.now();
    if (options && Number.isFinite(options.now)) return options.now;
    return Date.now();
  }

  function scanJson(lines, startLine, braceColumn) {
    let depth = 0,
      inString = false,
      escaped = false,
      started = false,
      text = "";
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
    let data = null,
      error = null;
    try {
      data = JSON.parse(scanned.text);
    } catch (e) {
      error = scanned.complete ? e.message : "JSON record is truncated";
    }
    const header = HEADER_RE.exec(line);
    return {
      id: kind + "-" + source.index + "-" + (lineIndex + 1),
      kind,
      data,
      error,
      sourceName: source.name,
      sourceIndex: source.index,
      markerLine: line,
      lineStart: lineIndex + 1,
      lineEnd: scanned.endLine + 1,
      timestampRaw: header ? header[1] : "",
      timestamp: header ? parseTimestamp(header[1]) : null,
      raw: scanned.text,
      complete: scanned.complete,
    };
  }

  function normalizeMessage(message, index) {
    const normalized = {
      index,
      role: (message && message.role) || "unknown",
      name: (message && message.name) || null,
      content:
        message && Object.prototype.hasOwnProperty.call(message, "content")
          ? message.content
          : null,
      reasoningContent:
        message &&
        Object.prototype.hasOwnProperty.call(message, "reasoning_content")
          ? message.reasoning_content
          : null,
      toolCallId: (message && message.tool_call_id) || null,
      toolCalls: (message && message.tool_calls) || null,
      raw: message || {},
    };
    normalized.fingerprint = hash(
      stableStringify({
        role: normalized.role,
        name: normalized.name,
        content: normalized.content,
        reasoningContent: normalized.reasoningContent,
        toolCallId: normalized.toolCallId,
        toolCalls: normalized.toolCalls,
      }),
    );
    return normalized;
  }

  function appendStringField(target, field, value) {
    if (typeof value !== "string" || !value) return;
    target[field] = (target[field] || "") + value;
  }

  function appendToolCallFragments(target, fragments) {
    for (const fragment of Array.isArray(fragments) ? fragments : []) {
      const index = Number.isInteger(fragment.index)
        ? fragment.index
        : target.length;
      const call = target[index] || { index, function: {} };
      if (fragment.id != null) call.id = (call.id || "") + fragment.id;
      if (fragment.type != null) call.type = fragment.type;
      const fn = fragment.function || {};
      if (fn.name != null)
        call.function.name = (call.function.name || "") + fn.name;
      if (fn.arguments != null)
        call.function.arguments =
          (call.function.arguments || "") + fn.arguments;
      target[index] = call;
    }
  }

  function toStreamPacketView(packetEvent) {
    const packet = (packetEvent && packetEvent.data) || {};
    return {
      ...packet,
      data: packet,
      eventId: packetEvent.id,
      kind: packetEvent.kind,
      error: packetEvent.error,
      sourceName: packetEvent.sourceName,
      sourceIndex: packetEvent.sourceIndex,
      markerLine: packetEvent.markerLine,
      lineStart: packetEvent.lineStart,
      lineEnd: packetEvent.lineEnd,
      timestampRaw: packetEvent.timestampRaw,
      timestamp: packetEvent.timestamp,
      raw: packetEvent.raw,
      complete: packetEvent.complete,
    };
  }

  function aggregateStream(group) {
    const message = {};
    let finishReason = null;
    let usage = null;

    // Detect whether this stream uses the legacy OpenAI format (choices-based)
    // or the Anthropic messages API format (type-based).
    const hasChoicesFormat = group.packets.some((p) =>
      Array.isArray(p.choices),
    );
    const hasMessagesFormat = group.packets.some(
      (p) => p.type === "message_start" || p.type === "content_block_start",
    );

    if (hasMessagesFormat && !hasChoicesFormat) {
      // Messages API format: accumulate text from content_block_delta / text_delta,
      // tool calls from content_block_start + input_json_delta, and stop_reason from message_delta.
      const textParts = [];
      const toolCalls = {}; // keyed by index

      for (const packet of group.packets) {
        if (packet.type === "message_start") {
          if (!message.role && packet.message && packet.message.role)
            message.role = packet.message.role;
          if (!group.model && packet.message && packet.message.model)
            group.model = packet.message.model;
        }
        if (packet.type === "content_block_start") {
          const idx = packet.index;
          if (
            packet.content_block &&
            packet.content_block.type === "tool_use"
          ) {
            toolCalls[idx] = {
              index: idx,
              type: "function",
              function: { name: "", arguments: "" },
            };
            if (packet.content_block.id)
              toolCalls[idx].id = packet.content_block.id;
          }
        }
        if (packet.type === "content_block_delta") {
          const delta = packet.delta || {};
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            textParts.push(delta.text);
          }
          if (delta.type === "input_json_delta" && delta.partial_json != null) {
            const idx = packet.index;
            const call = toolCalls[idx];
            if (call && call.function) {
              call.function.arguments += delta.partial_json;
            }
          }
        }
        if (packet.type === "message_delta" && packet.delta) {
          if (packet.delta.stop_reason != null)
            finishReason = packet.delta.stop_reason;
          if (packet.usage) usage = packet.usage;
        }
      }

      message.content = textParts.join("");
      if (!message.role) message.role = "assistant";
      const toolCallArray =
        Object.keys(toolCalls).length > 0 ? Object.values(toolCalls) : null;
      if (toolCallArray) message.tool_calls = toolCallArray;
    } else {
      // Legacy OpenAI choices-based format.
      for (const packet of group.packets) {
        const choice =
          packet && Array.isArray(packet.choices) ? packet.choices[0] : null;
        const delta = (choice && choice.delta) || null;
        if (delta) {
          if (delta.role && !message.role) message.role = delta.role;
          appendStringField(message, "content", delta.content);
          appendStringField(
            message,
            "reasoning_content",
            delta.reasoning_content,
          );
          if (delta.tool_calls) {
            if (!Array.isArray(message.tool_calls)) message.tool_calls = [];
            appendToolCallFragments(message.tool_calls, delta.tool_calls);
          }
        }
        if (choice && choice.finish_reason != null)
          finishReason = choice.finish_reason;
        if (packet && packet.usage) usage = packet.usage;
      }
      if (!message.role) message.role = "assistant";
    }

    const response = {
      id: group.id || null,
      object: "chat.completion",
      model: group.model || null,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage,
    };
    return { response, outputMessage: message, finishReason, usage };
  }

  function minilogOutputMessage(text) {
    if (!text) return null;
    const endThinking = text.indexOf("</think>");
    const message = {
      role: "assistant",
      content: endThinking < 0 ? text : text.slice(endThinking + "</think>".length),
    };
    if (endThinking >= 0)
      message.reasoning_content = text.slice(0, endThinking);

    const toolCalls = [];
    const removals = [];
    const blockPattern = /<tool_call>\s*<function=([^>\s]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
    let block;
    while ((block = blockPattern.exec(message.content))) {
      const functionName = block[1];
      const body = block[2];
      const parameters = {};
      const parameterPattern = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;
      let cursor = 0;
      let parameter;
      let valid = true;
      while ((parameter = parameterPattern.exec(body))) {
        if (body.slice(cursor, parameter.index).trim()) {
          valid = false;
          break;
        }
        parameters[parameter[1]] = parameter[2];
        cursor = parameterPattern.lastIndex;
      }
      if (body.slice(cursor).trim()) valid = false;
      if (!valid) continue;
      toolCalls.push({
        index: toolCalls.length,
        type: "function",
        function: {
          name: functionName,
          arguments: JSON.stringify(parameters),
        },
      });
      removals.push([block.index, block.index + block[0].length]);
    }
    for (let index = removals.length - 1; index >= 0; index--) {
      const [start, end] = removals[index];
      message.content = message.content.slice(0, start) + message.content.slice(end);
    }
    if (toolCalls.length) message.tool_calls = toolCalls;
    return message;
  }

  function contextFor(lines, start, end, radius) {
    const from = Math.max(0, start - 1 - radius);
    const to = Math.min(lines.length, end + radius);
    return { from: from + 1, to, text: lines.slice(from, to).join("\n") };
  }

  function isStreamRequest(request) {
    const body = (request && request.data) || {};
    return body.stream === true;
  }

  function selectRequestCandidate(candidates, isStreamResponse) {
    if (!candidates.length) return null;
    return isStreamResponse ? candidates.at(-1) : candidates[0];
  }

  function parseMinilogSource(source, options) {
    const incremental = createIncrementalParser(source.name);
    const first = incremental.push(source.text.replace(/^\uFEFF/, ""));
    const last = incremental.finish();
    const events = [...first.events, ...last.events];
    const warnings = [...first.warnings, ...last.warnings];
    const groups = [];
    const byId = new Map();
    for (const event of events) {
      if (event.kind === "request") {
        const group = {
          request: event,
          tokens: [],
          latestTimestamp: event.timestamp,
          closed: false,
        };
        groups.push(group);
        byId.set(event.id, group);
      } else if (event.kind === "minilog-token") {
        const group = byId.get(event.correlationId);
        if (!group) continue;
        group.tokens.push(event);
        group.latestTimestamp = event.timestamp || group.latestTimestamp;
      }
    }
    const now = getParserNow(options);
    const calls = groups.map((group, index) => {
      const request = group.request;
      const body = request.payload || {};
      const tokens = group.tokens;
      const tokenText = tokens.map((token) => token.payload.text).join("");
      group.closed = index < groups.length - 1;
      const stale =
        Boolean(tokenText) &&
        group.latestTimestamp != null &&
        now - group.latestTimestamp >= MINILOG_STALE_MS;
      const complete = Boolean(tokenText) && (group.closed || stale);
      const outputMessage = minilogOutputMessage(tokenText);
      const response = outputMessage
        ? {
            id: "minilog-response-" + request.id,
            object: "chat.completion",
            model: body.model || null,
            choices: [
              { index: 0, message: outputMessage, finish_reason: null },
            ],
            usage: null,
          }
        : null;
      const responseRaw = tokens.map((token) => token.raw).join("\n") || null;
      const lineEnd = tokens.length
        ? tokens.at(-1).lineEnd
        : request.lineEnd;
      return {
        id: "call-" + source.index + "-" + (index + 1),
        sourceName: source.name,
        sourceIndex: source.index,
        endpoint: "POST to /v1/chat/completions",
        timestamp: request.timestamp,
        timestampRaw: request.timestampRaw,
        lineStart: request.lineStart,
        model: body.model || "Unknown model",
        stream: body.stream === true,
        request: body,
        requestRaw: request.raw,
        messages: Array.isArray(body.messages)
          ? body.messages.map(normalizeMessage)
          : [],
        response,
        responseRaw,
        responseLineStart: tokens.length ? tokens[0].lineStart : null,
        outputMessage,
        finishReason: null,
        usage: null,
        status: complete ? "matched" : "incomplete",
        streamPackets: [],
        streamComplete: complete,
        matchMethod: "minilog-boundary",
        matchConfidence: "high",
        durationMs:
          request.timestamp != null && group.latestTimestamp != null
            ? Math.max(0, group.latestTimestamp - request.timestamp)
            : null,
        rawContext: {
          from: request.lineStart,
          to: lineEnd,
          text: [request.raw, responseRaw].filter(Boolean).join("\n"),
        },
        parseError: null,
      };
    });
    return {
      calls,
      warnings,
      lineCount: source.text.split(/\r?\n/).length,
      source: { name: source.name, size: source.text.length, index: source.index },
      events: {
        requests: [],
        responses: [],
        streamPackets: [],
        streamFinished: [],
        runs: [],
        minilog: events,
      },
    };
  }

  function parseSource(source, options) {
    const lines = source.text.replace(/^\uFEFF/, "").split(/\r?\n/);
    if (lines.some((line) => MINILOG_PROMPT_RE.test(line)))
      return parseMinilogSource(source, options);
    const requests = [],
      responses = [],
      runs = [],
      streamPackets = [],
      streamFinished = [],
      warnings = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(REQUEST_MARKER)) {
        const event = eventFromMarker(
          lines,
          i,
          REQUEST_MARKER,
          "request",
          source,
        );
        if (event) {
          requests.push(event);
          if (event.error)
            warnings.push({
              sourceName: source.name,
              line: event.lineStart,
              message: event.error,
            });
          i = event.lineEnd - 1;
        }
      } else if (line.includes(RESPONSE_MARKER)) {
        const event = eventFromMarker(
          lines,
          i,
          RESPONSE_MARKER,
          "response",
          source,
        );
        if (event) {
          responses.push(event);
          if (event.error)
            warnings.push({
              sourceName: source.name,
              line: event.lineStart,
              message: event.error,
            });
          i = event.lineEnd - 1;
        }
      } else if (line.includes(STREAM_PACKET_MARKER)) {
        const event = eventFromMarker(
          lines,
          i,
          STREAM_PACKET_MARKER,
          "stream-packet",
          source,
        );
        if (event) {
          streamPackets.push(event);
          if (event.error)
            warnings.push({
              sourceName: source.name,
              line: event.lineStart,
              message: event.error,
            });
          i = event.lineEnd - 1;
        }
      } else if (line.includes(STREAM_FINISHED_MARKER)) {
        const header = HEADER_RE.exec(line);
        if (header)
          streamFinished.push({
            rawLine: line,
            line: i + 1,
            timestampRaw: header[1],
            timestamp: parseTimestamp(header[1]),
            model: header[3] || null,
          });
      } else {
        const run = RUN_RE.exec(line);
        if (run)
          runs.push({
            rawLine: line,
            line: i + 1,
            timestampRaw: run[1],
            timestamp: parseTimestamp(run[1]),
            model: run[2],
            messageCount: Number(run[3]),
          });
      }
    }

    // Detect whether any packets use the messages API format (type-based).
    const hasMessagesFormatPackets = streamPackets.some((pe) => {
      const p = pe.data || {};
      return p.type === "message_start" || p.type === "content_block_start";
    });

    const streamGroups = [];
    const streamGroupsById = new Map();

    if (hasMessagesFormatPackets) {
      // Messages API format: packets lack a shared id. Group by looking for
      // message_start boundaries and collecting everything until the next
      // message_start or end of file.
      let currentGroup = null;
      for (const packetEvent of streamPackets) {
        const packet = packetEvent.data || {};

        if (packet.type === "message_start") {
          // Start a new group.
          currentGroup = {
            id: "msg-" + packetEvent.lineStart,
            model:
              packet.message && packet.message.model
                ? null
                : packet.model || null,
            packets: [],
            packetEvents: [],
            lineStart: packetEvent.lineStart,
            lineEnd: packetEvent.lineEnd,
            timestampRaw: packetEvent.timestampRaw,
            timestamp: packetEvent.timestamp,
            latestTimestampRaw: packetEvent.timestampRaw,
            latestTimestamp: packetEvent.timestamp,
            finished: null,
            complete: false,
          };
          streamGroups.push(currentGroup);
        } else if (currentGroup) {
          // Assign to the most recent group started by a message_start.
          currentGroup.model = currentGroup.model || packet.model || null;
        }

        const target = currentGroup || {
          id: "orphan-" + packetEvent.lineStart,
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
          complete: false,
        };

        if (target !== currentGroup) {
          streamGroups.push(target);
        }

        target.packets.push(packet);
        target.packetEvents.push(packetEvent);
        target.lineEnd = packetEvent.lineEnd;
        target.latestTimestampRaw = packetEvent.timestampRaw;
        target.latestTimestamp = packetEvent.timestamp;
        if (
          packet.type === "message_delta" &&
          packet.delta &&
          packet.delta.stop_reason != null
        ) {
          target.complete = true;
        }
      }
    } else {
      // Legacy OpenAI format: packets share an id across a stream.
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
            complete: false,
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
        if (choice && choice.finish_reason != null) group.complete = true;
      }
    }

    for (const finished of streamFinished) {
      const candidates = streamGroups.filter(
        (group) =>
          !group.finished &&
          group.lineEnd < finished.line &&
          (!finished.model || !group.model || group.model === finished.model),
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
        error: group.packetEvents.find((event) => event.error)?.error || null,
        sourceName: source.name,
        sourceIndex: source.index,
        markerLine: group.packetEvents[0]
          ? group.packetEvents[0].markerLine
          : "",
        lineStart: group.lineStart,
        lineEnd: group.finished ? group.finished.line : group.lineEnd,
        timestampRaw: group.finished
          ? group.finished.timestampRaw
          : group.latestTimestampRaw,
        timestamp: group.finished
          ? group.finished.timestamp
          : group.latestTimestamp,
        raw: group.packetEvents.map((event) => event.raw).join("\n"),
        complete: Boolean(group.complete || group.finished),
        stream: {
          id: group.id,
          packets: group.packets,
          packetEvents: group.packetEvents,
          finished: group.finished,
          aggregate,
          complete: Boolean(group.complete),
          hasFinishedMarker: Boolean(group.finished),
        },
      });
    }
    responses.sort(
      (a, b) =>
        a.lineStart - b.lineStart ||
        a.sourceIndex - b.sourceIndex ||
        (a.timestamp ?? 0) - (b.timestamp ?? 0),
    );

    // A run marker appears after the complete request body. Associate it with the
    // nearest preceding request that has not already started; this correctly leaves
    // requests rejected before inference unmatched.
    for (const run of runs) {
      const candidates = requests.filter(
        (r) =>
          !r.run &&
          r.lineEnd < run.line &&
          (!r.data || !r.data.model || r.data.model === run.model),
      );
      if (candidates.length) candidates[candidates.length - 1].run = run;
    }

    const pendingStarted = requests
      .filter((r) => r.run)
      .sort((a, b) => a.run.line - b.run.line);
    const fallbackPending = requests.filter((r) => !r.run);
    for (const response of responses) {
      const isStreamResponse = Boolean(response.stream);
      const baseStarted = pendingStarted.filter((r) => {
        const body = r.data || {};
        return (
          !r.response &&
          r.lineStart < response.lineStart &&
          (!response.data ||
            !response.data.model ||
            !body.model ||
            body.model === response.data.model)
        );
      });
      const preferredStarted = baseStarted.filter((r) =>
        isStreamResponse ? isStreamRequest(r) : !isStreamRequest(r),
      );
      let request = selectRequestCandidate(preferredStarted, isStreamResponse);
      if (!request && !isStreamResponse)
        request = selectRequestCandidate(baseStarted, false);
      let method = "lifecycle",
        confidence = "high";
      if (!request) {
        const baseFallback = fallbackPending.filter((r) => {
          const body = r.data || {};
          return (
            !r.response &&
            r.lineStart < response.lineStart &&
            (!response.data ||
              !response.data.model ||
              !body.model ||
              body.model === response.data.model)
          );
        });
        const preferredFallback = baseFallback.filter((r) =>
          isStreamResponse ? isStreamRequest(r) : !isStreamRequest(r),
        );
        request = selectRequestCandidate(preferredFallback, isStreamResponse);
        if (!request && !isStreamResponse)
          request = selectRequestCandidate(baseFallback, false);
        if (request) {
          method = "chronological";
          confidence = "uncertain";
        }
      }
      if (request) {
        request.response = response;
        request.matchMethod = method;
        request.matchConfidence = confidence;
      } else
        warnings.push({
          sourceName: source.name,
          line: response.lineStart,
          message: "Response has no preceding request",
        });
    }

    const calls = requests.map((request, index) => {
      const body = request.data || {};
      const response = request.response || null;
      const messages = Array.isArray(body.messages)
        ? body.messages.map(normalizeMessage)
        : [];
      const responseBody = response && response.data;
      const choice =
        responseBody && Array.isArray(responseBody.choices)
          ? responseBody.choices[0]
          : null;
      const streamInfo = (response && response.stream) || null;
      const streamComplete = streamInfo
        ? Boolean(streamInfo.complete || streamInfo.hasFinishedMarker)
        : false;
      const status = !response
        ? "incomplete"
        : streamInfo && !streamComplete
          ? "incomplete"
          : request.matchConfidence === "uncertain"
            ? "uncertain"
            : "matched";
      const endTime = response && response.timestamp;
      return {
        id: "call-" + source.index + "-" + (index + 1),
        sourceName: source.name,
        sourceIndex: source.index,
        endpoint: (
          (request.markerLine.match(
            /Received request:\s*(.+?)\s+with body\s+\{/,
          ) || [])[1] || "POST to /v1/chat/completions"
        ).trim(),
        timestamp: request.timestamp,
        timestampRaw: request.timestampRaw,
        lineStart: request.lineStart,
        model:
          body.model || (responseBody && responseBody.model) || "Unknown model",
        stream: body.stream === true,
        request: body,
        requestRaw: request.raw,
        messages,
        response: responseBody,
        responseRaw: response ? response.raw : null,
        responseLineStart: response ? response.lineStart : null,
        outputMessage: (choice && choice.message) || null,
        finishReason: (choice && choice.finish_reason) || null,
        usage: (responseBody && responseBody.usage) || null,
        status,
        streamPackets: streamInfo
          ? streamInfo.packetEvents.map(toStreamPacketView)
          : [],
        streamComplete,
        matchMethod: request.matchMethod || null,
        matchConfidence: request.matchConfidence || null,
        durationMs:
          request.timestamp != null && endTime != null
            ? Math.max(0, endTime - request.timestamp)
            : null,
        rawContext: contextFor(
          lines,
          request.lineStart,
          response ? response.lineEnd : request.lineEnd,
          12,
        ),
        parseError: request.error || (response && response.error) || null,
      };
    });
    return {
      calls,
      warnings,
      lineCount: lines.length,
      source: {
        name: source.name,
        size: source.text.length,
        index: source.index,
      },
      events: { requests, responses, streamPackets, streamFinished, runs },
    };
  }

  function normalizedLiveEvents(parsed, sourceId) {
    const events = [];
    const add = (event, kind, correlationId) => {
      if (!event || event.error || event.complete === false) return;
      events.push({
        id: event.id,
        sourceId,
        correlationId: correlationId || null,
        kind,
        timestamp: event.timestamp,
        timestampRaw: event.timestampRaw,
        lineStart: event.lineStart,
        lineEnd: event.lineEnd,
        payload: event.data,
        raw: event.raw,
        confidence: "inferred",
      });
    };
    for (const event of parsed.events.requests) add(event, "request");
    for (const event of parsed.events.runs)
      events.push({
        id: "run-" + sourceId + "-" + event.line,
        sourceId,
        correlationId: null,
        kind: "run",
        timestamp: event.timestamp,
        timestampRaw: event.timestampRaw,
        lineStart: event.line,
        lineEnd: event.line,
        payload: event,
        raw: event.rawLine,
        confidence: "inferred",
      });
    for (const event of parsed.events.responses) {
      if (event.stream) continue;
      add(event, "prediction");
    }
    let messagesStreamId = null;
    for (const event of parsed.events.streamPackets) {
      const packet = event.data || {};
      if (packet.type === "message_start")
        messagesStreamId = "messages-" + sourceId + "-" + event.lineStart;
      add(event, "packet", packet.id || messagesStreamId || null);
    }
    for (const event of parsed.events.streamFinished) {
      events.push({
        id: "finished-" + sourceId + "-" + event.line,
        sourceId,
        correlationId: null,
        kind: "finished",
        timestamp: event.timestamp,
        timestampRaw: event.timestampRaw,
        lineStart: event.line,
        lineEnd: event.line,
        payload: event,
        raw: event.rawLine,
        confidence: "inferred",
      });
    }
    return events.sort(
      (a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd,
    );
  }

  function createIncrementalParser(sourceId) {
    let buffer = "";
    let lineBase = 1;
    let finished = false;
    let activeMinilogId = null;
    let minilogSequence = 0;

    function lineCount(text) {
      return (text.match(/\n/g) || []).length;
    }

    function consume(length) {
      const consumed = buffer.slice(0, length);
      buffer = buffer.slice(length);
      lineBase += lineCount(consumed);
    }

    function liveEvent(kind, line, raw, data, lineEnd) {
      const header = HEADER_RE.exec(line);
      const event = {
        id: kind + "-" + sourceId + "-" + lineBase,
        sourceId,
        correlationId: null,
        kind,
        timestamp: header ? parseTimestamp(header[1]) : null,
        timestampRaw: header ? header[1] : "",
        lineStart: lineBase,
        lineEnd: lineBase + lineCount(raw),
        payload: data,
        raw,
        confidence: "inferred",
      };
      if (kind === "packet") {
        const packet = data || {};
        if (packet.type === "message_start")
          liveEvent.messagesStreamId = "messages-" + sourceId + "-" + lineBase;
        event.correlationId = packet.id || liveEvent.messagesStreamId || null;
      }
      return event;
    }

    function minilogEvent(kind, match, raw, payload, lineEnd) {
      const id =
        kind === "request"
          ? "minilog-request-" + sourceId + "-" + lineBase
          : "minilog-token-" + sourceId + "-" + lineBase + "-" + ++minilogSequence;
      return {
        id,
        sourceId,
        correlationId: kind === "request" ? id : activeMinilogId,
        kind,
        format: "minilog",
        timestamp: parseUnixTimestamp(match[1]),
        timestampRaw: match[1],
        lineStart: lineBase,
        lineEnd,
        payload,
        raw,
        confidence: "inferred",
      };
    }

    function process(final) {
      const events = [];
      const warnings = [];
      while (buffer) {
        const newline = buffer.indexOf("\n");
        const firstLine = (newline < 0 ? buffer : buffer.slice(0, newline)).replace(/\r$/, "");
        const minilogPrompt = MINILOG_PROMPT_RE.exec(firstLine);
        if (minilogPrompt) {
          if (newline < 0) {
            if (!final) break;
            warnings.push({ sourceName: sourceId, line: lineBase, message: "Prompt JSON is truncated" });
            break;
          }
          const brace = buffer.indexOf("{", newline + 1);
          if (brace < 0) {
            if (!final) break;
            warnings.push({ sourceName: sourceId, line: lineBase, message: "Prompt JSON has no object body" });
            consume(newline + 1);
            continue;
          }
          let depth = 0;
          let inString = false;
          let escaped = false;
          let end = -1;
          for (let index = brace; index < buffer.length; index++) {
            const ch = buffer[index];
            if (inString) {
              if (escaped) escaped = false;
              else if (ch === "\\") escaped = true;
              else if (ch === '"') inString = false;
            } else if (ch === '"') inString = true;
            else if (ch === "{") depth++;
            else if (ch === "}" && --depth === 0) {
              end = index;
              break;
            }
          }
          if (end < 0) {
            if (!final) break;
            warnings.push({ sourceName: sourceId, line: lineBase, message: "Prompt JSON is truncated" });
            break;
          }
          const rawJson = buffer.slice(brace, end + 1);
          let data;
          try {
            data = JSON.parse(rawJson);
          } catch (error) {
            warnings.push({ sourceName: sourceId, line: lineBase, message: error.message });
          }
          if (data) {
            const raw = buffer.slice(0, end + 1);
            const event = minilogEvent(
              "request",
              minilogPrompt,
              raw,
              data,
              lineBase + lineCount(buffer.slice(0, end + 1)),
            );
            events.push(event);
            activeMinilogId = event.id;
          }
          consume(end + 1 < buffer.length && buffer[end + 1] === "\n" ? end + 2 : end + 1);
          continue;
        }
        const minilogToken = MINILOG_TOKEN_RE.exec(firstLine);
        if (minilogToken) {
          if (newline < 0 && !final) break;
          let tokenLength = newline < 0 ? buffer.length : newline + 1;
          if (!activeMinilogId) {
            warnings.push({ sourceName: sourceId, line: lineBase, message: "Minilog token has no active Prompt" });
          } else {
            let tokenText = minilogToken[2];
            if (tokenText === "" && newline >= 0) {
              let offset = tokenLength;
              let newlineCount = 0;
              while (offset < buffer.length) {
                if (buffer[offset] === "\r") {
                  if (offset + 1 >= buffer.length && !final) break;
                  if (buffer[offset + 1] !== "\n") break;
                  offset += 2;
                } else if (buffer[offset] === "\n") {
                  offset++;
                } else {
                  break;
                }
                newlineCount++;
              }
              if (!final && offset === buffer.length) break;
              tokenText += "\n".repeat(newlineCount);
              tokenLength = offset;
            }
            const raw = buffer.slice(0, tokenLength);
            events.push(minilogEvent("minilog-token", minilogToken, firstLine, { text: tokenText }, lineBase + lineCount(raw)));
          }
          consume(newline < 0 ? buffer.length : tokenLength);
          continue;
        }
        const marker = firstLine.includes(REQUEST_MARKER)
          ? [REQUEST_MARKER, "request"]
          : firstLine.includes(RESPONSE_MARKER)
            ? [RESPONSE_MARKER, "prediction"]
            : firstLine.includes(STREAM_PACKET_MARKER)
              ? [STREAM_PACKET_MARKER, "packet"]
              : null;
        if (marker) {
          const brace = firstLine.indexOf("{", firstLine.indexOf(marker[0]) + marker[0].length);
          if (brace < 0) {
            if (!final && newline < 0) break;
            warnings.push({ sourceName: sourceId, line: lineBase, message: "JSON record has no object body" });
            consume(newline < 0 ? buffer.length : newline + 1);
            continue;
          }
          let depth = 0;
          let inString = false;
          let escaped = false;
          let end = -1;
          for (let index = brace; index < buffer.length; index++) {
            const ch = buffer[index];
            if (inString) {
              if (escaped) escaped = false;
              else if (ch === "\\") escaped = true;
              else if (ch === '"') inString = false;
            } else if (ch === '"') inString = true;
            else if (ch === "{") depth++;
            else if (ch === "}" && --depth === 0) {
              end = index;
              break;
            }
          }
          if (end < 0) {
            if (!final) break;
            warnings.push({ sourceName: sourceId, line: lineBase, message: "JSON record is truncated" });
            break;
          }
          const raw = buffer.slice(brace, end + 1);
          let data;
          try {
            data = JSON.parse(raw);
          } catch (error) {
            warnings.push({ sourceName: sourceId, line: lineBase, message: error.message });
          }
          if (data) events.push(liveEvent(marker[1], firstLine, raw, data, lineBase + lineCount(buffer.slice(0, end + 1))));
          consume(end + 1 < buffer.length && buffer[end + 1] === "\n" ? end + 2 : end + 1);
          continue;
        }
        const run = RUN_RE.exec(firstLine);
        const isFinished = firstLine.includes(STREAM_FINISHED_MARKER);
        if (run || isFinished) {
          if (newline < 0 && !final) break;
          if (run) {
            events.push({
              id: "run-" + sourceId + "-" + lineBase,
              sourceId,
              correlationId: null,
              kind: "run",
              timestamp: parseTimestamp(run[1]),
              timestampRaw: run[1],
              lineStart: lineBase,
              lineEnd: lineBase,
              payload: { model: run[2], messageCount: Number(run[3]) },
              raw: firstLine,
              confidence: "inferred",
            });
          } else {
            const header = HEADER_RE.exec(firstLine);
            events.push({
              id: "finished-" + sourceId + "-" + lineBase,
              sourceId,
              correlationId: null,
              kind: "finished",
              timestamp: header ? parseTimestamp(header[1]) : null,
              timestampRaw: header ? header[1] : "",
              lineStart: lineBase,
              lineEnd: lineBase,
              payload: { model: header && header[3] || null },
              raw: firstLine,
              confidence: "inferred",
            });
          }
          consume(newline < 0 ? buffer.length : newline + 1);
          continue;
        }
        if (newline < 0) break;
        consume(newline + 1);
      }
      return { events, warnings };
    }

    return {
      push(chunk) {
        if (finished) throw new Error("Incremental parser is finished");
        buffer += String(chunk || "");
        return process(false);
      },
      finish() {
        finished = true;
        return process(true);
      },
    };
  }

  function createLiveReducer(sourceId, options) {
    options = options || {};
    const seen = new Set();
    const requests = [];
    const requestByEvent = new Map();
    const streams = new Map();
    const streamToCall = new Map();
    const minilogCalls = new Map();
    const activeMinilogBySource = new Map();
    const warnings = new Map();
    const sources = new Set();
    let eventOrder = 0;
    let result = null;

    function emptyResult() {
      return {
        calls: [],
        threads: [],
        warnings: [],
        sources: [],
        stats: {
          files: 0,
          calls: 0,
          matched: 0,
          incomplete: 0,
          uncertain: 0,
          threads: 0,
          promptTokens: 0,
          completionTokens: 0,
        },
      };
    }

    function newCall(event) {
      const body = event.payload || {};
      const call = {
        id: "call-live-" + (requests.length + 1),
        sourceName: event.sourceId,
        sourceIndex: 0,
        endpoint: "POST to /v1/chat/completions",
        timestamp: event.timestamp,
        timestampRaw: event.timestampRaw || "",
        lineStart: event.lineStart,
        model: body.model || "Unknown model",
        stream: body.stream === true,
        request: body,
        requestRaw: event.raw || null,
        messages: Array.isArray(body.messages)
          ? body.messages.map(normalizeMessage)
          : [],
        response: null,
        responseRaw: null,
        responseLineStart: null,
        outputMessage: null,
        finishReason: null,
        usage: null,
        status: "incomplete",
        streamPackets: [],
        streamComplete: false,
        matchMethod: null,
        matchConfidence: null,
        durationMs: null,
        rawContext: {
          from: event.lineStart,
          to: event.lineEnd,
          text: event.raw || "",
        },
        parseError: null,
      };
      const request = {
        event,
        call,
        run: null,
        response: null,
        order: eventOrder++,
        minilog:
          event.format === "minilog"
            ? {
                correlationId: event.correlationId,
                tokens: [],
                text: "",
                latestTimestamp: event.timestamp,
                closed: false,
              }
            : null,
      };
      requests.push(request);
      requestByEvent.set(event.id, request);
      return call;
    }

    function minilogKey(event) {
      return event.sourceId + "\u0000" + event.correlationId;
    }

    function refreshMinilog(request) {
      const minilog = request.minilog;
      if (!minilog) return;
      const call = request.call;
      const outputMessage = minilogOutputMessage(minilog.text);
      const response = outputMessage
        ? {
            id: "minilog-response-" + request.event.id,
            object: "chat.completion",
            model: call.model === "Unknown model" ? null : call.model,
            choices: [
              { index: 0, message: outputMessage, finish_reason: null },
            ],
            usage: null,
          }
        : null;
      const stale =
        Boolean(outputMessage) &&
        minilog.latestTimestamp != null &&
        getParserNow(options) - minilog.latestTimestamp >= MINILOG_STALE_MS;
      const complete = Boolean(outputMessage) && (minilog.closed || stale);
      call.response = response;
      call.responseRaw = minilog.tokens.map((token) => token.raw).join("\n") || null;
      call.responseLineStart = minilog.tokens.length
        ? minilog.tokens[0].lineStart
        : null;
      call.outputMessage = outputMessage;
      call.finishReason = null;
      call.usage = null;
      call.streamComplete = complete;
      call.status = complete ? "matched" : "incomplete";
      call.matchMethod = "minilog-boundary";
      call.matchConfidence = "high";
      call.durationMs =
        call.timestamp != null && minilog.latestTimestamp != null
          ? Math.max(0, minilog.latestTimestamp - call.timestamp)
          : null;
      call.rawContext = {
        from: call.lineStart,
        to: minilog.tokens.length
          ? minilog.tokens.at(-1).lineEnd
          : request.event.lineEnd,
        text: [call.requestRaw, call.responseRaw].filter(Boolean).join("\n"),
      };
    }

    function eligibleRequests(event, stream) {
      const model = event.payload && event.payload.model;
      const correlated = requests.filter(
        (request) =>
          request.event.correlationId &&
          request.event.correlationId === stream.id &&
          request.event.payload &&
          request.event.payload.stream === true,
      );
      if (correlated.length) return correlated;
      return requests.filter(
        (request) =>
          request.event.order < event.order &&
          request.event.payload &&
          request.event.payload.stream === true &&
          (!model || !request.event.payload.model || request.event.payload.model === model),
      );
    }

    function packetView(event) {
      return toStreamPacketView({
        id: event.id,
        kind: "stream-packet",
        data: event.payload,
        sourceName: event.sourceId,
        sourceIndex: 0,
        markerLine: "",
        lineStart: event.lineStart,
        lineEnd: event.lineEnd,
        timestampRaw: event.timestampRaw || "",
        timestamp: event.timestamp,
        raw: event.raw || JSON.stringify(event.payload),
        complete: true,
      });
    }

    function updateStream(stream, event) {
      const aggregate = aggregateStream({
        id: stream.id,
        model: stream.model,
        packets: stream.events.map((item) => item.payload),
        packetEvents: stream.events.map(packetView),
      });
      const call = streamToCall.get(stream.id);
      if (!call) return null;
      const choice = aggregate.response.choices[0];
      call.response = aggregate.response;
      call.responseRaw = stream.events.map((item) => item.raw || JSON.stringify(item.payload)).join("\n");
      call.responseLineStart = stream.events[0].lineStart;
      call.outputMessage = aggregate.outputMessage;
      call.finishReason = aggregate.finishReason;
      call.usage = aggregate.usage;
      call.streamPackets = stream.events.map(packetView);
      call.streamComplete = Boolean(stream.complete || stream.finished);
      call.status = call.matchConfidence === "uncertain"
        ? "uncertain"
        : call.streamComplete ? "matched" : "incomplete";
      call.durationMs = call.timestamp != null && event.timestamp != null
        ? Math.max(0, event.timestamp - call.timestamp)
        : null;
      call.rawContext = {
        from: call.lineStart,
        to: stream.finished ? stream.finished.lineStart : event.lineEnd,
        text: call.requestRaw + "\n" + call.responseRaw,
      };
      return call.id;
    }

    function apply(incoming) {
      const addedCallIds = [];
      const updatedCallIds = new Set();
      let addedRequest = false;
      for (const original of incoming || []) {
        const key = original.sourceId + "\u0000" + original.id;
        if (seen.has(key)) continue;
        seen.add(key);
        const event = { ...original, order: eventOrder++ };
        sources.add(event.sourceId);
        if (event.kind === "request") {
          if (event.format === "minilog") {
            const previous = activeMinilogBySource.get(event.sourceId);
            if (previous && previous.minilog) {
              previous.minilog.closed = true;
              refreshMinilog(previous);
            }
          }
          const call = newCall(event);
          const request = requests.at(-1);
          if (event.format === "minilog") {
            minilogCalls.set(minilogKey(event), request);
            activeMinilogBySource.set(event.sourceId, request);
            refreshMinilog(request);
          }
          addedCallIds.push(call.id);
          addedRequest = true;
        } else if (event.kind === "run") {
          const candidates = requests.filter(
            (request) =>
              !request.run &&
              request.event.order < event.order &&
              (!event.payload.model || request.call.model === event.payload.model),
          );
          if (candidates.length) candidates.at(-1).run = event;
        } else if (event.kind === "minilog-token") {
          const request = minilogCalls.get(minilogKey(event));
          if (!request) {
            warnings.set(event.id, {
              sourceName: event.sourceId,
              line: event.lineStart,
              message: "Minilog token has no active Prompt",
            });
            continue;
          }
          const text = event.payload && typeof event.payload.text === "string"
            ? event.payload.text
            : "";
          request.minilog.text += text;
          request.minilog.tokens.push(event);
          request.minilog.latestTimestamp =
            event.timestamp || request.minilog.latestTimestamp;
          refreshMinilog(request);
          updatedCallIds.add(request.call.id);
        } else if (event.kind === "prediction") {
          const request = requests.find(
            (candidate) => !candidate.response && !candidate.call.stream && candidate.event.order < event.order,
          );
          if (request) {
            request.response = event;
            request.call.response = event.payload;
            request.call.responseRaw = event.raw || JSON.stringify(event.payload);
            request.call.responseLineStart = event.lineStart;
            const choice = event.payload && event.payload.choices && event.payload.choices[0];
            request.call.outputMessage = choice && choice.message || null;
            request.call.finishReason = choice && choice.finish_reason || null;
            request.call.usage = event.payload && event.payload.usage || null;
            request.call.status = "matched";
            request.call.matchMethod = "lifecycle";
            request.call.matchConfidence = "high";
            updatedCallIds.add(request.call.id);
          }
        } else if (event.kind === "packet" && event.correlationId) {
          let stream = streams.get(event.correlationId);
          if (!stream) {
            stream = { id: event.correlationId, model: event.payload && event.payload.model, events: [], finished: null, complete: false };
            streams.set(event.correlationId, stream);
          }
          stream.events.push(event);
          stream.model = stream.model || (event.payload && event.payload.model) || (event.payload && event.payload.message && event.payload.message.model) || null;
          const choice = event.payload && Array.isArray(event.payload.choices) ? event.payload.choices[0] : null;
          if (choice && choice.finish_reason != null) stream.complete = true;
          if (event.payload && event.payload.type === "message_delta" && event.payload.delta && event.payload.delta.stop_reason != null) stream.complete = true;
          const candidates = eligibleRequests(event, stream);
          if (!streamToCall.has(stream.id) && candidates.length) {
            const selected = candidates.at(-1);
            streamToCall.set(stream.id, selected.call);
            if (candidates.length > 1) {
              selected.call.matchConfidence = "uncertain";
              const warningKey = stream.id + ":" + selected.event.id;
              warnings.set(warningKey, {
                sourceName: event.sourceId,
                line: event.lineStart,
                message: "Ambiguous stream association for " + stream.id + "; request attribution is uncertain",
              });
            } else {
              selected.call.matchMethod = "lifecycle";
              selected.call.matchConfidence = "high";
            }
          }
          const id = updateStream(stream, event);
          if (id) updatedCallIds.add(id);
        } else if (event.kind === "finished") {
          const candidates = [...streams.values()].filter(
            (stream) =>
              !stream.finished &&
              stream.events.length &&
              stream.events.at(-1).order < event.order &&
              (!event.payload.model || !stream.model || stream.model === event.payload.model),
          );
          if (candidates.length) {
            const stream = candidates.at(-1);
            stream.finished = event;
            stream.complete = true;
            const id = updateStream(stream, event);
            if (id) updatedCallIds.add(id);
          }
        }
      }
      for (const request of requests) {
        if (request.minilog) refreshMinilog(request);
      }
      if (!result) result = emptyResult();
      result.calls = requests.map((request) => request.call);
      if (addedRequest || !result.threads.length) result.threads = buildThreads(result.calls);
      result.warnings = [...warnings.values()];
      result.sources = [...sources].map((name, index) => ({ name, size: 0, index }));
      result.stats.files = result.sources.length;
      result.stats.calls = result.calls.length;
      result.stats.matched = result.calls.filter((call) => call.status === "matched").length;
      result.stats.incomplete = result.calls.filter((call) => call.status === "incomplete").length;
      result.stats.uncertain = result.calls.filter((call) => call.status === "uncertain").length;
      result.stats.threads = result.threads.length;
      result.stats.promptTokens = result.calls.reduce((total, call) => total + ((call.usage && call.usage.prompt_tokens) || 0), 0);
      result.stats.completionTokens = result.calls.reduce((total, call) => total + ((call.usage && call.usage.completion_tokens) || 0), 0);
      const changes = {
        addedCallIds,
        updatedCallIds: [...updatedCallIds],
        warnings: result.warnings,
      };
      return { result, changes };
    }

    return { apply };
  }

  function lcsPairs(a, b) {
    const rows = a.length + 1,
      cols = b.length + 1;
    const table = Array.from({ length: rows }, () => new Uint16Array(cols));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        table[i][j] =
          a[i].fingerprint === b[j].fingerprint
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1]);
    const pairs = [];
    let i = 0,
      j = 0;
    while (i < a.length && j < b.length) {
      if (a[i].fingerprint === b[j].fingerprint) {
        pairs.push([i++, j++]);
      } else if (table[i + 1][j] >= table[i][j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  function sameConversationIdentity(previous, current) {
    const previousSystem =
      previous.messages.find((message) => message.role === "system") || null;
    const currentSystem =
      current.messages.find((message) => message.role === "system") || null;
    const previousUser =
      previous.messages.find((message) => message.role === "user") || null;
    const currentUser =
      current.messages.find((message) => message.role === "user") || null;
    if (
      !previousUser ||
      !currentUser ||
      previousUser.fingerprint !== currentUser.fingerprint
    )
      return false;
    if (!previousSystem && !currentSystem) return true;
    return Boolean(
      previousSystem &&
      currentSystem &&
      previousSystem.fingerprint === currentSystem.fingerprint,
    );
  }

  function buildThreads(calls) {
    const ordered = calls
      .slice()
      .sort(
        (a, b) =>
          (a.timestamp ?? 0) - (b.timestamp ?? 0) ||
          a.sourceIndex - b.sourceIndex ||
          a.lineStart - b.lineStart,
      );
    const byId = new Map(ordered.map((c) => [c.id, c]));
    for (let i = 0; i < ordered.length; i++) {
      const current = ordered[i];
      let best = null;
      for (let j = 0; j < i; j++) {
        const previous = ordered[j];
        if (
          previous.model !== current.model ||
          previous.endpoint !== current.endpoint ||
          !previous.messages.length ||
          !current.messages.length
        )
          continue;
        if (!sameConversationIdentity(previous, current)) continue;
        const pairs = lcsPairs(previous.messages, current.messages);
        const shared = pairs.length;
        const score =
          shared / Math.max(previous.messages.length, current.messages.length);
        // Exact initial system/user identity is the thread boundary. Overlap is
        // only used to choose the most plausible parent within that thread.
        const hasSystem = previous.messages.some(
          (message) => message.role === "system",
        );
        const eligible = shared >= (hasSystem ? 2 : 1);
        if (
          eligible &&
          (!best ||
            score > best.score ||
            (score === best.score && j > best.order))
        )
          best = { previous, pairs, score, order: j };
      }
      if (best) {
        current.predecessorId = best.previous.id;
        current.threadConfidence = best.score >= 0.8 ? "high" : "medium";
        const oldKept = new Set(best.pairs.map((p) => p[0])),
          newKept = new Set(best.pairs.map((p) => p[1]));
        current.delta = {
          retained: best.pairs.length,
          removed: best.previous.messages
            .filter((_, n) => !oldKept.has(n))
            .map((m) => m.index),
          added: current.messages
            .filter((_, n) => !newKept.has(n))
            .map((m) => m.index),
        };
      } else
        current.delta = {
          retained: 0,
          removed: [],
          added: current.messages.map((m) => m.index),
        };
    }
    const roots = new Map();
    function rootId(call) {
      let cur = call,
        seen = new Set();
      while (cur.predecessorId && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.predecessorId) || cur;
      }
      return cur.id;
    }
    for (const call of ordered) {
      const id = rootId(call);
      if (!roots.has(id))
        roots.set(id, { id: "thread-" + id, rootId: id, calls: [] });
      roots.get(id).calls.push(call);
    }
    return Array.from(roots.values()).sort(
      (a, b) =>
        (b.calls.at(-1).timestamp ?? 0) - (a.calls.at(-1).timestamp ?? 0),
    );
  }

  function parseFiles(files, options) {
    const normalizedFiles = files
      .map((file, index) => ({
        name: file.name || "log-" + (index + 1),
        text: file.text || "",
      }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      )
      .map((file, index) => ({ ...file, index }));
    const parsed = normalizedFiles.map((file) => parseSource(file, options));
    if (normalizedFiles.length === 1) {
      const only = parsed[0];
      const logicalKey = (call) =>
        stableStringify({
          timestampRaw: call.timestampRaw,
          model: call.model,
          stream: call.stream,
          messages: (call.request && call.request.messages) || [],
        });
      const calls = only.calls.filter((call, index, all) => {
        if (call.response) return true;
        const key = logicalKey(call);
        return !all.slice(index + 1).some((next) => logicalKey(next) === key);
      });
      const threads = buildThreads(calls);
      return {
        calls,
        threads,
        warnings: only.warnings,
        sources: [only.source],
        stats: {
          files: 1,
          calls: calls.length,
          matched: calls.filter((c) => c.status === "matched").length,
          incomplete: calls.filter((c) => c.status === "incomplete").length,
          uncertain: calls.filter((c) => c.status === "uncertain").length,
          threads: threads.length,
          promptTokens: calls.reduce(
            (n, c) => n + ((c.usage && c.usage.prompt_tokens) || 0),
            0,
          ),
          completionTokens: calls.reduce(
            (n, c) => n + ((c.usage && c.usage.completion_tokens) || 0),
            0,
          ),
        },
      };
    }

    const markers = {
      request: REQUEST_MARKER,
      response: RESPONSE_MARKER,
      "stream-packet": STREAM_PACKET_MARKER,
    };
    const records = [];
    for (const result of parsed) {
      const events = result.events;
      for (const event of [
        ...events.requests,
        ...events.responses.filter((item) =>
          item.markerLine.includes(RESPONSE_MARKER),
        ),
        ...events.streamPackets,
      ]) {
        // A rotation may leave a truncated record at EOF and repeat the same
        // record at the beginning of the next file. The complete copy is the
        // authoritative one for the cross-file parse.
        if (event.error || !event.data || !event.complete) continue;
        const marker = markers[event.kind];
        const markerIndex = event.markerLine.indexOf(marker);
        const identity =
          event.kind === "request"
            ? {
                timestampRaw: event.timestampRaw,
                model: event.data.model || null,
                stream: event.data.stream === true,
                messages: event.data.messages || [],
              }
            : event.data;
        records.push({
          sourceIndex: event.sourceIndex,
          line: event.lineStart,
          key: event.kind + "\u0000" + stableStringify(identity),
          text:
            event.markerLine.slice(0, markerIndex + marker.length) +
            " " +
            event.raw,
        });
      }
      for (const event of events.runs)
        records.push({
          sourceIndex: event.sourceIndex ?? result.source.index,
          line: event.line,
          text: event.rawLine,
        });
      for (const event of events.streamFinished)
        records.push({
          sourceIndex: event.sourceIndex ?? result.source.index,
          line: event.line,
          text: event.rawLine,
        });
    }
    records.sort((a, b) => a.sourceIndex - b.sourceIndex || a.line - b.line);
    const lastRecordByKey = new Map();
    const uniqueRecords = records.filter((record) => {
      if (!record.key) return true;
      const previous = lastRecordByKey.get(record.key);
      lastRecordByKey.set(record.key, record);
      const isRequest = record.key.startsWith("request\u0000");
      const copiedAcrossRotation =
        previous && record.sourceIndex - previous.sourceIndex === 1;
      const copiedWithinFile =
        previous && isRequest && record.sourceIndex === previous.sourceIndex;
      return !previous || (!copiedAcrossRotation && !copiedWithinFile);
    });
    const unifiedText = uniqueRecords.map((record) => record.text).join("\n");
    const unified = parseSource({
      name: normalizedFiles.map((file) => file.name).join(", "),
      text: unifiedText,
      index: 0,
    }, options);
    const calls = unified.calls;
    const threads = buildThreads(calls);
    return {
      calls,
      threads,
      warnings: [...parsed.flatMap((p) => p.warnings), ...unified.warnings],
      sources: normalizedFiles.map((file) => ({
        name: file.name,
        size: file.text.length,
        index: file.index,
      })),
      stats: {
        files: normalizedFiles.length,
        calls: calls.length,
        matched: calls.filter((c) => c.status === "matched").length,
        incomplete: calls.filter((c) => c.status === "incomplete").length,
        uncertain: calls.filter((c) => c.status === "uncertain").length,
        threads: threads.length,
        promptTokens: calls.reduce(
          (n, c) => n + ((c.usage && c.usage.prompt_tokens) || 0),
          0,
        ),
        completionTokens: calls.reduce(
          (n, c) => n + ((c.usage && c.usage.completion_tokens) || 0),
          0,
        ),
      },
    };
  }

  return {
    parseFiles,
    createIncrementalParser,
    createLiveReducer,
    parseSource,
    buildThreads,
    stableStringify,
    lcsPairs,
    sameConversationIdentity,
  };
});
