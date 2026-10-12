import { Trans } from '@lingui/react/macro';

import { useCurrentEnvelopeEditor } from '@documenso/lib/client-only/providers/envelope-editor-provider';
import { Button } from '@documenso/ui/primitives/button';

/**
 * The "you are picking fields" bar shown while either canvas pick-mode is active.
 *
 * Both pick-modes freeze dragging and swallow selection clicks on EVERY page —
 * picking a dependent/link member on another page is supported — so this lives
 * once, above the whole document view, rather than inside the per-page renderer.
 * Scoping it to the trigger's own page left every other page frozen with nothing
 * on screen explaining why, or how to get out.
 *
 * Sits in the scroll container as a zero-height sticky layer, so it floats over
 * the pages without shifting them when it appears.
 */
export const EnvelopeEditorPickModeBanner = () => {
  const { visibilityPickMode, linkPickMode } = useCurrentEnvelopeEditor();

  const visibilityTarget = visibilityPickMode.active;
  const linkTarget = linkPickMode.active;

  if (!visibilityTarget && !linkTarget) {
    return null;
  }

  return (
    <div className="pointer-events-none sticky top-0 z-50 h-0">
      <div className="flex justify-center pt-2">
        <div
          data-testid="pick-mode-banner"
          className="pointer-events-auto flex w-max items-center gap-3 rounded-md border border-primary bg-background px-3 py-1.5 text-xs shadow-sm"
        >
          {visibilityTarget ? (
            <>
              <span>
                <Trans>
                  Click fields to show when{' '}
                  <span className="font-semibold">“{visibilityTarget.value}”</span> is selected
                </Trans>
              </span>

              <Button type="button" size="sm" onClick={() => visibilityPickMode.exit()}>
                <Trans>Done</Trans>
              </Button>
            </>
          ) : (
            <>
              <span>
                <Trans>
                  Click fields to link — a value entered in one is copied to all of them
                </Trans>
              </span>

              <Button type="button" size="sm" onClick={() => linkPickMode.exit()}>
                <Trans>Done</Trans>
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
