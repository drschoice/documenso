import { PDFDocument } from '@cantoo/pdf-lib';
import type { Envelope } from '@prisma/client';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { putPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { prisma } from '@documenso/prisma';

type AddEnvelopeItemBlankPageOptions = {
  envelope: Pick<Envelope, 'id'>;
  envelopeItemId: string;
};

type AddEnvelopeItemBlankPageResult = {
  updatedItem: {
    id: string;
    title: string;
    envelopeId: string;
    order: number;
    documentDataId: string;
  };
  pageCount: number;
};

export const addEnvelopeItemBlankPage = async ({
  envelope,
  envelopeItemId,
}: AddEnvelopeItemBlankPageOptions): Promise<AddEnvelopeItemBlankPageResult> => {
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

  // Use the last page's dimensions for the new blank page.
  const lastPage = pdfDoc.getPage(pageCount - 1);
  const { width, height } = lastPage.getSize();

  pdfDoc.addPage([width, height]);

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
