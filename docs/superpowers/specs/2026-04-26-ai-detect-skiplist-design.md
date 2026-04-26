# AI Detect — Per-Item Exclusions (design)

**Date:** 2026-04-26
**Branch:** `feature/ai-detect-skiplist`
**Replaces:** the hardcoded `'Scope of Appointment.pdf'` skip in `packages/lib/server-only/ai/envelope/detect-fields/index.ts` (introduced in `5cbfa395`, reverted as the first commit of this branch).

## Problem

`detectFieldsFromEnvelope` currently has a hardcoded skip:

```ts
if (item.title === 'Scope of Appointment.pdf') {
  continue;
}
```

This is a brittle string match in core detection logic. It silently excludes one specific filename, with no way for users to control which envelope items the AI analyzes. Anyone uploading the same PDF under a slightly different name (`scope of appointment.pdf`, `SOA.pdf`, `Scope of Appointment (2).pdf`) gets unexpected behavior.

## Goal

Let the user choose, **at the moment they kick off AI detection,** which envelope items to analyze and which to exclude. No persistence, no settings page, no filename pattern matching — just a per-run choice in the existing detection dialog.

## Non-goals

- Team-level or organization-level skiplists. (Out of scope; can be added later if patterns emerge.)
- Persistent per-item flags on `EnvelopeItem`. (Out of scope; the choice is ephemeral.)
- Filename pattern matching (substring, regex, glob). The user picks specific items by ID, not patterns.
- Audit log entries for which items were excluded.

## Decisions locked from brainstorm

1. **Scope:** per-envelope, per-run (option B from the brainstorm).
2. **UI:** in the existing `AiFieldDetectionDialog`'s `PROMPT` state, above the Context textarea.
3. **Default:** all envelope items checked (included). User unchecks items to exclude them.
4. **Persistence:** none. Closing/reopening the dialog forgets prior unchecks.
5. **No audit trail** for excluded items.

## Architecture

```
┌─ AiFieldDetectionDialog (PROMPT) ─────────────────────────────┐
│  • Checklist of envelope items (all checked by default)       │
│  • Existing Context textarea (unchanged)                       │
│  • Detect button → POST /api/ai/detect-fields                  │
│       body: { envelopeId, teamId, context,                     │
│               excludeEnvelopeItemIds: string[] }               │
└────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─ apps/remix/server/api/ai/detect-fields.ts ───────────────────┐
│  • Zod schema gains optional excludeEnvelopeItemIds            │
│  • Forwards to detectFieldsFromEnvelope(...)                   │
└────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─ packages/lib/server-only/ai/envelope/detect-fields/index.ts ─┐
│  • Loop over envelope.envelopeItems                            │
│  • Skip any item whose id is in excludeEnvelopeItemIds         │
│  • Hardcoded title === 'Scope of Appointment.pdf' check gone   │
└────────────────────────────────────────────────────────────────┘
```

## Server changes

### `detectFieldsFromEnvelope`

File: `packages/lib/server-only/ai/envelope/detect-fields/index.ts`

```ts
export type DetectFieldsFromEnvelopeOptions = {
  context?: string;
  envelopeId: string;
  userId: number;
  teamId: number;
  excludeEnvelopeItemIds?: string[];   // NEW
  onProgress?: (progress: DetectFieldsProgress) => void;
};

// inside the for-loop:
for (const item of envelope.envelopeItems) {
  if (excludeEnvelopeItemIds?.includes(item.id)) {
    continue;
  }
  // ... existing logic
}
```

Default `[]` semantics: omitted or empty array → analyze all items (matches current behavior with no exclusions). The hardcoded `Scope of Appointment.pdf` check is removed (already reverted).

### API route

File: `apps/remix/server/api/ai/detect-fields.ts` and its `.types.ts`.

Request schema gains:

```ts
excludeEnvelopeItemIds: z.array(z.string()).optional(),
```

The handler forwards the array unchanged to `detectFieldsFromEnvelope`.

**Why exclude rather than include:** an empty `excludeEnvelopeItemIds` cleanly means "analyze everything," which is the desired default. An empty `includeEnvelopeItemIds` would mean "analyze nothing," which is a footgun.

## UI changes

### `AiFieldDetectionDialog`

File: `apps/remix/app/components/dialogs/ai-field-detection-dialog.tsx`

Add a new prop `envelopeItems: { id: string; title: string }[]` (passed in by the parent, which already has them in scope for the editor). The parent is `envelope-editor-fields-page.tsx` — it already loads envelope data and renders the editor against it.

