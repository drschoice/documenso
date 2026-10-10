import { type Page, expect, test } from '@playwright/test';
import { DocumentStatus, FieldType } from '@prisma/client';

import { prisma } from '@documenso/prisma';
import { seedUser } from '@documenso/prisma/seed/users';

import {
  MULTI_PAGE_PDF_PATH,
  type TSeedV2FieldInput,
  type TSeedV2RecipientInput,
  clickV2SigningField,
  getSigningUrl,
  getV2InlineFieldEditor,
  getV2SigningModalDialogs,
  openV2InlineFieldEditor,
  openV2SigningPage,
  seedV2PendingEnvelope,
} from '../fixtures/envelope-signing';
import { getKonvaTextContentsFor } from '../fixtures/konva';

/**
 * Filling fields in place on the v2 signer (#42).
 *
 * Text, number, and - when the page does not already know the value - name,
 * email and initials fields are typed straight onto the document instead of
 * into a dialog. The value is shown as soon as the signer leaves the field and
 * saved in the background.
 */

const seedEnvelope = async (options: {
  recipient?: Partial<TSeedV2RecipientInput>;
  fields: TSeedV2FieldInput[];
  pdfPath?: string;
}) => {
  const { user, team } = await seedUser();

  const seeded = await seedV2PendingEnvelope({
    ownerUserId: user.id,
    teamId: team.id,
    recipients: [
      {
        email: `v2-inline-${user.id}@example.com`,
        name: 'Inline Signer',
        ...options.recipient,
      },
    ],
    fields: options.fields,
    pdfPath: options.pdfPath,
  });

  return { ...seeded, recipient: seeded.recipients[0] };
};

const expectFieldValue = async (
  fieldId: number,
  expected: { customText: string; inserted: boolean },
) => {
  await expect
    .poll(
      async () => {
        const field = await prisma.field.findFirstOrThrow({ where: { id: fieldId } });

        return { customText: field.customText, inserted: field.inserted };
      },
      { timeout: 15_000 },
    )
    .toEqual(expected);
};

const expectNoDialog = async (page: Page) => {
  await expect(getV2SigningModalDialogs(page)).toHaveCount(0);
};

/** Click an empty part of the page, outside every field, to leave the open one. */
const clickOutsideFields = async (page: Page) => {
  await page
    .locator('.konva-container')
    .first()
    .click({ position: { x: 5, y: 5 } });
};

const textMeta = (overrides: Record<string, unknown> = {}) => ({
  type: 'text' as const,
  label: 'Street address',
  required: true,
  readOnly: false,
  ...overrides,
});

