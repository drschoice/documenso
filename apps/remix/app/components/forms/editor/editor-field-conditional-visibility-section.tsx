import { useEffect, useMemo, useRef } from 'react';

import { Trans } from '@lingui/react/macro';
import type { FieldType } from '@prisma/client';
import { CheckIcon, MousePointerClickIcon, XIcon } from 'lucide-react';

import type { TLocalField } from '@documenso/lib/client-only/hooks/use-editor-fields';
import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import {
  VISIBILITY_ELIGIBLE_FIELD_TYPES,
  getFieldStableId,
  getTriggerOptionValues,
  hasDependentRule,
  operatorForTriggerType,
  removeDependentRule,
} from '@documenso/lib/universal/field-visibility/authoring';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Label } from '@documenso/ui/primitives/label';

type Props = {
  /** The selected radio/checkbox/dropdown field acting as the trigger. */
  triggerField: TLocalField;
};

const fieldLabel = (field: TLocalField): string => {
  const label = (field.fieldMeta as { label?: string } | undefined)?.label?.trim();

  if (label) {
    return label;
  }

  const type = field.type;
  const typeName = type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ');

  return `${typeName} · p.${field.page}`;
};

/**
 * Trigger-centric conditional-visibility authoring (PandaDoc-style): for each
 * option of the selected radio/checkbox/dropdown, pick the fields that should
 * be revealed when that option is selected. Selections are stored as
 * `visibility` rules on the DEPENDENT fields (see field-visibility/authoring).
 */
export const EditorFieldConditionalVisibilitySection = ({ triggerField }: Props) => {
  const { editorFields, visibilityPickMode } = useCurrentEnvelopeEditor();

  const triggerStableId = getFieldStableId(triggerField.fieldMeta);
  const operator = operatorForTriggerType(triggerField.type);
  const recipientId = triggerField.recipientId;

  // Keep the latest pick-mode reachable from the unmount cleanup without
  // re-running the effect on every pick-mode change.
  const pickModeRef = useRef(visibilityPickMode);
  pickModeRef.current = visibilityPickMode;

  // Exit pick-mode when the author navigates away from this trigger.
  useEffect(() => {
    const formId = triggerField.formId;

    return () => {
      if (pickModeRef.current.active?.triggerFormId === formId) {
        pickModeRef.current.exit();
      }
    };
  }, [triggerField.formId]);

  const options = useMemo(() => {
    const seen = new Set<string>();

    return getTriggerOptionValues(triggerField.fieldMeta)
      .map((value) => value.trim())
      .filter((value) => {
        if (value.length === 0 || seen.has(value)) {
          return false;
        }

        seen.add(value);
        return true;
      });
  }, [triggerField.fieldMeta]);

  const eligibleDependents = useMemo(
    () =>
      editorFields.localFields.filter(
        (field) =>
          field.recipientId === recipientId &&
          field.formId !== triggerField.formId &&
          VISIBILITY_ELIGIBLE_FIELD_TYPES.has(field.type as FieldType),
      ),
    [editorFields.localFields, recipientId, triggerField.formId],
  );

  const activeForThisTrigger =
    visibilityPickMode.active?.triggerFormId === triggerField.formId
      ? visibilityPickMode.active
      : null;

  const removeDependent = (dependent: TLocalField, value: string) => {
    if (!triggerStableId) {
      return;
    }

    editorFields.updateFieldByFormId(dependent.formId, {
      fieldMeta: removeDependentRule(dependent.fieldMeta, { triggerStableId, value }),
    });
  };

  const togglePick = (value: string) => {
    if (!triggerStableId) {
      return;
    }

    if (activeForThisTrigger?.value === value) {
      visibilityPickMode.exit();
      return;
    }

    visibilityPickMode.enter({
      triggerFormId: triggerField.formId,
      triggerStableId,
      triggerRecipientId: recipientId,
      value,
      operator,
    });
  };

  return (
    <div
      data-testid="conditional-visibility-section"
      className="mt-4 rounded-md border border-border bg-muted/40 p-3"
    >
      <Label className="text-sm font-semibold">
        <Trans>Conditional visibility</Trans>
      </Label>

      <p className="mt-1 text-xs text-muted-foreground">
        <Trans>Choose which fields appear when an option is selected.</Trans>
      </p>

      {!triggerStableId || options.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          <Trans>Add options to this field to create visibility conditions.</Trans>
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {options.map((value, index) => {
            const dependents = eligibleDependents.filter((field) =>
              hasDependentRule(field.fieldMeta, triggerStableId, value),
            );
            const isPicking = activeForThisTrigger?.value === value;

            return (
              <div
                key={value}
                data-testid={`visibility-condition-${index}`}
                className={cn(
                  'rounded border bg-background p-2',
                  isPicking && 'border-primary ring-1 ring-primary',
                )}
              >
                <p className="text-xs font-medium">
                  <Trans>
                    When <span className="font-semibold">“{value}”</span> is selected, show:
                  </Trans>
                </p>

                {dependents.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {dependents.map((dependent) => (
                      <span
                        key={dependent.formId}
                        className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs"
                      >
                        {fieldLabel(dependent)}
                        <button
                          type="button"
                          aria-label="Remove field"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => removeDependent(dependent, value)}
                        >
                          <XIcon className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  !isPicking && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      <Trans>No fields yet.</Trans>
                    </p>
                  )
                )}

                {isPicking && (
                  <p className="mt-2 text-[11px] text-primary">
                    <Trans>Click fields on the document to show or hide them for this option.</Trans>
                  </p>
                )}

                <Button
                  type="button"
                  variant={isPicking ? 'default' : 'outline'}
                  size="sm"
                  className="mt-2"
                  data-testid={`visibility-select-fields-${index}`}
                  onClick={() => togglePick(value)}
                >
                  {isPicking ? (
                    <>
                      <CheckIcon className="mr-1 h-4 w-4" />
                      <Trans>Done</Trans>
                    </>
                  ) : (
                    <>
                      <MousePointerClickIcon className="mr-1 h-4 w-4" />
                      <Trans>Select fields</Trans>
                    </>
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