In the `PROMPT` state:

- **If `envelopeItems.length <= 1`:** render the existing dialog body unchanged. There's no choice to make.
- **If `envelopeItems.length >= 2`:**
  - Above the Context textarea, render a section labeled **"Analyze these documents"**.
  - Each item is a row: checkbox + filename (`item.title`).
  - All items checked by default.
  - If `length >= 3`, show a small **Select all / Deselect all** toggle on the right of the section header.
  - State is held locally in the dialog: `const [excludedItemIds, setExcludedItemIds] = useState<Set<string>>(new Set())`.
  - On Detect click: send `excludeEnvelopeItemIds: [...excludedItemIds]` to the API.
  - On dialog close (any state): reset to empty Set.
- **Disable the Detect button** if all items are unchecked (i.e., `excludedItemIds.size === envelopeItems.length`).

### Naming — avoiding "skip" overload

The existing dialog already has a **"Skip"** button (line 211) meaning "skip the AI detection step entirely." Reusing the word "skip" for the per-item toggle would confuse users. The toggle is framed as positive inclusion ("Analyze these documents"), and unchecking means exclusion. The label and copy avoid the word "skip" entirely.

### i18n

All new copy goes through Lingui (`<Trans>` / `msg`) like the rest of the dialog.

### Accessibility

- Each checkbox has an associated label tied via `htmlFor`/`id`.
- The section uses a `<fieldset>` + `<legend>` for screen readers.
- The "Select all" affordance is a button, not a hidden checkbox.

## Edge cases

| Case | Behavior |
|---|---|
| Envelope has 0 items | Existing flow already prevents this; not handled in dialog. |
| Envelope has exactly 1 item | Dialog renders without checklist (no choice). Send empty `excludeEnvelopeItemIds`. |
| User unchecks every item | Detect button disabled with tooltip "Select at least one document to analyze." |
| API receives `excludeEnvelopeItemIds` containing IDs not in the envelope | Server silently ignores unknown IDs (filter is `Array.includes`, no error). |
| API receives `excludeEnvelopeItemIds` containing all of the envelope's items | Loop iterates, skips all → `allFields` is `[]` → returns empty list. Harmless. |
| Concurrent mutation: items added/removed between dialog open and Detect click | Rare. Server uses `envelope.envelopeItems` at request time, so any new items are analyzed regardless of the dialog's stale list. Acceptable. |
| Zod validation of `excludeEnvelopeItemIds` | Must be array of strings. Empty array allowed. Field is optional. |

## Test plan

### Unit

- `detectFieldsFromEnvelope`: with `excludeEnvelopeItemIds: [item1.id]`, only items != `item1` get processed. Verify by mocking `detectFieldsFromPdf` and asserting call count + arguments.
- `detectFieldsFromEnvelope`: with `excludeEnvelopeItemIds: []` or omitted, all items processed.
- `detectFieldsFromEnvelope`: with all IDs excluded, returns `[]`, no calls to `detectFieldsFromPdf`.

### E2E

- Envelope with 2 items: open dialog, uncheck one, click Detect → only the checked item's pages get fields. (Mock the AI response to a deterministic shape.)
- Envelope with 1 item: dialog renders without checklist; Detect works as before.
- Envelope with ≥3 items: "Deselect all" disables the Detect button; "Select all" re-enables it.

### Manual

- Upload a real-world envelope with multiple PDFs; verify the unchecked file's pages aren't analyzed (no fields land on it after Detect).

## Out of scope (explicitly)

- Persisting the choice across dialog opens.
- Team or org-level skiplists or default exclusions.
- Filename pattern matching.
- Showing exclusion history in any UI or audit log.
- Refactoring the existing detection pipeline beyond removing the hardcoded check and adding the param.

## Implementation order

1. **Already done on this branch:** revert `5cbfa395` (the hardcoded `Scope of Appointment.pdf` check).
2. Add `excludeEnvelopeItemIds` to `DetectFieldsFromEnvelopeOptions` and apply the filter in the loop. Unit tests.
3. Add `excludeEnvelopeItemIds` to the API route's Zod schema and forward to the server function.
4. Update the dialog: new prop, checklist UI, Detect-button disable logic, i18n strings.
5. Update the parent (`envelope-editor-fields-page.tsx`) to pass envelope items to the dialog.
6. E2E test.
7. Manual smoke test.
