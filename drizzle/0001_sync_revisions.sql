ALTER TABLE work_orders ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE sync_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  catalog_revision INTEGER NOT NULL DEFAULT 0,
  change_revision INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sync_metadata (id, catalog_revision, change_revision)
VALUES (1, 0, 0);

CREATE INDEX work_orders_sync_revision_idx ON work_orders(change_revision);
CREATE INDEX work_orders_team_sync_revision_idx ON work_orders(team, change_revision);
