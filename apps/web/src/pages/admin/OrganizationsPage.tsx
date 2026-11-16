import type { OrganizationSummaryDto } from '@meridian/shared';
import { Building2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useAdminOrganizations } from '../../api/organization';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Table,
  type Column,
} from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { formatDate } from '../../lib/format';

/**
 * Platform admins (Meridian staff) belong to no client organization. To see or
 * change a client's data they pick one here; from then on every request carries
 * `X-Org-Id` for that organization (see lib/api.ts) until they pick another.
 */
export default function OrganizationsPage() {
  const { actingOrgId, setActingOrg } = useAuth();
  const navigate = useNavigate();
  const organizations = useAdminOrganizations();

  const workIn = (org: OrganizationSummaryDto) => {
    setActingOrg(org.id);
    navigate('/');
  };

  const current = organizations.data?.items.find((org) => org.id === actingOrgId);

  const columns: Column<OrganizationSummaryDto>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (org) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink-900">{org.name}</span>
          {org.id === actingOrgId && <Badge tone="green">Current</Badge>}
        </span>
      ),
    },
    { key: 'country', header: 'Country', cell: (org) => org.countryCode },
    { key: 'billing', header: 'Billing email', cell: (org) => org.billingEmail },
    { key: 'workers', header: 'Workers', align: 'right', cell: (org) => org.workerCount },
    { key: 'created', header: 'Created', cell: (org) => formatDate(org.createdAt) },
    {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (org) => (
        <Button
          size="sm"
          variant={org.id === actingOrgId ? 'secondary' : 'primary'}
          aria-label={`Work in ${org.name}`}
          onClick={() => workIn(org)}
        >
          {org.id === actingOrgId ? 'Continue' : 'Work in this organization'}
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Client organizations"
        description="As Meridian staff you don't belong to a client. Pick the organization you want to act inside — every page then shows and changes that client's data until you switch."
      />

      {current && (
        <Alert tone="info" className="mb-6" title={`You are working in ${current.name}`}>
          Pick another organization below to switch.
        </Alert>
      )}

      <Card padded={false}>
        {organizations.isPending ? (
          <Loading label="Loading organizations…" />
        ) : organizations.isError ? (
          <div className="px-4">
            <ErrorState error={organizations.error} onRetry={() => void organizations.refetch()} />
          </div>
        ) : (
          <Table
            caption="Client organizations"
            columns={columns}
            rows={organizations.data.items}
            rowKey={(org) => org.id}
            empty={
              <EmptyState
                icon={<Building2 className="h-6 w-6" aria-hidden />}
                title="No client organizations yet"
                description="Organizations appear here when a company signs up for Meridian."
              />
            }
          />
        )}
      </Card>
    </>
  );
}
