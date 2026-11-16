import type {
  CreateWorkerInput,
  DocumentDto,
  InviteCreatedDto,
  ListWorkersQuery,
  OnboardingTaskCompletedDto,
  Paginated,
  RequestDocumentInput,
  ReviewDocumentInput,
  TransitionWorkerInput,
  UpdateWorkerInput,
  UploadDocumentInput,
  WorkerCreatedDto,
  WorkerDetailDto,
  WorkerDto,
} from '@meridian/shared';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { api, saveBlob } from '../lib/api';
import { invalidate, keys } from '../lib/query';

/*
 * Workers, onboarding tasks and documents.
 *
 * A note on invalidation: every state-changing endpoint writes an audit record,
 * and the dashboard shows the newest audit entries — so every mutation here
 * also invalidates `keys.audit` and `keys.dashboard`, not just the data it
 * obviously touched.
 */

// ---------- workers ----------

export function useWorkers(query: ListWorkersQuery) {
  return useQuery({
    queryKey: [...keys.workers, 'list', query],
    queryFn: () => api.get<Paginated<WorkerDto>>('/workers', query),
    // While the user types in the search box, keep showing the previous page of
    // results instead of flashing a spinner on every keystroke.
    placeholderData: keepPreviousData,
  });
}

export function useWorker(id: string) {
  return useQuery({
    queryKey: [...keys.workers, 'detail', id],
    queryFn: () => api.get<WorkerDetailDto>(`/workers/${id}`),
  });
}

export function useHireWorker() {
  return useMutation({
    mutationFn: (input: CreateWorkerInput) => api.post<WorkerCreatedDto>('/workers', input),
    // Hiring creates the worker, their requested documents and (maybe) an invite.
    onSuccess: () =>
      invalidate(keys.workers, keys.documents, keys.team, keys.dashboard, keys.audit),
  });
}

export function useUpdateWorker(id: string) {
  return useMutation({
    mutationFn: (input: UpdateWorkerInput) => api.patch<WorkerDetailDto>(`/workers/${id}`, input),
    // The worker's name is shown on contracts, time off, expenses and payroll lists.
    onSuccess: () =>
      invalidate(
        keys.workers,
        keys.contracts,
        keys.timeOff,
        keys.expenses,
        keys.payroll,
        keys.payslips,
        keys.dashboard,
        keys.audit,
      ),
  });
}

export function useTransitionWorker(id: string) {
  return useMutation({
    mutationFn: (input: TransitionWorkerInput) =>
      api.post<WorkerDetailDto>(`/workers/${id}/transition`, input),
    // Terminating ends the active contract; cancelling voids contracts and deletes invites.
    onSuccess: () =>
      invalidate(keys.workers, keys.contracts, keys.team, keys.dashboard, keys.audit),
  });
}

export function useCreateWorkerInvite(id: string) {
  return useMutation({
    mutationFn: () => api.post<InviteCreatedDto>(`/workers/${id}/invite`),
    onSuccess: () => invalidate(keys.workers, keys.team, keys.dashboard, keys.audit),
  });
}

// ---------- onboarding tasks ----------

export function useCompleteOnboardingTask() {
  return useMutation({
    mutationFn: (taskId: string) =>
      api.post<OnboardingTaskCompletedDto>(`/onboarding-tasks/${taskId}/complete`),
    // Completing the last task activates the worker, which changes headcounts.
    onSuccess: () => invalidate(keys.workers, keys.dashboard, keys.audit),
  });
}

// ---------- documents ----------

export function useWorkerDocuments(workerId: string) {
  return useQuery({
    queryKey: [...keys.documents, 'worker', workerId],
    queryFn: () => api.get<{ items: DocumentDto[] }>(`/workers/${workerId}/documents`),
  });
}

export function useRequestDocument(workerId: string) {
  return useMutation({
    mutationFn: (input: RequestDocumentInput) =>
      api.post<DocumentDto>(`/workers/${workerId}/documents`, input),
    // A new request re-opens the worker's "documents verified" onboarding task.
    onSuccess: () => invalidate(keys.documents, keys.workers, keys.dashboard, keys.audit),
  });
}

export function useUploadDocument() {
  return useMutation({
    mutationFn: ({ documentId, ...input }: UploadDocumentInput & { documentId: string }) =>
      api.post<DocumentDto>(`/documents/${documentId}/file`, input),
    onSuccess: () => invalidate(keys.documents, keys.dashboard, keys.audit),
  });
}

export function useReviewDocument() {
  return useMutation({
    mutationFn: ({ documentId, ...input }: ReviewDocumentInput & { documentId: string }) =>
      api.post<DocumentDto>(`/documents/${documentId}/review`, input),
    // Verifying the last document completes an onboarding task (and may activate the worker).
    onSuccess: () => invalidate(keys.documents, keys.workers, keys.dashboard, keys.audit),
  });
}

/** Download a document's file and hand it to the browser to save. */
export async function downloadDocument(document: DocumentDto): Promise<void> {
  const blob = await api.blob(`/documents/${document.id}/file`);
  saveBlob(blob, document.fileName ?? document.title);
}
