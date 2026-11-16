import type { AuditLogDto, DashboardDto } from '@meridian/shared';
import { and, count, desc, eq, gte, lt, ne, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import {
  auditLogs,
  contracts,
  countries,
  expenses,
  invoices,
  payrollRuns,
  timeOffRequests,
  users,
  workers,
} from '../../db/schema';
import { requireOrgId, type Actor } from '../../lib/actor';
import { iso } from '../../lib/http';

/*
 * The home screen: a handful of small aggregate queries, run in parallel.
 * EVERY query below filters by organization — a dashboard is the easiest place
 * to leak another tenant's numbers, because nobody inspects totals row by row.
 */

/** Workers who no longer count towards headcount. */
const GONE_STATUSES = ['terminated', 'cancelled'] as const;
const SPEND_MONTHS = 6;
const RECENT_ACTIVITY_LIMIT = 10;

interface MonthKey {
  year: number;
  month: number;
}

/** The last `n` calendar months (UTC) including the current one, oldest first. */
function lastMonths(n: number, now = new Date()): MonthKey[] {
  const months: MonthKey[] = [];
  for (let back = n - 1; back >= 0; back -= 1) {
    // Date.UTC normalises negative/overflowing months, so this handles year boundaries.
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return months;
}

async function headcountAndCountries(orgId: string) {
  const current = and(
    eq(workers.organizationId, orgId),
    notInArray(workers.status, [...GONE_STATUSES]),
  );

  const [byStatusAndType, byCountry] = await Promise.all([
    db
      .select({ status: workers.status, type: workers.type, n: count() })
      .from(workers)
      .where(current)
      .groupBy(workers.status, workers.type),
    db
      .select({ countryCode: workers.countryCode, countryName: countries.name, count: count() })
      .from(workers)
      .innerJoin(countries, eq(countries.code, workers.countryCode))
      .where(current)
      .groupBy(workers.countryCode, countries.name)
      .orderBy(desc(count()), countries.name),
  ]);

  const sumWhere = (keep: (r: (typeof byStatusAndType)[number]) => boolean) =>
    byStatusAndType.filter(keep).reduce((total, r) => total + r.n, 0);

  return {
    headcount: {
      total: sumWhere(() => true),
      active: sumWhere((r) => r.status === 'active'),
      onboarding: sumWhere((r) => r.status === 'onboarding'),
      employees: sumWhere((r) => r.type === 'employee'),
      contractors: sumWhere((r) => r.type === 'contractor'),
    },
    byCountry,
  };
}

async function pendingCounts(orgId: string): Promise<DashboardDto['pending']> {
  const countWhere = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;

  const [timeOff, expenseCount, approvals, unpaid, awaitingSignature] = await Promise.all([
    countWhere(
      db
        .select({ n: count() })
        .from(timeOffRequests)
        .where(
          and(eq(timeOffRequests.organizationId, orgId), eq(timeOffRequests.status, 'pending')),
        ),
    ),
    countWhere(
      db
        .select({ n: count() })
        .from(expenses)
        .where(and(eq(expenses.organizationId, orgId), eq(expenses.status, 'submitted'))),
    ),
    countWhere(
      db
        .select({ n: count() })
        .from(payrollRuns)
        .where(
          and(eq(payrollRuns.organizationId, orgId), eq(payrollRuns.status, 'pending_approval')),
        ),
    ),
    countWhere(
      db
        .select({ n: count() })
        .from(invoices)
        .where(and(eq(invoices.organizationId, orgId), eq(invoices.status, 'issued'))),
    ),
    countWhere(
      db
        .select({ n: count() })
        .from(contracts)
        .where(and(eq(contracts.organizationId, orgId), eq(contracts.status, 'sent'))),
    ),
  ]);

  return {
    timeOffRequests: timeOff,
    expenses: expenseCount,
    payrollApprovals: approvals,
    unpaidInvoices: unpaid,
    contractsAwaitingSignature: awaitingSignature,
  };
}

async function monthlySpend(orgId: string): Promise<DashboardDto['monthlySpend']> {
  const months = lastMonths(SPEND_MONTHS);
  const first = months[0];
  const last = months[months.length - 1];
  if (!first || !last) return [];
  const windowStart = new Date(Date.UTC(first.year, first.month - 1, 1));
  const windowEnd = new Date(Date.UTC(last.year, last.month, 1)); // first instant of next month

  // Months are bucketed in UTC, the same calendar the window above is built in.
  const year = sql<number>`extract(year from ${invoices.issuedAt} at time zone 'UTC')::int`;
  const month = sql<number>`extract(month from ${invoices.issuedAt} at time zone 'UTC')::int`;
  const rows = await db
    .select({
      year,
      month,
      // sum(bigint) is numeric in Postgres and arrives as a string; cast back and map.
      totalUsdMinor: sql<number>`coalesce(sum(${invoices.totalMinor}), 0)::bigint`.mapWith(Number),
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, orgId),
        ne(invoices.status, 'void'),
        gte(invoices.issuedAt, windowStart),
        lt(invoices.issuedAt, windowEnd),
      ),
    )
    .groupBy(year, month);

  // Zero-fill: a month with no invoices is a 0 bar on the chart, not a missing one.
  return months.map(({ year: y, month: m }) => ({
    year: y,
    month: m,
    totalUsdMinor: rows.find((r) => r.year === y && r.month === m)?.totalUsdMinor ?? 0,
  }));
}

async function recentActivity(orgId: string): Promise<AuditLogDto[]> {
  // Same shape as GET /audit-logs. Duplicated rather than imported because modules
  // do not import each other; a shared mapper would belong in lib/audit.ts.
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      actorName: users.fullName,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(eq(auditLogs.organizationId, orgId))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(RECENT_ACTIVITY_LIMIT);
  return rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) }));
}

export async function getDashboard(actor: Actor): Promise<DashboardDto> {
  const orgId = requireOrgId(actor);
  const [people, pending, spend, activity] = await Promise.all([
    headcountAndCountries(orgId),
    pendingCounts(orgId),
    monthlySpend(orgId),
    recentActivity(orgId),
  ]);
  return {
    headcount: people.headcount,
    byCountry: people.byCountry,
    pending,
    monthlySpend: spend,
    recentActivity: activity,
  };
}
