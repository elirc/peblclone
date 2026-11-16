import { UserX } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router';
import { useWorker, useWorkerDocuments } from '../../api/workers';
import {
  ButtonLink,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  StatusBadge,
  Tabs,
  type TabItem,
} from '../../components/ui';
import { isApiError } from '../../lib/api';
import { fullName } from '../../lib/format';
import { DocumentsTab } from './DocumentsTab';
import { OnboardingTab } from './OnboardingTab';
import { OverviewTab } from './OverviewTab';

const TAB_IDS = ['overview', 'onboarding', 'documents'] as const;
type TabId = (typeof TAB_IDS)[number];

const isTabId = (value: string | null): value is TabId =>
  value !== null && (TAB_IDS as readonly string[]).includes(value);

export default function WorkerDetailPage() {
  const { id = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const tab: TabId = isTabId(requestedTab) ? requestedTab : 'overview';

  const worker = useWorker(id);
  // Fetched up front (not only on the Documents tab) so the tab can show a count.
  const documents = useWorkerDocuments(id);

  const back = { to: '/people', label: 'People' };

  if (worker.isPending) {
    return (
      <>
        <PageHeader title="Worker" back={back} />
        <Loading />
      </>
    );
  }

  if (worker.isError) {
    // Unknown id, someone else's worker (tenancy answers 404) or a malformed id.
    if (isApiError(worker.error) && (worker.error.status === 404 || worker.error.status === 400)) {
      return (
        <>
          <PageHeader title="Worker not found" back={back} />
          <EmptyState
            icon={<UserX className="h-6 w-6" aria-hidden />}
            title="We couldn't find this worker"
            description="They may have been removed, or the link may be wrong."
            action={<ButtonLink to="/people">Back to people</ButtonLink>}
          />
        </>
      );
    }
    return (
      <>
        <PageHeader title="Worker" back={back} />
        <ErrorState error={worker.error} onRetry={() => void worker.refetch()} />
      </>
    );
  }

  const w = worker.data;
  const openTasks = w.tasks.filter((t) => t.status === 'pending').length;
  const tabs: TabItem<TabId>[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'onboarding', label: 'Onboarding', count: openTasks > 0 ? openTasks : undefined },
    { id: 'documents', label: 'Documents', count: documents.data?.items.length },
  ];

  return (
    <>
      <PageHeader
        back={back}
        title={fullName(w)}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {w.jobTitle} · {w.countryName}
            </span>
            <StatusBadge status={w.type} />
            <StatusBadge status={w.status} />
          </span>
        }
      />
      <Tabs
        tabs={tabs}
        active={tab}
        // `replace`: switching tabs should not fill the back button with tab changes.
        onChange={(next) => setSearchParams({ tab: next }, { replace: true })}
      />
      <div role="tabpanel">
        {tab === 'overview' && <OverviewTab worker={w} />}
        {tab === 'onboarding' && <OnboardingTab worker={w} />}
        {tab === 'documents' && <DocumentsTab worker={w} />}
      </div>
    </>
  );
}
