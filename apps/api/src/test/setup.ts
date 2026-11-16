import { afterAll, beforeEach } from 'vitest';
import { config } from '../config';
import { pool } from '../db/client';
import { loginLimiter } from '../modules/auth/service';
import { resetTenantData } from './cleanup';

/**
 * Runs inside every test file. Each test starts from the same known state:
 * all tenant data gone, reference data (countries, fx_rates) intact.
 */
beforeEach(async () => {
  if (!config.isTest) throw new Error('Test setup loaded outside NODE_ENV=test');
  await resetTenantData();
  loginLimiter.reset();
});

afterAll(async () => {
  await pool.end();
});
