ALTER TABLE reports ADD COLUMN request_type TEXT NOT NULL DEFAULT 'report'
  CHECK (request_type IN ('report', 'removal'));

CREATE INDEX IF NOT EXISTS idx_reports_request_type_created
  ON reports(request_type, created_at DESC);
