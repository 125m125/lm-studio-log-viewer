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

  function assignDomIds(records) {
    const groups = new Map();
    records.forEach(record => {
      const base = "tool-invocation-" + hash(record.id);
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(record);
    });
    groups.forEach((group, base) => {
      group.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      group.forEach((record, index) => {
        record.target.domId = base + (group.length > 1 ? "-" + index.toString(36) : "");
      });
    });
    return records;
  }

  function isInvocationTargetForRecord(target, record) {
    return Boolean(target && record && target.dataset && target.dataset.toolRecordId === record.target.domId);
  }

  function getStaleTargetFallback(matching, staleRecordId, direction) {
    const stalePosition = matching.findIndex(record => record.id === staleRecordId);
    if (stalePosition < 0) return null;
    const remaining = matching.filter(record => record.id !== staleRecordId);
    const position = direction < 0
      ? stalePosition - 1
      : direction > 0
        ? stalePosition
        : Math.min(stalePosition, remaining.length - 1);
    return remaining[position] || null;
  }

  function buildInvocationIndex(result) {
    const preferred = new Map();
    for (const thread of result.threads || []) {
      const calls = thread.calls.slice().sort((a, b) =>
        (a.timestamp ?? 0) - (b.timestamp ?? 0) ||
        (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0) ||
        (a.lineStart ?? 0) - (b.lineStart ?? 0));
      const callsById = new Map(thread.calls.map(call => [call.id, call]));

      function fallbackSignature(toolCall, logicalMessageIndex, toolIndex) {
        const fn = toolCall && toolCall.function || {};
        const name = fn.name || "Unknown tool";
        const normalized = normalizeArguments(fn.arguments == null ? "" : fn.arguments);
        return [logicalMessageIndex, toolIndex, name, normalized.text].join("\u0000");
      }

      function generatedFallbackIdentity(call, signature) {
        return "fallback:" + call.id + "\u0000" + signature;
      }

      function ancestorFallbackIdentity(call, signature) {
        const seen = new Set();
        let predecessorId = call.predecessorId;
        while (predecessorId && !seen.has(predecessorId)) {
          seen.add(predecessorId);
          const predecessor = callsById.get(predecessorId);
          if (!predecessor) break;
          const responseCalls = predecessor.outputMessage && predecessor.outputMessage.tool_calls;
          if (Array.isArray(responseCalls)) {
            const responseIndex = responseCalls.findIndex((toolCall, toolIndex) =>
              fallbackSignature(toolCall, (predecessor.messages || []).length, toolIndex) === signature);
            if (responseIndex >= 0) return generatedFallbackIdentity(predecessor, signature);
          }
          predecessorId = predecessor.predecessorId;
        }
        return null;
      }

      function add(call, toolCall, logicalMessageIndex, toolIndex, source, messageIndex) {
        const fn = toolCall && toolCall.function || {};
        const name = fn.name || "Unknown tool";
        const normalized = normalizeArguments(fn.arguments == null ? "" : fn.arguments);
        const signature = [logicalMessageIndex, toolIndex, name, normalized.text].join("\u0000");
        const identity = toolCall && toolCall.id
          ? "id:" + toolCall.id
          : source === "response"
            ? generatedFallbackIdentity(call, signature)
            : ancestorFallbackIdentity(call, signature) || "fallback-request:" + signature;
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
            domId: "",
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
    const records = [...preferred.values()]
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
    return assignDomIds(records);
  }

  function getScopedInvocations(records, result, selectedCallId, scope) {
    if (scope === "history") return records.slice();
    const threadId = getThreadIdForCall(result, selectedCallId);
    return threadId ? records.filter(record => record.threadId === threadId) : [];
  }

  function summarizeToolTypes(records) {
    const counts = new Map();
    records.forEach(record => counts.set(record.name, (counts.get(record.name) || 0) + 1));
    return [...counts].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  /**
   * @param {InvocationRecord[]} records
   * @param {string | null} selectedType
   * @param {string | null} selectedRecordId
   * @param {number} [previousPosition]
   */
  function reconcileSelection(records, selectedType, selectedRecordId, previousPosition) {
    const types = summarizeToolTypes(records);
    const selectedRecord = records.find(record => record.id === selectedRecordId) || null;
    const type = selectedRecord
      ? selectedRecord.name
      : types.some(item => item.name === selectedType)
        ? selectedType
        : (types[0] && types[0].name) || null;
    const matching = type ? records.filter(record => record.name === type) : [];
    let position = matching.findIndex(record => record.id === selectedRecordId);
    if (position < 0) {
      const fallbackPosition = type !== selectedType ? 0 : previousPosition || 0;
      position = Math.min(Math.max(fallbackPosition, 0), Math.max(matching.length - 1, 0));
    }
    return { selectedType: type, selectedRecordId: matching[position] ? matching[position].id : null, position, matching };
  }

  function reconcileExplorerUpdate(state, records) {
    const selection = reconcileSelection(records, state.selectedType, state.selectedRecordId, state.position);
    return {
      ...state,
      records,
      selectedType: selection.selectedType,
      selectedRecordId: selection.selectedRecordId,
      position: selection.position,
    };
  }

  return { buildInvocationIndex, getThreadIdForCall, getScopedInvocations, summarizeToolTypes, reconcileSelection, reconcileExplorerUpdate, isInvocationTargetForRecord, getStaleTargetFallback };
});
