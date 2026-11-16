import { z } from 'zod';
import { isIsoDate } from './dates';
import {
  CONTRACT_STATUSES,
  DOCUMENT_KINDS,
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  INVITABLE_TEAM_ROLES,
  INVOICE_STATUSES,
  PAY_BASES,
  PAYROLL_RUN_STATUSES,
  TIME_OFF_STATUSES,
  TIME_OFF_TYPES,
  WORKER_STATUSES,
  WORKER_TYPES,
} from './enums';

/**
 * Request schemas: the shape of everything a client may SEND to the API.
 *
 * The API validates every body/query against these before a handler runs, and
 * the web app uses the inferred types for its forms. If the two ever disagree,
 * TypeScript fails the build — that is the whole point of a shared contract.
 */

// ---------- primitives ----------
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200);
export const nameSchema = z.string().trim().min(1).max(120);
export const uuidSchema = z.string().uuid();
export const isoDateSchema = z.string().refine(isIsoDate, 'Expected a date as YYYY-MM-DD');
export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Expected a 2-letter country code');
/** Money in minor units. The ceiling keeps sums far inside Number.MAX_SAFE_INTEGER. */
export const moneyMinorSchema = z.number().int().nonnegative().max(1_000_000_000_000);
export const positiveMoneyMinorSchema = moneyMinorSchema.refine((n) => n > 0, 'Must be > 0');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---------- auth ----------
export const registerSchema = z.object({
  organizationName: nameSchema,
  countryCode: countryCodeSchema,
  fullName: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  fullName: nameSchema,
  password: passwordSchema,
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

// ---------- organization & team ----------
export const updateOrganizationSchema = z
  .object({
    name: nameSchema,
    legalName: nameSchema,
    billingEmail: emailSchema,
    countryCode: countryCodeSchema,
  })
  .partial();
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const createTeamInviteSchema = z.object({
  email: emailSchema,
  role: z.enum(INVITABLE_TEAM_ROLES),
});
export type CreateTeamInviteInput = z.infer<typeof createTeamInviteSchema>;

export const updateTeamMemberSchema = z
  .object({
    role: z.enum(INVITABLE_TEAM_ROLES),
    isActive: z.boolean(),
  })
  .partial();
export type UpdateTeamMemberInput = z.infer<typeof updateTeamMemberSchema>;

// ---------- countries & quotes ----------
export const contributionRuleSchema = z.object({
  key: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(120),
  rateBps: z.number().int().min(0).max(10_000),
  annualCapMinor: moneyMinorSchema.nullable().optional(),
});

export const updateCountrySchema = z
  .object({
    employerContributions: z.array(contributionRuleSchema).max(20),
    employeeDeductions: z.array(contributionRuleSchema).max(20),
    monthlyFeeUsdMinor: moneyMinorSchema,
    annualLeaveDays: z.number().int().min(0).max(60),
    noticePeriodDays: z.number().int().min(0).max(365),
    probationDays: z.number().int().min(0).max(365),
    eorSupported: z.boolean(),
    requiredDocuments: z.array(z.enum(DOCUMENT_KINDS)).max(10),
  })
  .partial();
export type UpdateCountryInput = z.infer<typeof updateCountrySchema>;

export const calculateQuoteSchema = z.object({
  countryCode: countryCodeSchema,
  annualSalaryMinor: positiveMoneyMinorSchema,
});
export type CalculateQuoteInput = z.infer<typeof calculateQuoteSchema>;

export const saveQuoteSchema = calculateQuoteSchema.extend({
  label: z.string().trim().max(120).optional(),
});
export type SaveQuoteInput = z.infer<typeof saveQuoteSchema>;

// ---------- workers ----------
export const createWorkerSchema = z.object({
  type: z.enum(WORKER_TYPES),
  firstName: nameSchema,
  lastName: nameSchema,
  email: emailSchema,
  countryCode: countryCodeSchema,
  jobTitle: z.string().trim().min(1).max(120),
  department: z.string().trim().max(120).optional(),
  startDate: isoDateSchema,
  salaryMinor: positiveMoneyMinorSchema,
  payBasis: z.enum(PAY_BASES),
  /** Create a portal invite for the worker straight away. */
  sendInvite: z.boolean().default(true),
});
export type CreateWorkerInput = z.infer<typeof createWorkerSchema>;

export const updateWorkerSchema = z
  .object({
    firstName: nameSchema,
    lastName: nameSchema,
    jobTitle: z.string().trim().min(1).max(120),
    department: z.string().trim().max(120).nullable(),
    startDate: isoDateSchema,
    salaryMinor: positiveMoneyMinorSchema,
    payBasis: z.enum(PAY_BASES),
  })
  .partial();
export type UpdateWorkerInput = z.infer<typeof updateWorkerSchema>;

export const listWorkersQuerySchema = paginationSchema.extend({
  status: z.enum(WORKER_STATUSES).optional(),
  type: z.enum(WORKER_TYPES).optional(),
  countryCode: countryCodeSchema.optional(),
  search: z.string().trim().max(100).optional(),
});
export type ListWorkersQuery = z.infer<typeof listWorkersQuerySchema>;

export const transitionWorkerSchema = z.object({
  to: z.enum(WORKER_STATUSES),
  /** Last working day. Required when moving to `offboarding`. */
  endDate: isoDateSchema.optional(),
  reason: z.string().trim().max(500).optional(),
});
export type TransitionWorkerInput = z.infer<typeof transitionWorkerSchema>;

// ---------- documents ----------
export const requestDocumentSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  title: z.string().trim().min(1).max(160),
});
export type RequestDocumentInput = z.infer<typeof requestDocumentSchema>;

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const ALLOWED_DOCUMENT_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;

