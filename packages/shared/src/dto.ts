import type { ContributionRule, CostBreakdown, PayslipLine } from './calc';
import type {
  ContractStatus,
  DocumentKind,
  DocumentStatus,
  ExpenseCategory,
  ExpenseStatus,
  InvoiceLineKind,
  InvoiceStatus,
  OnboardingTaskKey,
  PayBasis,
  PayrollRunStatus,
  TaskAssignee,
  TaskStatus,
  TimeOffStatus,
  TimeOffType,
  UserRole,
  WorkerStatus,
  WorkerType,
} from './enums';

/**
 * Response DTOs: the shape of everything the API may SEND BACK.
 *
 * Conventions (every endpoint follows them):
 *  - timestamps are ISO-8601 strings (`2026-01-31T09:00:00.000Z`)
 *  - calendar dates are `YYYY-MM-DD` strings
 *  - money is `…Minor` integers plus a `currency` field
 *  - list endpoints return `Paginated<T>`
 *  - database rows are never returned directly; services map row -> DTO so a
 *    new column (say `passwordHash`) can never leak by accident.
 */

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Field-level problems for validation errors: { "email": ["Invalid email"] } */
    details?: Record<string, string[]>;
  };
}

// ---------- auth / org / team ----------
export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  organizationId: string | null;
  organizationName: string | null;
  /** Set when role === 'worker'. */
  workerId: string | null;
}

export interface AuthResponse {
  user: SessionUser;
}

export interface InvitePreviewDto {
  email: string;
  organizationName: string;
  role: UserRole;
  suggestedName: string | null;
}

export interface OrganizationDto {
  id: string;
  name: string;
  legalName: string;
  countryCode: string;
  billingEmail: string;
  createdAt: string;
}

export interface OrganizationSummaryDto extends OrganizationDto {
  workerCount: number;
}

export interface TeamMemberDto {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
}

