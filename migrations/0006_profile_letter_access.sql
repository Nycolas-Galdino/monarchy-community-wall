ALTER TABLE profiles
ADD COLUMN letter_visibility TEXT NOT NULL DEFAULT 'public'
CHECK (letter_visibility IN ('public', 'protected'));

ALTER TABLE profiles
ADD COLUMN letter_password_hash TEXT;

CREATE TABLE IF NOT EXISTS profile_access_tokens (
  token_hash TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profile_access_tokens_profile
ON profile_access_tokens(profile_id, expires_at);
