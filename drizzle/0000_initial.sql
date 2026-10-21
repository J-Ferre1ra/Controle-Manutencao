CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  team TEXT NOT NULL,
  responsible TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_orders_team_status_idx ON work_orders(team, status);
CREATE INDEX IF NOT EXISTS work_orders_responsible_idx ON work_orders(team, responsible);

CREATE TABLE IF NOT EXISTS access_profiles (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS execution_records (
  id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL,
  team TEXT NOT NULL,
  responsible TEXT NOT NULL DEFAULT '',
  registered_by TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS execution_order_idx ON execution_records(order_id, created_at);

CREATE TABLE IF NOT EXISTS photos (
  protocol TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data_base64 TEXT NOT NULL,
  team TEXT NOT NULL,
  responsible TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