test.describe('typing into fields in place on the v2 signer', () => {
  test('a text field is typed into on the document and saved on Enter', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      fields: [{ type: FieldType.TEXT, fieldMeta: textMeta() }],
    });

    const [textField] = fields;

    await openV2SigningPage(page, recipient.token);

    const editor = await openV2InlineFieldEditor(page, textField.id);

    await expectNoDialog(page);
    await expect(editor).toHaveAttribute('placeholder', 'Street address');

    await editor.pressSequentially('12 Main St');
    await editor.press('Enter');

    await expect(getV2InlineFieldEditor(page)).toHaveCount(0);
    await expectFieldValue(textField.id, { customText: '12 Main St', inserted: true });

    // The canvas draws the saved value once the editor has gone.
    await expect
      .poll(async () => await getKonvaTextContentsFor(page, 1, `#${textField.id}-text`))
      .toEqual(['12 Main St']);
  });

  test('Shift+Enter starts a new line in a text field, and Enter saves it', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      fields: [{ type: FieldType.TEXT, height: 12, fieldMeta: textMeta({ label: 'Notes' }) }],
    });

    const [textField] = fields;

    await openV2SigningPage(page, recipient.token);

    const editor = await openV2InlineFieldEditor(page, textField.id);
    await editor.pressSequentially('First line');
    await editor.press('Shift+Enter');
    await editor.pressSequentially('Second line');

    await expect(editor).toHaveValue('First line\nSecond line');

    await editor.press('Enter');

    await expectFieldValue(textField.id, { customText: 'First line\nSecond line', inserted: true });
  });

  test('a value the server rejects goes back to the saved value, and the signer is told', async ({
    page,
  }) => {
    const { envelope, recipient, fields } = await seedEnvelope({
      fields: [{ type: FieldType.TEXT, fieldMeta: textMeta() }],
    });

    const [textField] = fields;

    await openV2SigningPage(page, recipient.token);

    const editor = await openV2InlineFieldEditor(page, textField.id);
    await editor.pressSequentially('Never saved');

    // The document stops accepting signatures while the signer is typing, so the save that the
    // page has already shown is refused.
    await prisma.envelope.update({
      where: { id: envelope.id },
      data: { status: DocumentStatus.REJECTED },
    });

    await editor.press('Enter');

    await expect(
      page.getByText('An error occurred while signing the field.').first(),
    ).toBeVisible();

    // The field shows its label again rather than the refused value.
    await expect
      .poll(async () => await getKonvaTextContentsFor(page, 1, `#${textField.id}-text`))
      .toEqual(['Street address']);

    await expectFieldValue(textField.id, { customText: '', inserted: false });
  });

  test('clicking another field saves the one being typed into', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      fields: [
        { type: FieldType.TEXT, positionY: 10, fieldMeta: textMeta({ label: 'First' }) },
        { type: FieldType.TEXT, positionY: 30, fieldMeta: textMeta({ label: 'Second' }) },
      ],
    });

    const [first, second] = fields;

    await openV2SigningPage(page, recipient.token);

    const firstEditor = await openV2InlineFieldEditor(page, first.id);
    await firstEditor.pressSequentially('one');

    const secondEditor = await openV2InlineFieldEditor(page, second.id);
    await expectFieldValue(first.id, { customText: 'one', inserted: true });

    await secondEditor.pressSequentially('two');
    await clickOutsideFields(page);

    await expect(getV2InlineFieldEditor(page)).toHaveCount(0);
    await expectFieldValue(second.id, { customText: 'two', inserted: true });
  });

  test('a filled field opens with its value, can be changed, and is cleared by emptying it', async ({
    page,
  }) => {
    const { recipient, fields } = await seedEnvelope({
      fields: [
        {
          type: FieldType.TEXT,
          fieldMeta: textMeta({ required: false }),
          customText: 'Old value',
          inserted: true,
        },
      ],
    });

    const [textField] = fields;

    await openV2SigningPage(page, recipient.token);

    // Clicking a filled field used to clear it straight away. Now it opens for editing.
    let editor = await openV2InlineFieldEditor(page, textField.id);
    await expect(editor).toHaveValue('Old value');

    await editor.fill('New value');
    await editor.press('Enter');

    await expectFieldValue(textField.id, { customText: 'New value', inserted: true });

    editor = await openV2InlineFieldEditor(page, textField.id);
    await editor.fill('');
    await editor.press('Enter');

    await expectFieldValue(textField.id, { customText: '', inserted: false });
  });

  test('Escape closes the field without saving what was typed', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      fields: [{ type: FieldType.TEXT, fieldMeta: textMeta() }],
    });

    const [textField] = fields;

    await openV2SigningPage(page, recipient.token);

    const editor = await openV2InlineFieldEditor(page, textField.id);
    await editor.pressSequentially('not this');
    await editor.press('Escape');

    await expect(getV2InlineFieldEditor(page)).toHaveCount(0);

    // Give a stray save time to land before asserting there was none.
    await page.waitForTimeout(1_000);
    await expectFieldValue(textField.id, { customText: '', inserted: false });
  });

  test('a number outside its range keeps the field open and says why', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      fields: [
        {
          type: FieldType.NUMBER,
          fieldMeta: {
            type: 'number' as const,
            label: 'Household size',
            required: true,
            minValue: 10,
            maxValue: 20,
          },
        },
      ],
    });

    const [numberField] = fields;

    await openV2SigningPage(page, recipient.token);

    const editor = await openV2InlineFieldEditor(page, numberField.id);

    // Anything that cannot be part of a number is dropped as it is typed.
    await editor.pressSequentially('5x');
    await expect(editor).toHaveValue('5');

    await editor.press('Enter');

    await expect(editor).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Number must be at least 10.' }),
    ).toBeVisible();
    await expectFieldValue(numberField.id, { customText: '', inserted: false });

    await editor.fill('15');
    await editor.press('Enter');

    await expect(getV2InlineFieldEditor(page)).toHaveCount(0);
    await expectFieldValue(numberField.id, { customText: '15', inserted: true });
  });

  test('a character limit is enforced while typing', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      fields: [{ type: FieldType.TEXT, fieldMeta: textMeta({ characterLimit: 5 }) }],
    });

    const [textField] = fields;

    await openV2SigningPage(page, recipient.token);

    const editor = await openV2InlineFieldEditor(page, textField.id);
    await editor.pressSequentially('abcdefgh');

    await expect(editor).toHaveValue('abcde');
    await expect(page.getByText('0 characters remaining')).toBeVisible();

    await editor.press('Enter');

    await expectFieldValue(textField.id, { customText: 'abcde', inserted: true });
  });

  test('typing into one linked field fills the others on the page', async ({ page }) => {
    const linkedMeta = (label: string) => textMeta({ label, linkGroupId: 'inline-link-group' });

    const { recipient, fields } = await seedEnvelope({
      fields: [
        { type: FieldType.TEXT, positionY: 10, fieldMeta: linkedMeta('Medicare number') },
        { type: FieldType.TEXT, positionY: 40, fieldMeta: linkedMeta('Medicare number again') },
      ],
    });

    const [first, second] = fields;

    await openV2SigningPage(page, recipient.token);

    const editor = await openV2InlineFieldEditor(page, first.id);
    await editor.pressSequentially('1EG4-TE5-MK73');
    await editor.press('Enter');

    // The linked field is drawn with the value straight away, not after a reload.
    await expect
      .poll(async () => await getKonvaTextContentsFor(page, 1, `#${second.id}-text`))
      .toEqual(['1EG4-TE5-MK73']);

    await expectFieldValue(first.id, { customText: '1EG4-TE5-MK73', inserted: true });
    await expectFieldValue(second.id, { customText: '1EG4-TE5-MK73', inserted: true });
  });

  test('a name the page does not know is typed in place', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      recipient: { name: '' },
      fields: [
        { type: FieldType.NAME, positionY: 10, fieldMeta: { type: 'name' as const } },
        { type: FieldType.INITIALS, positionY: 30, fieldMeta: { type: 'initials' as const } },
      ],
    });

    const [nameField, initialsField] = fields;

    await openV2SigningPage(page, recipient.token);

    const editor = await openV2InlineFieldEditor(page, nameField.id);
    await expectNoDialog(page);

    await editor.pressSequentially('Grace Hopper');
    await editor.press('Enter');

    await expectFieldValue(nameField.id, { customText: 'Grace Hopper', inserted: true });

    // The typed name becomes the signer's name, so the initials are now known and fill in a
    // single click, without opening anything.
    await expect(async () => {
      const persisted = await prisma.field.findFirstOrThrow({ where: { id: initialsField.id } });

      if (!persisted.inserted) {
        await clickV2SigningField(page, initialsField.id);
      }

      await expectFieldValue(initialsField.id, { customText: 'GH', inserted: true });
    }).toPass({ timeout: 30_000 });

    await expect(getV2InlineFieldEditor(page)).toHaveCount(0);
  });

  test('initials the page does not know are typed in place', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      recipient: { name: '' },
      fields: [{ type: FieldType.INITIALS, fieldMeta: { type: 'initials' as const } }],
    });

    const [initialsField] = fields;

    await openV2SigningPage(page, recipient.token);

    const editor = await openV2InlineFieldEditor(page, initialsField.id);
    await expectNoDialog(page);

    await editor.pressSequentially('GH');
    await editor.press('Enter');

    await expectFieldValue(initialsField.id, { customText: 'GH', inserted: true });
  });

  test('a comb field is typed into its own cells', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      fields: [
        {
          type: FieldType.TEXT,
          positionY: 20,
          width: 30,
          height: 8,
          fieldMeta: {
            type: 'text' as const,
            label: 'Medicare number',
            required: true,
            layout: 'cells' as const,
            cellSize: 20,
            cells: Array.from({ length: 6 }, (_, index) => ({
              id: index + 1,
              offsetX: index * 4,
              offsetY: 0,
            })),
          },
        },
      ],
    });

    const [combField] = fields;

    await openV2SigningPage(page, recipient.token);

    const input = await openV2InlineFieldEditor(page, combField.id, 1, { cellIndex: 0 });
    await expectNoDialog(page);

    const cells = page.getByTestId('signing-inline-comb-cell');
    await expect(cells).toHaveCount(6);

    // The cells are the limit: a seventh character has nowhere to go.
    await input.pressSequentially('ABC123X');
    await expect(input).toHaveValue('ABC123');
    await expect(cells).toHaveText(['A', 'B', 'C', '1', '2', '3']);

    // Clicking a cell moves the caret there without closing the field, so Backspace removes the
    // character before it.
    await cells.nth(2).click();
    await expect(cells.nth(2)).toHaveAttribute('data-active', 'true');
    await input.press('Backspace');

    await expect(input).toBeFocused();
    await expect(cells).toHaveText(['A', 'C', '1', '2', '3', '']);

    await input.press('Enter');

    await expect(getV2InlineFieldEditor(page)).toHaveCount(0);
    await expectFieldValue(combField.id, { customText: 'AC123', inserted: true });

    await expect
      .poll(async () => await getKonvaTextContentsFor(page, 1, '.field-cell-text'))
      .toEqual(['A', 'C', '1', '2', '3', '']);
  });

  test('completing straight after typing the last field waits for it to save', async ({ page }) => {
    const { envelope, recipient, fields } = await seedEnvelope({
      fields: [{ type: FieldType.TEXT, fieldMeta: textMeta() }],
    });

    const [textField] = fields;

    await openV2SigningPage(page, recipient.token);

    const editor = await openV2InlineFieldEditor(page, textField.id);
    await editor.pressSequentially('Last field');

    // Still in the field: the header button says "Next Field" until the value is saved, and
    // pressing it saves the value and opens the completion dialog in one go.
    await page
      .getByRole('button', { name: /Next Field|Complete/ })
      .first()
      .click();

    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await page.waitForURL(`${getSigningUrl(recipient.token)}/complete`, { timeout: 30_000 });

    await expectFieldValue(textField.id, { customText: 'Last field', inserted: true });

    const persistedEnvelope = await prisma.envelope.findFirstOrThrow({
      where: { id: envelope.id },
      include: { recipients: true },
    });

    expect(persistedEnvelope.recipients[0].signingStatus).toBe('SIGNED');
  });
});

