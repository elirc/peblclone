import type { OnboardingTaskKey, TaskAssignee } from '@meridian/shared';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { onboardingTasks, workers } from '../db/schema';
import { recordAudit } from './audit';

/**
 * Onboarding is the seam where three modules meet:
 *   workers   -> creates the checklist at hire time
 *   documents -> completes `documents_verified` when the last document is verified
 *   contracts -> completes `contract_signed` when the worker signs
 *
 * Rather than have those modules reach into each other's services, they all
 * call the two small functions in this file. The checklist rules live in one
 * place and no module imports another module.
 */
export interface TaskTemplate {
  key: OnboardingTaskKey;
  title: string;
  description: string;
  assignee: TaskAssignee;
  /** Automatic tasks are completed by the system, not by a button. */
  automatic: boolean;
}

export const ONBOARDING_TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    key: 'contract_signed',
    title: 'Sign employment agreement',
    description: 'Review and sign the agreement in the worker portal.',
    assignee: 'worker',
    automatic: true,
  },
  {
    key: 'documents_verified',
    title: 'Submit required documents',
    description: 'Upload each requested document; Meridian verifies them.',
    assignee: 'worker',
    automatic: true,
  },
  {
    key: 'bank_details',
    title: 'Confirm bank details',
    description: 'Confirm the bank account salary should be paid into.',
    assignee: 'worker',
    automatic: false,
  },
  {
    key: 'client_confirm_start',
    title: 'Confirm start date and equipment',
    description: 'Client confirms the start date and that equipment has been arranged.',
    assignee: 'client',
    automatic: false,
  },
];

/**
 * If the worker is still onboarding and nothing on their checklist is pending,
 * flip them to `active`. Returns true if the worker was activated.
 */
export async function activateWorkerIfReady(
  tx: Tx,
  workerId: string,
  actorUserId: string | null,
): Promise<boolean> {
  // FOR UPDATE: two tasks completing at the same instant must not both decide
  // "one task still pending" from stale reads. The row lock makes them queue.
  const [worker] = await tx
    .select({ id: workers.id, status: workers.status, organizationId: workers.organizationId })
    .from(workers)
    .where(eq(workers.id, workerId))
    .for('update');
  if (!worker || worker.status !== 'onboarding') return false;

  const pending = await tx
    .select({ id: onboardingTasks.id })
    .from(onboardingTasks)
    .where(and(eq(onboardingTasks.workerId, workerId), eq(onboardingTasks.status, 'pending')))
    .limit(1);
  if (pending.length > 0) return false;

  await tx.update(workers).set({ status: 'active' }).where(eq(workers.id, workerId));
  await recordAudit(
    tx,
    { userId: actorUserId, organizationId: worker.organizationId },
    {
      action: 'worker.activated',
      entityType: 'worker',
      entityId: workerId,
      metadata: { via: 'onboarding_complete' },
    },
  );
  return true;
}

/**
 * Mark one checklist task complete (idempotent: completing twice is a no-op),
 * then activate the worker if that was the last one.
 */
export async function completeOnboardingTask(
  tx: Tx,
  workerId: string,
  key: OnboardingTaskKey,
  actorUserId: string | null,
): Promise<{ completed: boolean; activated: boolean }> {
  const updated = await tx
    .update(onboardingTasks)
    .set({ status: 'completed', completedAt: new Date(), completedBy: actorUserId })
    .where(
      and(
        eq(onboardingTasks.workerId, workerId),
        eq(onboardingTasks.key, key),
        eq(onboardingTasks.status, 'pending'),
      ),
    )
    .returning({ id: onboardingTasks.id });
  const activated = await activateWorkerIfReady(tx, workerId, actorUserId);
  return { completed: updated.length > 0, activated };
}

/** Put a task back to pending (e.g. a verified document was later rejected). */
export async function reopenOnboardingTask(
  tx: Tx,
  workerId: string,
  key: OnboardingTaskKey,
): Promise<void> {
  await tx
    .update(onboardingTasks)
    .set({ status: 'pending', completedAt: null, completedBy: null })
    .where(and(eq(onboardingTasks.workerId, workerId), eq(onboardingTasks.key, key)));
}
