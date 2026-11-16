import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './Button';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Buttons row. */
  footer?: ReactNode;
  size?: 'md' | 'lg';
}

/**
 * Built on the native <dialog> element: the browser provides the focus trap,
 * Escape-to-close, the backdrop and correct screen-reader semantics, so we do
 * not re-implement (and subtly break) any of them.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={onClose}
      // Clicking the backdrop (the dialog element itself, outside the panel) closes it.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={`m-auto w-[calc(100%-2rem)] rounded-xl p-0 shadow-xl backdrop:bg-ink-900/50 ${
        size === 'lg' ? 'max-w-2xl' : 'max-w-lg'
      }`}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-ink-200 px-6 py-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold text-ink-900">
                {title}
              </h2>
              {description && <p className="mt-1 text-sm text-ink-500">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-ink-200 bg-ink-50 px-6 py-4">
              {footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}

/** "Are you sure?" for irreversible or consequential actions. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = 'Confirm',
  danger = false,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink-600">{children}</div>
    </Modal>
  );
}
