import { useCallback, useState, type FormEvent } from 'react';
import type { z } from 'zod';
import { errorMessage, isApiError } from './api';

type FieldErrors = Record<string, string>;

/**
 * A small form hook built on the SAME zod schemas the API validates with.
 *
 *   const form = useZodForm(loginSchema, { email: '', password: '' });
 *   <form onSubmit={form.handleSubmit(async (data) => { await login(data); })}>
 *     <Input {...form.field('email')} />
 *
 * Validation runs in the browser first (instant feedback); if the server still
 * rejects the request, its field-level `details` are shown on the same fields.
 * The browser check is a convenience — the server check is the real one.
 */
export function useZodForm<S extends z.ZodType>(schema: S, initialValues: z.input<S>) {
  const [values, setValues] = useState<z.input<S>>(initialValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setValue = useCallback(<K extends keyof z.input<S>>(name: K, value: z.input<S>[K]) => {
    setValues((prev) => ({ ...(prev as object), [name]: value }) as z.input<S>);
    setErrors((prev) => {
      if (!(String(name) in prev)) return prev;
      const { [String(name)]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  const handleSubmit = useCallback(
    (onValid: (data: z.output<S>) => Promise<void> | void) => async (event?: FormEvent) => {
      event?.preventDefault();
      setFormError(null);

      const result = schema.safeParse(values);
      if (!result.success) {
        const next: FieldErrors = {};
        for (const issue of result.error.issues) {
          const key = issue.path.join('.') || '_';
          next[key] ??= issue.message;
        }
        setErrors(next);
        if (next._) setFormError(next._);
        return;
      }

      setErrors({});
      setSubmitting(true);
      try {
        await onValid(result.data);
      } catch (err) {
        if (isApiError(err) && err.details) {
          const next: FieldErrors = {};
          for (const [key, messages] of Object.entries(err.details)) {
            if (messages[0]) next[key] = messages[0];
          }
          setErrors(next);
        }
        setFormError(errorMessage(err));
      } finally {
        setSubmitting(false);
      }
    },
    [schema, values],
  );

  /** Props for a text-like input bound to a string field. */
  const field = useCallback(
    <K extends keyof z.input<S> & string>(name: K) => ({
      name,
      value: String((values as Record<string, unknown>)[name] ?? ''),
      error: errors[name],
      onChange: (event: { target: { value: string } }) =>
        setValue(name, event.target.value as z.input<S>[K]),
    }),
    [values, errors, setValue],
  );

  const reset = useCallback(
    (next: z.input<S> = initialValues) => {
      setValues(next);
      setErrors({});
      setFormError(null);
    },
    [initialValues],
  );

  return {
    values,
    setValue,
    setValues,
    errors,
    formError,
    setFormError,
    submitting,
    handleSubmit,
    field,
    reset,
  };
}
