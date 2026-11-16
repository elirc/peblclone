import { calculateEmploymentCost } from '@meridian/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import { COUNTRY_SEEDS } from '../../db/reference-data';
import { auditLogs, countries, quotes } from '../../db/schema';
import {
  anonymous,
  createManager,
  createPlatformAdmin,
  createTenant,
  createWorker,
  loginAsWorker,
} from '../../test/helpers';

/**
 * Countries are reference data: the per-test TRUNCATE does not touch them. Any
 * test that changes a country must put it back, or later tests (and other test
 * files in the same run) would see the change. `touch(code)` registers that.
 */
const touched = new Set<string>();
function touch(code: string) {
  touched.add(code);
}
afterEach(async () => {
  for (const code of touched) {
    const seed = COUNTRY_SEEDS.find((c) => c.code === code);
    if (!seed) continue;
    await db
      .update(countries)
      .set({
        employerContributions: seed.employer,
        employeeDeductions: seed.employee,
        monthlyFeeUsdMinor: seed.feeUsd,
        annualLeaveDays: seed.leave,
        noticePeriodDays: seed.notice,
        probationDays: seed.probation,
        eorSupported: true,
        requiredDocuments: seed.docs,
      })
      .where(eq(countries.code, code));
  }
  touched.clear();
});

async function setCountry(code: string, values: Partial<typeof countries.$inferInsert>) {
  touch(code);
  await db.update(countries).set(values).where(eq(countries.code, code));
}

describe('GET /countries', () => {
  it('lists every country sorted by name, for any signed-in role', async () => {
    const { org, admin } = await createTenant();
    const worker = await loginAsWorker(await createWorker(org.id));

    for (const c of [admin, worker.client]) {
      const res = await c.get('/countries');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(COUNTRY_SEEDS.length);
      const names = res.body.items.map((x: { name: string }) => x.name);
      expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b)));
    }
  });

  it('returns the full rule set per country', async () => {
    const { admin } = await createTenant();
    const res = await admin.get('/countries');
    const de = res.body.items.find((c: { code: string }) => c.code === 'DE');
    expect(de).toMatchObject({
      code: 'DE',
      name: 'Germany',
      currency: 'EUR',
      eorSupported: true,
      requiredDocuments: ['passport', 'bank_proof', 'tax_form', 'proof_of_address'],
    });
    expect(de.employerContributions.length).toBeGreaterThan(0);
  });

  it('requires authentication', async () => {
    expect((await anonymous().get('/countries')).status).toBe(401);
    expect((await anonymous().get('/countries/DE')).status).toBe(401);
  });
});

