# AI Detect — Per-Item Exclusions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `'Scope of Appointment.pdf'` skip in AI detection with a per-run, in-dialog checklist that lets the user choose which envelope items the AI should analyze.

**Architecture:** A new optional `excludeEnvelopeItemIds: string[]` flows from the dialog → API request → server function. The server filters the loop. No persistence, no schema migration, no settings page.

**Tech Stack:** TypeScript, React 19, Lingui (i18n), Hono (API), Zod (validation), shadcn/ui, Tailwind, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-04-26-ai-detect-skiplist-design.md`

**Branch:** `feature/ai-detect-skiplist` (already created from `main`; first commit is the revert of `5cbfa395`).

## File Structure

| File | Purpose | Change |
|---|---|---|
| `packages/lib/server-only/ai/envelope/detect-fields/index.ts` | Server orchestrator that loops over envelope items and calls the AI detector | Modify: add `excludeEnvelopeItemIds` option, filter loop |
| `apps/remix/server/api/ai/detect-fields.types.ts` | Zod schemas for the AI detect-fields endpoint | Modify: add `excludeEnvelopeItemIds` to request schema |
| `apps/remix/server/api/ai/detect-fields.ts` | Hono route handler | Modify: forward `excludeEnvelopeItemIds` to server function |
| `apps/remix/app/components/dialogs/ai-field-detection-dialog.tsx` | The PROMPT/PROCESSING/REVIEW dialog the user clicks "Detect with AI" to open | Modify: new `envelopeItems` prop + checklist UI + state + Detect-disable |
| `apps/remix/app/components/general/envelope-editor/envelope-editor-fields-page.tsx` | Parent component that renders the dialog | Modify: pass `envelopeItems={envelope.envelopeItems}` |
| `packages/app-tests/e2e/envelopes/ai-detect-exclusions.spec.ts` | Playwright e2e test (new file) | Create |

---

## Task 1: Server — add `excludeEnvelopeItemIds` to detect-fields options + filter loop

**Files:**
- Modify: `packages/lib/server-only/ai/envelope/detect-fields/index.ts`

**Why no unit test on this task:** the server function is an orchestrator that calls `prisma`, `getFileServerSide`, `pdfToImages`, and the Gemini SDK. A unit test requires extensive mocking for what reduces to a 3-line filter. The behavior is verified end-to-end in Task 8. The change is small and self-evident.

- [ ] **Step 1: Open the file and add the option to the type**

`packages/lib/server-only/ai/envelope/detect-fields/index.ts` lines 28–34 currently:

```ts
export type DetectFieldsFromEnvelopeOptions = {
  context?: string;
  envelopeId: string;
  userId: number;
  teamId: number;
  onProgress?: (progress: DetectFieldsProgress) => void;
};
```

Replace with:

```ts
export type DetectFieldsFromEnvelopeOptions = {
  context?: string;
  envelopeId: string;
  userId: number;
  teamId: number;
  /**
   * Envelope item IDs to exclude from AI detection. Items with these IDs are skipped entirely.
   * Default: [] (analyze all items).
   */
  excludeEnvelopeItemIds?: string[];
  onProgress?: (progress: DetectFieldsProgress) => void;
};
```

- [ ] **Step 2: Destructure the new option and filter the loop**

`packages/lib/server-only/ai/envelope/detect-fields/index.ts` lines 36–42 currently:

```ts
export const detectFieldsFromEnvelope = async ({
  context,
  envelopeId,
  userId,
  teamId,
  onProgress,
}: DetectFieldsFromEnvelopeOptions) => {
```

Replace with:

```ts
export const detectFieldsFromEnvelope = async ({
  context,
  envelopeId,
  userId,
  teamId,
  excludeEnvelopeItemIds,
  onProgress,
}: DetectFieldsFromEnvelopeOptions) => {
```

Lines 68–71 currently (after the revert of `5cbfa395`, this is just the bare `for` loop opener — confirm `Scope of Appointment.pdf` is no longer present):

```ts
  for (const item of envelope.envelopeItems) {
    const existingFields = await prisma.field.findMany({
```

Replace with:

```ts
  const excluded = new Set(excludeEnvelopeItemIds ?? []);

  for (const item of envelope.envelopeItems) {
    if (excluded.has(item.id)) {
      continue;
    }
    const existingFields = await prisma.field.findMany({
```

- [ ] **Step 3: Type-check**

Run: `cd packages/lib && npx tsc --noEmit`

Expected: PASS (no new errors).

- [ ] **Step 4: Commit**

```bash
git add packages/lib/server-only/ai/envelope/detect-fields/index.ts
git commit -m "feat(ai-detect): add excludeEnvelopeItemIds option to skip envelope items"
```

---

## Task 2: API types — extend Zod request schema

**Files:**
- Modify: `apps/remix/server/api/ai/detect-fields.types.ts`

- [ ] **Step 1: Add the new field to `ZDetectFieldsRequestSchema`**

`apps/remix/server/api/ai/detect-fields.types.ts` lines 8–17 currently:

```ts
export const ZDetectFieldsRequestSchema = z.object({
  envelopeId: z.string().min(1).describe('The ID of the envelope to detect fields from.'),
  teamId: z.number().describe('The ID of the team the envelope belongs to.'),
  context: z
    .string()
    .optional()
    .describe(
      'Optional context about recipients to help map fields (e.g., "David is the Employee, Lucas is the Manager").',
    ),
});
```

Replace with:

```ts
export const ZDetectFieldsRequestSchema = z.object({
  envelopeId: z.string().min(1).describe('The ID of the envelope to detect fields from.'),
  teamId: z.number().describe('The ID of the team the envelope belongs to.'),
  context: z
    .string()
    .optional()
    .describe(
      'Optional context about recipients to help map fields (e.g., "David is the Employee, Lucas is the Manager").',
    ),
  excludeEnvelopeItemIds: z
    .array(z.string())
    .optional()
    .describe(
      'Optional list of envelope item IDs to exclude from AI detection. Items with these IDs are skipped entirely.',
    ),
});
```

- [ ] **Step 2: Type-check**

Run: `cd apps/remix && npx tsc --noEmit`

Expected: PASS. Because `TDetectFieldsRequest` is `z.infer<typeof ZDetectFieldsRequestSchema>`, the new optional field automatically flows into the client (`detect-fields.client.ts`) without further changes.

- [ ] **Step 3: Commit**

```bash
git add apps/remix/server/api/ai/detect-fields.types.ts
git commit -m "feat(ai-detect): add excludeEnvelopeItemIds to API request schema"
```

---

## Task 3: API route — forward the new param to the server function

**Files:**
- Modify: `apps/remix/server/api/ai/detect-fields.ts`

- [ ] **Step 1: Destructure the new field and pass it through**

`apps/remix/server/api/ai/detect-fields.ts` line 23 currently:

```ts
      const { envelopeId, teamId, context } = c.req.valid('json');
```

Replace with:

```ts
      const { envelopeId, teamId, context, excludeEnvelopeItemIds } = c.req.valid('json');
```

`apps/remix/server/api/ai/detect-fields.ts` lines 76–91 currently:

```ts
          const allFields = await detectFieldsFromEnvelope({
            context,
            envelopeId,
            userId: session.user.id,
            teamId: team.id,
            onProgress: (progress) => {
              void stream.writeln(
                JSON.stringify({
                  type: 'progress',
                  pagesProcessed: progress.pagesProcessed,
                  totalPages: progress.totalPages,
                  fieldsDetected: progress.fieldsDetected,
                }),
              );
            },
          });
```

Replace with:

```ts
          const allFields = await detectFieldsFromEnvelope({
            context,
            envelopeId,
            userId: session.user.id,
            teamId: team.id,
            excludeEnvelopeItemIds,
            onProgress: (progress) => {
              void stream.writeln(
                JSON.stringify({
                  type: 'progress',
                  pagesProcessed: progress.pagesProcessed,
                  totalPages: progress.totalPages,
                  fieldsDetected: progress.fieldsDetected,
                }),
              );
            },
          });
```

- [ ] **Step 2: Type-check**

Run: `cd apps/remix && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/remix/server/api/ai/detect-fields.ts
git commit -m "feat(ai-detect): forward excludeEnvelopeItemIds from route to server"
```

---

## Task 4: Dialog — add `envelopeItems` prop, exclusion state, reset on close

**Files:**
- Modify: `apps/remix/app/components/dialogs/ai-field-detection-dialog.tsx`

This task adds the data plumbing without rendering anything new. Subsequent tasks add the visible UI.

- [ ] **Step 1: Add the prop to the dialog's prop type**

`apps/remix/app/components/dialogs/ai-field-detection-dialog.tsx` lines 31–37 currently:

```ts
type AiFieldDetectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (fields: NormalizedFieldWithContext[]) => void;
  envelopeId: string;
  teamId: number;
};
```

Replace with:

```ts
type AiFieldDetectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (fields: NormalizedFieldWithContext[]) => void;
  envelopeId: string;
  teamId: number;
  envelopeItems: { id: string; title: string; order: number }[];
};
```

- [ ] **Step 2: Destructure the new prop in the component signature**

Lines 61–67 currently:

```ts
export const AiFieldDetectionDialog = ({
  open,
  onOpenChange,
  onComplete,
  envelopeId,
  teamId,
}: AiFieldDetectionDialogProps) => {
```

Replace with:

```ts
export const AiFieldDetectionDialog = ({
  open,
  onOpenChange,
  onComplete,
  envelopeId,
  teamId,
  envelopeItems,
}: AiFieldDetectionDialogProps) => {
```

- [ ] **Step 3: Add the exclusion state and a sorted-items memo**

Right after the existing `useState` block at line 75 (after `const [progress, setProgress] = useState<DetectFieldsProgressEvent | null>(null);`), add:

```ts
  const [excludedItemIds, setExcludedItemIds] = useState<Set<string>>(() => new Set());

  const sortedItems = useMemo(
    () => [...envelopeItems].sort((a, b) => a.order - b.order),
    [envelopeItems],
  );
```

(`useMemo` is already imported at line 1.)

- [ ] **Step 4: Reset the exclusion set on close**

Lines 130–137 currently:

```ts
  const onClose = () => {
    onOpenChange(false);
    setState('PROMPT');
    setDetectedFields([]);
    setError(null);
    setContext('');
    setProgress(null);
  };
```

Replace with:

```ts
  const onClose = () => {
    onOpenChange(false);
    setState('PROMPT');
    setDetectedFields([]);
    setError(null);
    setContext('');
    setProgress(null);
    setExcludedItemIds(new Set());
  };
```

Lines 122–128 currently (`onAddFields`):

```ts
  const onAddFields = () => {
    onComplete(detectedFields);
    onOpenChange(false);
    setState('PROMPT');
    setDetectedFields([]);
    setContext('');
  };
```

Replace with:

```ts
  const onAddFields = () => {
    onComplete(detectedFields);
    onOpenChange(false);
    setState('PROMPT');
    setDetectedFields([]);
    setContext('');
    setExcludedItemIds(new Set());
  };
```

- [ ] **Step 5: Type-check (partial — parent will error)**

Run: `cd apps/remix && npx tsc --noEmit`

Expected: ONE error in `envelope-editor-fields-page.tsx` complaining that `envelopeItems` is missing from the dialog's props. This is expected; the parent gets fixed in Task 7. **Do not** modify the parent in this task to silence the error — the next two dialog tasks (5 and 6) need to land first so the dialog interface is stable before the parent is wired up.

If you see any other type errors (e.g., in the dialog file itself), stop and fix before committing.

- [ ] **Step 6: Commit**

```bash
git add apps/remix/app/components/dialogs/ai-field-detection-dialog.tsx
git commit -m "feat(ai-detect-dialog): add envelopeItems prop and exclusion state"
```

---

## Task 5: Dialog — render the checklist + send `excludeEnvelopeItemIds`

**Files:**
- Modify: `apps/remix/app/components/dialogs/ai-field-detection-dialog.tsx`

- [ ] **Step 1: Import the Checkbox primitive**

At the top of the file (around line 11–20 with the other shadcn/ui imports), add:

```ts
import { Checkbox } from '@documenso/ui/primitives/checkbox';
```

(Verified: `packages/ui/primitives/checkbox.tsx` exists in this repo.)

- [ ] **Step 2: Render the checklist in the PROMPT state**

In the PROMPT block (`state === 'PROMPT'`), the current body is lines 165–217. Find the `<div className="space-y-4">` block (line 173) and insert the checklist directly above the existing Context label section.

Lines 173–207 currently:

```tsx
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                <Trans>
                  We'll scan your document to find form fields like signature lines, text inputs,
                  checkboxes, and more. Detected fields will be suggested for you to review.
                </Trans>
              </p>

              <Alert className="flex items-center gap-2 space-y-0" variant="neutral">
                <ShieldCheckIcon className="h-5 w-5 stroke-green-600" />
                <AlertDescription className="mt-0">
                  <Trans>
                    Your document is processed securely using AI services that don't retain your
                    data.
                  </Trans>
                </AlertDescription>
              </Alert>

              <div className="space-y-1.5">
                <Label htmlFor="context">
                  <Trans>Context</Trans>
                </Label>
                <Textarea
                  id="context"
                  placeholder={_(msg`David is the Employee, Lucas is the Manager`)}
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  rows={2}
                  className="resize-none"
                />
                <p className="text-xs text-muted-foreground">
                  <Trans>Help the AI assign fields to the right recipients.</Trans>
                </p>
              </div>
            </div>
```

Replace with:

```tsx
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                <Trans>
                  We'll scan your document to find form fields like signature lines, text inputs,
                  checkboxes, and more. Detected fields will be suggested for you to review.
                </Trans>
              </p>

              <Alert className="flex items-center gap-2 space-y-0" variant="neutral">
                <ShieldCheckIcon className="h-5 w-5 stroke-green-600" />
                <AlertDescription className="mt-0">
                  <Trans>
                    Your document is processed securely using AI services that don't retain your
                    data.
                  </Trans>
                </AlertDescription>
              </Alert>

              {sortedItems.length >= 2 && (
                <fieldset className="space-y-1.5">
                  <legend className="text-sm font-medium">
                    <Trans>Analyze these documents</Trans>
                  </legend>
                  <ul className="divide-y rounded-md border">
                    {sortedItems.map((item) => {
                      const checkboxId = `ai-detect-include-${item.id}`;
                      const isIncluded = !excludedItemIds.has(item.id);
                      return (
                        <li key={item.id} className="flex items-center gap-3 px-3 py-2">
                          <Checkbox
                            id={checkboxId}
                            checked={isIncluded}
                            onCheckedChange={(checked) => {
                              setExcludedItemIds((prev) => {
                                const next = new Set(prev);
                                if (checked) {
                                  next.delete(item.id);
                                } else {
                                  next.add(item.id);
                                }
                                return next;
                              });
                            }}
                          />
                          <Label htmlFor={checkboxId} className="flex-1 cursor-pointer text-sm font-normal">
                            {item.title}
                          </Label>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="context">
                  <Trans>Context</Trans>
                </Label>
                <Textarea
                  id="context"
                  placeholder={_(msg`David is the Employee, Lucas is the Manager`)}
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  rows={2}
                  className="resize-none"
                />
                <p className="text-xs text-muted-foreground">
                  <Trans>Help the AI assign fields to the right recipients.</Trans>
                </p>
              </div>
            </div>
```

- [ ] **Step 3: Send the exclusion list in the API request**

Lines 84–89 currently inside `onDetectClick`:

```ts
      await detectFields({
        request: {
          envelopeId,
          teamId,
          context: context || undefined,
        },
```

Replace with:

```ts
      await detectFields({
        request: {
          envelopeId,
          teamId,
          context: context || undefined,
          excludeEnvelopeItemIds: excludedItemIds.size > 0 ? [...excludedItemIds] : undefined,
        },
```

(Sending `undefined` when there are no exclusions keeps the API call body minimal and matches the Zod schema's `.optional()`.)

- [ ] **Step 4: Update the `useCallback` dep list**

`onDetectClick` at line 120 currently:

```ts
  }, [envelopeId, teamId, context]);
```

Replace with:

```ts
  }, [envelopeId, teamId, context, excludedItemIds]);
```

- [ ] **Step 5: Manual smoke**

Skip in this step (covered by E2E in Task 8).

- [ ] **Step 6: Commit**

```bash
git add apps/remix/app/components/dialogs/ai-field-detection-dialog.tsx
git commit -m "feat(ai-detect-dialog): render exclusion checklist when 2+ items"
```

---

## Task 6: Dialog — Select all / Deselect all + disable Detect button when none included

**Files:**
- Modify: `apps/remix/app/components/dialogs/ai-field-detection-dialog.tsx`

- [ ] **Step 1: Compute derived flags**

Inside the component body, just below the existing `sortedItems` memo from Task 4, add:

```ts
  const allExcluded = sortedItems.length > 0 && excludedItemIds.size === sortedItems.length;
  const showSelectAllToggle = sortedItems.length >= 3;
```

- [ ] **Step 2: Add the Select all / Deselect all toggle**

Inside the `fieldset` from Task 5, replace the `<legend>` block with a header row that holds the toggle on the right.

Replace:

```tsx
              {sortedItems.length >= 2 && (
                <fieldset className="space-y-1.5">
                  <legend className="text-sm font-medium">
                    <Trans>Analyze these documents</Trans>
                  </legend>
```

With:

```tsx
              {sortedItems.length >= 2 && (
                <fieldset className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <legend className="text-sm font-medium">
                      <Trans>Analyze these documents</Trans>
                    </legend>
                    {showSelectAllToggle && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto px-2 py-1 text-xs"
                        onClick={() => {
                          setExcludedItemIds((prev) => {
                            // If everything is currently included, deselect all.
                            // Otherwise, select all.
                            if (prev.size === 0) {
                              return new Set(sortedItems.map((i) => i.id));
                            }
                            return new Set();
                          });
                        }}
                      >
                        {excludedItemIds.size === 0 ? (
                          <Trans>Deselect all</Trans>
                        ) : (
                          <Trans>Select all</Trans>
                        )}
                      </Button>
                    )}
                  </div>
```

- [ ] **Step 3: Disable Detect when all items excluded**

Lines 209–216 currently (the PROMPT footer):

```tsx
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                <Trans>Skip</Trans>
              </Button>
              <Button type="button" onClick={onDetectClick}>
                <Trans>Detect</Trans>
              </Button>
            </DialogFooter>
```

Replace with:

```tsx
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                <Trans>Skip</Trans>
              </Button>
              <Button
                type="button"
                onClick={onDetectClick}
                disabled={allExcluded}
                title={allExcluded ? _(msg`Select at least one document to analyze`) : undefined}
              >
                <Trans>Detect</Trans>
              </Button>
            </DialogFooter>
```

- [ ] **Step 4: Type-check**

Run: `cd apps/remix && npx tsc --noEmit`

Expected: PASS (the parent will still type-error on the missing `envelopeItems` prop until Task 7).

- [ ] **Step 5: Commit**

```bash
git add apps/remix/app/components/dialogs/ai-field-detection-dialog.tsx
git commit -m "feat(ai-detect-dialog): add select-all toggle and disable detect when none selected"
```

---

## Task 7: Parent — pass `envelopeItems` to the dialog

**Files:**
- Modify: `apps/remix/app/components/general/envelope-editor/envelope-editor-fields-page.tsx`

- [ ] **Step 1: Pass the new prop**

`apps/remix/app/components/general/envelope-editor/envelope-editor-fields-page.tsx` lines 324–330 currently:

```tsx
                <AiFieldDetectionDialog
                  open={isAiFieldDialogOpen}
                  onOpenChange={setIsAiFieldDialogOpen}
                  onComplete={onFieldDetectionComplete}
                  envelopeId={envelope.id}
                  teamId={envelope.teamId}
                />
```

Replace with:

```tsx
                <AiFieldDetectionDialog
                  open={isAiFieldDialogOpen}
                  onOpenChange={setIsAiFieldDialogOpen}
                  onComplete={onFieldDetectionComplete}
                  envelopeId={envelope.id}
                  teamId={envelope.teamId}
                  envelopeItems={envelope.envelopeItems.map((item) => ({
                    id: item.id,
                    title: item.title,
                    order: item.order,
                  }))}
                />
```

(The mapping narrows the prop to the three fields the dialog cares about — keeps the dialog's prop type tight rather than coupling it to the full Prisma `EnvelopeItem` shape.)

- [ ] **Step 2: Type-check**

Run: `cd apps/remix && npx tsc --noEmit`

Expected: PASS, repo-wide.

- [ ] **Step 3: Commit**

```bash
git add apps/remix/app/components/general/envelope-editor/envelope-editor-fields-page.tsx
git commit -m "feat(envelope-editor): pass envelopeItems to AiFieldDetectionDialog"
```

---

## Task 8: E2E test — exclusion is sent to the API

**Files:**
- Create: `packages/app-tests/e2e/envelopes/ai-detect-exclusions.spec.ts`

This test does NOT exercise real Gemini calls. Instead it intercepts `POST /api/ai/detect-fields`, asserts the request body, and returns a fake streaming response.

- [ ] **Step 1: Create the spec file with the seed helper and one happy-path test**

Create `packages/app-tests/e2e/envelopes/ai-detect-exclusions.spec.ts`:

```ts
/**
 * E2E test for AI field detection per-item exclusions.
 *
 * Strategy: seed a DRAFT envelope with two envelope items, navigate to the editor,
 * open the "Detect with AI" dialog, uncheck one item, click Detect. Intercept the
 * POST /api/ai/detect-fields request and assert that the request body contains
 * excludeEnvelopeItemIds == [<unchecked item id>].
 *
 * The AI service is never actually called — the route is fulfilled by Playwright
 * with a fake streaming response containing zero detected fields.
 */
import { expect, test } from '@playwright/test';

import { prefixedId } from '@documenso/lib/universal/id';
import { prisma } from '@documenso/prisma';
import { DocumentDataType, DocumentStatus, EnvelopeType } from '@documenso/prisma/client';
import { seedUser } from '@documenso/prisma/seed/users';

import { apiSignin } from '../fixtures/authentication';

async function seedDraftEnvelopeWithTwoItems(ownerUserId: number, teamId: number) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const examplePdf = fs
    .readFileSync(path.join(__dirname, '../../../../assets/example.pdf'))
    .toString('base64');

  const dataA = await prisma.documentData.create({
    data: { type: DocumentDataType.BYTES_64, data: examplePdf, initialData: examplePdf },
  });
  const dataB = await prisma.documentData.create({
    data: { type: DocumentDataType.BYTES_64, data: examplePdf, initialData: examplePdf },
  });

  const envelope = await prisma.envelope.create({
    data: {
      id: prefixedId('envelope'),
      type: EnvelopeType.DOCUMENT,
      status: DocumentStatus.DRAFT,
      title: 'AI Detect Exclusions Test',
      userId: ownerUserId,
      teamId,
      envelopeItems: {
        create: [
          { id: prefixedId('item'), title: 'Keep.pdf', order: 0, documentDataId: dataA.id },
          { id: prefixedId('item'), title: 'Skip.pdf', order: 1, documentDataId: dataB.id },
        ],
      },
    },
    include: { envelopeItems: { orderBy: { order: 'asc' } } },
  });

  return envelope;
}

test('uncheck one envelope item -> excludeEnvelopeItemIds contains its id', async ({ page }) => {
  const { user, team } = await seedUser();
  const envelope = await seedDraftEnvelopeWithTwoItems(user.id, team.id);
  const skipItem = envelope.envelopeItems.find((i) => i.title === 'Skip.pdf')!;

  await apiSignin({ page, email: user.email });

  // Mock the API route: fulfill with a fake "complete" stream event, zero fields.
  await page.route('**/api/ai/detect-fields', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: JSON.stringify({ type: 'complete', fields: [] }) + '\n',
    });
  });

  // Navigate to the envelope editor (fields step).
  await page.goto(`/t/${team.url}/documents/${envelope.id}/edit`);

  // Open the AI detect dialog.
  await page.getByRole('button', { name: /detect with ai/i }).click();

  // Wait for checklist to render.
  await expect(page.getByText(/analyze these documents/i)).toBeVisible();

  // Uncheck "Skip.pdf".
  await page.getByLabel('Skip.pdf').click();

  // Set up the waiter BEFORE the click so we don't race the request.
  const requestPromise = page.waitForRequest(
    (req) => req.url().includes('/api/ai/detect-fields') && req.method() === 'POST',
  );

  // Click Detect.
  await page.getByRole('button', { name: /^detect$/i }).click();

  const request = await requestPromise;
  const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;

  expect(body.excludeEnvelopeItemIds).toEqual([skipItem.id]);
  expect(body.envelopeId).toBe(envelope.id);
});
```

**Note on the editor route:** the path `/t/${team.url}/documents/${envelope.id}/edit` follows the pattern in the conditional-field-visibility e2e test. If the actual editor URL is different in this codebase (verify by inspecting `apps/remix/app/routes/`), adjust the navigation accordingly. Do NOT silently change the test logic — the route is the only piece that may need adjustment.

- [ ] **Step 2: Run the test**

Run: `cd packages/app-tests && npx playwright test e2e/envelopes/ai-detect-exclusions.spec.ts`

Expected: PASS.

If the test fails because of selector mismatch (e.g. the "Detect with AI" button copy doesn't match), discover the correct selector by running with `--headed` and inspecting the page. Adjust selectors until the test passes. Do NOT remove the request-body assertion — that is the core of the test.

- [ ] **Step 3: Commit**

```bash
git add packages/app-tests/e2e/envelopes/ai-detect-exclusions.spec.ts
git commit -m "test(e2e): ai detect sends excludeEnvelopeItemIds for unchecked items"
```

---

## Task 9: Manual smoke + push

- [ ] **Step 1: Start dev server**

Run: `npm run dev` (root). Wait for the app to be reachable.

- [ ] **Step 2: Manual flow check**

1. Sign in.
2. Create a new envelope and upload **two** PDFs.
3. Proceed to the Fields step.
4. Click **Detect with AI**.
5. Verify the dialog shows the checklist labeled "Analyze these documents" with both PDF titles, both checked.
6. Uncheck one. Click **Detect**.
7. After the run completes, verify in the editor that fields landed only on the checked PDF, not the unchecked one. (You can navigate between envelope items in the editor sidebar.)
8. Reopen the dialog. Verify the checklist is reset (both checked again).
9. Test single-item case: create a new envelope with **one** PDF. Open the dialog. Verify no checklist is shown (just the existing prompt with the Context textarea).
10. Test ≥3-item case: upload three PDFs. Verify the "Select all / Deselect all" toggle appears and toggles correctly.
11. Test all-excluded case: uncheck every item. Verify the Detect button is disabled and the tooltip reads "Select at least one document to analyze."

If any of the manual checks fail, fix the issue, add a regression test if applicable, and commit before continuing.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feature/ai-detect-skiplist
```

---

## Self-Review Checklist (for the implementer, before declaring done)

- [ ] All 9 tasks committed in order, each commit small and focused.
- [ ] No leftover hardcoded title checks anywhere in `detect-fields/`.
- [ ] `ZDetectFieldsRequestSchema` includes `excludeEnvelopeItemIds`.
- [ ] Dialog reset on close also clears `excludedItemIds`.
- [ ] Dialog reset on Add Fields (success path) also clears `excludedItemIds`.
- [ ] E2E test passes locally.
- [ ] Manual smoke covered all three branches: 1-item / 2-items / 3+ items.
- [ ] No new dependencies added.
- [ ] No `console.log` left behind in dialog code.
