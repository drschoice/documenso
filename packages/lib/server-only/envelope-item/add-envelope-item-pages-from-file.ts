import { PDFDocument } from '@cantoo/pdf-lib';
import type { Envelope } from '@prisma/client';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { putPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { prisma } from '@documenso/prisma';

type AddEnvelopeItemPagesFromFileOptions = {
  envelope: Pick<Envelope, 'id'>;
  envelopeItemId: string;
  file: File;
};

type AddEnvelopeItemPagesFromFileResult = {
  updatedItem: {
    id: string;
    title: string;
    envelopeId: string;
    order: number;
    documentDataId: string;
  };
  pageCount: number;
};

/**
 * Appends the page(s) of an uploaded file to the end of an envelope item's PDF.
 *
 * - PDF: all pages are copied and appended.
 * - PNG / JPG: a single page (matching the last existing page's dimensions) is
 *   added with the image drawn contain-fit and centered.
 *
 * Existing pages (and therefore existing fields) are left untouched.
 */
export const addEnvelopeItemPagesFromFile = async ({
  envelope,
  envelopeItemId,
  file,
}: AddEnvelopeItemPagesFromFileOptions): Promise<AddEnvelopeItemPagesFromFileResult> => {
  const envelopeItem = await prisma.envelopeItem.findUnique({
    where: {
      id: envelopeItemId,
      envelopeId: envelope.id,
    },
    include: {
      documentData: true,
    },
  });

  if (!envelopeItem) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Envelope item not found',
    });
  }

  const existingBytes = await getFileServerSide({
    type: envelopeItem.documentData.type,
    data: envelopeItem.documentData.data,
  });

  const pdfDoc = await PDFDocument.load(existingBytes);

  const pageCount = pdfDoc.getPageCount();

  if (pageCount === 0) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'PDF has no pages',
    });
  }

  // New pages inherit the last page's dimensions to keep the document consistent.
  const lastPage = pdfDoc.getPage(pageCount - 1);
  const { width, height } = lastPage.getSize();

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const fileType = file.type;

  if (fileType === 'application/pdf') {
    const sourceDoc = await PDFDocument.load(fileBytes);
    const copiedPages = await pdfDoc.copyPages(sourceDoc, sourceDoc.getPageIndices());

    copiedPages.forEach((page) => pdfDoc.addPage(page));
  } else if (fileType === 'image/png' || fileType === 'image/jpeg') {
    const image =
      fileType === 'image/png'
        ? await pdfDoc.embedPng(fileBytes)
        : await pdfDoc.embedJpg(fileBytes);

    const page = pdfDoc.addPage([width, height]);

    // Contain-fit the image within the page while preserving its aspect ratio.
    const scale = Math.min(width / image.width, height / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;

    page.drawImage(image, {
      x: (width - drawWidth) / 2,
      y: (height - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  } else {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Unsupported file type. Only PDF, PNG and JPG files are supported.',
    });
  }

  const newBytes = await pdfDoc.save();

  const { documentData: newDocumentData, filePageCount } = await putPdfFileServerSide({
    name: `${envelopeItem.title}.pdf`,
    type: 'application/pdf',
    arrayBuffer: async () => Promise.resolve(newBytes),
  });

  const updatedItem = await prisma.envelopeItem.update({
    where: {
      id: envelopeItemId,
      envelopeId: envelope.id,
    },
    data: {
      documentDataId: newDocumentData.id,
    },
    select: {
      id: true,
      title: true,
      envelopeId: true,
      order: true,
      documentDataId: true,
    },
  });

  return {
    updatedItem,
    pageCount: filePageCount,
  };
};
