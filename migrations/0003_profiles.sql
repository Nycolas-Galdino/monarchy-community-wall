ALTER TABLE recipients ADD COLUMN kind TEXT NOT NULL DEFAULT 'community';

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  recipient_id INTEGER NOT NULL UNIQUE REFERENCES recipients(id),
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  ducks_url TEXT,
  avatar_media_type TEXT CHECK (avatar_media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  avatar_blob BLOB,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden', 'deleted')),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  moderated_at TEXT,
  moderated_by TEXT REFERENCES moderators(id),
  moderation_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_profiles_public ON profiles(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_recipient ON profiles(recipient_id);
