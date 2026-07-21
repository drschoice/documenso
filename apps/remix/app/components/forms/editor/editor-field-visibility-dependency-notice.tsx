import { Trans, useLingui } from '@lingui/react/macro';
import { EyeIcon } from 'lucide-react';

import type { TLocalField } from '@documenso/lib/client-only/hooks/use-editor-fields';
import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import type { TVisibilityBlock, TVisibilityRule } from '@documenso/lib/types/field-meta';
import { getFieldStableId } from '@documenso/lib/universal/field-visibility/authoring';
import { Label } from '@documenso/ui/primitives/label';

type Props = {
  /** The currently selected field (any type). */
  field: TLocalField;
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

const getVisibility = (field: TLocalField): TVisibilityBlock | undefined =>
  (field.fieldMeta as { visibility?: TVisibilityBlock } | undefined)?.visibility;

const OPERATOR_PHRASE: Record<TVisibilityRule['operator'], string> = {
  equals: 'is',
  notEquals: 'is not',
  contains: 'includes',
  notContains: 'does not include',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
};

/**
 * Read-only notice shown on a DEPENDENT field: tells the author which field(s)
 * control its visibility and the value that reveals it. Authoring itself lives
 * on the controlling (trigger) field's settings.
 */
export const EditorFieldVisibilityDependencyNotice = ({ field }: Props) => {
  const { t } = useLingui();
  const { editorFields } = useCurrentEnvelopeEditor();

  const block = getVisibility(field);

  if (!block) {
    return null;
  }

  return (
    <div
      data-testid="visibility-dependency-notice"
      className="mt-4 rounded-md border border-border bg-muted/40 p-3"
    >
      <Label className="flex items-center gap-1.5 text-sm font-semibold">
        <EyeIcon className="h-4 w-4" />
        <Trans>Visibility</Trans>
      </Label>

      <p className="mt-1 text-xs text-muted-foreground">
        <Trans>Shown to the recipient only when:</Trans>
      </p>

      <ul className="mt-2 space-y-1">
        {block.rules.map((rule, index) => {
          const trigger = editorFields.localFields.find(
            (f) => getFieldStableId(f.fieldMeta) === rule.triggerFieldStableId,
          );

          return (
            <li key={index} className="text-xs">
              {trigger ? (
                <button
                  type="button"
                  data-testid={`visibility-dependency-trigger-${index}`}
                  onClick={() => editorFields.setSelectedField(trigger.formId)}
                  className="text-primary rounded-sm font-medium underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                  title={t`Select this field`}
                >
                  {fieldLabel(trigger)}
                </button>
              ) : (
                <span className="font-medium">
                  <Trans>another field</Trans>
                </span>
              )}{' '}
              {OPERATOR_PHRASE[rule.operator]}
              {'value' in rule ? (
                <>
                  {' '}
                  “<span className="font-medium">{rule.value}</span>”
                </>
              ) : null}
            </li>
          );
        })}
      </ul>

      {block.rules.length >= 2 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {block.match === 'all' ? (
            <Trans>All of these must match.</Trans>
          ) : (
            <Trans>Any of these can match.</Trans>
          )}
        </p>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground">
        <Trans>Managed from the controlling field's settings.</Trans>
      </p>
    </div>
  );
};
