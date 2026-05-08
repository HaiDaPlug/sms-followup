export type BookingStatus = "Booked" | "Cancelled" | "Unknown" | string;
export type ReviewStatus = "open" | "resolved" | "ignored";
export type ReviewSeverity = "low" | "medium" | "high";
export type ReminderLogStatus = "sent" | "delivered" | "failed" | "dry_run" | "skipped" | "cycle_reset";
export type SkipReason =
  | "future_booking"
  | "missing_phone"
  | "do_not_contact"
  | "needs_review"
  | "no_valid_booking"
  | "waiting"
  | "unresolved_placeholder"
  | "sequence_complete";

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
  source: string;
  raw_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type SmsStep = {
  day: number;
  template: string;
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
  /** Variable-length sequence: [{day, template}, ...] sorted by day ascending */
  sms_steps: SmsStep[] | null;
  booking_link: string;
  clinic_name: string;
  is_active: boolean;
  dry_run_mode: boolean;
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
  /** Which SMS in the sequence this was: 1, 2, or 3. null for non-SMS logs. */
  sequence_number: number | null;
  /** True when a new booking reset this patient's cycle */
  is_cycle_reset: boolean;
  provider_message_id: string | null;
  /** Machine-readable skip reason — set whenever status is "skipped" */
  skip_reason: SkipReason | null;
  error: string | null;
  sent_at: string | null;
  created_at: string;
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
  | "Waiting"
  | "No valid booking";

/** Which SMS in the sequence should be sent next, or null if none due yet / all sent */
export type NextSequenceInfo = {
  sequenceNumber: number;
  daysThreshold: number;
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
