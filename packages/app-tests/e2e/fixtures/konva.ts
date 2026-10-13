import { type Page, expect } from '@playwright/test';
import type Konva from 'konva';

const waitForCanvas = async (page: Page) => {
  await page.locator('.konva-container canvas').first().waitFor({ state: 'visible' });
};

export const getKonvaElementCountForPage = async (
  page: Page,
  pageNumber: number,
  elementSelector: string,
) => {
  await waitForCanvas(page);

  return await page.evaluate(
    ({ pageNumber, elementSelector }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const konva: typeof Konva = (window as unknown as { Konva: typeof Konva }).Konva;

      const pageOne = konva.stages.find((stage) => stage.attrs.id === `page-${pageNumber}`);

      return pageOne?.find(elementSelector).length || 0;
    },
    { pageNumber, elementSelector },
  );
};

/**
 * Returns how many field groups are currently attached to the page's Konva
 * transformer, i.e. the size of the active canvas selection. Used to assert
 * multi-select behaviour (marquee drag and Shift+click).
 */
export const getKonvaTransformerNodeCountForPage = async (page: Page, pageNumber: number) => {
  await page.locator('.konva-container canvas').first().waitFor({ state: 'visible' });

  return await page.evaluate(
    ({ pageNumber }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const konva: typeof Konva = (window as unknown as { Konva: typeof Konva }).Konva;

      const stage = konva.stages.find((stage) => stage.attrs.id === `page-${pageNumber}`);

      if (!stage) {
        return 0;
      }

      const transformer = stage.find('Transformer')[0];

      if (!transformer) {
        return 0;
      }

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return (transformer as Konva.Transformer).nodes().length;
    },
    { pageNumber },
  );
};

/**
 * Assert how many nodes match `elementSelector`, retrying until it settles.
 *
 * `getKonvaElementCountForPage` only waits for the canvas ELEMENT to exist, not
 * for the stage to have (re)painted its contents. Reading it once straight after
 * an action that re-renders the stage - placing a field, switching editor steps,
 * deleting a recipient - races the render and reports a stale count. Use this
 * wherever the count follows such an action.
 */
export const expectKonvaElementCount = async (
  page: Page,
  pageNumber: number,
  elementSelector: string,
  expected: number,
  timeout = 15_000,
) => {
  await expect(async () => {
    expect(await getKonvaElementCountForPage(page, pageNumber, elementSelector)).toBe(expected);
  }).toPass({ timeout });
};

/**
 * A Konva node's visual attributes, as the stage actually rendered them.
 *
 * Counting nodes is not enough for anything that lives purely in how a shape is
 * painted - field background transparency, the greyed-out treatment applied to
 * another signer's fields, per-option offsets under the free layout. Those are
 * invisible to the DOM and to the exported PDF (which renders in `export` mode,
 * without backgrounds), so they can only be asserted off the stage.
 */
export type TKonvaNodeAttrs = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** `null` when nothing in the node paints, e.g. a text-only group. */
  fill: string | CanvasGradient | null;
  stroke: string | CanvasGradient | null;
  opacity: number;
  visible: boolean;
  listening: boolean;
};

/**
 * Read the rendered attributes of the nth node matching `elementSelector` on a page.
 *
 * Useful selectors: `.field-group` (a placed field), `.field-option-group` (a
 * radio/checkbox option button or a comb character cell).
 */
export const getKonvaNodeAttrs = async (
  page: Page,
  pageNumber: number,
  elementSelector: string,
  index = 0,
): Promise<TKonvaNodeAttrs | null> => {
  await waitForCanvas(page);

  return await page.evaluate(
    ({ pageNumber, elementSelector, index }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const konva: typeof Konva = (window as unknown as { Konva: typeof Konva }).Konva;

      const stage = konva.stages.find((s) => s.attrs.id === `page-${pageNumber}`);
      const node = stage?.find(elementSelector)[index];

      if (!node) {
        return null;
      }

      const rect = node.getClientRect({ skipTransform: false });

      // `fill`/`stroke` only exist on shapes; a group paints nothing itself, so
      // fall back to its first descendant that does.
      const asShape = node as Konva.Shape;
      const painted =
        typeof asShape.fill === 'function'
          ? asShape
          : (node as Konva.Container)
              .find((n: Konva.Node) => typeof (n as Konva.Shape).fill === 'function')
              .at(0);

      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        fill: (painted as Konva.Shape | undefined)?.fill() ?? null,
        stroke: (painted as Konva.Shape | undefined)?.stroke() ?? null,
        opacity: node.opacity(),
        visible: Boolean(node.isVisible()),
        listening: Boolean(node.isListening()),
      };
    },
    { pageNumber, elementSelector, index },
  );
};

