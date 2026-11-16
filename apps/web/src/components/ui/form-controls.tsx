import clsx from 'clsx';
import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

const controlClass = (hasError: boolean, className?: string) =>
  clsx(
    'block w-full rounded-lg border bg-white px-3 text-sm text-ink-900 shadow-sm',
    'placeholder:text-ink-400 disabled:bg-ink-100 disabled:text-ink-500',
    hasError ? 'border-red-400' : 'border-ink-300',
    className,
  );

interface FieldShellProps {
  id: string;
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
}

/**
 * Label + control + hint/error, wired for accessibility: the label is tied to
 * the control by id, and the error is announced via aria-describedby.
 */
function FieldShell({ id, label, hint, error, required, children }: FieldShellProps) {
  return (
    <div>
      {label && (
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink-700">
          {label}
          {required && <span className="ml-0.5 text-red-600">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-sm text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-ink-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface CommonProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
}

const describedBy = (id: string, error?: string, hint?: ReactNode) =>
  error ? `${id}-error` : hint ? `${id}-hint` : undefined;

export function Input({
  label,
  hint,
  error,
  className,
  id: idProp,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & CommonProps) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={rest.required}>
      <input
        id={id}
        className={controlClass(Boolean(error), clsx('h-10', className))}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...rest}
      />
    </FieldShell>
  );
}

export function Select({
  label,
  hint,
  error,
  className,
  id: idProp,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & CommonProps) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={rest.required}>
      <select
        id={id}
        className={controlClass(Boolean(error), clsx('h-10', className))}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  );
}

export function Textarea({
  label,
  hint,
  error,
  className,
  id: idProp,
  rows = 4,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & CommonProps) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={rest.required}>
      <textarea
        id={id}
        rows={rows}
        className={controlClass(Boolean(error), clsx('py-2', className))}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        {...rest}
      />
    </FieldShell>
  );
}

export function Checkbox({
  label,
  className,
  id: idProp,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode }) {
  const generated = useId();
  const id = idProp ?? generated;
  return (
    <div className={clsx('flex items-start gap-2', className)}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-ink-300 accent-brand-700"
        {...rest}
      />
      <label htmlFor={id} className="text-sm text-ink-700">
        {label}
      </label>
    </div>
  );
}
