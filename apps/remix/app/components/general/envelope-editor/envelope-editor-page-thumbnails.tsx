import { Trans } from '@lingui/react/macro';
import { PlusIcon, Trash2Icon } from 'lucide-react';

import { cn } from '@documenso/ui/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@documenso/ui/primitives/alert-dialog';
import { Button } from '@documenso/ui/primitives/button';
import { Spinner } from '@documenso/ui/primitives/spinner';

type EnvelopeEditorPageThumbnailsProps = {
  pageCount: number;
  pageImages: Map<number, string>;
  isLoading?: boolean;
  onDeletePage: (pageNumber: number) => void;
  onAddBlankPage: () => void;
};

export const EnvelopeEditorPageThumbnails = ({
  pageCount,
  pageImages,
  isLoading,
  onDeletePage,
  onAddBlankPage,
}: EnvelopeEditorPageThumbnailsProps) => {
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
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button
                      type="button"
                      disabled={isLoading}
                      className={cn(
                        'absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded bg-destructive/90 text-destructive-foreground opacity-0 transition-opacity hover:bg-destructive',
                        'group-hover:opacity-100',
                        'disabled:pointer-events-none disabled:opacity-30',
                      )}
                      aria-label={`Delete page ${pageNumber}`}
                    >
                      <Trash2Icon className="h-3 w-3" />
                    </button>
                  </AlertDialogTrigger>

                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        <Trans>Delete page {pageNumber}?</Trans>
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        <Trans>
                          This will permanently remove page {pageNumber} and any fields placed on
                          it. This action cannot be undone.
                        </Trans>
                      </AlertDialogDescription>
                    </AlertDialogHeader>

                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        <Trans>Cancel</Trans>
                      </AlertDialogCancel>
                      <AlertDialogAction onClick={() => onDeletePage(pageNumber)}>
                        <Trans>Delete page</Trans>
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>

            <span className="text-[10px] text-muted-foreground">{pageNumber}</span>
          </div>
        );
      })}

      {/* Add blank page */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isLoading}
        onClick={onAddBlankPage}
        className="mt-1 flex w-full flex-col items-center gap-1 border-dashed px-1 py-2 text-[10px] text-muted-foreground hover:text-foreground"
      >
        {isLoading ? <Spinner className="h-4 w-4" /> : <PlusIcon className="h-4 w-4" />}
        <Trans>Add page</Trans>
      </Button>
    </div>
  );
};
