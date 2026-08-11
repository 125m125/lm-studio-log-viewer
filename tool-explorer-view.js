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

  function restoreExplorerControlFocus(root, target) {
    if (!root || !target) return false;
    const control = target.kind === "toggle"
      ? root.querySelector("[data-explorer-toggle]")
      : target.kind === "scope"
        ? Array.from(root.querySelectorAll("[data-explorer-scope]")).find(button => button.dataset.explorerScope === target.value)
        : null;
    if (!control || typeof control.focus !== "function") return false;
    control.focus();
    return true;
  }

  function renderToolInvocations(toolCalls, records, copyPrefix) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return "";
    return '<div class="tool-invocations">' + toolCalls.map((toolCall, index) => {
      const record = records.find(item => item.target.toolIndex === index);
      const fn = toolCall && toolCall.function || {};
      const name = fn.name || "Unknown tool";
      const args = fn.arguments == null ? "" : contentText(fn.arguments);
      const targetAttributes = record
        ? ' id="' + escapeHtml(record.target.domId) + '" tabindex="-1" data-tool-record-id="' + escapeHtml(record.id) + '"'
        : "";
      return '<article class="tool-invocation"' + targetAttributes + ' aria-label="' + escapeHtml(name + " tool invocation") + '">' +
        '<div class="tool-invocation-head"><strong>' + escapeHtml(name) + '</strong>' +
        '<button type="button" data-copy-tool="' + escapeHtml(copyPrefix + ":" + index) + '" aria-label="Copy ' + escapeHtml(name) + ' tool invocation">Copy</button></div>' +
        '<pre>' + escapeHtml(args || "(empty arguments)") + '</pre></article>';
    }).join("") + "</div>";
  }

  function renderExplorerTray(viewModel) {
    const types = Array.isArray(viewModel.types) ? viewModel.types : [];
    const preview = viewModel.preview;
    const atStart = viewModel.position <= 0;
    const atEnd = viewModel.position >= viewModel.total - 1;
    const navigation = viewModel.total > 0
      ? '<div class="explorer-navigation">' +
          '<button type="button" data-explorer-previous' + (atStart ? " disabled" : "") + '>Previous</button>' +
          '<span>' + escapeHtml(viewModel.position + 1) + ' of ' + escapeHtml(viewModel.total) + '</span>' +
          '<button type="button" data-explorer-next' + (atEnd ? " disabled" : "") + '>Next</button>' +
        '</div>' +
        '<div class="explorer-preview"><strong>' + escapeHtml(preview.name) + '</strong><pre>' + escapeHtml(preview.arguments) + '</pre>' +
          '<div><span>' + escapeHtml(preview.time) + '</span><span>' + escapeHtml(preview.model) + '</span><span>' + escapeHtml(preview.callId) + '</span></div>' +
        '</div>'
      : '<p class="explorer-empty">No tool invocations found in this scope.</p>';
    return '<section class="explorer-tray" aria-labelledby="explorer-toggle">' +
      '<button type="button" id="explorer-toggle" data-explorer-toggle aria-controls="explorer-panel" aria-expanded="' + (viewModel.open ? "true" : "false") + '">Explore</button>' +
      '<div class="explorer-panel"' + (viewModel.open ? "" : " hidden") + ' id="explorer-panel" role="region" aria-labelledby="explorer-module-title">' +
        '<div class="explorer-toolbar"><span id="explorer-module-title">Tool calls</span>' +
          '<div class="explorer-scopes" role="group" aria-label="Tool call scope">' +
          '<button type="button" data-explorer-scope="conversation" aria-pressed="' + (viewModel.scope === "conversation" ? "true" : "false") + '">Current conversation</button>' +
          '<button type="button" data-explorer-scope="history" aria-pressed="' + (viewModel.scope === "history" ? "true" : "false") + '">All loaded history</button>' +
          '</div></div>' +
        '<div class="explorer-types" role="group" aria-label="Tool types">' + types.map(type =>
          '<button type="button" class="explorer-type" data-explorer-type="' + escapeHtml(type.name) + '" aria-pressed="' + (type.name === viewModel.selectedType ? "true" : "false") + '">' + escapeHtml(type.name) + ' <span>' + escapeHtml(type.count) + '</span></button>'
        ).join("") + '</div>' +
        navigation +
      '</div>' +
    '</section>';
  }

  return { renderToolInvocations, renderExplorerTray, restoreExplorerControlFocus };
});
