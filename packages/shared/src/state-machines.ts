import type {
  ContractStatus,
  ExpenseStatus,
  InvoiceStatus,
  PayrollRunStatus,
  TimeOffStatus,
  WorkerStatus,
} from './enums';

/**
 * State machines as data.
 *
 * Each table answers one question: "from this status, where may I go?"
 * Services call `assertTransition` before every status change, so an illegal
 * jump (e.g. paying a payroll run that was never approved) is impossible to
 * reach through any endpoint — not merely hidden in the UI.
 */
export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export const WORKER_TRANSITIONS: TransitionMap<WorkerStatus> = {
  onboarding: ['active', 'cancelled'],
  active: ['offboarding'],
  offboarding: ['terminated', 'active'],
  terminated: [],
  cancelled: [],
};

export const CONTRACT_TRANSITIONS: TransitionMap<ContractStatus> = {
  draft: ['sent', 'void'],
  sent: ['signed', 'void', 'draft'],
  signed: ['active', 'void'],
  active: ['terminated'],
  terminated: [],
  void: [],
};

export const TIME_OFF_TRANSITIONS: TransitionMap<TimeOffStatus> = {
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['cancelled'],
  rejected: [],
  cancelled: [],
};

export const EXPENSE_TRANSITIONS: TransitionMap<ExpenseStatus> = {
  submitted: ['approved', 'rejected'],
  approved: ['reimbursed'],
  rejected: [],
  reimbursed: [],
};

export const PAYROLL_RUN_TRANSITIONS: TransitionMap<PayrollRunStatus> = {
  draft: ['pending_approval'],
  // A rejected run goes back to draft so the same period can be fixed and resubmitted.
  pending_approval: ['approved', 'draft'],
  approved: ['processing'],
  processing: ['paid'],
  paid: [],
};

export const INVOICE_TRANSITIONS: TransitionMap<InvoiceStatus> = {
  issued: ['paid', 'void'],
  paid: [],
  void: [],
};

export function canTransition<S extends string>(map: TransitionMap<S>, from: S, to: S): boolean {
  return map[from].includes(to);
}

export function isTerminal<S extends string>(map: TransitionMap<S>, status: S): boolean {
  return map[status].length === 0;
}
