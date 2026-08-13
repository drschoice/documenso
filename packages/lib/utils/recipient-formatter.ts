import type { Recipient } from '@prisma/client';

export const extractInitials = (text: string) =>
  text
    .split(' ')
    .map((name: string) => name.slice(0, 1).toUpperCase())
    .slice(0, 2)
    .join('');

export const recipientAbbreviation = (recipient: Pick<Recipient, 'name' | 'email'>) => {
  return extractInitials(recipient.name) || recipient.email.slice(0, 1).toUpperCase();
};

/**
 * The individual parts a recipient's name is stored in.
 *
 * `Recipient.name` remains the full name and is recomputed from these whenever they are written, so
 * that every consumer of the full name (emails, certificates, audit logs, search, webhooks, the
 * public API) keeps working unchanged.
 */
export type RecipientNameParts = {
  firstName: string;
  middleName: string;
  lastName: string;
};

export type RecipientNamePart = 'full' | 'first' | 'middle' | 'last';

/**
 * Join the name parts into the full name stored on `Recipient.name`.
 */
export const buildRecipientFullName = (parts: Partial<RecipientNameParts>): string => {
  return [parts.firstName, parts.middleName, parts.lastName]
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join(' ');
};

/**
 * Best-effort split of a full name into parts.
 *
 * This is only ever used as a *fallback* for recipients that have no parts stored — legacy rows and
 * recipients created through name-only APIs. It is deliberately not run as a migration, so the
 * stored parts always reflect what somebody actually typed.
 */
export const splitFullName = (name: string): RecipientNameParts => {
  const tokens = (name ?? '').trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return { firstName: '', middleName: '', lastName: '' };
  }

  if (tokens.length === 1) {
    return { firstName: tokens[0], middleName: '', lastName: '' };
  }

  return {
    firstName: tokens[0],
    middleName: tokens.slice(1, -1).join(' '),
    lastName: tokens[tokens.length - 1],
  };
};

/**
 * Return the name parts for a recipient, falling back to splitting the full name when no parts have
 * been stored.
 */
export const getRecipientNameParts = (
  recipient: Partial<RecipientNameParts> & { name?: string | null },
): RecipientNameParts => {
  const stored = {
    firstName: (recipient.firstName ?? '').trim(),
    middleName: (recipient.middleName ?? '').trim(),
    lastName: (recipient.lastName ?? '').trim(),
  };

  if (stored.firstName || stored.middleName || stored.lastName) {
    return stored;
  }

  return splitFullName(recipient.name ?? '');
};

type RecipientNameInput = {
  name?: string | null;
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
};

/**
 * Resolve the name columns to write when creating a recipient.
 *
 * When parts are supplied they are authoritative and `name` is derived from them. When they are not
 * — name-only callers such as the public API, CSV bulk send and direct links — `name` is kept as
 * given and the parts are left empty, to be derived on read.
 */
export const resolveRecipientNameOnCreate = (
  input: RecipientNameInput,
): RecipientNameParts & { name: string } => {
  const parts = {
    firstName: (input.firstName ?? '').trim(),
    middleName: (input.middleName ?? '').trim(),
    lastName: (input.lastName ?? '').trim(),
  };

  const nameFromParts = buildRecipientFullName(parts);

  return {
    ...parts,
    name: nameFromParts || (input.name ?? '').trim(),
  };
};

/**
 * Resolve the name columns to write when updating a recipient, given only the fields the caller
 * actually supplied.
 *
 * Supplying any part rebuilds `name` from the parts. Supplying only `name` clears the parts, so they
 * can never contradict the full name — reads fall back to splitting `name` instead of returning a
 * stale first/last from before the rename.
 */
export const resolveRecipientNameOnUpdate = (
  update: RecipientNameInput,
  original: RecipientNameInput,
): Partial<RecipientNameParts & { name: string }> => {
  const hasPartUpdate =
    update.firstName !== undefined ||
    update.middleName !== undefined ||
    update.lastName !== undefined;

  if (hasPartUpdate) {
    const parts = {
      firstName: (update.firstName ?? original.firstName ?? '').trim(),
      middleName: (update.middleName ?? original.middleName ?? '').trim(),
      lastName: (update.lastName ?? original.lastName ?? '').trim(),
    };

    return { ...parts, name: buildRecipientFullName(parts) };
  }

  if (update.name !== undefined) {
    return {
      name: (update.name ?? '').trim(),
      firstName: '',
      middleName: '',
      lastName: '',
    };
  }

  return {};
};

/**
 * Resolve the value a NAME field should be filled with, given the part it is bound to.
 *
 * `fullName` is what the signer has actually entered for this session. When it differs from the
 * recipient's stored name we split that instead, so part-bound fields stay consistent with the name
 * the signer typed rather than the one the author originally set.
 */
export const resolveRecipientNamePart = (
  part: RecipientNamePart | undefined,
  options: {
    recipient?: (Partial<RecipientNameParts> & { name?: string | null }) | null;
    fullName?: string | null;
  },
): string => {
  const { recipient, fullName } = options;

  const recipientName = (recipient?.name ?? '').trim();
  const providedName = (fullName ?? '').trim();

  if (!part || part === 'full') {
    return providedName || recipientName;
  }

  const parts =
    providedName && providedName !== recipientName
      ? splitFullName(providedName)
      : getRecipientNameParts({ ...recipient, name: recipientName });

  switch (part) {
    case 'first':
      return parts.firstName;
    case 'middle':
      return parts.middleName;
    case 'last':
      return parts.lastName;
  }
};
