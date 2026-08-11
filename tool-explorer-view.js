(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LMStudioToolExplorerView = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch]);
  }

  function contentText(value) {
    if (value == null) return "";
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  function renderToolInvocations(toolCalls, records, copyPrefix) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return "";
    return '<div class="tool-invocations">' + toolCalls.map((toolCall, index) => {
      const record = records.find(item => item.target.toolIndex === index);
      const fn = toolCall && toolCall.function || {};
      const args = fn.arguments == null ? "" : contentText(fn.arguments);
      return '<article class="tool-invocation" id="' + escapeHtml(record ? record.target.domId : "") + '" tabindex="-1" data-tool-record-id="' + escapeHtml(record ? record.id : "") + '">' +
        '<div class="tool-invocation-head"><strong>' + escapeHtml(fn.name || "Unknown tool") + '</strong>' +
        '<button type="button" data-copy-tool="' + escapeHtml(copyPrefix + ":" + index) + '">Copy</button></div>' +
        '<pre>' + escapeHtml(args || "(empty arguments)") + '</pre></article>';
    }).join("") + "</div>";
  }

  return { renderToolInvocations };
});
