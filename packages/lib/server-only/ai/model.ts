import type { LanguageModel } from 'ai';

import { IS_AI_STUB_MODEL_ENABLED } from '../../constants/app';
import { vertex } from './google';

/** The model field detection runs against. */
export const FIELD_DETECTION_MODEL_ID = 'gemini-3-flash-preview';

/**
 * Resolves the model used to detect fields on a page.
 *
 * The indirection exists so the detector can be driven deterministically: the
 * exclusion loop, the per-page retry and the per-page skip are all wrapped
 * around a non-deterministic network call, and there was otherwise nowhere to
 * stand in for it. `NEXT_PRIVATE_AI_STUB_MODEL` is the only way in, it is
 * server-only, and it is never set outside the test environment.
 *
 * Imported lazily so the stub is never evaluated on a real deployment.
 */
export const getFieldDetectionModel = async (): Promise<LanguageModel> => {
  if (IS_AI_STUB_MODEL_ENABLED()) {
    const { createStubFieldDetectionModel } = await import('./stub-model');

    return createStubFieldDetectionModel();
  }

  return vertex(FIELD_DETECTION_MODEL_ID);
};
