export type BookingStatus = "Booked" | "Cancelled" | "Unknown" | string;
export type ReviewStatus = "open" | "resolved" | "ignored";
export type ReviewSeverity = "low" | "medium" | "high";
export type ReminderLogStatus =
  | "pending"
  | "unknown"
  | "sent"
  | "delivered"
  | "failed"
  | "dry_run"
  | "skipped"
  | "cycle_reset";
export type ScheduledSmsStatus =
  | "pending"
  | "processing"
  | "sent"
  | "cancelled"
  | "skipped"
  | "failed"
  | "unknown"
  | "dry_run";
export type SkipReason =
  | "future_booking"
  | "missing_phone"
  | "do_not_contact"
  | "needs_review"
  | "no_valid_booking"
  | "waiting"
  | "unresolved_placeholder"
  | "sequence_complete"
  | "delivery_pending"
  /** Scheduled send whose booking cycle was reset before it fired. */
  | "stale_cycle"
  /** Requested step is behind one already sent in this cycle. */
  | "out_of_order"
  /** The requested follow-up step no longer exists in the settings. */
  | "step_removed";

export type Patient = {
  id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  normalized_phone: string | null;
  email: string | null;
  last_booking_at: string | null;
  latest_treatment: string | null;
  has_future_booking: boolean;
  do_not_contact: boolean;
  source: string;
  bokadirekt_customer_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type Booking = {
  id: string;
  external_booking_id: string;
  patient_id: string | null;
  patient_name: string | null;
  phone: string | null;
  normalized_phone: string | null;
  email: string | null;
  booking_at: string | null;
  treatment: string | null;
  status: BookingStatus;
  cancelled: boolean;
  source: string;
  raw_data: Record<string, unknown>;
  event_created_at?: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A follow-up step as stored in reminder_settings.sms_steps. `id` and `active`
 * are optional only because rows written before migration 025 lack them; the
 * settings route and migration 025 fill them in, and resolveSteps() never
 * hands the engine a step without both.
 */
export type StoredSmsStep = {
  id?: string;
  day: number;
  template: string;
  active?: boolean;
};

/** A follow-up step as resolved for the engine and the UI. */
export type SmsStep = {
  /** Stable, immutable UUID. Historical logs reference this, never the array position. */
  id: string;
  /** Days after the patient's latest valid booking at which this step is due. */
  day: number;
  template: string;
  /** Inactive steps are skipped by the daily automation but stay selectable manually. */
  active: boolean;
};

export type ReminderSettings = {
  id: string;
  days_after_booking: number;
  send_time: string;
  max_per_day: number;
  /** Legacy fixed templates — superseded by sms_steps when present */
  sms_template: string;
  sms_template_2: string;
  sms_template_3: string;
  /** Variable-length sequence: [{id, day, template, active}, ...] sorted by day ascending */
  sms_steps: StoredSmsStep[] | null;
  booking_link: string;
  clinic_name: string;
  is_active: boolean;
  dry_run_mode: boolean;
  allow_same_number_override: boolean;
  created_at: string;
  updated_at: string;
};

export type ReminderLog = {
  id: string;
  patient_id: string | null;
  booking_id: string | null;
  phone: string | null;
  message: string;
  status: ReminderLogStatus;
  /** Position of the step in the day-sorted list at send time. null for non-SMS logs. */
  sequence_number: number | null;
  /** Immutable id of the follow-up step this row reserved. null for non-step logs. */
  step_id: string | null;
  /** Trigger day of that step at send time — survives the step being deleted or re-timed. */
  step_day: number | null;
  /** True when a new booking reset this patient's cycle */
  is_cycle_reset: boolean;
  provider_message_id: string | null;
  /** Machine-readable skip reason — set whenever status is "skipped" */
  skip_reason: SkipReason | null;
  error: string | null;
  sent_at: string | null;
  created_at: string;
};

export type ScheduledSms = {
  id: string;
  patient_id: string | null;
  booking_id: string | null;
  patient_name: string | null;
  recipient_phone: string | null;
  /** Sequence step resolved and frozen when the job is created. */
  sequence_override: number | null;
  /** Immutable id of that step. Survives a later re-ordering of the step list. */
  step_id: string | null;
  /** Fully rendered message snapshot frozen when the job is created. */
  message_override: string | null;
  scheduled_for: string;
  status: ScheduledSmsStatus;
  /** Delivery audit row, including skipped, unknown, and dry-run outcomes. */
  reminder_log_id: string | null;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  attempt_count: number;
};

export type InboxRow = IncomingSms & { patient_name: string | null };

export type IncomingSms = {
  id: string;
  from_number: string;
  to_number: string;
  message: string;
  received_at: string;
  patient_id: string | null;
  replied_at: string | null;
  reply_message: string | null;
  reply_provider_id: string | null;
  created_at: string;
};

export type DailySnapshot = {
  id: string;
  snapped_at: string;
  total_patients: number;
  ready: number;
  waiting: number;
  sent_complete: number;
  future_booking: number;
  missing_phone: number;
  do_not_contact: number;
  needs_review: number;
  no_valid_booking: number;
  sms_sent: number;
  sms_dry_run: number;
  sms_failed: number;
  sms_skipped: number;
  dry_run_mode: boolean;
  is_active: boolean;
};

export type ReviewItem = {
  id: string;
  type: string;
  severity: ReviewSeverity;
  title: string;
  description: string;
  suggested_action: string | null;
  status: ReviewStatus;
  raw_data: Record<string, unknown>;
  content_hash?: string | null;
  created_at: string;
  updated_at: string;
};

export type ClinicStore = {
  patients: Patient[];
  bookings: Booking[];
  reminder_settings: ReminderSettings[];
  reminder_logs: ReminderLog[];
  review_items: ReviewItem[];
};

export type NormalizedBookingRow = {
  external_booking_id: string;
  patient_name: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  normalized_phone: string | null;
  email: string | null;
  booking_at: string | null;
  treatment: string | null;
  status: BookingStatus;
  source: string;
  raw_data: Record<string, string>;
  issues: ImportIssue[];
};

export type ImportIssue = {
  type: string;
  severity: ReviewSeverity;
  title: string;
  description: string;
};

export type ImportSummary = {
  totalRows: number;
  importedBookings: number;
  importedOrUpdatedPatients: number;
  skippedRows: number;
  missingPhoneCount: number;
  cancelledCount: number;
  futureBookingCount: number;
  reviewItemsCreated: number;
};

export type PatientReminderStatus =
  | "Ready"
  | "Sent"
  | "Future booking"
  | "Missing phone"
  | "Do not contact"
  | "Needs review"
  | "Delivery pending"
  | "Waiting"
  | "No valid booking";

/** Which follow-up should be sent next, or null if none due yet / all sent */
export type NextSequenceInfo = {
  /** Immutable id of the step — what the send is actually keyed on. */
  stepId: string;
  /** Its trigger day, snapshotted onto the log. */
  day: number;
  /** Position in the full day-sorted list, inactive steps included. */
  sequenceNumber: number;
} | null;

export type DashboardStats = {
  totalPatients: number;
  readyForReminder: number;
  smsSentThisMonth: number;
  needsReviewCount: number;
  dryRun: {
    eligible_count: number;
    would_send_today: number;
    excluded_missing_phone: number;
    excluded_future_booking: number;
    excluded_do_not_contact: number;
    needs_review: number;
    estimated_sms_count: number;
  };
  recentReminderActivity: (ReminderLog & { full_name: string | null })[];
  nudges: Array<{
    title: string;
    description: string;
    severity: ReviewSeverity;
  }>;
};
