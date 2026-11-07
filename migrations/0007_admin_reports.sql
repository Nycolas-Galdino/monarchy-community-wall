ALTER TABLE reports ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'reviewed', 'dismissed'));
ALTER TABLE reports ADD COLUMN reviewed_at TEXT;
ALTER TABLE reports ADD COLUMN reviewed_by TEXT REFERENCES moderators(id);
ALTER TABLE reports ADD COLUMN review_note TEXT;

CREATE INDEX IF NOT EXISTS idx_reports_status_created
  ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_letter_created
  ON reports(letter_id, created_at DESC);
