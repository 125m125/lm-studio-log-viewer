## Task 1 report: complete-stream parser contract

Status: DONE

Scope:
- Modified `tests/parser.test.js`
- Modified `parser.js`
- Preserved unrelated worktree changes (`docs/superpowers/plans/` remained untouched)

### Requirement check

- Added the streamed fixture helpers `packet()` and `finished()` beside the existing test helpers.
- Added the exact contract test `reconstructs a complete streamed response and keeps its packets`.
- Observed the required RED failure before editing `parser.js`.
- Implemented stream packet discovery, grouping, aggregation, and request matching in `parser.js`.
- Populated `call.streamPackets`, `call.streamComplete`, reconstructed `outputMessage`, `finishReason`, `usage`, and response timing metadata.
- Verified the focused parser checks and the full parser suite after implementation.
- Self-reviewed the scoped diff before committing.

### RED evidence

Command:

```powershell
node --test tests/parser.test.js --test-name-pattern="reconstructs a complete streamed response"
```

Result:

```text
not ok 2 - reconstructs a complete streamed response and keeps its packets
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + 'incomplete'
    - 'matched'
```

Interpretation:
- The new test failed for the intended missing behavior: streamed packet groups were not being reconstructed or matched back onto the streamed request.

### Implementation summary

In `parser.js` I added:

- `STREAM_PACKET_MARKER = "Generated packet:"`
- `STREAM_FINISHED_MARKER = "Finished streaming response"`
- `appendStringField(target, field, value)` to concatenate streamed string deltas.
- `aggregateStream(group)` to:
  - iterate packet bodies in source order
  - concatenate `delta.content`
  - concatenate `delta.reasoning_content`
  - retain the last non-null `finish_reason`
  - retain the latest packet `usage`
  - synthesize a response with `choices[0].message`

I then extended `parseSource()` to:

- collect stream packet events via `eventFromMarker(...)`
- collect finished-stream boundary lines with timestamp/model metadata
- group packets by `data.id`
- mark packet groups terminal when they include a non-null `finish_reason` or usage packet
- associate finished markers with the latest prior unmatched stream group for the same model
- convert each packet group into a single response event
- match each streamed response event to the latest preceding unmatched streamed request with the same model
- expose `streamPackets` and `streamComplete` on the resulting call
- treat a streamed call as:
  - `matched` when the packet group is terminal or has a finished boundary
  - `incomplete` when only partial packets exist

### GREEN evidence

Focused verification command:

```powershell
node --test tests/parser.test.js --test-name-pattern="reconstructs a complete streamed response|parses and matches multiline request and prediction"
```

Result:

```text
1..8
# tests 8
# pass 8
# fail 0
```

Full parser suite command:

```powershell
node --test tests/parser.test.js
```

Result:

```text
1..8
# tests 8
# pass 8
# fail 0
```

Notes:
- No warnings or failures were emitted by the parser test suite.

### Self-review notes

Checked the diff for only the scoped task files plus this report.

Key review points:

- The new stream aggregation path produces one response per packet group, not one response per packet.
- Existing non-stream prediction matching behavior still passes its prior regression test.
- The rejected-request regression still passes, confirming stream support did not shift normal lifecycle matching.
- Unrelated untracked work (`docs/superpowers/plans/`) was preserved.

### Commit

Planned commit message:

```text
feat: reconstruct streamed log responses
```

### Concerns

- None at this task scope.

---

## Reviewer fix follow-up

Status: DONE

Scope:
- Modified `tests/parser.test.js`
- Modified `parser.js`
- Appended this report entry
- Preserved unrelated worktree changes (`docs/superpowers/plans/` remained untouched)

### Reviewed issues addressed

1. Tightened stream completion:
   - usage by itself no longer marks a stream complete
   - completion now requires one of:
     - a non-null `finish_reason`
     - a `Finished streaming response` boundary
     - a usage-only terminal packet with `choices: []`
