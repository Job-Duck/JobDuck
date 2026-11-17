CREATE TABLE outcomes_new (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('rejection', 'interview_invite', 'assessment', 'offer')),
  company TEXT,
  title TEXT,
  job_url TEXT,
  job_ref TEXT,
  received_at TEXT NOT NULL,
  application_id INTEGER REFERENCES applications (id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'matched', 'needs_match', 'awaiting_confirm', 'dismissed')),
  matched_by TEXT,
  candidates TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL,
  scheduled_at TEXT
);

INSERT INTO outcomes_new (
  id, message_id, kind, company, title, job_url, job_ref, received_at, application_id, status, matched_by,
  candidates, synced_at, created_at
)
SELECT
  id, message_id, kind, company, title, job_url, job_ref, received_at, application_id, status, matched_by,
  candidates, synced_at, created_at
FROM outcomes;

DROP TABLE outcomes;
ALTER TABLE outcomes_new RENAME TO outcomes;
