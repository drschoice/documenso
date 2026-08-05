import { z } from 'zod';

/**
 * Curated set of typed-signature fonts.
 *
 * This manifest is the single source of truth for:
 * - the Zod enum that validates the org/team setting ({@link ZSignatureFontFamilySchema})
 * - the font-family `Select` options in the branding settings form
 * - the `FontLibrary.use()` registration loop for the skia-canvas (V2) PDF path
 * - the family -> TTF file lookup used by the pdf-lib (V1/legacy) PDF paths
 *
 * Adding a font is "drop a TTF into `apps/remix/public/fonts/`, add a row here".
 *
 * Only free fonts are included: OFL-1.1 and Apache-2.0 both permit embedding, modification and
 * commercial use with no fee. Every file must live in `apps/remix/public/fonts/` (the path that
 * `ensureFontLibrary()`, the pdf-lib fetches and the CSS `@font-face` blocks all resolve to).
 */
export const SIGNATURE_FONTS = [
  {
    family: 'Caveat',
    file: 'caveat.ttf',
    cssFallback: 'cursive',
    license: 'OFL-1.1',
  },
  {
    family: 'Kaushan Script',
    file: 'kaushan-script.ttf',
    cssFallback: 'cursive',
    license: 'OFL-1.1',
  },
  {
    family: 'Dancing Script',
    file: 'dancing-script.ttf',
    cssFallback: 'cursive',
    license: 'OFL-1.1',
  },
  {
    family: 'Yellowtail',
    file: 'yellowtail.ttf',
    cssFallback: 'cursive',
    license: 'Apache-2.0',
  },
  {
    family: 'Sacramento',
    file: 'sacramento.ttf',
    cssFallback: 'cursive',
    license: 'OFL-1.1',
  },
  {
    family: 'Great Vibes',
    file: 'great-vibes.ttf',
    cssFallback: 'cursive',
    license: 'OFL-1.1',
  },
] as const;

export type SignatureFont = (typeof SIGNATURE_FONTS)[number];

export type SignatureFontFamily = SignatureFont['family'];

/**
 * The font every existing document was rendered with before this feature. Used as the fallback
 * whenever a document's snapshotted font is `null`/unknown, so historical documents keep rendering
 * exactly as they did.
 */
export const DEFAULT_SIGNATURE_FONT_FAMILY: SignatureFontFamily = 'Caveat';

const SIGNATURE_FONT_FAMILIES = SIGNATURE_FONTS.map((font) => font.family) as [
  SignatureFontFamily,
  ...SignatureFontFamily[],
];

/**
 * Validates that a value is one of the curated signature font families.
 */
export const ZSignatureFontFamilySchema = z.enum(SIGNATURE_FONT_FAMILIES);

/**
 * Bounds for the typed-signature font size (px). Mirrors the per-field `fieldMeta.fontSize` range
 * (see `ZBaseFieldMeta` in `@documenso/lib/types/field-meta`) so the org/team default and a per-field
 * override share the same allowed values. The default (18) lives in `./pdf` as
 * `DEFAULT_SIGNATURE_TEXT_FONT_SIZE`.
 */
export const MIN_SIGNATURE_FONT_SIZE = 8;
export const MAX_SIGNATURE_FONT_SIZE = 96;

/**
 * Validates the typed-signature font size setting.
 */
export const ZSignatureFontSizeSchema = z
  .number()
  .int()
  .min(MIN_SIGNATURE_FONT_SIZE)
  .max(MAX_SIGNATURE_FONT_SIZE);

/**
 * Resolve a font family to its manifest entry, falling back to the default (Caveat) for any unknown
 * or `null` value.
 */
export const getSignatureFont = (family?: string | null): SignatureFont => {
  return (
    SIGNATURE_FONTS.find((font) => font.family === family) ??
    SIGNATURE_FONTS.find((font) => font.family === DEFAULT_SIGNATURE_FONT_FAMILY)!
  );
};

/**
 * Resolve a font family to the TTF filename that must be fetched/embedded (pdf-lib) or registered
 * (skia-canvas). Falls back to the default font's file.
 */
export const getSignatureFontFile = (family?: string | null): string => {
  return getSignatureFont(family).file;
};

/**
 * Build the CSS/Konva `font-family` string for a chosen family, including its fallback stack, e.g.
 * `'Dancing Script', cursive`.
 */
export const getSignatureFontFamilyString = (family?: string | null): string => {
  const font = getSignatureFont(family);

  return `'${font.family}', ${font.cssFallback}`;
};