export interface InviteDto {
  id: string;
  email: string;
  role: UserRole;
  workerId: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

/** Returned once, at creation. There is no email service; the UI shows the link to copy. */
export interface InviteCreatedDto {
  invite: InviteDto;
  acceptUrl: string;
}

// ---------- countries & quotes ----------
export interface CountryDto {
  code: string;
  name: string;
  region: string;
  currency: string;
  employerContributions: ContributionRule[];
  employeeDeductions: ContributionRule[];
  monthlyFeeUsdMinor: number;
  annualLeaveDays: number;
  noticePeriodDays: number;
  probationDays: number;
  eorSupported: boolean;
  requiredDocuments: DocumentKind[];
}

export interface QuoteDto {
  id: string;
  label: string | null;
  countryCode: string;
  breakdown: CostBreakdown;
  createdAt: string;
}

// ---------- workers ----------
export interface WorkerDto {
  id: string;
  type: WorkerType;
  status: WorkerStatus;
  firstName: string;
  lastName: string;
  email: string;
  countryCode: string;
  countryName: string;
  jobTitle: string;
  department: string | null;
  startDate: string;
  endDate: string | null;
  salaryMinor: number;
  payBasis: PayBasis;
  currency: string;
  hasPortalAccess: boolean;
  createdAt: string;
}

export interface OnboardingTaskDto {
  id: string;
  workerId: string;
  key: OnboardingTaskKey;
  title: string;
  description: string;
  assignee: TaskAssignee;
  status: TaskStatus;
  /** True when the system completes it (e.g. on contract signature); no manual button. */
  automatic: boolean;
  completedAt: string | null;
}

export interface WorkerDetailDto extends WorkerDto {
  tasks: OnboardingTaskDto[];
}

/** Response of POST /workers. `acceptUrl` is present when an invite was created. */
export interface WorkerCreatedDto {
  worker: WorkerDetailDto;
  acceptUrl: string | null;
}

// ---------- documents ----------
export interface DocumentDto {
  id: string;
  workerId: string;
  kind: DocumentKind;
  title: string;
  status: DocumentStatus;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  reviewNote: string | null;
  uploadedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

// ---------- contracts ----------
export interface ContractTerms {
  workerName: string;
  workerType: WorkerType;
  jobTitle: string;
  countryCode: string;
  countryName: string;
  startDate: string;
  salaryMinor: number;
  payBasis: PayBasis;
  currency: string;
  annualLeaveDays: number;
  noticePeriodDays: number;
  probationDays: number;
}

export interface ContractDto {
  id: string;
  workerId: string;
  workerName: string;
  status: ContractStatus;
  title: string;
  /** Snapshot of the commercial terms at generation time. */
  terms: ContractTerms;
  sentAt: string | null;
  signedAt: string | null;
  signedByName: string | null;
  activatedAt: string | null;
  terminatedAt: string | null;
  createdAt: string;
}

export interface ContractDetailDto extends ContractDto {
  body: string;
}

// ---------- time off ----------
export interface TimeOffRequestDto {
  id: string;
  workerId: string;
  workerName: string;
  type: TimeOffType;
  status: TimeOffStatus;
  startDate: string;
  endDate: string;
  /** Business days in the range. */
  days: number;
  reason: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface TimeOffBalanceDto {
  workerId: string;
  year: number;
  entitlementDays: number;
  usedDays: number;
  pendingDays: number;
  remainingDays: number;
}

// ---------- expenses ----------
export interface ExpenseDto {
  id: string;
  workerId: string;
  workerName: string;
  category: ExpenseCategory;
  description: string;
  amountMinor: number;
  currency: string;
  incurredOn: string;
  status: ExpenseStatus;
  decisionNote: string | null;
  decidedAt: string | null;
  payrollRunId: string | null;
  createdAt: string;
}

// ---------- payroll ----------
export interface PayrollRunDto {
  id: string;
  countryCode: string;
  countryName: string;
  currency: string;
  periodYear: number;
  periodMonth: number;
  status: PayrollRunStatus;
  workerCount: number;
  grossMinor: number;
  deductionsMinor: number;
  netMinor: number;
  employerCostMinor: number;
  reimbursementsMinor: number;
  /** gross + employer costs + reimbursements, local currency. */
  totalCostMinor: number;
  rejectionReason: string | null;
  invoiceId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface PayrollItemDto {
  id: string;
  payrollRunId: string;
  workerId: string;
  workerName: string;
  workerType: WorkerType;
  daysWorked: number;
  daysInPeriod: number;
  grossMinor: number;
  deductionsMinor: number;
  netMinor: number;
  employerCostMinor: number;
  reimbursementsMinor: number;
  deductions: PayslipLine[];
  employerCosts: PayslipLine[];
}

export interface PayrollRunDetailDto extends PayrollRunDto {
  items: PayrollItemDto[];
}

/** A worker-facing payslip: one paid payroll item plus its period. */
export interface PayslipDto extends PayrollItemDto {
  currency: string;
  periodYear: number;
  periodMonth: number;
  paidAt: string;
}

// ---------- invoices ----------
export interface InvoiceLineDto {
  id: string;
  kind: InvoiceLineKind;
  description: string;
  amountMinor: number;
}

export interface InvoiceDto {
  id: string;
  number: string;
  status: InvoiceStatus;
  /** Invoices are always billed in USD. */
  currency: string;
  subtotalMinor: number;
  feeMinor: number;
  totalMinor: number;
  payrollRunId: string | null;
  /** Local-currency units per 1 USD used for conversion, frozen at issue time. */
  fxRate: string;
  localCurrency: string;
  issuedAt: string;
  dueDate: string;
  paidAt: string | null;
}

export interface InvoiceDetailDto extends InvoiceDto {
  organizationName: string;
  lines: InvoiceLineDto[];
}

// ---------- audit & dashboard ----------
export interface AuditLogDto {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DashboardDto {
  headcount: {
    total: number;
    active: number;
    onboarding: number;
    employees: number;
    contractors: number;
  };
  byCountry: { countryCode: string; countryName: string; count: number }[];
  pending: {
    timeOffRequests: number;
    expenses: number;
    payrollApprovals: number;
    unpaidInvoices: number;
    contractsAwaitingSignature: number;
  };
  /** Paid/issued invoice totals for the last 6 months, oldest first, in USD. */
  monthlySpend: { year: number; month: number; totalUsdMinor: number }[];
  recentActivity: AuditLogDto[];
}