export const uploadDocumentSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(ALLOWED_DOCUMENT_MIME_TYPES),
  dataBase64: z.string().min(1),
});
export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;

export const reviewDocumentSchema = z.object({
  decision: z.enum(['verified', 'rejected']),
  note: z.string().trim().max(500).optional(),
});
export type ReviewDocumentInput = z.infer<typeof reviewDocumentSchema>;

// ---------- contracts ----------
export const createContractSchema = z.object({ workerId: uuidSchema });
export type CreateContractInput = z.infer<typeof createContractSchema>;

export const updateContractSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().min(1).max(50_000),
  })
  .partial();
export type UpdateContractInput = z.infer<typeof updateContractSchema>;

export const signContractSchema = z.object({
  /** The signer types their full legal name; it must match the worker's name. */
  signedByName: nameSchema,
  agree: z.literal(true),
});
export type SignContractInput = z.infer<typeof signContractSchema>;

export const listContractsQuerySchema = paginationSchema.extend({
  workerId: uuidSchema.optional(),
  status: z.enum(CONTRACT_STATUSES).optional(),
});
export type ListContractsQuery = z.infer<typeof listContractsQuerySchema>;

// ---------- time off ----------
export const createTimeOffRequestSchema = z
  .object({
    /** Omitted when a worker files for themselves; required for client users. */
    workerId: uuidSchema.optional(),
    type: z.enum(TIME_OFF_TYPES),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: 'End date must be on or after start date',
    path: ['endDate'],
  });
export type CreateTimeOffRequestInput = z.infer<typeof createTimeOffRequestSchema>;

export const decisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
});
export type DecisionInput = z.infer<typeof decisionSchema>;

export const listTimeOffQuerySchema = paginationSchema.extend({
  workerId: uuidSchema.optional(),
  status: z.enum(TIME_OFF_STATUSES).optional(),
});
export type ListTimeOffQuery = z.infer<typeof listTimeOffQuerySchema>;

export const timeOffBalanceQuerySchema = z.object({
  workerId: uuidSchema.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

// ---------- expenses ----------
export const createExpenseSchema = z.object({
  workerId: uuidSchema.optional(),
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().trim().min(1).max(300),
  amountMinor: positiveMoneyMinorSchema,
  incurredOn: isoDateSchema,
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const listExpensesQuerySchema = paginationSchema.extend({
  workerId: uuidSchema.optional(),
  status: z.enum(EXPENSE_STATUSES).optional(),
});
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;

// ---------- payroll ----------
export const createPayrollRunSchema = z.object({
  countryCode: countryCodeSchema,
  periodYear: z.number().int().min(2020).max(2100),
  periodMonth: z.number().int().min(1).max(12),
});
export type CreatePayrollRunInput = z.infer<typeof createPayrollRunSchema>;

export const rejectPayrollRunSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type RejectPayrollRunInput = z.infer<typeof rejectPayrollRunSchema>;

export const listPayrollRunsQuerySchema = paginationSchema.extend({
  status: z.enum(PAYROLL_RUN_STATUSES).optional(),
  countryCode: countryCodeSchema.optional(),
});
export type ListPayrollRunsQuery = z.infer<typeof listPayrollRunsQuerySchema>;

export const listPayslipsQuerySchema = paginationSchema.extend({
  workerId: uuidSchema.optional(),
});

// ---------- invoices ----------
export const listInvoicesQuerySchema = paginationSchema.extend({
  status: z.enum(INVOICE_STATUSES).optional(),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

// ---------- audit ----------
export const listAuditLogsQuerySchema = paginationSchema.extend({
  entityType: z.string().trim().max(60).optional(),
  entityId: uuidSchema.optional(),
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
