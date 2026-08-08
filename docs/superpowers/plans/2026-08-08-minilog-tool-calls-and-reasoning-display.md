# Minilog Tool Calls and Reasoning Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse minilog tool-call markup, remove it from visible content, and show passed-back assistant reasoning in request messages.

**Architecture:** Add a focused minilog text parser in `parser.js` that converts complete tool-call blocks into the existing `tool_calls` shape after reasoning/content splitting. Extend normalized request messages with `reasoningContent`, then update `app.js` to render that field in assistant cards while preserving raw evidence.

**Tech Stack:** Plain JavaScript, Node's built-in `node:test`, static source-level UI tests.

## Global Constraints

- Keep malformed tool-call markup visible rather than dropping it.
- Keep the original minilog/request text available through existing raw evidence fields.
- Do not change ordinary or streamed response behavior.
- Use test-first changes and run `node --test tests/*.test.js` before completion.

---

### Task 1: Parse minilog tool-call markup

**Files:**
- Modify: `parser.js` near `minilogOutputMessage()`
- Test: `tests/parser.test.js`

**Interfaces:**
- Consumes: reconstructed minilog text after `</think>` splitting.
- Produces: `{ content, tool_calls }` fields compatible with existing streamed-response output.

- [x] **Step 1: Write failing tests** for a minilog response containing `<tool_call>`, a named function, two parameters, and surrounding text; assert the call shape and that markup is absent from `content`. Add a malformed/incomplete block test that keeps markup visible.
- [x] **Step 2: Run `node --test tests/parser.test.js`** and confirm the new assertions fail because minilog output currently has no `tool_calls` extraction.
- [x] **Step 3: Implement the smallest parser** that extracts complete blocks, decodes their function and parameter tags, removes only successfully parsed blocks, and leaves incomplete blocks untouched.
- [x] **Step 4: Run the focused parser tests** and confirm they pass.

### Task 2: Preserve reasoning in normalized request messages

**Files:**
- Modify: `parser.js` in `normalizeMessage()` and its message fingerprint.
- Test: `tests/parser.test.js`

**Interfaces:**
- Consumes: request message objects with optional `reasoning_content`.
- Produces: normalized messages with `reasoningContent` and fingerprints that distinguish different reasoning.

- [x] **Step 1: Write a failing parser test** asserting assistant request messages preserve `reasoning_content` and that changed reasoning changes the normalized fingerprint.
- [x] **Step 2: Run the focused test** and confirm the normalized message lacks the field or has an unchanged fingerprint.
- [x] **Step 3: Add `reasoningContent` normalization and fingerprint input** without changing the original `raw` message.
- [x] **Step 4: Run parser tests** and confirm they pass.

### Task 3: Render assistant reasoning and tool calls in request messages

**Files:**
- Modify: `app.js` in `renderMessage()`.
- Test: `tests/static.test.js`

**Interfaces:**
- Consumes: normalized message `reasoningContent` and `toolCalls` fields.
- Produces: assistant message cards containing visible reasoning and existing structured tool-call details.

- [x] **Step 1: Write a failing static rendering test** requiring assistant message rendering to reference `reasoningContent` and label the rendered block as Reasoning.
- [x] **Step 2: Run the focused static test** and confirm it fails against the current renderer.
- [x] **Step 3: Render a Reasoning subpayload** for non-empty assistant reasoning and retain the existing Tool calls subpayload.
- [x] **Step 4: Run static tests** and confirm they pass.

### Task 4: Full verification

**Files:**
- Verify: `parser.js`, `app.js`, `tests/parser.test.js`, `tests/static.test.js`

- [x] **Step 1: Run `git diff --check`.**
- [x] **Step 2: Run `node --test tests/*.test.js` and confirm all tests pass.**
- [x] **Step 3: Smoke-test the active sample log and verify tool calls/reasoning are present while raw evidence remains available.**
