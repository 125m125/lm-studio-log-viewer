# Minilog Tool Calls and Reasoning Display Design

## Goal

Expose tool calls emitted in llama.cpp/LM Studio minilog text and preserve assistant reasoning passed back in later request messages.

## Scope

- Parse minilog `<tool_call>` blocks containing a `<function=name>` element and named `<parameter=name>value</parameter>` elements.
- Store parsed calls as the existing OpenAI-compatible `tool_calls` array on the reconstructed assistant output.
- Remove successfully parsed tool-call markup from visible response content while retaining the original text in raw evidence.
- Preserve `reasoning_content` when normalizing request messages and render it in assistant message cards.
- Preserve malformed or incomplete tool-call markup as visible content instead of silently discarding it.

## Data Flow

Minilog token text is concatenated, split into reasoning/content at `</think>`, and then parsed for tool-call blocks. The parser returns the same `tool_calls` shape used by streamed OpenAI responses. Request messages retain their original reasoning and tool-call fields through normalization; the existing message renderer displays those fields without changing raw request evidence.

## Compatibility

- Existing ordinary and streamed response parsing remains unchanged.
- Minilog responses without tool-call markup remain unchanged.
- Tool-call markup is removed only from the visible reconstructed content; `responseRaw` and raw request message data remain available for evidence.

## Verification

Tests cover minilog calls with multiple parameters, markup removal, malformed fallback, assistant-message reasoning preservation/rendering, and the existing full test suite.
