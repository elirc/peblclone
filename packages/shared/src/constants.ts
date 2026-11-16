/** Business constants that more than one package needs to agree on. */

/** Meridian's monthly fee for a contractor (employees use the per-country EOR fee). USD cents. */
export const CONTRACTOR_MONTHLY_FEE_USD_MINOR = 4_900;

/** Invoices are due this many days after issue. */
export const INVOICE_DUE_DAYS = 14;

/** Expenses older than this cannot be submitted. */
export const EXPENSE_MAX_AGE_DAYS = 90;

/** Human labels for document kinds (used for auto-requested documents and in the UI). */
export const DOCUMENT_KIND_LABELS = {
  passport: 'Passport',
  national_id: 'National ID',
  tax_form: 'Tax form',
  bank_proof: 'Proof of bank account',
  work_permit: 'Work permit',
  proof_of_address: 'Proof of address',
  other: 'Other document',
} as const;
