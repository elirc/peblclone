import type {
  DocumentDto,
  OnboardingTaskCompletedDto,
  UploadDocumentInput,
  WorkerDetailDto,
} from '@meridian/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, saveBlob } from '../lib/api';
import { invalidate, keys } from '../lib/query';

/**
 * The worker portal's own lookups: "who am I as a worker", my documents, and
 * completing my onboarding tasks.
 *
 * `/me/worker` is cached under `keys.workers`, so anything that changes a worker
 * (signing a contract, completing a task) refreshes the portal too.
 */

export function useMyWorker(enabled = true) {
  return useQuery({
    queryKey: [...keys.workers, 'me'],
    queryFn: () => api.get<WorkerDetailDto>('/me/worker'),
    enabled,
  });
}

export function useWorkerDocuments(workerId: string | undefined) {
  return useQuery({
    queryKey: [...keys.documents, 'worker', workerId],
    queryFn: () => api.get<{ items: DocumentDto[] }>(`/workers/${workerId ?? ''}/documents`),
    enabled: Boolean(workerId),
  });
}

export function useUploadDocument() {
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UploadDocumentInput }) =>
      api.post<DocumentDto>(`/documents/${id}/file`, input),
    // Staff see the new upload on the worker page too (same `documents` key).
    onSuccess: () => invalidate(keys.documents, keys.audit),
  });
}

export function useCompleteOnboardingTask() {
  return useMutation({
    mutationFn: (taskId: string) =>
      api.post<OnboardingTaskCompletedDto>(`/onboarding-tasks/${taskId}/complete`),
    // Completing the last task activates the worker, which moves the dashboard headcount.
    onSuccess: () => invalidate(keys.workers, keys.dashboard, keys.audit),
  });
}

/** Download an uploaded document to the user's disk. */
export async function downloadDocument(doc: DocumentDto): Promise<void> {
  const blob = await api.blob(`/documents/${doc.id}/file`);
  saveBlob(blob, doc.fileName ?? `${doc.title}`);
}