test.describe('moving between fields on the v2 signer', () => {
  test('Tab saves and moves through the fields in reading order, across pages', async ({
    page,
  }) => {
    const { recipient, fields } = await seedEnvelope({
      pdfPath: MULTI_PAGE_PDF_PATH,
      fields: [
        // Drawn second but on the right of the same line, so it is read second.
        {
          type: FieldType.TEXT,
          positionX: 55,
          positionY: 10,
          fieldMeta: textMeta({ label: 'Right' }),
        },
        {
          type: FieldType.TEXT,
          positionX: 10,
          positionY: 11,
          fieldMeta: textMeta({ label: 'Left' }),
        },
        // Not typed, so Tab passes over it.
        {
          type: FieldType.SIGNATURE,
          positionX: 10,
          positionY: 40,
          fieldMeta: { type: 'signature' },
        },
        {
          type: FieldType.TEXT,
          page: 3,
          positionX: 10,
          positionY: 20,
          fieldMeta: textMeta({ label: 'Page three' }),
        },
      ],
    });

    const [right, left, , pageThree] = fields;

    await openV2SigningPage(page, recipient.token);

    const leftEditor = await openV2InlineFieldEditor(page, left.id);
    await leftEditor.pressSequentially('one');
    await leftEditor.press('Tab');

    const rightEditor = getV2InlineFieldEditor(page, right.id);
    await expect(rightEditor).toBeFocused();
    await rightEditor.pressSequentially('two');
    await rightEditor.press('Tab');

    // The next field is two pages down: the page is scrolled to and its field opened.
    const pageThreeEditor = getV2InlineFieldEditor(page, pageThree.id);
    await expect(pageThreeEditor).toBeFocused({ timeout: 15_000 });
    await expect(pageThreeEditor).toBeInViewport();
    await pageThreeEditor.pressSequentially('three');

    // Shift+Tab goes back, to the field with its saved value.
    await pageThreeEditor.press('Shift+Tab');

    const backEditor = getV2InlineFieldEditor(page, right.id);
    await expect(backEditor).toBeFocused({ timeout: 15_000 });
    await expect(backEditor).toHaveValue('two');
    await backEditor.press('Escape');

    await expectFieldValue(left.id, { customText: 'one', inserted: true });
    await expectFieldValue(right.id, { customText: 'two', inserted: true });
    await expectFieldValue(pageThree.id, { customText: 'three', inserted: true });
  });

  test('Tab moves onto a field the value just chosen reveals', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      fields: [
        {
          type: FieldType.DROPDOWN,
          positionY: 10,
          fieldMeta: {
            type: 'dropdown' as const,
            label: 'Marital status',
            required: true,
            stableId: 'trigger-status',
            values: [{ value: 'Single' }, { value: 'Married' }],
          },
        },
        {
          type: FieldType.TEXT,
          positionY: 30,
          fieldMeta: textMeta({
            label: 'Spouse name',
            stableId: 'dependent-spouse',
            visibility: {
              match: 'all' as const,
              rules: [
                {
                  operator: 'equals' as const,
                  triggerFieldStableId: 'trigger-status',
                  value: 'Married',
                },
              ],
            },
          }),
        },
        { type: FieldType.TEXT, positionY: 50, fieldMeta: textMeta({ label: 'Occupation' }) },
      ],
    });

    const [status, spouse] = fields;

    await openV2SigningPage(page, recipient.token);

    const statusEditor = await openV2InlineFieldEditor(page, status.id);

    // Typing narrows the list; Tab picks the highlighted option and moves on.
    await statusEditor.pressSequentially('mar');
    await expect(
      page.getByTestId('signing-inline-dropdown-options').getByRole('option'),
    ).toHaveText(['Married']);
    await statusEditor.press('Tab');

    // The spouse field only exists once "Married" is chosen, and comes before Occupation.
    await expect(getV2InlineFieldEditor(page, spouse.id)).toBeFocused({ timeout: 15_000 });

    await expectFieldValue(status.id, { customText: 'Married', inserted: true });
  });

  test('"Next Field" opens the next field ready to type', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      fields: [
        { type: FieldType.TEXT, positionY: 10, fieldMeta: textMeta({ label: 'First' }) },
        { type: FieldType.TEXT, positionY: 30, fieldMeta: textMeta({ label: 'Second' }) },
      ],
    });

    const [first, second] = fields;

    await openV2SigningPage(page, recipient.token);

    await page.getByRole('button', { name: 'Next Field' }).first().click();

    const firstEditor = getV2InlineFieldEditor(page, first.id);
    await expect(firstEditor).toBeFocused();
    await firstEditor.pressSequentially('one');

    // Pressing it again saves the field being typed into and opens the next one.
    await page.getByRole('button', { name: 'Next Field' }).first().click();

    await expect(getV2InlineFieldEditor(page, second.id)).toBeFocused();
    await expectFieldValue(first.id, { customText: 'one', inserted: true });
  });
});

