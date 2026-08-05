import { NEXT_PUBLIC_WEBAPP_URL } from './app';

export const DEFAULT_STANDARD_FONT_SIZE = 12;
export const DEFAULT_HANDWRITING_FONT_SIZE = 50;
// Default typed-signature size (px) for the Konva/V2 path: the per-field default baked into new
// signature fields, the org/team signature-size default, and the render fallback all resolve here.
export const DEFAULT_SIGNATURE_TEXT_FONT_SIZE = 24;

export const MIN_STANDARD_FONT_SIZE = 8;
export const MIN_HANDWRITING_FONT_SIZE = 20;

export const CAVEAT_FONT_PATH = () => `${NEXT_PUBLIC_WEBAPP_URL()}/fonts/caveat.ttf`;

export const PDF_SIZE_A4_72PPI = {
  width: 595,
  height: 842,
};
