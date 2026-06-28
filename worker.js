importScripts("parser.js");
self.onmessage = function (event) {
  try { self.postMessage({ ok: true, result: self.LMStudioLogParser.parseFiles(event.data.files) }); }
  catch (error) { self.postMessage({ ok: false, error: error && error.message || String(error) }); }
};
