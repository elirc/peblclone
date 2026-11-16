import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ALLOWED_DOCUMENT_MIME_TYPES } from '@meridian/shared';
import { config } from '../../config';

/**
 * File storage for uploaded documents: a thin wrapper over the local disk.
 *
 * The one rule that matters: a path on disk is NEVER built from anything the
 * user sent. A file is addressed by an opaque key the server generated
 * (`<organizationId>/<random uuid>`), and the key is re-validated on every
 * read/write/delete. A file name like `../../etc/passwd` therefore can't reach
 * the filesystem at all — it is only ever stored as a display label.
 *
 * Swapping this for S3 later means re-implementing these four functions.
 */

export type DocumentMimeType = (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_PATTERN = new RegExp(`^(${UUID})/(${UUID})$`);

/** A fresh, unguessable storage key inside the organization's folder. */
export function newStorageKey(organizationId: string): string {
  const key = `${organizationId.toLowerCase()}/${randomUUID()}`;
  // Validates the org id too: it must be a uuid, not a path fragment.
  resolveKey(key);
  return key;
}

/** Key -> absolute path, refusing anything that is not exactly `<uuid>/<uuid>`. */
function resolveKey(key: string): string {
  const match = KEY_PATTERN.exec(key);
  if (!match?.[1] || !match[2]) throw new Error('Invalid storage key');
  const root = path.resolve(config.storageDir);
  const full = path.resolve(root, match[1], match[2]);
  // Belt and braces: the regex already rules out `..`, but check containment anyway.
  if (!full.startsWith(root + path.sep)) throw new Error('Storage key escapes the storage root');
  return full;
}

export async function saveFile(key: string, bytes: Buffer): Promise<void> {
  const full = resolveKey(key);
  await mkdir(path.dirname(full), { recursive: true });
  // 'wx': fail rather than overwrite. Keys are random, so a collision means a bug.
  await writeFile(full, bytes, { flag: 'wx' });
}

export async function loadFile(key: string): Promise<Buffer | null> {
  try {
    return await readFile(resolveKey(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Deleting a file that is already gone is not an error. */
export async function deleteFile(key: string): Promise<void> {
  await rm(resolveKey(key), { force: true });
}

// ---------- content sniffing ----------

const SIGNATURES: Record<DocumentMimeType, readonly number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46], // "%PDF"
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

/**
 * Does the file really start like the type it claims to be? The declared mime
 * type comes from the client and the file name proves nothing, so the bytes
 * themselves are the only evidence we have.
 */
export function matchesMimeType(bytes: Buffer, mimeType: DocumentMimeType): boolean {
  const signature = SIGNATURES[mimeType];
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}
