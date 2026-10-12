import type { LanguageModel } from 'ai';
import { z } from 'zod';

import { logger } from '../../utils/logger';
import type { SubmitDetectedFieldsInput } from './envelope/detect-fields/schema';

/**
 * Marker the stub model looks for in the prompt to decide how to answer.
 *
 * It rides in on the detection request's `context`, which is already free text
 * forwarded verbatim to the model, so a test steers the stub per request rather
 * than through shared server state - which is what makes this safe to use from
 * tests running in parallel against one server.
 */
export const AI_STUB_DIRECTIVE_PREFIX = 'DOCUMENSO_AI_STUB:';

const ZStubDirectiveSchema = z.object({
  /** How many fields to return for every page that succeeds. */
  fieldsPerPage: z.number().int().min(0).max(20).default(1),
  /** Pages that throw on every attempt, so the page is skipped entirely. */
  failPages: z.array(z.number().int()).default([]),
  /** Pages that throw once and then succeed, so the retry loop is exercised. */
  flakyPages: z.array(z.number().int()).default([]),
});

export type TStubDirective = z.infer<typeof ZStubDirectiveSchema>;

/** Serialise a directive for the request's `context` field. */
export const buildAiStubDirective = (directive: Partial<TStubDirective>) =>
  `${AI_STUB_DIRECTIVE_PREFIX}${JSON.stringify(directive)}`;

const DEFAULT_DIRECTIVE = ZStubDirectiveSchema.parse({});

const parseDirective = (promptText: string): TStubDirective => {
  const markerIndex = promptText.indexOf(AI_STUB_DIRECTIVE_PREFIX);

  if (markerIndex === -1) {
    return DEFAULT_DIRECTIVE;
  }

  // The directive is one line of JSON; anything after the newline is whatever
  // else the caller put in `context`.
  const rest = promptText.slice(markerIndex + AI_STUB_DIRECTIVE_PREFIX.length);
  const line = rest.split('\n')[0].trim();

  try {
    return ZStubDirectiveSchema.parse(JSON.parse(line));
  } catch (err) {
    logger.warn({ err, line }, '[ai-stub-model] unparseable directive, using defaults');

    return DEFAULT_DIRECTIVE;
  }
};

/**
 * The page number the detector asks about, taken from the message it builds in
 * `detectFieldsFromPage`. Falls back to page 1 so a prompt change degrades into
 * "every page behaves like page 1" rather than into a crash.
 */
const parsePageNumber = (promptText: string) => {
  const match = promptText.match(/document page \(page (\d+)\)/);

  return match ? Number(match[1]) : 1;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const collectPromptText = (prompt: any): string => {
  if (!Array.isArray(prompt)) {
    return '';
  }

  const parts: string[] = [];

  for (const message of prompt) {
    const content = message?.content;

    if (typeof content === 'string') {
      parts.push(content);
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }

  return parts.join('\n');
};

const buildStubFields = (pageNumber: number, count: number): SubmitDetectedFieldsInput => ({
  fields: Array.from({ length: count }, (_, index) => ({
    type: 'TEXT' as const,
    // The label is how a test tells the pages apart in the response, which is
    // what makes "page 2 was skipped but 1 and 3 came back" assertable.
    label: `Stub page ${pageNumber} field ${index + 1}`,
    recipientKey: '',
    // [yMin, xMin, yMax, xMax] on the 0-1000 scale the real model answers on.
    box2d: [100 + index * 100, 100, 140 + index * 100, 400],
    confidence: 'high' as const,
  })),
});

/**
 * A deterministic stand-in for the field-detection model.
 *
 * It exists so the code *around* the model call can be tested: the per-item
 * exclusion loop, the per-page retry, and the per-page skip. Everything but the
 * model itself is the production path.
 *
 * One instance is created per page, so the attempt counter it keeps is that
 * page's attempt counter.
 */
export const createStubFieldDetectionModel = (): LanguageModel => {
  let attempts = 0;

  return {
    specificationVersion: 'v2',
    provider: 'documenso-stub',
    modelId: 'documenso-stub-field-detection',
    supportedUrls: {},

    // The stub answers without doing any I/O, so there is nothing to await; the
    // contract still requires a PromiseLike, hence async with no await in it.
    // eslint-disable-next-line @typescript-eslint/require-await
    doGenerate: async (options) => {
      attempts += 1;

      const promptText = collectPromptText(options.prompt);
      const pageNumber = parsePageNumber(promptText);
      const directive = parseDirective(promptText);

      logger.debug({ pageNumber, attempts, directive }, '[ai-stub-model] generating');

      if (directive.failPages.includes(pageNumber)) {
        throw new Error(`[ai-stub-model] page ${pageNumber} fails by directive`);
      }

      if (directive.flakyPages.includes(pageNumber) && attempts === 1) {
        throw new Error(`[ai-stub-model] page ${pageNumber} fails its first attempt by directive`);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(buildStubFields(pageNumber, directive.fieldsPerPage)),
          },
        ],
        finishReason: 'stop' as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      };
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    doStream: async () => {
      throw new Error('[ai-stub-model] streaming is not supported');
    },
  };
};
