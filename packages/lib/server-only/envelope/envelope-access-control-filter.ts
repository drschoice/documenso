import type { DocumentVisibility } from '@prisma/client';
import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';

import { sql } from '@documenso/prisma';
import type { DB } from '@documenso/prisma/generated/types';

// Expression builder type scoped to Envelope table context.
type EnvelopeExpressionBuilder = ExpressionBuilder<DB, 'Envelope'>;

/**
 * Reusable EXISTS subquery: checks that a Recipient row exists for the given
 * envelope with the given email.
 */
const recipientExists = (eb: EnvelopeExpressionBuilder, email: string) =>
  eb.exists(
    eb
      .selectFrom('Recipient')
      .whereRef('Recipient.envelopeId', '=', 'Envelope.id')
      .where('Recipient.email', '=', email)
      .select(sql.lit(1).as('one')),
  );

/**
 * Reusable EXISTS subquery: checks that the envelope's sender (User) has the given email.
 */
const senderEmailIs = (eb: EnvelopeExpressionBuilder, email: string) =>
  eb.exists(
    eb
      .selectFrom('User')
      .whereRef('User.id', '=', 'Envelope.userId')
      .where('User.email', '=', email)
      .select(sql.lit(1).as('one')),
  );

export type EnvelopeAccessControlOptions = {
  teamId: number;
  userId: number;
  teamEmail: string | null;
  allowedVisibilities: DocumentVisibility[];
};

/**
 * Build the access-control predicate shared by the envelope find/search queries.
 *
 * Unlike `findDocuments` (used by the UI), being a recipient does NOT override
 * document visibility. An envelope is visible if ANY of:
 *   1. It belongs to this team AND (meets the visibility threshold OR the requesting user is the owner)
 *   2. (If team email) The sender's email matches the team email
 *   3. (If team email) A recipient's email matches the team email
 */
export const buildEnvelopeAccessControlFilter = (
  eb: EnvelopeExpressionBuilder,
  { teamId, userId, teamEmail, allowedVisibilities }: EnvelopeAccessControlOptions,
): Expression<SqlBool> => {
  const visibilityFilter = eb.or([
    eb(
      'Envelope.visibility',
      'in',
      allowedVisibilities.map((v) => sql.lit(v)),
    ),
    // Owner always sees their own docs within this team
    eb('Envelope.userId', '=', userId),
  ]);

  const accessBranches: Expression<SqlBool>[] = [
    // Team docs that pass visibility (or are owned by the user)
    eb.and([eb('Envelope.teamId', '=', teamId), visibilityFilter]),
  ];

  if (teamEmail) {
    // Docs sent by the team email user
    accessBranches.push(senderEmailIs(eb, teamEmail));
    // Docs received by the team email
    accessBranches.push(recipientExists(eb, teamEmail));
  }

  return eb.or(accessBranches);
};
