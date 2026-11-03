import type { I18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import * as ReactEmail from '@react-email/render';

import config from '@documenso/tailwind-config';

import { Tailwind } from './components';
import { BrandingProvider, type BrandingSettings } from './providers/branding';

export type RenderOptions = ReactEmail.Options & {
  branding?: BrandingSettings;
  i18n?: I18n;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const colors = (config.theme?.extend?.colors || {}) as Record<string, string>;

/**
 * React 18's streaming renderer flushes its whole 2 KB buffer when a multi-byte character doesn't
 * fit at the end, so the unfilled tail goes out as NUL bytes. The preview padding is all multi-byte
 * characters and often straddles that boundary. SendGrid cuts the HTML part short at the NUL, and
 * the email arrives blank. react-email only strips these in `pretty` mode.
 */
const stripNulBytes = (output: string) => output.replaceAll('\0', '');

export const render = async (element: React.ReactNode, options?: RenderOptions) => {
  const { branding, ...otherOptions } = options ?? {};

  return stripNulBytes(
    await ReactEmail.render(
      <BrandingProvider branding={branding}>
        <Tailwind
          config={{
            theme: {
              extend: {
                colors,
              },
            },
          }}
        >
          {element}
        </Tailwind>
      </BrandingProvider>,
      otherOptions,
    ),
  );
};

export const renderWithI18N = async (element: React.ReactNode, options?: RenderOptions) => {
  const { branding, i18n, ...otherOptions } = options ?? {};

  if (!i18n) {
    throw new Error('i18n is required');
  }

  return stripNulBytes(
    await ReactEmail.render(
      <I18nProvider i18n={i18n}>
        <BrandingProvider branding={branding}>
          <Tailwind
            config={{
              theme: {
                extend: {
                  colors,
                },
              },
            }}
          >
            {element}
          </Tailwind>
        </BrandingProvider>
      </I18nProvider>,
      otherOptions,
    ),
  );
};
