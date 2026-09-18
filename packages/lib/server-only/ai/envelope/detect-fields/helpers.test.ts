import { describe, expect, it } from 'vitest';

import type { DetectedField } from './schema';
import { normalizeDetectedField, resolveRecipientFromKey } from './helpers';
import type { RecipientContext } from './types';

/**
 * The seam where a model's raw answer becomes coordinates on a page.
 *
 * Everything either side of it needs a live model to exercise, but these two are
 * pure, and they are where a swapped axis or an off-by-a-factor-of-ten silently
 * puts every detected field in the wrong place - a failure that looks like the
 * model being bad rather than like a bug.
 */

const baseField = {
  type: 'TEXT',
  label: 'Account number',
  recipientKey: '',
  confidence: 'high',
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
} as DetectedField;

describe('normalizeDetectedField', () => {
  it('converts a 0-1000 box to 0-100 position and size', () => {
    const normalized = normalizeDetectedField({
      ...baseField,
      // The model answers [yMin, xMin, yMax, xMax] - y first, which is the
      // opposite order to the x/y the rest of the codebase uses.
      box2d: [250, 100, 350, 600],
    });

    expect(normalized.positionX).toBe(10);
    expect(normalized.positionY).toBe(25);
    expect(normalized.width).toBe(50);
    expect(normalized.height).toBe(10);
  });

  it('carries the comb layout through untouched', () => {
    const normalized = normalizeDetectedField({
      ...baseField,
      box2d: [0, 0, 100, 100],
      layout: 'cells',
      cellCount: 9,
    });

    expect(normalized.layout).toBe('cells');
    expect(normalized.cellCount).toBe(9);
  });

  it('spans an option group across every button and offsets each from that box', () => {
    const normalized = normalizeDetectedField({
      ...baseField,
      type: 'RADIO',
      label: 'Marital status',
      // The group's own box is ignored in favour of the union of its options, so
      // a model that boxed only the first button cannot clip the group.
      box2d: [100, 100, 150, 150],
      options: [
        { value: 'Married', box2d: [200, 100, 220, 120] },
        { value: 'Single', box2d: [300, 500, 320, 520] },
      ],
    });

    // Union of both buttons: y 200..320, x 100..520.
    expect(normalized.positionX).toBe(10);
    expect(normalized.positionY).toBe(20);
    expect(normalized.width).toBe(42);
    expect(normalized.height).toBe(12);

    // Offsets are relative to that union's top-left, so the first option sits at
    // the origin and the second carries the real distance. Without these every
    // option would stack on the field's corner.
    expect(normalized.options).toEqual([
      { value: 'Married', offsetX: 0, offsetY: 0 },
      { value: 'Single', offsetX: 40, offsetY: 10 },
    ]);
  });
});

describe('resolveRecipientFromKey', () => {
  const recipients: RecipientContext[] = [
    { id: 7, name: 'Ada', email: 'ada@example.com' },
    { id: 9, name: 'Grace', email: 'grace@example.com' },
  ];

  it('returns null when the envelope has no recipients', () => {
    expect(resolveRecipientFromKey('7|Ada|ada@example.com', [])).toBeNull();
  });

  it('matches on id', () => {
    expect(resolveRecipientFromKey('9|Grace|grace@example.com', recipients)).toBe(recipients[1]);
  });

  it('prefers the id over a name and email that point elsewhere', () => {
    // The model echoes the key back and can garble the human-readable half; the
    // id is the part it was given verbatim.
    expect(resolveRecipientFromKey('9|Ada|ada@example.com', recipients)).toBe(recipients[1]);
  });

  it('falls back to name and email when the id is not a number', () => {
    expect(resolveRecipientFromKey('Landlord|Grace|grace@example.com', recipients)).toBe(
      recipients[1],
    );
  });

  it('needs both the name and the email to match', () => {
    // A half-match is not a match: it lands on the first recipient rather than
    // guessing, so a field is assigned to someone by default rather than by a
    // coincidence of surnames.
    expect(resolveRecipientFromKey('x|Grace|someone-else@example.com', recipients)).toBe(
      recipients[0],
    );
  });

  it('defaults to the first recipient for an empty or unknown key', () => {
    expect(resolveRecipientFromKey('', recipients)).toBe(recipients[0]);
    expect(resolveRecipientFromKey('404|Nobody|nobody@example.com', recipients)).toBe(
      recipients[0],
    );
  });
});
