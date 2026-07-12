# Streamed response support

## Goal

Parse LM Studio server logs that record streaming chat completions as repeated multiline `Generated packet:` JSON records, reconstruct the assistant response for the existing viewer, and preserve every streamed delta as expandable evidence.

## Context

The current parser recognizes one `Generated prediction:` JSON record per request. LM Studio streaming logs instead emit a sequence of OpenAI-style `chat.completion.chunk` packets. Each packet may contain content, reasoning, tool-call fragments, finish metadata, or usage; a `Finished streaming response` line marks the end of the stream. A streamed call must remain one call in the existing request/response/thread model.

## Design

### Parser and data model

- Add recognition for `Generated packet:` JSON records and `Finished streaming response` boundaries.
- Parse each packet with the existing multiline JSON scanner and retain its source metadata, raw JSON, timestamp, and parsed object.
- Group packets by their stable chunk `id`. Associate each grouped stream with the nearest eligible request/run, while keeping ordinary `Generated prediction:` matching unchanged.
- Expose the original packet sequence on the call as `streamPackets`. Each packet retains all fields, especially the complete `choices[*].delta` object, so content, reasoning, tool-call, and future delta fields are not discarded.
- Build the normal response-facing fields from the packet sequence:
  - concatenate string-valued `delta.content` fragments into assistant content;
  - concatenate string-valued `delta.reasoning_content` fragments into reasoning content;
  - preserve the first streamed role and assemble tool-call fragments when their structure allows it;
  - use the last non-null finish reason and the packet carrying usage for `finishReason` and `usage`;
  - synthesize a response object compatible with the existing `response`, `outputMessage`, and evidence rendering.
- Set `streamComplete` when a terminal finish/usage packet or finish boundary is present. A stream with packets but no terminal marker remains visible with its partial output and is marked incomplete, with a warning where appropriate.
- Use the first packet as the response start and the terminal packet/boundary as the response end for line ranges, raw context, and duration.

### UI

- Keep the reconstructed assistant response in the existing Response section so streamed and non-streamed calls have the same primary experience.
- Identify streamed calls with a compact packet-count indicator.
- Add an expandable Stream packets evidence block containing the packet index, timestamp, finish/usage state, and the complete original packet/delta data.
- Keep the raw synthesized response available through the existing Response JSON evidence block.

### Error handling

- A malformed packet records a parser warning and does not abort the file.
- A truncated packet stream keeps all successfully parsed packets and exposes the partial reconstruction.
- Packet groups that cannot be associated with a request produce a warning rather than a fabricated call.
- Existing non-streamed request/response behavior, matching confidence, filters, and thread grouping remain unchanged.

## Verification

Add parser tests for:

1. multiple content packets reconstructing one response;
2. reasoning and tool-call delta preservation;
3. terminal finish and usage packet extraction;
4. partial streams remaining visible and incomplete;
5. ordinary `Generated prediction:` calls remaining unchanged;
6. malformed packet JSON producing warnings without throwing; and
7. matching a stream to the correct request.

Run the full Node test suite and parse the supplied LM Studio log as an integration check. Confirm that the real `chat.completion.chunk` format, final usage-only packet, and existing non-streamed records are all handled.

## Scope boundaries

This change does not add live tailing, network access, a new persistence format, or a separate stream timeline. The packet evidence is rendered from the data already held in the parsed call.
