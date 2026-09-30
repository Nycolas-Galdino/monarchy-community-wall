ALTER TABLE profiles
ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
CHECK (visibility IN ('public', 'private'));
