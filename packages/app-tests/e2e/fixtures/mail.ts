import { type APIRequestContext, expect } from '@playwright/test';

/**
 * Reading sent mail in e2e.
 *
 * `docker/development/compose.yml` already runs Inbucket (SMTP on 2500, HTTP on
 * 9000) and `.env.example` already points `NEXT_PRIVATE_SMTP_*` at it, in CI as
 * well as locally - but until now no spec ever read a message back, so every
 * subject line, sender name and template change shipped unverified.
 *
 * Inbucket derives a mailbox name from the address' local part, so
 * `ada@example.com` lands in the `ada` mailbox.
 */
const INBUCKET_URL = process.env.E2E_INBUCKET_URL ?? 'http://localhost:9000';

export type TInbucketMessageSummary = {
  id: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  size: number;
};

export type TInbucketMessage = TInbucketMessageSummary & {
  header: Record<string, string[]>;
  body: { text: string; html: string };
};

export const mailboxNameFor = (email: string) => email.split('@')[0];

const request = async (context: APIRequestContext, path: string) => {
  const response = await context.get(`${INBUCKET_URL}${path}`);

  if (!response.ok()) {
    throw new Error(`Inbucket ${path} responded ${response.status()}`);
  }

  return response;
};

export const listMessages = async (
  context: APIRequestContext,
  email: string,
): Promise<TInbucketMessageSummary[]> => {
  const response = await request(context, `/api/v1/mailbox/${mailboxNameFor(email)}`);

  return (await response.json()) as TInbucketMessageSummary[];
};

export const getMessage = async (
  context: APIRequestContext,
  email: string,
  id: string,
): Promise<TInbucketMessage> => {
  const response = await request(context, `/api/v1/mailbox/${mailboxNameFor(email)}/${id}`);

  return (await response.json()) as TInbucketMessage;
};

/**
 * Wait for a mailbox to receive at least `count` messages, then return the most
 * recent one in full.
 *
 * Mail is sent from a background job, so it arrives a beat after the action that
 * triggered it.
 */
export const waitForLatestMessage = async (
  context: APIRequestContext,
  email: string,
  { count = 1, timeout = 30_000 }: { count?: number; timeout?: number } = {},
): Promise<TInbucketMessage> => {
  let latestId = '';

  await expect(async () => {
    const messages = await listMessages(context, email);

    expect(messages.length).toBeGreaterThanOrEqual(count);

    latestId = messages[messages.length - 1].id;
  }).toPass({ timeout });

  return await getMessage(context, email, latestId);
};

/**
 * Empty a mailbox so a spec starts from a known state. Safe to call for an
 * address that has never received anything.
 */
export const clearMailbox = async (context: APIRequestContext, email: string) => {
  await context.delete(`${INBUCKET_URL}/api/v1/mailbox/${mailboxNameFor(email)}`);
};
