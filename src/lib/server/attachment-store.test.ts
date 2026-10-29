import { describe, expect, test } from 'bun:test';
import { createD1AttachmentBucket, D1_CHUNK_BYTES, resolveAttachmentBucket } from './attachment-store';
import { ATTACHMENTS_MIGRATIONS_DIR, createTestDb } from './test-db';

function sample(size: number): Uint8Array {
	return Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) % 256);
}

describe('D1 attachment bucket', () => {
	test('round-trips a multi-chunk object byte for byte', async () => {
		const { db } = createTestDb(ATTACHMENTS_MIGRATIONS_DIR);
		const bucket = createD1AttachmentBucket(db);
		const bytes = sample(D1_CHUNK_BYTES * 2 + 123);
		await bucket.put('a/b/file.bin', bytes);
		const got = await bucket.get('a/b/file.bin');
		expect(got).not.toBeNull();
		expect(new Uint8Array(await got!.arrayBuffer())).toEqual(bytes);
	});

	test('empty object and missing key', async () => {
		const { db } = createTestDb(ATTACHMENTS_MIGRATIONS_DIR);
		const bucket = createD1AttachmentBucket(db);
		await bucket.put('empty', new Uint8Array());
		expect((await bucket.get('empty'))!.arrayBuffer).toBeDefined();
		expect(new Uint8Array(await (await bucket.get('empty'))!.arrayBuffer()).length).toBe(0);
		expect(await bucket.get('nope')).toBeNull();
	});

	test('put overwrites, delete removes one or many', async () => {
		const { db } = createTestDb(ATTACHMENTS_MIGRATIONS_DIR);
		const bucket = createD1AttachmentBucket(db);
		await bucket.put('k', sample(D1_CHUNK_BYTES + 5));
		await bucket.put('k', sample(10));
		expect((await (await bucket.get('k'))!.arrayBuffer()).byteLength).toBe(10);
		await bucket.put('j', sample(3));
		await bucket.delete(['k', 'j']);
		expect(await bucket.get('k')).toBeNull();
		expect(await bucket.get('j')).toBeNull();
		await bucket.delete([]);
	});

	test('resolve prefers a bound R2 bucket, else D1', () => {
		const { db } = createTestDb(ATTACHMENTS_MIGRATIONS_DIR);
		const r2 = {} as never;
		expect(resolveAttachmentBucket({ ATTACHMENTS: r2 })).toBe(r2);
		expect(typeof resolveAttachmentBucket({ ATTACHMENTS_DB: db }).put).toBe('function');
	});

	test('with nothing bound it fails loudly instead of dropping files', async () => {
		const bucket = resolveAttachmentBucket({});
		await expect(bucket.put('k', new Uint8Array([1]))).rejects.toThrow('No attachment storage configured');
	});

	test('with R2 and D1 both bound: new files go to R2, old D1 files stay readable, delete hits both', async () => {
		const { db } = createTestDb(ATTACHMENTS_MIGRATIONS_DIR);
		const legacy = createD1AttachmentBucket(db);
		await legacy.put('old', Uint8Array.from([1, 2, 3]));

		const store = new Map<string, Uint8Array>();
		const r2 = {
			async put(key: string, value: Uint8Array) {
				store.set(key, value);
			},
			async get(key: string) {
				const v = store.get(key);
				return v ? { arrayBuffer: async () => v.buffer as ArrayBuffer } : null;
			},
			async delete(keys: string | string[]) {
				for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
			}
		};
		const bucket = resolveAttachmentBucket({ ATTACHMENTS: r2 as never, ATTACHMENTS_DB: db });

		await bucket.put('new', Uint8Array.from([9, 9]) as never);
		expect(store.has('new')).toBe(true);
		expect(await legacy.get('new')).toBeNull();
		expect(new Uint8Array(await (await bucket.get('old'))!.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]));
		expect(new Uint8Array(await (await bucket.get('new'))!.arrayBuffer())).toEqual(Uint8Array.from([9, 9]));

		await bucket.delete(['old', 'new']);
		expect(await legacy.get('old')).toBeNull();
		expect(store.size).toBe(0);
	});
});
