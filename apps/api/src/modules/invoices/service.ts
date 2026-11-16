import {
  canTransition,
  INVOICE_TRANSITIONS,
  type InvoiceDetailDto,
  type InvoiceDto,
  type ListInvoicesQuery,
  type Paginated,
} from '@meridian/shared';
import { and, asc, count, desc, eq, type SQL } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client';
import { invoiceLines, invoices, organizations } from '../../db/schema';
import { requireOrgId, type Actor } from '../../lib/actor';
import { recordAudit } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';
import { iso, paginated } from '../../lib/http';

/*
 * Invoices are CREATED by payroll approval (see lib/invoicing.ts). This module
 * only reads them and records the client's (simulated) payment.
 */

type InvoiceRow = typeof invoices.$inferSelect;

function toInvoiceDto(row: InvoiceRow): InvoiceDto {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    currency: row.currency,
    subtotalMinor: row.subtotalMinor,
    feeMinor: row.feeMinor,
    totalMinor: row.totalMinor,
    payrollRunId: row.payrollRunId,
    fxRate: row.fxRate,
    localCurrency: row.localCurrency,
    issuedAt: iso(row.issuedAt),
    dueDate: row.dueDate,
    paidAt: iso(row.paidAt),
  };
}

async function loadInvoiceDetail(
  dbOrTx: DbOrTx,
  orgId: string,
  invoiceId: string,
): Promise<InvoiceDetailDto> {
  const [row] = await dbOrTx
    .select({ invoice: invoices, organizationName: organizations.name })
    .from(invoices)
    .innerJoin(organizations, eq(organizations.id, invoices.organizationId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId)))
    .limit(1);
  if (!row) throw notFound('Invoice');

  // invoice_lines has no organization_id of its own; it is reached only through
  // an invoice we have just proven belongs to this tenant.
  const lines = await dbOrTx
    .select({
      id: invoiceLines.id,
      kind: invoiceLines.kind,
      description: invoiceLines.description,
      amountMinor: invoiceLines.amountMinor,
    })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(invoiceLines.sortOrder), asc(invoiceLines.id));

  return { ...toInvoiceDto(row.invoice), organizationName: row.organizationName, lines };
}

export async function listInvoices(
  actor: Actor,
  query: ListInvoicesQuery,
): Promise<Paginated<InvoiceDto>> {
  const filters: SQL[] = [eq(invoices.organizationId, requireOrgId(actor))];
  if (query.status) filters.push(eq(invoices.status, query.status));
  const where = and(...filters);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(invoices)
      .where(where)
      // Numbers come from a sequence, so they break ties between invoices issued in the same instant.
      .orderBy(desc(invoices.issuedAt), desc(invoices.number))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ total: count() }).from(invoices).where(where),
  ]);
  return paginated(rows.map(toInvoiceDto), totalRow?.total ?? 0, query);
}

export async function getInvoice(actor: Actor, invoiceId: string): Promise<InvoiceDetailDto> {
  return loadInvoiceDetail(db, requireOrgId(actor), invoiceId);
}

/** Simulated payment: there is no payment provider, an admin clicks "pay". */
export async function payInvoice(actor: Actor, invoiceId: string): Promise<InvoiceDetailDto> {
  const orgId = requireOrgId(actor);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: invoices.status, number: invoices.number })
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, orgId)))
      .limit(1);
    if (!current) throw notFound('Invoice');
    if (!canTransition(INVOICE_TRANSITIONS, current.status, 'paid')) {
      throw conflict(`A ${current.status} invoice cannot be paid`, 'invalid_transition');
    }

    // Conditional on the status we read: two simultaneous "pay" clicks cannot both win.
    const [updated] = await tx
      .update(invoices)
      .set({ status: 'paid', paidAt: new Date() })
      .where(
        and(
          eq(invoices.id, invoiceId),
          eq(invoices.organizationId, orgId),
          eq(invoices.status, current.status),
        ),
      )
      .returning({ id: invoices.id, totalMinor: invoices.totalMinor });
    if (!updated)
      throw conflict(`A ${current.status} invoice cannot be paid`, 'invalid_transition');

    await recordAudit(tx, actor, {
      action: 'invoice.paid',
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: { number: current.number, totalMinor: updated.totalMinor, currency: 'USD' },
    });
    return loadInvoiceDetail(tx, orgId, invoiceId);
  });
}