describe('GET /countries/:code', () => {
  it('is case-insensitive', async () => {
    const { admin } = await createTenant();
    const lower = await admin.get('/countries/de');
    expect(lower.status).toBe(200);
    expect(lower.body.code).toBe('DE');
    expect((await admin.get('/countries/De')).body.code).toBe('DE');
  });

  it('answers 404 for an unknown or malformed code', async () => {
    const { admin } = await createTenant();
    for (const code of ['ZZ', 'xyz', '1']) {
      const res = await admin.get(`/countries/${code}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
  });
});

describe('PATCH /countries/:code', () => {
  it('lets a platform admin change the rules and audits it without a tenant', async () => {
    touch('FR');
    const platform = await createPlatformAdmin();
    const res = await platform.client
      .patch('/countries/fr')
      .send({ monthlyFeeUsdMinor: 70_000, annualLeaveDays: 30 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code: 'FR', monthlyFeeUsdMinor: 70_000, annualLeaveDays: 30 });
    expect((await platform.client.get('/countries/FR')).body.monthlyFeeUsdMinor).toBe(70_000);

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'country.updated'));
    expect(audit).toMatchObject({ organizationId: null, actorUserId: platform.user.id });
    expect(audit?.metadata).toMatchObject({ code: 'FR' });
    expect(audit?.metadata.fields).toEqual(['monthlyFeeUsdMinor', 'annualLeaveDays']);
  });

  it('audits with organizationId null even when the admin has a tenant selected', async () => {
    touch('ES');
    const { org } = await createTenant();
    const platform = await createPlatformAdmin(org.id);
    expect((await platform.client.patch('/countries/ES').send({ eorSupported: false })).status).toBe(
      200,
    );
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'country.updated'));
    expect(audit?.organizationId).toBeNull();
  });

  it('is forbidden to client admins, managers and workers', async () => {
    const { org, admin } = await createTenant();
    const manager = await createManager(org.id);
    const worker = await loginAsWorker(await createWorker(org.id));
    for (const c of [admin, manager.client, worker.client]) {
      expect((await c.patch('/countries/DE').send({ annualLeaveDays: 99 })).status).toBe(403);
    }
    expect((await admin.get('/countries/DE')).body.annualLeaveDays).toBe(24);
  });

  it('validates the body', async () => {
    const platform = await createPlatformAdmin();
    const res = await platform.client.patch('/countries/DE').send({
      annualLeaveDays: -1,
      employerContributions: [{ key: 'x', name: 'X', rateBps: 20_000 }],
      requiredDocuments: ['selfie'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(Object.keys(res.body.error.details)).toEqual(
      expect.arrayContaining(['annualLeaveDays', 'employerContributions.0.rateBps', 'requiredDocuments.0']),
    );
  });

  it('answers 404 for an unknown country', async () => {
    const platform = await createPlatformAdmin();
    expect((await platform.client.patch('/countries/ZZ').send({ annualLeaveDays: 5 })).status).toBe(
      404,
    );
  });
});

describe('POST /quotes/calculate', () => {
  it('returns the breakdown from the shared calculator and saves nothing', async () => {
    const { admin } = await createTenant();
    const res = await admin
      .post('/quotes/calculate')
      .send({ countryCode: 'de', annualSalaryMinor: 7_200_000 });

    expect(res.status).toBe(200);
    const seed = COUNTRY_SEEDS.find((c) => c.code === 'DE');
    expect(res.body).toEqual(
      calculateEmploymentCost({
        countryCode: 'DE',
        currency: 'EUR',
        annualSalaryMinor: 7_200_000,
        employerContributions: seed?.employer ?? [],
        employeeDeductions: seed?.employee ?? [],
        monthlyFeeUsdMinor: seed?.feeUsd ?? 0,
      }),
    );
    expect(res.body.monthlySalaryMinor).toBe(600_000);
    expect(await db.select().from(quotes)).toHaveLength(0);
  });

  it('uses the country’s current rules', async () => {
    await setCountry('NL', { employerContributions: [], monthlyFeeUsdMinor: 1 });
    const { admin } = await createTenant();
    const res = await admin
      .post('/quotes/calculate')
      .send({ countryCode: 'NL', annualSalaryMinor: 1_200_000 });
    expect(res.body).toMatchObject({ monthlyEmployerCostMinor: 0, monthlyFeeUsdMinor: 1 });
  });

  it('rejects an unknown country with unknown_country', async () => {
    const { admin } = await createTenant();
    const res = await admin
      .post('/quotes/calculate')
      .send({ countryCode: 'ZZ', annualSalaryMinor: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_country');
  });

  it('rejects a country without EOR support with eor_not_supported', async () => {
    await setCountry('JP', { eorSupported: false });
    const { admin } = await createTenant();
    const res = await admin
      .post('/quotes/calculate')
      .send({ countryCode: 'JP', annualSalaryMinor: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('eor_not_supported');
  });

  it('validates the body', async () => {
    const { admin } = await createTenant();
    const res = await admin
      .post('/quotes/calculate')
      .send({ countryCode: 'Germany', annualSalaryMinor: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toHaveProperty('countryCode');
    expect(res.body.error.details).toHaveProperty('annualSalaryMinor');
  });

  it('is open to staff (manager, platform admin) but not workers', async () => {
    const { org } = await createTenant();
    const manager = await createManager(org.id);
    const platform = await createPlatformAdmin();
    const worker = await loginAsWorker(await createWorker(org.id));
    const body = { countryCode: 'GB', annualSalaryMinor: 5_000_000 };

    expect((await manager.client.post('/quotes/calculate').send(body)).status).toBe(200);
    expect((await platform.client.post('/quotes/calculate').send(body)).status).toBe(200);
    expect((await worker.client.post('/quotes/calculate').send(body)).status).toBe(403);
  });
});

describe('saved quotes', () => {
  it('saves a quote with its breakdown and audits it', async () => {
    const { org, admin } = await createTenant();
    const res = await admin
      .post('/quotes')
      .send({ countryCode: 'GB', annualSalaryMinor: 6_000_000, label: 'Senior engineer, London' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      label: 'Senior engineer, London',
      countryCode: 'GB',
      breakdown: { countryCode: 'GB', currency: 'GBP', annualSalaryMinor: 6_000_000 },
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(Object.keys(res.body).sort()).toEqual(['breakdown', 'countryCode', 'createdAt', 'id', 'label']);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'quote.created'), eq(auditLogs.entityId, res.body.id)));
    expect(audit?.organizationId).toBe(org.id);
  });

  it('stores a snapshot: later rate changes do not rewrite it', async () => {
    const { admin } = await createTenant();
    const saved = await admin.post('/quotes').send({ countryCode: 'CA', annualSalaryMinor: 9_000_000 });
    const before = saved.body.breakdown;

    await setCountry('CA', { employerContributions: [], monthlyFeeUsdMinor: 1 });
    const list = await admin.get('/quotes');
    expect(list.body.items[0].breakdown).toEqual(before);
    expect(before.monthlyEmployerCostMinor).toBeGreaterThan(0);
  });

  it('saves without a label as null', async () => {
    const { admin } = await createTenant();
    const res = await admin.post('/quotes').send({ countryCode: 'US', annualSalaryMinor: 100_000 });
    expect(res.status).toBe(201);
    expect(res.body.label).toBeNull();
  });

  it('applies the same country rules as calculate', async () => {
    await setCountry('AU', { eorSupported: false });
    const { admin } = await createTenant();
    const refused = await admin.post('/quotes').send({ countryCode: 'AU', annualSalaryMinor: 100 });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('eor_not_supported');
    const unknown = await admin.post('/quotes').send({ countryCode: 'ZZ', annualSalaryMinor: 100 });
    expect(unknown.body.error.code).toBe('unknown_country');
    expect(await db.select().from(quotes)).toHaveLength(0);
  });

  it('needs a tenant: a platform admin without X-Org-Id is told to pick one', async () => {
    const platform = await createPlatformAdmin();
    const res = await platform.client.post('/quotes').send({ countryCode: 'US', annualSalaryMinor: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('organization_required');
  });

  it('lists quotes newest first, paginated', async () => {
    const { admin } = await createTenant();
    for (const [i, label] of ['first', 'second', 'third'].entries()) {
      const res = await admin.post('/quotes').send({ countryCode: 'US', annualSalaryMinor: 1_000, label });
      // Pin creation times so "newest first" does not depend on clock resolution.
      await db
        .update(quotes)
        .set({ createdAt: new Date(Date.UTC(2026, 0, 1 + i)) })
        .where(eq(quotes.id, res.body.id));
    }

    const page1 = await admin.get('/quotes?limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(page1.body.items.map((q: { label: string }) => q.label)).toEqual(['third', 'second']);

    const page2 = await admin.get('/quotes?limit=2&offset=2');
    expect(page2.body.items.map((q: { label: string }) => q.label)).toEqual(['first']);

    expect((await admin.get('/quotes?limit=500')).status).toBe(400);
  });

  it('never shows another organization’s quotes', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await b.admin.post('/quotes').send({ countryCode: 'US', annualSalaryMinor: 1_000 });
    const res = await a.admin.get('/quotes');
    expect(res.body).toMatchObject({ items: [], total: 0 });
  });

  it('deletes a quote (204) and audits it', async () => {
    const { admin } = await createTenant();
    const saved = await admin.post('/quotes').send({ countryCode: 'US', annualSalaryMinor: 1_000 });
    const res = await admin.delete(`/quotes/${saved.body.id}`);
    expect(res.status).toBe(204);
    expect((await admin.get('/quotes')).body.total).toBe(0);
    expect((await admin.delete(`/quotes/${saved.body.id}`)).status).toBe(404);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'quote.deleted'));
    expect(audits).toHaveLength(1);
  });

  it('answers 404 when deleting another organization’s quote', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const saved = await b.admin.post('/quotes').send({ countryCode: 'US', annualSalaryMinor: 1_000 });
    expect((await a.admin.delete(`/quotes/${saved.body.id}`)).status).toBe(404);
    expect((await b.admin.get('/quotes')).body.total).toBe(1);
  });

  it('rejects a malformed quote id with 400', async () => {
    const { admin } = await createTenant();
    expect((await admin.delete('/quotes/not-a-uuid')).status).toBe(400);
  });

  it('is off limits to workers', async () => {
    const { org, admin } = await createTenant();
    const saved = await admin.post('/quotes').send({ countryCode: 'US', annualSalaryMinor: 1_000 });
    const worker = await loginAsWorker(await createWorker(org.id));
    expect((await worker.client.get('/quotes')).status).toBe(403);
    expect(
      (await worker.client.post('/quotes').send({ countryCode: 'US', annualSalaryMinor: 1 })).status,
    ).toBe(403);
    expect((await worker.client.delete(`/quotes/${saved.body.id}`)).status).toBe(403);
  });

  it('lets a manager save, list and delete', async () => {
    const { org } = await createTenant();
    const manager = await createManager(org.id);
    const saved = await manager.client.post('/quotes').send({ countryCode: 'US', annualSalaryMinor: 1 });
    expect(saved.status).toBe(201);
    expect((await manager.client.get('/quotes')).body.total).toBe(1);
    expect((await manager.client.delete(`/quotes/${saved.body.id}`)).status).toBe(204);
  });
});
