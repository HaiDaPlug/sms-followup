-- Two new skip reasons so a refused send says WHY in the audit trail instead of
-- being flattened into the generic 'sequence_complete'.
--
--   stale_cycle       -- the scheduled row was created against a booking cycle
--                        that has since been reset (patient rebooked). Migration
--                        023 cancels pending rows inside the booking
--                        transaction, but bookings can also arrive via the CSV
--                        import, which does not go through those RPCs -- so the
--                        send-time check in process.ts is the backstop.
--
--   out_of_order      -- the requested sequence step is behind one already sent
--                        in this cycle. sequence_override bypasses
--                        getNextSequence() entirely, so without this the
--                        chronological ordering logic is never consulted.

alter table public.reminder_logs
  drop constraint if exists reminder_logs_skip_reason_check;

alter table public.reminder_logs
  add constraint reminder_logs_skip_reason_check
  check (
    skip_reason in (
      'future_booking',
      'missing_phone',
      'do_not_contact',
      'needs_review',
      'no_valid_booking',
      'waiting',
      'unresolved_placeholder',
      'sequence_complete',
      'delivery_pending',
      'stale_cycle',
      'out_of_order'
    )
  );
