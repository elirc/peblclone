import { ApiError, isApiError } from '../../lib/api';

/**
 * Some business-rule errors are really about ONE field (e.g. `signature_mismatch`
 * is about the typed name, `future_date` about the expense date), but the API
 * sends them without field `details`. Re-throwing them with details attached lets
 * `useZodForm` show the message under the right input instead of only at the top.
 *
 * Use inside a `form.handleSubmit` callback:
 *   try { await m.mutateAsync(x) } catch (e) { rethrowOnField(e, { signature_mismatch: 'signedByName' }) }
 */
export function rethrowOnField(err: unknown, fieldByCode: Record<string, string>): never {
  if (isApiError(err) && !err.details) {
    const field = fieldByCode[err.code];
    if (field) throw new ApiError(err.status, err.code, err.message, { [field]: [err.message] });
  }
  throw err;
}

/**
 * The top-of-form alert is only needed when the message is not already shown
 * under a field (avoids the same sentence twice).
 */
export function topLevelError(form: {
  formError: string | null;
  errors: Record<string, string>;
}): string | null {
  if (!form.formError) return null;
  return Object.values(form.errors).includes(form.formError) ? null : form.formError;
}
