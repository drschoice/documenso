import { type Field, FieldType, RecipientRole } from '@prisma/client';

import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { DIRECT_TEMPLATE_RECIPIENT_EMAIL } from '@documenso/lib/constants/direct-templates';
import { ZFieldMetaSchema, getFieldNamePart } from '@documenso/lib/types/field-meta';
import {
  extractInitials,
  resolveRecipientNamePart,
} from '@documenso/lib/utils/recipient-formatter';

import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';

import { useRequiredEnvelopeSigningContext } from '../document-signing/envelope-signing-provider';

/**
 * The name, email and initials the signing page already knows for the person whose fields are
 * being filled, and whether the signer may type different ones.
 *
 * An assistant fills fields for the recipient they have selected, so that recipient's details are
 * used rather than the assistant's own.
 */
export const useSigningIdentityValues = () => {
  const { sessionData } = useOptionalSession();

  const { recipient, email, fullName, nameParts, selectedAssistantRecipient, isDirectTemplate } =
    useRequiredEnvelopeSigningContext();

  const { isNameLocked = false, isEmailLocked = false } = useEmbedSigningContext() || {};

  const isAssistant = recipient.role === RecipientRole.ASSISTANT;

  const localEmail: string | null = isAssistant
    ? selectedAssistantRecipient?.email || null
    : email || null;

  const localFullName: string | null = isAssistant
    ? selectedAssistantRecipient?.name || null
    : fullName || null;

  // In assistant mode the name belongs to the recipient being filled for, so use their stored
  // parts. Otherwise use the parts the signer is editing in the sidebar.
  const localRecipient = isAssistant
    ? selectedAssistantRecipient
    : { ...recipient, ...nameParts, name: fullName };

  // Lets a direct template signer use a different email than the one they are logged in with.
  let placeholderEmail: string | null = null;

  if (isDirectTemplate) {
    placeholderEmail = sessionData?.user?.email || email || recipient.email;

    if (!placeholderEmail || placeholderEmail === DIRECT_TEMPLATE_RECIPIENT_EMAIL) {
      placeholderEmail = null;
    }
  }

  /** A recipient's email is fixed. Only a direct template signer chooses their own. */
  const isEmailEditable = isDirectTemplate && !isEmailLocked;

  /**
   * The value a NAME, INITIALS or EMAIL field would be filled with in one click, or an empty
   * string when the page does not know it.
   */
  const getKnownValue = (field: Pick<Field, 'type' | 'fieldMeta'>): string => {
    switch (field.type) {
      case FieldType.NAME: {
        const fieldMeta = ZFieldMetaSchema.safeParse(field.fieldMeta);

        return resolveRecipientNamePart(getFieldNamePart(fieldMeta.data), {
          recipient: localRecipient,
          fullName: localFullName,
        });
      }

      case FieldType.INITIALS:
        return localFullName ? extractInitials(localFullName) : '';

      case FieldType.EMAIL:
        return localEmail ?? '';

      default:
        return '';
    }
  };

  return {
    localEmail,
    localFullName,
    localRecipient,
    placeholderEmail,
    isNameLocked,
    isEmailEditable,
    getKnownValue,
  };
};
