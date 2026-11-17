CREATE TABLE scheduled_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('find_only', 'apply')),
  host TEXT NOT NULL,
  exit_code INTEGER,
  found INTEGER CHECK (found IS NULL OR found >= 0),
  applied INTEGER CHECK (applied IS NULL OR applied >= 0),
  pending INTEGER CHECK (pending IS NULL OR pending >= 0),
  error TEXT
);

CREATE INDEX scheduled_runs_started ON scheduled_runs (started_at);
