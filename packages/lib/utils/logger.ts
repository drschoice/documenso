import { type TransportTargetOptions, pino } from 'pino';

import type { BaseApiLog } from '../types/api-logs';
import { extractRequestMetadata } from '../universal/extract-request-metadata';
import { env } from './env';

// Defaults to 'info'. Set NEXT_PRIVATE_LOGGER_LEVEL=debug to surface debug logs
// (e.g. AI token-usage diagnostics) without code changes.
const logLevel = env('NEXT_PRIVATE_LOGGER_LEVEL') || 'info';

const transports: TransportTargetOptions[] = [];

if (env('NODE_ENV') !== 'production' && !env('INTERNAL_FORCE_JSON_LOGGER')) {
  transports.push({
    target: 'pino-pretty',
    level: logLevel,
  });
}

const loggingFilePath = env('NEXT_PRIVATE_LOGGER_FILE_PATH');

if (loggingFilePath) {
  transports.push({
    target: 'pino/file',
    level: logLevel,
    options: {
      destination: loggingFilePath,
      mkdir: true,
    },
  });
}

export const logger = pino({
  level: logLevel,
  transport:
    transports.length > 0
      ? {
          targets: transports,
        }
      : undefined,
});

export const logDocumentAccess = ({
  request,
  documentId,
  userId,
}: {
  request: Request;
  documentId: number;
  userId: number;
}) => {
  const metadata = extractRequestMetadata(request);

  const data: BaseApiLog = {
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent,
    path: new URL(request.url).pathname,
    auth: 'session',
    source: 'app',
    userId,
  };

  logger.info({
    ...data,
    input: {
      documentId,
    },
  });
};
