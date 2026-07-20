import { useEffect, useState } from 'react';

import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type * as DialogPrimitive from '@radix-ui/react-dialog';
import { FileIcon, FilePlusIcon, ImageIcon, UploadIcon, XIcon } from 'lucide-react';
import type { Accept, FileRejection } from 'react-dropzone';

import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import { trpc } from '@documenso/trpc/react';
import { buildDropzoneRejectionDescription } from '@documenso/ui/lib/handle-dropzone-rejection';
import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@documenso/ui/primitives/dialog';
import { DocumentDropzone } from '@documenso/ui/primitives/document-dropzone';
import { useToast } from '@documenso/ui/primitives/use-toast';

const ACCEPTED_FILE_TYPES: Accept = {
  'application/pdf': ['.pdf'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
};

type AddPageSource = 'blank' | 'upload';

type SelectedFile = {
  file: File;
  pageCount: number;
  isImage: boolean;
};

export type EnvelopeAddPageDialogProps = {
  envelopeItem: { id: string; title: string };
  trigger: React.ReactNode;
} & Omit<DialogPrimitive.DialogProps, 'children'>;

export const EnvelopeAddPageDialog = ({
  envelopeItem,
  trigger,
  ...props
}: EnvelopeAddPageDialogProps) => {
  const { t, i18n } = useLingui();
  const { toast } = useToast();

  const { envelope, setLocalEnvelope, registerPendingMutation } = useCurrentEnvelopeEditor();

  const [isOpen, setIsOpen] = useState(false);
  const [source, setSource] = useState<AddPageSource>('upload');
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [isDropping, setIsDropping] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { mutateAsync: addBlankPage } = trpc.envelope.item.addBlankPage.useMutation();
  const { mutateAsync: addPagesFromFile } = trpc.envelope.item.addPagesFromFile.useMutation();

  const onFileDropRejected = (fileRejections: FileRejection[]) => {
    toast({
      title: t`Upload failed`,
      description: i18n._(buildDropzoneRejectionDescription(fileRejections)),
      duration: 5000,
      variant: 'destructive',
    });
  };

  const onFileDrop = async (files: File[]) => {
    const file = files[0];

    if (!file || isDropping) {
      return;
    }

    setIsDropping(true);

    try {
      const isImage = file.type === 'image/png' || file.type === 'image/jpeg';

      if (isImage) {
        setSelectedFile({ file, pageCount: 1, isImage: true });
      } else {
        const arrayBuffer = await file.arrayBuffer();
        const fileData = new Uint8Array(arrayBuffer.slice(0));
        const { PDF } = await import('@libpdf/core');
        const pdfDoc = await PDF.load(fileData);

        setSelectedFile({ file, pageCount: pdfDoc.getPageCount(), isImage: false });
      }
    } catch (err) {
      console.error(err);

      toast({
        title: t`Failed to read file`,
        description: t`The file could not be read. Please try a different file.`,
        variant: 'destructive',
      });
    }

    setIsDropping(false);
  };

  const applyDocumentDataId = (documentDataId: string) => {
    setLocalEnvelope({
      envelopeItems: envelope.envelopeItems.map((item) =>
        item.id === envelopeItem.id ? { ...item, documentDataId } : item,
      ),
    });
  };

  const onSubmit = async () => {
    if (isDropping || isSubmitting) {
      return;
    }

    if (source === 'upload' && !selectedFile) {
      return;
    }

    setIsSubmitting(true);

    try {
      if (source === 'blank') {
        const addPromise = addBlankPage({
          envelopeId: envelope.id,
          envelopeItemId: envelopeItem.id,
        });

        registerPendingMutation(addPromise);

        const { data } = await addPromise;

        applyDocumentDataId(data.documentDataId);
      } else if (selectedFile) {
        const formData = new FormData();
        formData.append(
          'payload',
          JSON.stringify({ envelopeId: envelope.id, envelopeItemId: envelopeItem.id }),
        );
        formData.append('file', selectedFile.file);

        const addPromise = addPagesFromFile(formData);

        registerPendingMutation(addPromise);

        const { data } = await addPromise;

        applyDocumentDataId(data.documentDataId);
      }

      setIsOpen(false);
    } catch {
      toast({
        title: t`Failed to add page`,
        description: t`Something went wrong while adding the page.`,
        duration: 5000,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      setSource('upload');
      setSelectedFile(null);
      setIsDropping(false);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const isSubmitDisabled = isDropping || (source === 'upload' && !selectedFile);

  return (
    <Dialog {...props} open={isOpen} onOpenChange={(value) => !isSubmitting && setIsOpen(value)}>
      <DialogTrigger onClick={(e) => e.stopPropagation()} asChild>
        {trigger}
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Add page</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Add a blank page or upload a file to append to this document.</Trans>
          </DialogDescription>
        </DialogHeader>

        <fieldset disabled={isSubmitting} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              data-testid="envelope-add-page-source-upload"
              onClick={() => setSource('upload')}
              className={cn(
                'flex flex-col items-center gap-2 rounded-md border px-3 py-4 text-sm transition-colors',
                source === 'upload'
                  ? 'border-primary bg-primary/5 text-foreground'
                  : 'border-border text-muted-foreground hover:border-muted-foreground/50 hover:bg-muted/50',
              )}
            >
              <UploadIcon className="h-5 w-5" />
              <Trans>Upload file</Trans>
            </button>

            <button
              type="button"
              data-testid="envelope-add-page-source-blank"
              onClick={() => setSource('blank')}
              className={cn(
                'flex flex-col items-center gap-2 rounded-md border px-3 py-4 text-sm transition-colors',
                source === 'blank'
                  ? 'border-primary bg-primary/5 text-foreground'
                  : 'border-border text-muted-foreground hover:border-muted-foreground/50 hover:bg-muted/50',
              )}
            >
              <FilePlusIcon className="h-5 w-5" />
              <Trans>Blank page</Trans>
            </button>
          </div>

          {source === 'blank' ? (
            <p className="text-sm text-muted-foreground">
              <Trans>A blank page will be added to the end of this document.</Trans>
            </p>
          ) : selectedFile ? (
            <div
              data-testid="envelope-add-page-selected-file"
              className="flex items-center justify-between rounded-md border border-border bg-muted/50 px-3 py-2"
            >
              <div className="flex min-w-0 items-center space-x-2">
                {selectedFile.isImage ? (
                  <ImageIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                ) : (
                  <FileIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{selectedFile.file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(selectedFile.file.size)}
                    {' · '}
                    <Plural one="1 page" other="# pages" value={selectedFile.pageCount} />
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="envelope-add-page-clear-file"
                onClick={() => setSelectedFile(null)}
              >
                <XIcon className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <DocumentDropzone
              data-testid="envelope-add-page-dropzone"
              accept={ACCEPTED_FILE_TYPES}
              maxFiles={1}
              disabled={isSubmitting}
              heading={msg`Add a file`}
              message={msg`Drag & drop your PDF, PNG or JPG here.`}
              onDrop={(files) => void onFileDrop(files)}
              onDropRejected={onFileDropRejected}
            />
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                <Trans>Cancel</Trans>
              </Button>
            </DialogClose>

            <Button
              type="button"
              loading={isSubmitting}
              disabled={isSubmitDisabled}
              data-testid="envelope-add-page-submit"
              onClick={() => void onSubmit()}
            >
              <Trans>Add page</Trans>
            </Button>
          </DialogFooter>
        </fieldset>
      </DialogContent>
    </Dialog>
  );
};
