# Tool Call Explorer Design

## Goal

Add a compact exploration utility that inventories tool invocation types and lets users move directly between invocations in either the selected conversation or the entire loaded log history. The utility should establish an extensible home for future exploration features without crowding the existing conversation viewer.

## Scope

The first version covers assistant tool invocations only. Tool-role result messages are not separate explorer occurrences.

It will:

- group invocations by tool or function name;
- show deduplicated counts for each type;
- switch between the selected conversation thread and all loaded history;
- navigate backward and forward through one selected type;
- jump to, expand, scroll to, and briefly highlight the exact invocation;
- preserve explorer state while the user navigates between logged calls; and
- provide a reusable container for later explorer modules.

It will not add result pairing, argument search, aggregate dashboards, parser changes, or several simultaneously visible explorer modules.

## Exploration Tray

The feature lives in a collapsible **Explore** tray above the conversation detail. Its collapsed state is a single control and may include a short summary such as the number of tool types in the active scope. Closing the tray restores the current detail layout without discarding explorer state.

The tray owns only shared exploration state:

- whether it is open;
- the active explorer module; and
- the active scope.

The initial and only module is **Tool calls**. The tray will expose the module through a small selector that can later accommodate sibling modules such as token usage, models, timing, errors, or message roles. Only one module is visible at a time.

## Tool Calls Module

The module contains:

- a scope toggle for **Current conversation** and **All loaded history**;
- a selectable chip for every tool name, including its deduplicated invocation count;
- **Previous** and **Next** controls with an `n of total` position;
- a compact preview of the focused invocation, including function name, arguments, time, model, and containing call.

The default scope is the current conversation. Tool types are ordered by descending count, then alphabetically. Changing scope retains the selected type if it still exists; otherwise the first available type becomes selected. Previous and Next stop at the sequence boundaries and become disabled rather than wrapping.

Selecting a tool-type chip focuses that type's first chronological invocation. Selecting a different conversation in the sidebar recomputes current-conversation scope for that thread while retaining the selected type when possible. All-history scope is unaffected by conversation selection.

The tray remains open and preserves its module, scope, selected tool type, and occurrence position as call selection changes. Live updates retain that state when possible. If the focused occurrence disappears, the module selects the nearest valid occurrence of the same type, then falls back to the first available type if necessary.

## Invocation Index

A derived index reads the parser's existing normalized calls and produces explorer records without changing parsing. Each record contains:

- a stable invocation identity;
- function name;
- parsed or raw arguments;
- chronological position;
- containing call ID;
- source location, distinguishing request-message and generated-response occurrences; and
- a precise render target for navigation.

Current-conversation scope includes all calls in the selected reconstructed thread. All-history scope includes every loaded call. Inventory computation is independent of the existing status, model, and text filters so “all loaded history” means the full parsed dataset, not merely the calls currently visible in the sidebar.

Records are ordered chronologically by their containing calls and by their original order within each call.

## Deduplication

Conversation history can repeat the same assistant tool invocation in several later request contexts. The index represents each logical invocation only once.

When present, the tool-call ID is the primary identity. If no ID exists, a deterministic fallback combines the reconstructed thread ID, logical assistant-message position, ordinal within that message, normalized function name, and normalized arguments. For a generated response, the logical assistant-message position is immediately after its request messages; when that response reappears in a later request context, its message index provides the same position. This makes repeated history entries converge while keeping two otherwise identical invocations at different conversation positions distinct.

Structured arguments are normalized with stable object-key ordering. Arguments that are not valid structured data retain their exact text so normalization does not invent equivalence.

When several source occurrences represent one invocation, a generated-response occurrence is the preferred navigation target. If that source is unavailable, the earliest request-context occurrence is used.

## Detail Rendering and Navigation

Tool-call arrays currently rendered as one JSON payload become a list of individually addressable invocation entries. Each entry retains readable formatted arguments and copy behavior. Request-message tool calls and generated-response tool calls use the same entry renderer so navigation behavior is consistent.

Activating an occurrence performs these steps:

1. Select its containing logged call.
2. Render that call's detail while retaining explorer state.
3. Expand the containing request message or response tool-call section.
4. Scroll the exact invocation into view.
5. Apply a short-lived highlight to confirm the destination.

The render target is based on stable invocation and source identifiers, not array indexes alone. If a target is stale or cannot be rendered, navigation skips it when another valid occurrence exists and reports the issue through a small non-blocking notice.

## Empty and Update States

If a scope has no invocations, the module explains that none were found and disables navigation. If a selected type vanishes after a live update, scope change, or reconstructed-thread change, the module uses the fallback behavior described above.

Incremental log updates rebuild or update the derived invocation index after the parsed result changes. They must not reset the tray's open state or unrelated module state.

## Component Boundaries

The implementation should keep three responsibilities separate:

1. **Invocation indexing** derives, orders, and deduplicates records from parsed calls.
2. **Exploration tray** manages shared container state and module selection.
3. **Tool calls module and invocation renderer** manage tool-specific inventory, navigation, preview, anchors, expansion, and highlighting.

These units communicate through normalized invocation records and stable IDs. Future explorer modules can consume the loaded result and selected thread through the same tray boundary without depending on tool-call internals.

## Accessibility and Responsive Behavior

The tray toggle, scope controls, type chips, and navigation controls are keyboard-accessible buttons with clear accessible names and pressed or selected state. Focus moves to the destination invocation after a jump so keyboard users receive the same confirmation as scrolling users. The transient highlight is not the only indication of the destination.

On narrow screens, the tray remains in normal document flow. Tool chips may wrap or scroll horizontally, while navigation controls and the selected invocation preview remain usable without widening the page.

## Verification

Automated tests will cover:

- indexing invocations from request messages and generated responses;
- grouping by normalized function name;
- tool-call-ID deduplication;
- deterministic fallback deduplication without merging separate identical invocations;
- current-thread and all-history scope boundaries;
- independence from sidebar status, model, and text filters;
- chronological ordering and disabled Previous/Next boundaries;
- state retention across call selection and live updates;
- fallback when a selected type or occurrence disappears;
- expansion, exact render targeting, focus, scrolling, and highlighting;
- empty scopes and stale targets; and
- regression coverage for existing search, filters, call selection, message rendering, response rendering, and copy controls.

Manual responsive checks will verify the collapsed and expanded tray at desktop and narrow viewport widths.
