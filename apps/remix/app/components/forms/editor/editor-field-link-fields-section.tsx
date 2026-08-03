import { useEffect, useMemo, useRef } from 'react';

import { Trans } from '@lingui/react/macro';
import { CheckIcon, LinkIcon, MousePointerClickIcon, XIcon } from 'lucide-react';

import type { TLocalField } from '@documenso/lib/client-only/hooks/use-editor-fields';
import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import {
  getLinkGroupId,
  getLinkGroupMembers,
  pruneOrphanLinkGroups,
  removeFromLinkGroup,
} from '@documenso/lib/universal/field-linking';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Label } from '@documenso/ui/primitives/label';

type Props = {
  /** The selected TEXT/NUMBER field whose link group is being edited. */
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

/**
 * Copy & link fields authoring. Filling in any member of a link group syncs the
 * value to every other member (see field-linking/authoring + the signing
 * fan-out). Membership is a flat `linkGroupId` on each member's meta — symmetric,
 * no source/dependent — so this section is intentionally simpler than the
 * conditional-visibility one.
 */
export const EditorFieldLinkFieldsSection = ({ field }: Props) => {
  const { editorFields, linkPickMode } = useCurrentEnvelopeEditor();

  const groupId = getLinkGroupId(field.fieldMeta);
  const recipientId = field.recipientId;

  // Keep the latest pick-mode reachable from the unmount cleanup without
  // re-running the effect on every pick-mode change.
  const pickModeRef = useRef(linkPickMode);
  pickModeRef.current = linkPickMode;

  // Exit pick-mode when the author navigates away from this field.
  useEffect(() => {
    const formId = field.formId;

    return () => {
      if (pickModeRef.current.active?.sourceFormId === formId) {
        pickModeRef.current.exit();
      }
    };
  }, [field.formId]);

  const isPicking = linkPickMode.active?.sourceFormId === field.formId;

  // Other members of this field's link group (the field itself is excluded).
  const linkedFields = useMemo(() => {
    if (!groupId) {
      return [];
    }

    return getLinkGroupMembers(editorFields.localFields, groupId).filter(
      (member) => member.formId !== field.formId,
    );
  }, [editorFields.localFields, groupId, field.formId]);

  const togglePick = () => {
    if (isPicking) {
      linkPickMode.exit();
      return;
    }

    linkPickMode.enter({
      sourceFormId: field.formId,
      sourceRecipientId: recipientId,
      sourceFieldType: field.type,
    });
  };

  const unlink = (member: TLocalField) => {
    // Clear the member's group, then prune so a group that drops below two
    // members releases its remaining lone field too.
    const withMemberCleared = editorFields.localFields.map((f) =>
      f.formId === member.formId
        ? { ...f, fieldMeta: removeFromLinkGroup(f.fieldMeta) }
        : f,
    );

    const pruned = pruneOrphanLinkGroups(withMemberCleared);

    editorFields.updateAllFields(
      (f) => pruned.find((p) => p.formId === f.formId) ?? f,
    );
  };

  return (
    <div
      data-testid="link-fields-section"
      className="mt-4 rounded-md border border-border bg-muted/40 p-3"
    >
      <Label className="flex items-center gap-1.5 text-sm font-semibold">
        <LinkIcon className="h-3.5 w-3.5" />
        <Trans>Copy &amp; link fields</Trans>
      </Label>

      <p className="mt-1 text-xs text-muted-foreground">
        <Trans>
          Link fields so a value entered in one is copied to all of them — handy for repeating
          data across pages.
        </Trans>
      </p>

      {linkedFields.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {linkedFields.map((member) => (
            <span
              key={member.formId}
              className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs"
            >
              {fieldLabel(member)}
              <button
                type="button"
                aria-label="Unlink field"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => unlink(member)}
              >
                <XIcon className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        !isPicking && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            <Trans>Not linked to any other fields yet.</Trans>
          </p>
        )
      )}

      {isPicking && (
        <p className="mt-2 text-[11px] text-primary">
          <Trans>
            Click other {field.type.toLowerCase()} fields for this recipient to link or unlink
            them.
          </Trans>
        </p>
      )}

      <Button
        type="button"
        variant={isPicking ? 'default' : 'outline'}
        size="sm"
        className={cn('mt-2', isPicking && 'ring-1 ring-primary')}
        data-testid="link-fields-select"
        onClick={togglePick}
      >
        {isPicking ? (
          <>
            <CheckIcon className="mr-1 h-4 w-4" />
            <Trans>Done</Trans>
          </>
        ) : (
          <>
            <MousePointerClickIcon className="mr-1 h-4 w-4" />
            <Trans>Link fields</Trans>
          </>
        )}
      </Button>
    </div>
  );
};
