import { useState } from 'react';

import { Trans } from '@lingui/react/macro';
import { PlusIcon, Trash2Icon } from 'lucide-react';

import { cn } from '@documenso/ui/lib/utils';
import { Alert, AlertDescription } from '@documenso/ui/primitives/alert';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@documenso/ui/primitives/dialog';
import { Spinner } from '@documenso/ui/primitives/spinner';

import { EnvelopeAddPageDialog } from '~/components/dialogs/envelope-add-page-dialog';

type EnvelopeEditorPageThumbnailsProps = {
  pageCount: number;
  pageImages: Map<number, string>;
  isLoading?: boolean;
  envelopeItem: { id: string; title: string };
  onDeletePage: (pageNumber: number) => void;
};

export const EnvelopeEditorPageThumbnails = ({
  pageCount,
  pageImages,
  isLoading,
  envelopeItem,
  onDeletePage,
}: EnvelopeEditorPageThumbnailsProps) => {
  const [pageToDelete, setPageToDelete] = useState<number | null>(null);

  return (
    <div className="flex h-full w-24 flex-shrink-0 flex-col gap-2 overflow-y-auto border-r border-border bg-muted/30 px-2 py-3">
      {Array.from({ length: pageCount }, (_, i) => {
        const pageNumber = i + 1;
        const dataUrl = pageImages.get(pageNumber);

        return (
          <div key={pageNumber} className="group relative flex flex-col items-center gap-1">
            <div
              className={cn(
                'relative w-full overflow-hidden rounded border border-border bg-white',
                'aspect-[8.5/11]',
              )}
            >
              {dataUrl ? (
                <img
                  src={dataUrl}
                  alt=""
                  className="h-full w-full object-contain"
                  draggable={false}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Spinner className="h-4 w-4 text-muted-foreground" />
                </div>
              )}

              {/* Delete button — only shown on hover when more than 1 page exists */}
              {pageCount > 1 && (
                <button
                  type="button"
                  disabled={isLoading}
                  className={cn(
                    'absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded bg-destructive/90 text-destructive-foreground opacity-0 transition-opacity hover:bg-destructive',
                    'group-hover:opacity-100',
                    'disabled:pointer-events-none disabled:opacity-30',
                  )}
                  aria-label={`Delete page ${pageNumber}`}
                  onClick={() => setPageToDelete(pageNumber)}
                >
                  <Trash2Icon className="h-3 w-3" />
                </button>
              )}
            </div>

            <span className="text-[10px] text-muted-foreground">{pageNumber}</span>
          </div>
        );
      })}

      {/* Add page (blank or from an uploaded file) */}
      <EnvelopeAddPageDialog
        envelopeItem={envelopeItem}
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isLoading}
            className="mt-1 flex w-full flex-col items-center gap-1 border-dashed px-1 py-2 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {isLoading ? <Spinner className="h-4 w-4" /> : <PlusIcon className="h-4 w-4" />}
            <Trans>Add page</Trans>
          </Button>
        }
      />

      <Dialog open={pageToDelete !== null} onOpenChange={(open) => !open && setPageToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Do you want to delete this page?</Trans>
            </DialogTitle>

            <DialogDescription>
              <Trans>Are you sure you want to delete this page?</Trans>
            </DialogDescription>

            <Alert variant="warning" className="-mt-1">
              <AlertDescription>
                <Trans>
                  Please note that this action is <strong>irreversible</strong>. Once confirmed,
                  page {pageToDelete} and any fields placed on it will be permanently deleted.
                </Trans>
              </AlertDescription>
            </Alert>
          </DialogHeader>

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={isLoading}
              onClick={() => setPageToDelete(null)}
            >
              <Trans>Cancel</Trans>
            </Button>

            <Button
              type="button"
              variant="destructive"
              loading={isLoading}
              onClick={() => {
                if (pageToDelete !== null) {
                  onDeletePage(pageToDelete);
                  setPageToDelete(null);
                }
              }}
            >
              <Trans>Delete</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
