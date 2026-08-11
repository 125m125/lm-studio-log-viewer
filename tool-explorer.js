(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LMStudioToolExplorer = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  }

  function normalizeArguments(raw) {
    const text = typeof raw === "string" ? raw : stableStringify(raw);
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return { text: stableStringify(parsed), parsed };
    } catch (_) {
      return { text, parsed: null };
    }
  }

  function getThreadIdForCall(result, callId) {
    const thread = (result.threads || []).find(item => item.calls.some(call => call.id === callId));
    return thread ? thread.id : null;
  }

  function hash(text) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index++) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(36);
  }

  function buildInvocationIndex(result) {
    const preferred = new Map();
    for (const thread of result.threads || []) {
      const calls = thread.calls.slice().sort((a, b) =>
        (a.timestamp ?? 0) - (b.timestamp ?? 0) ||
        (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0) ||
        (a.lineStart ?? 0) - (b.lineStart ?? 0));

      function add(call, toolCall, logicalMessageIndex, toolIndex, source, messageIndex) {
        const fn = toolCall && toolCall.function || {};
        const name = fn.name || "Unknown tool";
        const normalized = normalizeArguments(fn.arguments == null ? "" : fn.arguments);
        const identity = toolCall && toolCall.id
          ? "id:" + toolCall.id
          : "fallback:" + [logicalMessageIndex, toolIndex, name, normalized.text].join("\u0000");
        const id = thread.id + ":" + identity;
        const candidate = {
          id,
          identity,
          threadId: thread.id,
          name,
          arguments: normalized.text,
          parsedArguments: normalized.parsed,
          logicalMessageIndex,
          toolIndex,
          timestamp: call.timestamp,
          timestampRaw: call.timestampRaw,
          model: call.model,
          target: {
            callId: call.id,
            source,
            messageIndex,
            toolIndex,
            domId: "tool-invocation-" + hash(id),
          },
          sortKey: [call.timestamp ?? 0, call.sourceIndex ?? 0, call.lineStart ?? 0, logicalMessageIndex, toolIndex],
        };
        const current = preferred.get(id);
        if (!current || (current.target.source === "request" && source === "response")) preferred.set(id, candidate);
      }

      for (const call of calls) {
        (call.messages || []).forEach((message, messagePosition) => {
          if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) return;
          const logicalMessageIndex = Number.isInteger(message.index) ? message.index : messagePosition;
          message.toolCalls.forEach((toolCall, toolIndex) =>
            add(call, toolCall, logicalMessageIndex, toolIndex, "request", logicalMessageIndex));
        });
        const responseCalls = call.outputMessage && call.outputMessage.tool_calls;
        if (Array.isArray(responseCalls)) {
          responseCalls.forEach((toolCall, toolIndex) =>
            add(call, toolCall, (call.messages || []).length, toolIndex, "response", null));
        }
      }
    }
    return [...preferred.values()]
      .sort((a, b) => {
        for (let index = 0; index < a.sortKey.length; index++) {
          if (a.sortKey[index] !== b.sortKey[index]) return a.sortKey[index] - b.sortKey[index];
        }
        return a.id.localeCompare(b.id);
      })
      .map(record => {
        const clean = { ...record };
        delete clean.sortKey;
        return clean;
      });
  }

  return { buildInvocationIndex, getThreadIdForCall };
});
