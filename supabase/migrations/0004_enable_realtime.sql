-- Enable Supabase Realtime on the change_log table so connected devices receive
-- push notifications when another device uploads changes.
--
-- This is an OPTIMISATION layer: devices that cannot receive Realtime (offline,
-- older Supabase plan, firewall) continue polling at the normal interval. The
-- notification carries no payload — just "something changed" — and the actual
-- data arrives through the normal sync_pull path with all the same idempotency
-- and tenant-safety checks.

-- Ensure the supabase_realtime publication exists (created by default on new
-- Supabase projects, but idempotent to redeclare).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime FOR TABLE change_log;
  ELSE
    ALTER PUBLICATION supabase_realtime ADD TABLE change_log;
  END IF;
EXCEPTION WHEN duplicate_object THEN
  -- Table already in the publication — safe to ignore.
END $$;

-- The RLS policy on change_log already restricts reads to business members,
-- so Realtime subscribers only receive notifications for their own tenant.
