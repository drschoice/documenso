import { useEffect, useMemo, useRef } from 'react';

import Konva from 'konva';

import { SIGNATURE_FONTS } from '../../constants/signature-fonts';
import { type PageRenderData } from '../providers/envelope-render-provider';

type RenderFunction = (props: { stage: Konva.Stage; pageLayer: Konva.Layer }) => void;

export const usePageRenderer = (renderFunction: RenderFunction, pageData: PageRenderData) => {
  const { pageWidth, pageHeight, scale, imageLoadingState, pageNumber } = pageData;

  const konvaContainer = useRef<HTMLDivElement>(null);

  const stage = useRef<Konva.Stage | null>(null);
  const pageLayer = useRef<Konva.Layer | null>(null);

  /**
   * The raw viewport with no scaling. Basically the actual PDF size.
   */
  const unscaledViewport = useMemo(
    () => ({
      scale: 1,
      width: pageWidth,
      height: pageHeight,
    }),
    [pageWidth, pageHeight],
  );

  /**
   * The viewport scaled according to page width.
   */
  const scaledViewport = useMemo(
    () => ({
      scale,
      width: pageWidth * scale,
      height: pageHeight * scale,
    }),
    [pageWidth, pageHeight, scale],
  );

  useEffect(() => {
    const { current: container } = konvaContainer;

    if (!container || imageLoadingState !== 'loaded') {
      return;
    }

    stage.current = new Konva.Stage({
      container,
      id: `page-${pageNumber}`,
      width: scaledViewport.width,
      height: scaledViewport.height,
      scale: {
        x: scale,
        y: scale,
      },
    });

    // Create the main layer for interactive elements.
    pageLayer.current = new Konva.Layer();

    stage.current.add(pageLayer.current);

    renderFunction({
      stage: stage.current,
      pageLayer: pageLayer.current,
    });

    // Konva draws typed signatures to a canvas, which can only use a font the browser has already
    // loaded. Signature fonts aren't referenced by any DOM element, so `document.fonts.ready` alone
    // never triggers their load — explicitly request each one, then redraw once they resolve.
    void Promise.all([
      document.fonts.ready,
      ...SIGNATURE_FONTS.map((signatureFont) =>
        document.fonts.load(`40px "${signatureFont.family}"`).catch(() => undefined),
      ),
    ]).then(function () {
      pageLayer.current?.batchDraw();
    });

    return () => {
      stage.current?.destroy();
      stage.current = null;
    };
  }, [imageLoadingState, scaledViewport]);

  return {
    konvaContainer,
    stage,
    pageLayer,
    unscaledViewport,
    scaledViewport,
  };
};
