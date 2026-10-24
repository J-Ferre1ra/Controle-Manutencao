CREATE INDEX IF NOT EXISTS work_orders_responsible_sync_idx
  ON work_orders(responsible, change_revision, id);