test.describe('typing in place on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a field opened low on the screen is scrolled clear of the bottom bar', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      pdfPath: MULTI_PAGE_PDF_PATH,
      fields: [
        { type: FieldType.TEXT, positionY: 5, fieldMeta: textMeta({ label: 'Top' }) },
        { type: FieldType.TEXT, page: 2, positionY: 45, fieldMeta: textMeta({ label: 'Lower' }) },
      ],
    });

    const [top, lower] = fields;

    await openV2SigningPage(page, recipient.token);

    const bottomBar = page
      .locator('div.fixed.bottom-0')
      .filter({ hasText: 'Sign Document' })
      .locator('.rounded-xl')
      .first();

    await expect(bottomBar).toBeVisible();

    const barTop = (await bottomBar.boundingBox())?.y ?? 0;

    // The next field starts out under the bar, so the test only passes if opening it moves it.
    const lowerFieldTop = await page.evaluate((fieldId) => {
      const konva = (
        window as unknown as {
          Konva: {
            stages: Array<{
              attrs: { id?: string };
              container: () => HTMLElement;
              find: (selector: string) => Array<{
                id: () => string;
                getClientRect: () => { y: number };
              }>;
            }>;
          };
        }
      ).Konva;

      const stage = konva.stages.find((s) => s.attrs.id === 'page-2');
      const node = stage?.find('.field-group').find((n) => n.id() === String(fieldId));

      return stage && node
        ? stage.container().getBoundingClientRect().top + node.getClientRect().y
        : null;
    }, lower.id);

    expect(lowerFieldTop).not.toBeNull();
    expect(lowerFieldTop ?? 0).toBeGreaterThan(barTop);

    const topEditor = await openV2InlineFieldEditor(page, top.id);
    await topEditor.press('Tab');

    const lowerEditor = getV2InlineFieldEditor(page, lower.id);
    await expect(lowerEditor).toBeFocused({ timeout: 15_000 });

    await expect(async () => {
      const box = await lowerEditor.boundingBox();

      expect(box).not.toBeNull();
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(barTop);
    }).toPass({ timeout: 5_000 });
  });
});

