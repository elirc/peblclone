import {
  calculateEmploymentCost,
  type CalculateQuoteInput,
  type CostBreakdown,
  type CountryDto,
  type Paginated,
  type QuoteDto,
  type SaveQuoteInput,
  type UpdateCountryInput,
} from '@meridian/shared';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { countries, quotes } from '../../db/schema';
import { requireOrgId, type Actor } from '../../lib/actor';
import { recordAudit } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { iso, paginated } from '../../lib/http';

type CountryRow = typeof countries.$inferSelect;
type QuoteRow = typeof quotes.$inferSelect;

/** Row -> DTO. Explicit field list: a new column is private until someone adds it here. */
function toCountryDto(row: CountryRow): CountryDto {
  return {
    code: row.code,
    name: row.name,
    region: row.region,
    currency: row.currency,
    employerContributions: row.employerContributions,
    employeeDeductions: row.employeeDeductions,
    monthlyFeeUsdMinor: row.monthlyFeeUsdMinor,
    annualLeaveDays: row.annualLeaveDays,
    noticePeriodDays: row.noticePeriodDays,
    probationDays: row.probationDays,
    eorSupported: row.eorSupported,
    requiredDocuments: row.requiredDocuments,
  };
}

function toQuoteDto(row: QuoteRow): QuoteDto {
  return {
    id: row.id,
    label: row.label,
    countryCode: row.countryCode,
    breakdown: row.breakdown,
    createdAt: iso(row.createdAt),
  };
}

/**
 * Country codes are stored upper-case (ISO 3166-1 alpha-2). The URL is
 * case-insensitive, so `/countries/de` and `/countries/DE` are the same thing.
 */
const normaliseCode = (code: string) => code.trim().toUpperCase();

async function findCountry(code: string): Promise<CountryRow | undefined> {
  const [row] = await db
    .select()
    .from(countries)
    .where(eq(countries.code, normaliseCode(code)))
    .limit(1);
  return row;
}

// ---------- countries ----------

export async function listCountries(): Promise<CountryDto[]> {
  const rows = await db.select().from(countries).orderBy(asc(countries.name));
  return rows.map(toCountryDto);
}

export async function getCountry(code: string): Promise<CountryDto> {
  const row = await findCountry(code);
  if (!row) throw notFound('Country');
  return toCountryDto(row);
}

/** Platform admins only (enforced by the route). Countries are global, not tenant data. */
export async function updateCountry(
  actor: Actor,
  code: string,
  input: UpdateCountryInput,
): Promise<CountryDto> {
  const countryCode = normaliseCode(code);
  if (Object.keys(input).length === 0) return getCountry(countryCode);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(countries)
      .set(input)
      .where(eq(countries.code, countryCode))
      .returning();
    if (!row) throw notFound('Country');
    await recordAudit(tx, actor, {
      action: 'country.updated',
      entityType: 'country',
      // audit_logs.entity_id is a uuid column and a country's key is its ISO
      // code, so the code travels in metadata instead.
      entityId: null,
      // A country is platform-level reference data: the change belongs to no tenant,
      // even if the admin happened to have an X-Org-Id selected.
      organizationId: null,
      metadata: { code: countryCode, fields: Object.keys(input) },
    });
    return toCountryDto(row);
  });
}

// ---------- quotes ----------

/**
 * The quote calculator: pure maths from `@meridian/shared`, fed with the
 * country's current rules. Shared by "calculate" (nothing saved) and "save".
 */
async function breakdownFor(input: CalculateQuoteInput): Promise<CostBreakdown> {
  const country = await findCountry(input.countryCode);
  if (!country) throw badRequest('Unknown country code', 'unknown_country');
  if (!country.eorSupported) {
    throw badRequest(`Meridian cannot employ people in ${country.name} yet`, 'eor_not_supported');
  }
  return calculateEmploymentCost({
    countryCode: country.code,
    currency: country.currency,
    annualSalaryMinor: input.annualSalaryMinor,
    employerContributions: country.employerContributions,
    employeeDeductions: country.employeeDeductions,
    monthlyFeeUsdMinor: country.monthlyFeeUsdMinor,
  });
}

export async function calculateQuote(input: CalculateQuoteInput): Promise<CostBreakdown> {
  return breakdownFor(input);
}

export async function saveQuote(actor: Actor, input: SaveQuoteInput): Promise<QuoteDto> {
  const orgId = requireOrgId(actor);
  // The breakdown is stored whole, as a snapshot: if the country's rates change
  // next month, this quote still shows what the client was told today.
  const breakdown = await breakdownFor(input);
  const label = input.label && input.label.length > 0 ? input.label : null;

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(quotes)
      .values({
        organizationId: orgId,
        label,
        countryCode: breakdown.countryCode,
        breakdown,
        createdBy: actor.userId,
      })
      .returning();
    if (!row) throw new Error('Failed to save quote');
    await recordAudit(tx, actor, {
      action: 'quote.created',
      entityType: 'quote',
      entityId: row.id,
      metadata: { countryCode: row.countryCode, annualSalaryMinor: breakdown.annualSalaryMinor },
    });
    return toQuoteDto(row);
  });
}

export async function listQuotes(
  actor: Actor,
  page: { limit: number; offset: number },
): Promise<Paginated<QuoteDto>> {
  const orgId = requireOrgId(actor);
  const where = eq(quotes.organizationId, orgId);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(quotes)
      .where(where)
      // id as a tie-breaker keeps pages stable when two quotes share a timestamp.
      .orderBy(desc(quotes.createdAt), desc(quotes.id))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ value: count() }).from(quotes).where(where),
  ]);
  return paginated(rows.map(toQuoteDto), totalRow?.value ?? 0, page);
}

export async function deleteQuote(actor: Actor, quoteId: string): Promise<void> {
  const orgId = requireOrgId(actor);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(quotes)
      // Tenant filter inside the WHERE: another org's quote id matches nothing -> 404.
      .where(and(eq(quotes.id, quoteId), eq(quotes.organizationId, orgId)))
      .returning({ id: quotes.id, countryCode: quotes.countryCode });
    if (!row) throw notFound('Quote');
    await recordAudit(tx, actor, {
      action: 'quote.deleted',
      entityType: 'quote',
      entityId: row.id,
      metadata: { countryCode: row.countryCode },
    });
  });
}
