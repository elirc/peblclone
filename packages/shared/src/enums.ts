/**
 * Every closed set of values in the system lives here, exactly once.
 *
 * The API turns these tuples into Postgres enums (see apps/api/src/db/schema.ts),
 * zod turns them into validators, and the web app turns them into dropdowns.
 * One source of truth means "the database allows a status the UI has never
 * heard of" is a compile error instead of a production incident.
 */

export const USER_ROLES = ['platform_admin', 'client_admin', 'client_manager', 'worker'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Roles a client admin is allowed to hand out when inviting a teammate. */
export const INVITABLE_TEAM_ROLES = ['client_admin', 'client_manager'] as const;

export const WORKER_TYPES = ['employee', 'contractor'] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

export const WORKER_STATUSES = [
  'onboarding',
  'active',
  'offboarding',
  'terminated',
  'cancelled',
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const PAY_BASES = ['annual', 'monthly'] as const;
export type PayBasis = (typeof PAY_BASES)[number];

export const TASK_ASSIGNEES = ['worker', 'client', 'platform'] as const;
export type TaskAssignee = (typeof TASK_ASSIGNEES)[number];

export const TASK_STATUSES = ['pending', 'completed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Stable keys for onboarding tasks. Code looks tasks up by key, never by title. */
export const ONBOARDING_TASK_KEYS = [
  'bank_details',
  'documents_verified',
  'contract_signed',
  'client_confirm_start',
] as const;
export type OnboardingTaskKey = (typeof ONBOARDING_TASK_KEYS)[number];

export const DOCUMENT_STATUSES = ['requested', 'submitted', 'verified', 'rejected'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_KINDS = [
  'passport',
  'national_id',
  'tax_form',
  'bank_proof',
  'work_permit',
  'proof_of_address',
  'other',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const CONTRACT_STATUSES = [
  'draft',
  'sent',
  'signed',
  'active',
  'terminated',
  'void',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const TIME_OFF_TYPES = ['vacation', 'sick', 'unpaid', 'parental'] as const;
export type TimeOffType = (typeof TIME_OFF_TYPES)[number];

export const TIME_OFF_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type TimeOffStatus = (typeof TIME_OFF_STATUSES)[number];

export const EXPENSE_CATEGORIES = [
  'travel',
  'meals',
  'equipment',
  'software',
  'training',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_STATUSES = ['submitted', 'approved', 'rejected', 'reimbursed'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const PAYROLL_RUN_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'processing',
  'paid',
] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

export const INVOICE_STATUSES = ['issued', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_LINE_KINDS = [
  'gross_pay',
  'employer_cost',
  'reimbursement',
  'platform_fee',
] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];