test.describe('picking a date on the v2 signer', () => {
  test('the month and year lists stay small, and a picked day is signed', async ({ page }) => {
    const { user, team } = await seedUser();

    const seeded = await seedV2PendingEnvelope({
      ownerUserId: user.id,
      teamId: team.id,
      recipients: [{ email: `v2-inline-date-${user.id}@example.com`, name: 'Inline Signer' }],
      documentMeta: { dateFormat: 'yyyy-MM-dd', timezone: 'Etc/UTC' },
      fields: [
        { type: FieldType.DATE, width: 30, height: 6, fieldMeta: { type: 'date', label: 'Born' } },
      ],
    });

    const [recipient] = seeded.recipients;
    const [dateField] = seeded.fields;

    await openV2SigningPage(page, recipient.token);
    await openV2InlineFieldEditor(page, dateField.id);

    const calendar = page.getByTestId('signing-inline-date-calendar');

    // A hundred years are on offer, but the list shows five at a time rather than filling the
    // screen.
    await calendar.getByRole('button', { name: 'Year', exact: true }).click();

    const years = calendar.getByRole('listbox', { name: 'Year' });
    await expect(years).toBeVisible();

    const yearsBox = await years.boundingBox();
    expect(yearsBox?.height).toBeLessThanOrEqual(5 * 28 + 10);

    await years.getByRole('option', { name: '1957' }).click();

    await calendar.getByRole('button', { name: 'Month', exact: true }).click();
    await calendar
      .getByRole('listbox', { name: 'Month' })
      .getByRole('option', { name: 'Mar' })
      .click();

    // Choosing the month and year keeps the field open.
    await expect(getV2InlineFieldEditor(page, dateField.id)).toHaveCount(1);

    await calendar.getByRole('gridcell', { name: '14', exact: true }).first().click();

    await expectFieldValue(dateField.id, { customText: '1957-03-14', inserted: true });
  });
});