2. Restored chronological/stable matching:
   - synthesized stream response events are sorted together with ordinary responses by source line before the matching loop
   - ordinary `Generated prediction` matching now stays stable in mixed ordinary/stream logs
3. Fixed synthesized role defaulting:
   - streamed role is taken from delta packets first
   - synthesized role defaults to `"assistant"` only if no delta role was ever provided

### RED evidence for reviewer fixes

Command:

```powershell
node --test tests/parser.test.js --test-name-pattern="usage-bearing stream incomplete|matches ordinary and streamed responses by source order"
```

Result:

```text
not ok 3 - keeps a usage-bearing stream incomplete without a terminal chunk or finished boundary
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + 'matched'
    - 'incomplete'

not ok 4 - matches ordinary and streamed responses by source order
  error: "Cannot read properties of null (reading 'content')"
```

Interpretation:
- The first regression showed the parser was still treating any usage-bearing stream packet as terminal.
- The second regression showed mixed ordering was unstable: the ordinary response could no longer be matched to its intended request once stream responses were appended after ordinary ones.

### Regression tests added

- `keeps a usage-bearing stream incomplete without a terminal chunk or finished boundary`
  - proves a usage-bearing non-terminal packet remains `incomplete`
  - also proves the synthesized role comes from the delta (`tool`) instead of being hardcoded to assistant
- `matches ordinary and streamed responses by source order`
  - proves a streamed terminal chunk that appears earlier in the log is matched before a later ordinary response
  - prevents ordinary predictions from stealing streamed requests

### Implementation summary for reviewer fixes

In `parser.js` I changed:

- `aggregateStream(group)`:
  - start synthesized messages without a preset role
  - apply `delta.role` when present
  - default role to `"assistant"` only after all packets are processed
- stream terminal detection:
  - replaced `if (packet.usage) group.complete = true`
  - with `usageOnlyTerminal = packet.usage && packet.choices.length === 0`
- response matching order:
  - sort the combined `responses` array by source line before the existing matching loop

### GREEN evidence for reviewer fixes

Focused regression command:

```powershell
node --test tests/parser.test.js --test-name-pattern="usage-bearing stream incomplete|matches ordinary and streamed responses by source order"
```

Result:

```text
1..10
# tests 10
# pass 10
# fail 0
```

Full parser suite command:

```powershell
node --test tests/parser.test.js
```

Result:

```text
1..10
# tests 10
# pass 10
# fail 0
```

### Self-review notes for reviewer fixes

- The original complete streamed fixture still passes, so the stricter terminal logic preserved the approved happy path.
- The new non-terminal usage test covers both completion semantics and streamed role aggregation.
- Sorting responses by line preserves the existing matching algorithm while restoring chronological stability.

### Fix commit

Planned commit message:

```text
fix: tighten streamed response matching
```

---

## Final reviewer follow-up

Status: DONE

Scope:
- Modified `tests/parser.test.js`
- Modified `parser.js`
- Appended this report entry
- Preserved unrelated worktree changes (`docs/superpowers/plans/` remained untouched)

### Reviewed issue addressed

- Ordinary `Generated prediction:` responses now prefer unmatched preceding ordinary requests where `body.stream !== true`.
- Synthesized stream responses continue to prefer unmatched preceding streamed requests where `body.stream === true`.
- If no preferred candidate exists, matching falls back to the previous candidate pool so older behavior remains available as a fallback path.
- Requests with absent `stream` fields are treated as ordinary requests.

### RED evidence for final reviewer fix

Command:

```powershell
node --test tests/parser.test.js --test-name-pattern="prefers ordinary requests for ordinary responses when a streamed request is newer"
```

Result:

```text
not ok 5 - prefers ordinary requests for ordinary responses when a streamed request is newer
  error: "Cannot read properties of null (reading 'content')"
```

Interpretation:
- The ordinary `Generated prediction:` response was still attaching to the newer streamed request, leaving the ordinary request without an output message.

### Regression test added

