import type { ReactNode } from 'react';

/**
 * Frame of the «Pull from BigQuery» dialog: the body scrolls, the footer with the action
 * buttons stays outside the scrolling part, so Cancel and Pull are never cut off when the
 * tab pane is short (the over-cap and changed-settings states are tall).
 */
export function GscBqDialogFrame({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50">
      <div
        role="dialog"
        aria-label={title}
        className="flex max-h-[80%] w-[460px] flex-col rounded border border-surface-700 bg-surface-900 text-[12px] text-surface-200 shadow-xl"
      >
        <div data-testid="gsc-bq-body" className="min-h-0 flex-1 overflow-y-auto p-4 pb-0">
          <div className="mb-2 text-[13px] font-semibold">{title}</div>
          {children}
        </div>
        <div data-testid="gsc-bq-footer" className="flex justify-end gap-2 p-4 pt-3">
          {footer}
        </div>
      </div>
    </div>
  );
}
