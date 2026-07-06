import { PDFDocument } from '@cantoo/pdf-lib';
import type { Envelope, Field } from '@prisma/client';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getFileServerSide } from '@documenso/lib/universal/upload/get-file.server';
import { putPdfFileServerSide } from '@documenso/lib/universal/upload/put-file.server';
import { prisma } from '@documenso/prisma';

type DeleteEnvelopeItemPageOptions = {
  envelope: Pick<Envelope, 'id'>;
  envelopeItemId: string;
  /**
   * 1-indexed page number to delete.
   */
  pageNumber: number;
};

type DeleteEnvelopeItemPageResult = {
  updatedItem: {
    id: string;
    title: string;
    envelopeId: string;
    order: number;
    documentDataId: string;
  };

  /**
   * The full list of fields for the envelope after deletion.
   *
   * Only returned when fields were removed or renumbered, otherwise `undefined`.
   */
  fields: Field[] | undefined;
};

export const deleteEnvelopeItemPage = async ({
  envelope,
  envelopeItemId,
  pageNumber,
}: DeleteEnvelopeItemPageOptions): Promise<DeleteEnvelopeItemPageResult> => {
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

  if (pageCount <= 1) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Cannot delete the last page of a PDF',
    });
  }

  if (pageNumber < 1 || pageNumber > pageCount) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: `Page number ${pageNumber} is out of bounds (1–${pageCount})`,
    });
  }

  // pdf-lib uses 0-indexed pages.
  pdfDoc.removePage(pageNumber - 1);

  const newBytes = await pdfDoc.save();

  const { documentData: newDocumentData } = await putPdfFileServerSide({
    name: `${envelopeItem.title}.pdf`,
    type: 'application/pdf',
    arrayBuffer: async () => Promise.resolve(newBytes),
  });

  let didFieldsChange = false;

  const updatedItem = await prisma.$transaction(async (tx) => {
    const updated = await tx.envelopeItem.update({
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

    // Delete fields that were on the deleted page.
    const fieldsOnDeletedPage = await tx.field.findMany({
      where: {
        envelopeId: envelope.id,
        envelopeItemId,
        page: pageNumber,
      },
      select: { id: true },
    });

    if (fieldsOnDeletedPage.length > 0) {
      await tx.field.deleteMany({
        where: {
          id: { in: fieldsOnDeletedPage.map((f) => f.id) },
        },
      });

      didFieldsChange = true;
    }

    // Decrement page numbers for all fields on pages after the deleted page.
    const fieldsAfterDeletedPage = await tx.field.findMany({
      where: {
        envelopeId: envelope.id,
        envelopeItemId,
        page: { gt: pageNumber },
      },
      select: { id: true },
    });

    if (fieldsAfterDeletedPage.length > 0) {
      await tx.field.updateMany({
        where: {
          id: { in: fieldsAfterDeletedPage.map((f) => f.id) },
        },
        data: {
          page: { decrement: 1 },
        },
      });

      didFieldsChange = true;
    }

    return updated;
  });

  let fields: Field[] | undefined;

  if (didFieldsChange) {
    fields = await prisma.field.findMany({
      where: { envelopeId: envelope.id },
    });
  }

  return {
    updatedItem,
    fields,
  };
};