- `prefers ordinary requests for ordinary responses when a streamed request is newer`
  - fixture order: ordinary request, streamed request, ordinary response, streamed packet response
  - asserts the ordinary response stays on the ordinary call
  - asserts the streamed packet response stays on the streamed call

### Implementation summary for final reviewer fix

In `parser.js` I added:

- `isStreamRequest(request)` helper to classify requests by `body.stream === true`

I then updated the matching loop to:

- build the base eligible candidate set by time/model first
- prefer:
  - ordinary requests for ordinary responses
  - streamed requests for synthesized stream responses
- fall back to the base eligible set only when no preferred candidate exists

This keeps absent or false `stream` fields in the ordinary-request bucket.

### GREEN evidence for final reviewer fix

Focused regression command:

```powershell
node --test tests/parser.test.js --test-name-pattern="prefers ordinary requests for ordinary responses when a streamed request is newer"
```

Result:

```text
1..11
# tests 11
# pass 11
# fail 0
```

Full parser suite command:

```powershell
node --test tests/parser.test.js
```

Result:

```text
1..11
# tests 11
# pass 11
# fail 0
```

### Fix commit

Planned commit message:

```text
fix: prefer ordinary matches for ordinary responses
```

---

## Final re-review follow-up

Status: DONE

Scope:
- Modified `tests/parser.test.js`
- Modified `parser.js`
- Appended this report entry
- Preserved unrelated worktree changes (`docs/superpowers/plans/` remained untouched)

### Reviewed issues addressed

1. Completion semantics:
   - a usage-only packet no longer marks a stream complete by itself
   - completion now still requires a true terminal signal:
     - non-null `finish_reason`, or
     - `Finished streaming response` boundary
   - usage is still extracted into call metadata even when the stream remains incomplete
2. Null safety:
   - request preference filtering now uses a safe body (`r.data || {}`) before reading `model` or `stream`
   - malformed earlier requests no longer break candidate filtering for later valid requests

### RED evidence for final re-review fixes

Command:

```powershell
node --test tests/parser.test.js --test-name-pattern="usage-only packet stream incomplete|null-safe when a malformed request precedes a valid one"
```

Result:

```text
not ok 4 - keeps a usage-only packet stream incomplete without a finish chunk or boundary
  error: |-
    Expected values to be strictly equal:

    true !== false
```

Interpretation:
- The parser was still marking a stream complete from a usage-only packet even though no finish chunk or finished boundary existed.

Notes:
- The null-safe malformed-request regression was added in the same RED cycle and became the guard for the request-preference path after the fixture was tightened to produce an actual `request.data === null` event.

### Regression tests added

- `keeps a usage-only packet stream incomplete without a finish chunk or boundary`
  - proves `choices: []` plus `usage` alone is not a completion signal
  - confirms usage metadata is still preserved on the incomplete call
- `keeps matching null-safe when a malformed request precedes a valid one`
  - uses a malformed earlier request body `{ invalid }`, which parses as a request event with `data === null`
  - confirms a later valid request still matches its response without throwing

### Implementation summary for final re-review fixes

In `parser.js` I changed:

- `isStreamRequest(request)`:
  - now reads from `const body = request && request.data || {}`
- stream completion detection:
  - removed usage-only empty-choices packets as a completion condition
  - completion now depends only on:
    - a non-null `finish_reason`, or
    - a finished-stream boundary
- response candidate filtering:
  - both lifecycle and fallback candidate scans now use `const body = r.data || {}`
  - model comparisons no longer dereference `r.data.model` directly

### GREEN evidence for final re-review fixes

Focused regression command:

```powershell
node --test tests/parser.test.js --test-name-pattern="usage-only packet stream incomplete|null-safe when a malformed request precedes a valid one"
```

Result:

```text
1..13
# tests 13
# pass 13
# fail 0
```

Full parser suite command:

```powershell
node --test tests/parser.test.js
```

Result:

```text
1..13
# tests 13
# pass 13
# fail 0
```

### Fix commit

Planned commit message:

```text
fix: keep incomplete streams open without terminal signals
```