test.describe('choosing from a dropdown on the v2 signer', () => {
  const dropdownMeta = {
    type: 'dropdown' as const,
    label: 'Plan',
    required: false,
    values: [{ value: 'Basic' }, { value: 'Plus' }, { value: 'Premium' }],
  };

  test('the options open under the field and are picked from the keyboard', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      fields: [{ type: FieldType.DROPDOWN, fieldMeta: dropdownMeta }],
    });

    const [dropdownField] = fields;

    await openV2SigningPage(page, recipient.token);

    const editor = await openV2InlineFieldEditor(page, dropdownField.id);
    await expectNoDialog(page);

    const options = page.getByTestId('signing-inline-dropdown-options').getByRole('option');
    await expect(options).toHaveText(['Basic', 'Plus', 'Premium']);

    await editor.press('ArrowDown');
    await editor.press('Enter');

    await expect(getV2InlineFieldEditor(page)).toHaveCount(0);
    await expectFieldValue(dropdownField.id, { customText: 'Plus', inserted: true });
  });

  test('a chosen option can be cleared, and clicking away keeps the choice', async ({ page }) => {
    const { recipient, fields } = await seedEnvelope({
      fields: [
        {
          type: FieldType.DROPDOWN,
          fieldMeta: dropdownMeta,
          customText: 'Premium',
          inserted: true,
        },
      ],
    });

    const [dropdownField] = fields;

    await openV2SigningPage(page, recipient.token);

    // Typing only filters, so leaving without picking changes nothing.
    let editor = await openV2InlineFieldEditor(page, dropdownField.id);
    await editor.pressSequentially('bas');
    await clickOutsideFields(page);

    await expect(getV2InlineFieldEditor(page)).toHaveCount(0);
    await page.waitForTimeout(1_000);
    await expectFieldValue(dropdownField.id, { customText: 'Premium', inserted: true });

    editor = await openV2InlineFieldEditor(page, dropdownField.id);
    await page.getByRole('option', { name: 'Clear selection' }).click();

    await expectFieldValue(dropdownField.id, { customText: '', inserted: false });
  });
});
