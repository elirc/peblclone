import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt from Node's standard library.
 *
 * Why not bcrypt/argon2? Both are fine algorithms, but their npm packages ship
 * native binaries that have to compile or download per platform. scrypt is
 * memory-hard, recommended by OWASP, and built into Node — zero dependencies.
 *
 * Stored format: `scrypt$N$r$p$<salt b64>$<hash b64>`. Keeping the parameters
 * in the string means we can raise the cost later and still verify old hashes.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// scrypt needs 128 * N * r bytes; Node's default memory ceiling (32 MiB) is exactly at
// that edge for N=2^15, so raise it explicitly.
const options = (n: number, r: number, p: number): ScryptOptions => ({
  N: n,
  r,
  p,
  maxmem: 256 * n * r,
});

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH, options(N, R, P));
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(
    password,
    Buffer.from(saltB64, 'base64'),
    expected.length,
    options(Number(n), Number(r), Number(p)),
  );
  // Constant-time comparison: do not leak how many leading bytes matched.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A real hash of a random password, used to burn equal time when the user does not exist. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  return (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));
}

/** 256 bits of randomness, URL-safe. Used for session and invite tokens. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Tokens are stored hashed. They are already high-entropy, so a fast hash is
 * correct here (slow hashes are for low-entropy secrets like passwords).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
