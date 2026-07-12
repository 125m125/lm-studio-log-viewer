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
