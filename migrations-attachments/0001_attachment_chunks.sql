-- Lives in the separate ATTACHMENTS_DB database (migrations_dir: migrations-attachments),
-- used when no R2 bucket is bound (no payment card needed).
-- D1 caps a row at 2 MB, so each object is split into chunks. `storage_key`
-- matches email_attachments.storage_key; rows are removed by the same delete
-- path that removes R2 objects.
CREATE TABLE IF NOT EXISTS attachment_chunks (
	storage_key TEXT NOT NULL,
	chunk_index INTEGER NOT NULL,
	data BLOB NOT NULL,
	PRIMARY KEY (storage_key, chunk_index)
);
