import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

/**
 * Attachment bytes live in R2 when an `ATTACHMENTS` bucket is bound, and in a
 * dedicated D1 database (`ATTACHMENTS_DB`) otherwise. R2 needs a payment card on file; D1 does not. The rest of the app
 * only ever calls put/get/delete, so the D1 store implements exactly those.
 */

/** D1 rejects rows over 2,000,000 bytes; stay well below. */
export const D1_CHUNK_BYTES = 900_000;

type StoredObject = { arrayBuffer(): Promise<ArrayBuffer> };

export type AttachmentBucket = {
	put(key: string, value: Uint8Array | ArrayBuffer, options?: unknown): Promise<unknown>;
	get(key: string): Promise<StoredObject | null>;
	delete(keys: string | string[]): Promise<void>;
};

export function createD1AttachmentBucket(db: D1Database): AttachmentBucket {
	return {
		async put(key, value) {
			const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
			const statements = [db.prepare('DELETE FROM attachment_chunks WHERE storage_key = ?').bind(key)];
			const count = Math.max(1, Math.ceil(bytes.byteLength / D1_CHUNK_BYTES));
			for (let index = 0; index < count; index++) {
				const chunk = bytes.slice(index * D1_CHUNK_BYTES, (index + 1) * D1_CHUNK_BYTES);
				statements.push(
					db
						.prepare('INSERT INTO attachment_chunks (storage_key, chunk_index, data) VALUES (?, ?, ?)')
						.bind(key, index, chunk)
				);
			}
			await db.batch(statements);
		},

		async get(key) {
			const { results } = await db
				.prepare('SELECT data FROM attachment_chunks WHERE storage_key = ? ORDER BY chunk_index')
				.bind(key)
				.all<{ data: ArrayBuffer | number[] | Uint8Array }>();
			if (!results.length) return null;
			const parts = results.map((row) =>
				row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : Uint8Array.from(row.data)
			);
			const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
			let offset = 0;
			for (const part of parts) {
				out.set(part, offset);
				offset += part.byteLength;
			}
			return { arrayBuffer: async () => out.buffer.slice(0) as ArrayBuffer };
		},

		async delete(keys) {
			const list = Array.isArray(keys) ? keys : [keys];
			if (!list.length) return;
			await db.batch(
				list.map((key) => db.prepare('DELETE FROM attachment_chunks WHERE storage_key = ?').bind(key))
			);
		}
	};
}

/** Stand-in used when neither R2 nor ATTACHMENTS_DB is bound: fails loudly, never silently. */
function createMissingBucket(): AttachmentBucket {
	const fail = async (): Promise<never> => {
		throw new Error(
			'No attachment storage configured: bind ATTACHMENTS_DB (a second D1 database) or an R2 bucket named ATTACHMENTS.'
		);
	};
	return { put: fail, get: fail, delete: fail };
}

/**
 * R2 for new files, with the D1 store kept as a read-through fallback so files
 * saved before R2 was enabled stay readable. Deletes hit both.
 */
function createHybridBucket(r2: R2Bucket, legacy: AttachmentBucket): AttachmentBucket {
	return {
		put: (key, value, options) =>
			r2.put(key, value as ArrayBuffer, options as never) as Promise<unknown>,
		async get(key) {
			return (await r2.get(key)) ?? (await legacy.get(key));
		},
		async delete(keys) {
			await Promise.all([r2.delete(keys), legacy.delete(keys)]);
		}
	};
}

/**
 * R2 when `ATTACHMENTS` is bound (falling back to ATTACHMENTS_DB for older files
 * if that is bound too), otherwise the ATTACHMENTS_DB database alone.
 * Typed as R2Bucket so existing call sites keep working unchanged.
 */
export function resolveAttachmentBucket(env: {
	ATTACHMENTS?: R2Bucket;
	ATTACHMENTS_DB?: D1Database;
}): R2Bucket {
	const d1 = env.ATTACHMENTS_DB ? createD1AttachmentBucket(env.ATTACHMENTS_DB) : null;
	if (env.ATTACHMENTS) {
		return (d1 ? createHybridBucket(env.ATTACHMENTS, d1) : env.ATTACHMENTS) as unknown as R2Bucket;
	}
	return (d1 ?? createMissingBucket()) as unknown as R2Bucket;
}