export const getAllKonvaNodeAttrs = async (
  page: Page,
  pageNumber: number,
  elementSelector: string,
): Promise<TKonvaNodeAttrs[]> => {
  const count = await getKonvaElementCountForPage(page, pageNumber, elementSelector);

  const attrs: TKonvaNodeAttrs[] = [];

  for (let index = 0; index < count; index++) {
    const node = await getKonvaNodeAttrs(page, pageNumber, elementSelector, index);

    if (node) {
      attrs.push(node);
    }
  }

  return attrs;
};

/**
 * Every string painted onto a page's stage, in render order.
 *
 * The editor preview and the signing canvas draw field values and placeholder
 * labels as Konva text, so this is the only way to assert on what a viewer
 * actually reads - it is invisible to the DOM.
 */
export const getKonvaTextContents = async (page: Page, pageNumber: number): Promise<string[]> => {
  await waitForCanvas(page);

  return await page.evaluate(
    ({ pageNumber }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const konva: typeof Konva = (window as unknown as { Konva: typeof Konva }).Konva;

      const stage = konva.stages.find((s) => s.attrs.id === `page-${pageNumber}`);

      if (!stage) {
        return [];
      }

      return stage
        .find('Text')
        .map((node) => (node as Konva.Text).text())
        .filter((text): text is string => typeof text === 'string' && text.length > 0);
    },
    { pageNumber },
  );
};

/**
 * The strings painted by the nodes matching a selector, in render order,
 * including the empty ones.
 *
 * `getKonvaTextContents` drops empty strings, which is right when asking what a
 * viewer reads but wrong for a comb field: an unfilled cell paints an empty text
 * node, and "cell 3 is blank" is exactly the thing worth asserting.
 */
export const getKonvaTextContentsFor = async (
  page: Page,
  pageNumber: number,
  elementSelector: string,
): Promise<string[]> => {
  await waitForCanvas(page);

  return await page.evaluate(
    ({ pageNumber, elementSelector }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const konva: typeof Konva = (window as unknown as { Konva: typeof Konva }).Konva;

      const stage = konva.stages.find((s) => s.attrs.id === `page-${pageNumber}`);

      if (!stage) {
        return [];
      }

      return stage.find(elementSelector).map((node) => (node as Konva.Text).text() ?? '');
    },
    { pageNumber, elementSelector },
  );
};

/**
 * Drag a Konva node by a delta, in viewport pixels.
 *
 * Konva shapes are painted into a single `<canvas>`, so Playwright cannot target
 * them directly. Translate the node's stage-space client rect into viewport
 * coordinates via the stage container, then drive the real mouse - the small
 * intermediate moves matter because the editor's drag handlers only engage
 * after a `mousemove`.
 */
export const dragKonvaNode = async (
  page: Page,
  pageNumber: number,
  elementSelector: string,
  index: number,
  delta: { x: number; y: number },
) => {
  await waitForCanvas(page);

  const origin = await page.evaluate(
    ({ pageNumber, elementSelector, index }) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const konva: typeof Konva = (window as unknown as { Konva: typeof Konva }).Konva;

      const stage = konva.stages.find((s) => s.attrs.id === `page-${pageNumber}`);
      const node = stage?.find(elementSelector)[index];

      if (!stage || !node) {
        return null;
      }

      const containerRect = stage.container().getBoundingClientRect();
      const nodeRect = node.getClientRect();

      return {
        x: containerRect.left + nodeRect.x + nodeRect.width / 2,
        y: containerRect.top + nodeRect.y + nodeRect.height / 2,
      };
    },
    { pageNumber, elementSelector, index },
  );

  if (!origin) {
    throw new Error(`No Konva node matching "${elementSelector}"[${index}] on page ${pageNumber}`);
  }

  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + delta.x / 2, origin.y + delta.y / 2, { steps: 5 });
  await page.mouse.move(origin.x + delta.x, origin.y + delta.y, { steps: 5 });
  await page.mouse.up();

  return origin;
};
