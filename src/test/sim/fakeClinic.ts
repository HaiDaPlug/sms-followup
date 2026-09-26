/**
 * In-memory clinic for time-travel tests of the follow-up engine.
 *
 * A stateful fake of everything the engine touches (repository, supabase
 * client, SMS provider) so the REAL, UNCHANGED processDailyReminders() and
 * processScheduledSms() can be driven across simulated days. Rows live in plain
 * arrays (`clinic.tables.*`) that follow the production schema and constraints
 * closely enough that a bug the database would catch also fails here.
 *
 * Wiring (verified with vitest 4 — vi.mock is hoisted above the imports, and the
 * async factories only run when the engine module first imports the mocked path,
 * by which time this module can be imported without a cycle):
 *
 *   import { afterEach, beforeEach, vi } from "vitest";
 *   import { createClinic, restoreClock, type FakeClinic } from "@/test/sim";
 *
 *   vi.mock("@/lib/data/repository", async () => (await import("@/test/sim/fakeClinic")).repositoryMock);
 *   vi.mock("@/lib/data/readStoreForUi", async () => (await import("@/test/sim/fakeClinic")).readStoreForUiMock);
 *   vi.mock("@/lib/supabase/client", async () => ({ supabase: (await import("@/test/sim/fakeClinic")).supabaseMock }));
 *   vi.mock("@/lib/sms/provider", async () => (await import("@/test/sim/fakeClinic")).providerMock);
 *
 *   let clinic: FakeClinic;
 *   beforeEach(() => { clinic = createClinic(); });
 *   afterEach(() => { restoreClock(); });
 *
 * Every mock delegates to the clinic most recently returned by createClinic(),
 * so a fresh clinic per test is a fresh database.
 *
 * This module must never statically import src/lib/reminders/* (or anything
 * else that imports a mocked path): the mock factories above import THIS
 * module, and a static edge back into the engine would make the mock depend on
 * itself while it is still initialising. Engine code is reached through
 * dynamic import() inside the methods that need it.
 *
 * Time: see clock.ts. Sim day 0 is the UTC date of the start instant; every
 * row written gets created_at = the current fake time.
 */
import { vi } from "vitest";
import type {
  Booking,
  ClinicStore,
  DailySnapshot,
  Patient,
  PatientReminderStatus,
  ReminderLog,
  ReminderLogStatus,
  ReminderSettings,
  ReviewItem,
  ScheduledSms,
  SkipReason,
  SmsStep,
  StoredSmsStep
} from "@/types/clinic";
import type { SendSmsInput, SendSmsResult, VerifyDeliveryResult } from "@/lib/sms/provider";
import { normalizeEmail, normalizePhone } from "@/lib/import/normalizers";
import {
  CRON_HOUR_UTC,
  HOUR_MS,
  WORKER_TICK_MINUTES,
  atSimDay,
  calendarDaysBetween,
  currentSimDay,
  setNow,
  simDayOf,
  startClock
} from "./clock";

type ProcessModule = typeof import("@/lib/reminders/process");
/** What processDailyReminders() resolves to. */
export type DailyCronResult = Awaited<ReturnType<ProcessModule["processDailyReminders"]>>;
/**
 * The daily cron's result when automation was on and patients were evaluated.
 * DailyCronResult is inferred as a union whose inactive branch carries
 * `results?: undefined`, so `"results" in r` does not narrow it; use
 * activeResult() or check `r.results !== undefined`.
 */
export type ActiveCronResult = Extract<DailyCronResult, { results: unknown[] }>;
/** What processScheduledSms() resolves to. */
export type ScheduledWorkerResult = Awaited<ReturnType<ProcessModule["processScheduledSms"]>>;

// ---------------------------------------------------------------------------
// Follow-up step fixtures
// ---------------------------------------------------------------------------

/** A Monday in March 2026: no DST change within weeks either side, in Sweden or the EU. */
export const DEFAULT_START = "2026-03-02T00:00:00.000Z";

/**
 * Fixed ids by POSITION, shared by both step sets: migration 010 re-timed the
 * second step from 10 to 14 days in place, so in production the 10-day and the
 * 14-day follow-up are the same step (same id). Switching a clinic from
 * STEPS_5_10 to PRODUCTION_STEPS mid-scenario therefore reproduces that edit.
 */
const STEP_IDS = [
  "5eed0000-0000-4000-8000-000000000001",
  "5eed0000-0000-4000-8000-000000000002",
  "5eed0000-0000-4000-8000-000000000003",
  "5eed0000-0000-4000-8000-000000000004",
  "5eed0000-0000-4000-8000-000000000005"
] as const;

// Production wording from migration 009. None of them use {{lastBookingDate}},
// whose rendering depends on the machine's time zone (Intl in renderSmsTemplate).
const SIGNATURE = "Mvh Mattias Hietala Osteopat\n\nBoka tid här:\n{{bookingLink}}";
const TEMPLATES = [
  `Hej {{firstName}},\nför att uppnå ett hållbart resultat rekommenderas vanligtvis 3–4 behandlingar, och i vissa fall kan fler behövas.\n${SIGNATURE}`,
  `Hej {{firstName}},\nuppföljning ger ofta bättre och mer stabila resultat.\nSvar gärna på detta meddelande eller boka en tid via länken nedan:\n\n${SIGNATURE}`,
  `Hej {{firstName}}! Det har nu gått några månader sedan ditt senaste besök hos mig. Hoppas att det känns bra i kroppen, annars kan det vara läge att boka ett besök snart.\n${SIGNATURE}`,
  `Hej {{firstName}}! Det har nu gått ett tag sedan ditt senaste besök hos mig. Många upplever att regelbunden osteopatisk behandling hjälper till att förebygga stelhet och besvär innan de hinner bli större problem.\n\n${SIGNATURE}`,
  `Hej {{firstName}}! Nu har det gått ett tag sedan din senaste behandling hos mig. Kroppen förändras över tid och många väntar tyvärr lite för länge innan de söker hjälp igen.\nEn uppföljande behandling kan vara ett bra sätt att förebygga återkommande besvär och hålla kroppen i balans. Hör gärna av dig om du vill boka en tid.\n\n${SIGNATURE}`
] as const;

function buildSteps(days: readonly number[]): readonly SmsStep[] {
  return Object.freeze(
    days.map((day, i) => Object.freeze({ id: STEP_IDS[i], day, template: TEMPLATES[i], active: true }))
  );
}

/** Production config today: 5/14/90/180/365 (migration 009 seeded 5/10/..., 010 changed 10 -> 14). */
export const PRODUCTION_STEPS = buildSteps([5, 14, 90, 180, 365]);
/** The "5 and 10 days" config the clinic talks about: 5/10/90/180/365, as migration 009 seeded it. */
export const STEPS_5_10 = buildSteps([5, 10, 90, 180, 365]);

/** Id of the step with trigger `day` in `steps` (default PRODUCTION_STEPS). Throws when absent. */
export function stepId(day: number, steps: readonly StoredSmsStep[] = PRODUCTION_STEPS): string {
  const step = steps.find((candidate) => candidate.day === day);
  if (!step?.id) throw new Error(`stepId: no step with day ${day} in [${steps.map((s) => s.day).join(", ")}]`);
  return step.id;
}

// ---------------------------------------------------------------------------
// Schema, defaults and constraints (what Postgres would enforce)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** The seven tables the engine reads or writes, typed as the app types them. */
export type SimTables = {
  patients: Patient[];
  bookings: Booking[];
  reminder_settings: ReminderSettings[];
  reminder_logs: ReminderLog[];
  review_items: ReviewItem[];
  scheduled_sms: ScheduledSms[];
  daily_snapshots: DailySnapshot[];
};
export type SimTableName = keyof SimTables;

const TABLE_NAMES: readonly SimTableName[] = [
  "patients",
  "bookings",
  "reminder_settings",
  "reminder_logs",
  "review_items",
  "scheduled_sms",
  "daily_snapshots"
];

const ID_PREFIX: Record<SimTableName, string> = {
  patients: "patient",
  bookings: "booking",
  reminder_settings: "settings",
  reminder_logs: "log",
  review_items: "review",
  scheduled_sms: "sched",
  daily_snapshots: "snapshot"
};

/** Column defaults per table (migrations 001-025). The key set doubles as the column list. */
function columnDefaults(table: SimTableName, now: string): Row {
  switch (table) {
    case "patients":
      return {
        id: undefined, full_name: undefined, first_name: null, last_name: null, phone: null,
        normalized_phone: null, email: null, last_booking_at: null, latest_treatment: null,
        has_future_booking: false, do_not_contact: false, source: "bokadirekt_csv",
        bokadirekt_customer_id: null, created_at: now, updated_at: now
      };
    case "bookings":
      return {
        id: undefined, external_booking_id: null, patient_id: null, patient_name: null, phone: null,
        normalized_phone: null, email: null, booking_at: null, treatment: null, status: null,
        cancelled: false, source: "bokadirekt_csv", raw_data: {}, event_created_at: null,
        created_at: now, updated_at: now
      };
    case "reminder_settings":
      return {
        id: undefined, days_after_booking: 30, send_time: "09:00", max_per_day: 25,
        sms_template: "", sms_template_2: "", sms_template_3: "", sms_steps: null,
        booking_link: "", clinic_name: "Kliniken", is_active: true, dry_run_mode: true,
        allow_same_number_override: false, created_at: now, updated_at: now
      };
    case "reminder_logs":
      return {
        id: undefined, patient_id: null, booking_id: null, phone: null, message: undefined,
        status: undefined, sequence_number: null, step_id: null, step_day: null,
        is_cycle_reset: false, provider_message_id: null, skip_reason: null, error: null,
        sent_at: null, created_at: now
      };
    case "review_items":
      return {
        id: undefined, type: undefined, severity: "medium", title: undefined, description: undefined,
        suggested_action: null, status: "open", raw_data: {}, content_hash: null,
        created_at: now, updated_at: now
      };
    case "scheduled_sms":
      return {
        id: undefined, patient_id: null, booking_id: null, patient_name: null, recipient_phone: null,
        sequence_override: null, step_id: null, message_override: null, scheduled_for: undefined,
        status: "pending", reminder_log_id: null, error: null, created_at: now, claimed_at: null,
        completed_at: null, attempt_count: 0
      };
    case "daily_snapshots":
      return {
        id: undefined, snapped_at: now, total_patients: 0, ready: 0, waiting: 0, sent_complete: 0,
        future_booking: 0, missing_phone: 0, do_not_contact: 0, needs_review: 0,
        no_valid_booking: 0, sms_sent: 0, sms_dry_run: 0, sms_failed: 0, sms_skipped: 0,
        dry_run_mode: true, is_active: true
      };
  }
}

const NOT_NULL: Record<SimTableName, readonly string[]> = {
  patients: ["id", "full_name", "has_future_booking", "do_not_contact", "source", "created_at", "updated_at"],
  bookings: ["id", "source", "raw_data", "created_at", "updated_at"],
  reminder_settings: ["id", "max_per_day", "is_active", "dry_run_mode", "created_at", "updated_at"],
  reminder_logs: ["id", "message", "status", "is_cycle_reset", "created_at"],
  review_items: ["id", "type", "severity", "title", "description", "status", "raw_data", "created_at", "updated_at"],
  scheduled_sms: ["id", "scheduled_for", "status", "created_at", "attempt_count"],
  daily_snapshots: ["id", "snapped_at"]
};

/** reminder_logs_status_check (013). */
const LOG_STATUSES: readonly ReminderLogStatus[] = [
  "pending", "unknown", "sent", "delivered", "failed", "dry_run", "skipped", "cycle_reset"
];
/** reminder_logs_skip_reason_check (025). */
const SKIP_REASONS: readonly SkipReason[] = [
  "future_booking", "missing_phone", "do_not_contact", "needs_review", "no_valid_booking",
  "waiting", "unresolved_placeholder", "sequence_complete", "delivery_pending", "stale_cycle",
  "out_of_order", "step_removed"
];
/** scheduled_sms_status_check (016). */
const SCHEDULED_STATUSES: readonly ScheduledSms["status"][] = [
  "pending", "processing", "sent", "cancelled", "skipped", "failed", "unknown", "dry_run"
];
/** Statuses that hold a step slot in the 025 partial unique indexes. */
const SLOT_STATUSES: readonly string[] = ["pending", "unknown", "sent", "dry_run", "delivered"];

type UniqueIndex = { name: string; applies: (row: Row) => boolean; key: (row: Row) => string };

const pkey = (table: SimTableName): UniqueIndex => ({
  name: `${table}_pkey`,
  applies: () => true,
  key: (row) => String(row.id)
});

// Postgres treats NULLs as distinct in a unique index, hence the not-null
// guards on every key column: a NULL patient_id never collides.
const UNIQUE_INDEXES: Record<SimTableName, readonly UniqueIndex[]> = {
  patients: [
    pkey("patients"),
    {
      name: "patients_normalized_phone_idx", // 001
      applies: (r) => r.normalized_phone != null && r.normalized_phone !== "",
      key: (r) => String(r.normalized_phone)
    }
  ],
  bookings: [
    pkey("bookings"),
    {
      name: "bookings_external_booking_id_key", // 001: `external_booking_id text unique`
      applies: (r) => r.external_booking_id != null,
      key: (r) => String(r.external_booking_id)
    }
  ],
  reminder_settings: [pkey("reminder_settings")],
  reminder_logs: [
    pkey("reminder_logs"),
    {
      name: "reminder_logs_provider_message_id_idx", // 004
      applies: (r) => r.provider_message_id != null,
      key: (r) => String(r.provider_message_id)
    },
    {
      name: "reminder_logs_booking_step_idx", // 025
      applies: (r) =>
        SLOT_STATUSES.includes(String(r.status)) && r.booking_id != null && r.step_id != null && r.patient_id != null,
      key: (r) => `${r.patient_id}|${r.booking_id}|${r.step_id}`
    },
    {
      name: "reminder_logs_null_booking_step_idx", // 025
      applies: (r) =>
        SLOT_STATUSES.includes(String(r.status)) && r.booking_id == null && r.step_id != null && r.patient_id != null,
      key: (r) => `${r.patient_id}|${r.step_id}`
    }
  ],
  review_items: [
    pkey("review_items"),
    {
      name: "review_items_content_hash_idx", // 002
      applies: (r) => r.content_hash != null,
      key: (r) => String(r.content_hash)
    }
  ],
  scheduled_sms: [pkey("scheduled_sms")],
  daily_snapshots: [pkey("daily_snapshots")]
};

/** A Postgres / PostgREST error as supabase-js surfaces it in `{ error }`. */
export type PgErrorShape = { code: string; message: string; details: string | null; hint: string | null };

class PgError extends Error {
  constructor(readonly pg: PgErrorShape) {
    super(pg.message);
  }
}

function pgError(code: string, message: string, details: string | null = null): PgError {
  return new PgError({ code, message, details, hint: null });
}

function checkViolation(table: SimTableName, row: Row): PgError | null {
  for (const column of NOT_NULL[table]) {
    if (row[column] === null || row[column] === undefined) {
      return pgError("23502", `null value in column "${column}" of relation "${table}" violates not-null constraint`);
    }
  }
  const failCheck = (constraint: string) =>
    pgError("23514", `new row for relation "${table}" violates check constraint "${constraint}"`);
  if (table === "reminder_logs") {
    if (!LOG_STATUSES.includes(row.status as ReminderLogStatus)) return failCheck("reminder_logs_status_check");
    if (row.skip_reason != null && !SKIP_REASONS.includes(row.skip_reason as SkipReason)) {
      return failCheck("reminder_logs_skip_reason_check");
    }
  }
  if (table === "scheduled_sms") {
    if (!SCHEDULED_STATUSES.includes(row.status as ScheduledSms["status"])) return failCheck("scheduled_sms_status_check");
    if (row.sequence_override != null && !(Number(row.sequence_override) > 0)) {
      return failCheck("scheduled_sms_sequence_override_check");
    }
  }
  return null;
}

function uniqueViolation(table: SimTableName, candidate: Row, others: readonly Row[]): PgError | null {
  for (const index of UNIQUE_INDEXES[table]) {
    if (!index.applies(candidate)) continue;
    const key = index.key(candidate);
    if (others.some((other) => index.applies(other) && index.key(other) === key)) {
      return pgError(
        "23505",
        `duplicate key value violates unique constraint "${index.name}"`,
        `Key already exists: ${key}`
      );
    }
  }
  return null;
}

function unknownColumn(table: SimTableName, row: Row, columns: Row): PgError | null {
  for (const key of Object.keys(row)) {
    if (!(key in columns)) {
      return pgError("PGRST204", `Could not find the '${key}' column of '${table}' in the schema cache`);
    }
  }
  return null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function timeMs(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

/**
 * Newest-first like PostgREST `.order(col, { ascending: false })`. Postgres
 * leaves ties unordered; here a later insertion wins, which is what the cycle
 * logic needs when a whole cron run shares one frozen created_at.
 */
function newestFirst<T>(rows: readonly T[], column: string): T[] {
  return rows
    .map((row, index) => ({ row, index, t: timeMs((row as Row)[column]) }))
    .sort((a, b) => b.t - a.t || b.index - a.index)
    .map((entry) => entry.row);
}

function oldestFirst<T>(rows: readonly T[], column: string): T[] {
  return rows
    .map((row, index) => ({ row, index, t: timeMs((row as Row)[column]) }))
    .sort((a, b) => a.t - b.t || a.index - b.index)
    .map((entry) => entry.row);
}

// ---------------------------------------------------------------------------
// Fake provider
// ---------------------------------------------------------------------------

type SendResponse = SendSmsResult | ((input: SendSmsInput) => SendSmsResult | Promise<SendSmsResult>);
type VerifyResponse =
  | VerifyDeliveryResult
  | ((providerMessageId: string) => VerifyDeliveryResult | Promise<VerifyDeliveryResult>);

/** One call the engine made to sendSms(). */
export type ProviderCall = {
  to: string;
  message: string;
  /** Fake time of the call. */
  at: string;
  simDay: number;
  /** Patient whose normalized_phone matched `to` at call time, or null. */
  patientId: string | null;
  /**
   * What sendSms() returned. When the scripted response threw, the engine
   * never received a result: this is then a placeholder
   * `{ success: false, error: <message> }` and `threw` is set.
   */
  result: SendSmsResult;
  /**
   * Message of the error the scripted response threw (the provider was reached
   * but the call never returned, e.g. the function died mid-send). Absent for
   * calls that returned, so existing whole-object assertions keep matching.
   */
  threw?: string;
};

/**
 * Scriptable stand-in for src/lib/sms/provider. Queued responses are consumed
 * first-in-first-out, one per call; when the queue is empty the handler (if
 * set) answers, else the default. Defaults: sendSms succeeds with a unique
 * providerMessageId; verifyDelivery returns { status: "unsupported" }, which
 * leaves an accepted send as "sent" (resolveDelivery).
 */
export class FakeProvider {
  private sendQueue: SendResponse[] = [];
  private sendHandler: SendResponse | null = null;
  private verifyQueue: VerifyResponse[] = [];
  private verifyHandler: VerifyResponse | null = null;

  constructor(private readonly nextMessageId: () => string) {}

  /** Answer the next sendSms() calls with these, in order. E.g. queue({ success: false, uncertain: true, error: "timeout" }). */
  queue(...responses: SendResponse[]): this {
    this.sendQueue.push(...responses);
    return this;
  }

  /** Answer every sendSms() call not covered by queue(). null restores the default. */
  setHandler(handler: SendResponse | null): this {
    this.sendHandler = handler;
    return this;
  }

  /** Answer the next verifyDelivery() calls with these, in order. */
  queueVerify(...responses: VerifyResponse[]): this {
    this.verifyQueue.push(...responses);
    return this;
  }

  /** Answer every verifyDelivery() call not covered by queueVerify(). null restores the default. */
  setVerifyHandler(handler: VerifyResponse | null): this {
    this.verifyHandler = handler;
    return this;
  }

  /** Drop queued responses and handlers. */
  reset(): this {
    this.sendQueue = [];
    this.sendHandler = null;
    this.verifyQueue = [];
    this.verifyHandler = null;
    return this;
  }

  /** @internal Used by providerMock.sendSms. */
  async respondToSend(input: SendSmsInput): Promise<SendSmsResult> {
    const response = this.sendQueue.length > 0 ? this.sendQueue.shift()! : this.sendHandler;
    if (response === null) return { success: true, providerMessageId: this.nextMessageId() };
    return clone(typeof response === "function" ? await response(input) : response);
  }

  /** @internal Used by providerMock.verifyDelivery. */
  async respondToVerify(providerMessageId: string): Promise<VerifyDeliveryResult> {
    const response = this.verifyQueue.length > 0 ? this.verifyQueue.shift()! : this.verifyHandler;
    if (response === null) return { status: "unsupported" };
    return clone(typeof response === "function" ? await response(providerMessageId) : response);
  }
}

// ---------------------------------------------------------------------------
// Scenario option types
// ---------------------------------------------------------------------------

/** When something happens: a sim day plus UTC hour/minute, or an absolute ISO instant. */
export type SimWhen = { day: number; hourUtc?: number; minute?: number } | { at: string };

export type ConfigureOptions = {
  /** Replaces reminder_settings.sms_steps (deep-copied). */
  steps?: readonly StoredSmsStep[];
  maxPerDay?: number;
  dryRun?: boolean;
  isActive?: boolean;
  allowSameNumberOverride?: boolean;
  clinicName?: string;
  bookingLink?: string;
};

export type AddPatientOptions = {
  id?: string;
  /** full_name; first word becomes first_name. Default "Patient 0001" style. */
  name?: string;
  /** Sim day of the visit (may be negative). Default: the current sim day. */
  visitDay?: number;
  /** UTC hour of the visit on visitDay (fractions allowed). Default 11. */
  visitHourUtc?: number;
  /** Absolute visit instant; overrides visitDay/visitHourUtc. */
  visitAt?: string;
  /** Raw phone; normalised like the import does. null = no phone. Default: a unique 07xxxxxxxx number. */
  phone?: string | null;
  email?: string | null;
  doNotContact?: boolean;
  treatment?: string;
  /**
   * How the record arrives. "import" (default) = CSV import semantics: no
   * cycle_reset, last_booking_at/latest_treatment/has_future_booking recomputed.
   *
   * "confirmedMatch" = the only way a booking creates a patient outside the
   * import. The BokaDirekt webhook never creates one: for an unknown customer
   * it only stages an open pending_booking_match review item. The patient
   * appears when an operator confirms that item as a new patient
   * (confirm_booking_match, 018, which runs apply_bokadirekt_booking with a
   * null patient, 023: insert patient + booking, refresh metadata, one
   * cycle_reset, cancel pending scheduled SMS, then resolve the item). Here
   * both the staging and the confirmation happen at the current fake time. To
   * confirm later than the booking arrived, use stageNewPatientBooking() and
   * confirmNewPatient() instead.
   */
  via?: "import" | "confirmedMatch";
  /**
   * An import can only record a visit that already happened, so a visit after
   * the current fake time throws unless this is true. With true the booking is a
   * FUTURE booking and last_booking_at stays null until something refreshes it —
   * as in production. Confirmed matches never need this.
   */
  allowFuture?: boolean;
};

/** A BokaDirekt booking for a customer the webhook could not match to any patient. */
export type StageBookingOptions = {
  /** Customer name; first word becomes FirstName. Default "Webb Patient 0001" style. */
  name?: string;
  /** Sim day of the appointment. Default: the current sim day. */
  visitDay?: number;
  /** UTC hour of the appointment (fractions allowed). Default 11. */
  visitHourUtc?: number;
  /** Absolute appointment instant; overrides visitDay/visitHourUtc. */
  visitAt?: string;
  /** Raw mobile number. null = none. Default: a unique 0790xxxxxx number. */
  phone?: string | null;
  email?: string | null;
  treatment?: string;
};

/** The part of the BokaDirekt payload stageNewPatientBooking() stores in raw_data.booking. */
type StagedBookingPayload = {
  Id: string;
  BookingStartDate: string;
  ServiceName: string | null;
  EventCreated: string | null;
  Customer: {
    Id: string | null;
    FirstName: string | null;
    LastName: string | null;
    MobilePhoneNumber: string | null;
    PhoneNumber: string | null;
    EmailAdress: string | null;
  };
};

export type AddBookingOptions = {
  cancelled?: boolean;
  /** Booking status text. Default "Booked" (or "Cancelled" when cancelled). */
  status?: string;
  treatment?: string;
  /** Recompute metadata like the CSV import does (default true). false = raw row only. */
  refresh?: boolean;
};

export type ScheduleSmsOptions = {
  patientId: string;
  /** Explicit step by id (route body.stepId). */
  stepId?: string;
  /** Explicit step by trigger day in the CURRENT settings; resolved to its id. */
  stepDay?: number;
  /** Absolute scheduled_for; or give day (+ hourUtc, default 9, + minute). */
  at?: string;
  day?: number;
  hourUtc?: number;
  minute?: number;
};

/** app/api/scheduled-sms POST refused the request; `status` is the HTTP status it would return. */
export class ScheduleSmsRejected extends Error {
  constructor(readonly status: number, message: string) {
    super(`scheduleSms rejected (${status}): ${message}`);
    this.name = "ScheduleSmsRejected";
  }
}

export type RunDaysOptions = {
  /** UTC hour the daily cron fires. Default CRON_HOUR_UTC (8, vercel.json). */
  cronHourUtc?: number;
  /**
   * Minute within that hour the cron actually fires, 0-59 (default 0). A
   * function gets the sim day and returns that day's minute, which models
   * Vercel Hobby's "anywhere within the hour" invocation (see clock.ts).
   */
  cronMinute?: number | ((simDay: number) => number);
  /**
   * Also run processScheduledSms() once per day at the cron instant.
   * true / "afterCron": right after the daily cron. "beforeCron": right before.
   * For 15-minute worker ticks use runWorkerTicksUntil().
   */
  scheduledWorker?: boolean | "afterCron" | "beforeCron";
};

export type SimDayRun = {
  simDay: number;
  /** Instant the cron ran at. */
  at: string;
  result: DailyCronResult;
  /** Present when the scheduled worker ran that day. */
  scheduled?: ScheduledWorkerResult;
};

export type TimelineEntry = {
  logId: string;
  /** created_at of the log. */
  at: string;
  simDay: number;
  /**
   * UTC calendar days from the date of the visit this log refers to (its
   * booking_id's booking_at, else the patient's current last_booking_at) to the
   * date of the log. null when there is no such visit. Negative for a
   * cycle_reset written before its (future) appointment.
   */
  daysSinceVisitDate: number | null;
  /** Elapsed hours from that visit to the log (what the engine floors into days is this / 24). */
  hoursSinceVisit: number | null;
  visitAt: string | null;
  status: ReminderLogStatus;
  stepDay: number | null;
  stepId: string | null;
  sequenceNumber: number | null;
  skipReason: SkipReason | null;
  error: string | null;
  bookingId: string | null;
  isCycleReset: boolean;
  message: string;
};

const SENT_STATUSES: readonly string[] = ["sent", "delivered", "dry_run"];
const PGRST116_MESSAGE = "Cannot coerce the result to a single JSON object";

// ---------------------------------------------------------------------------
// The clinic
// ---------------------------------------------------------------------------

export class FakeClinic {
  /** Live tables. Read them for assertions; edit them for surgical setups (no constraint checks on direct edits). */
  readonly tables: SimTables = {
    patients: [],
    bookings: [],
    reminder_settings: [],
    reminder_logs: [],
    review_items: [],
    scheduled_sms: [],
    daily_snapshots: []
  };
  /** Every sendSms() call, in order. */
  readonly sent: ProviderCall[] = [];
  /** Script provider responses here. */
  readonly provider: FakeProvider;
  /** ISO instant of 00:00 UTC on sim day 0. */
  readonly day0: string;

  private readonly counters = new Map<string, number>();

  constructor(start: string) {
    startClock(start);
    this.day0 = atSimDay(0);
    this.provider = new FakeProvider(() => this.nextId("sim-msg"));
    this.insertRows("reminder_settings", [
      {
        days_after_booking: 5,
        send_time: "09:00",
        max_per_day: 25,
        sms_steps: clone(PRODUCTION_STEPS) as StoredSmsStep[],
        booking_link: "https://bokat.se/osteopaticentrum",
        clinic_name: "Osteopaticentrum",
        is_active: true,
        dry_run_mode: false,
        allow_same_number_override: false
      }
    ]);
  }

  // -------------------------------------------------------------------------
  // Low-level table operations (constraint-checked, atomic per call)
  // -------------------------------------------------------------------------

  /** @internal Deterministic id like "log-0007". */
  nextId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(4, "0")}`;
  }

  private rows(table: SimTableName): Row[] {
    return this.tables[table] as unknown as Row[];
  }

  /**
   * @internal INSERT with defaults, NOT NULL / CHECK / UNIQUE checks. All rows
   * or none (one statement). Returns the stored rows (live references).
   * Throws PgError.
   */
  insertRows(table: SimTableName, input: readonly Row[]): Row[] {
    const now = new Date().toISOString();
    const prepared: Row[] = [];
    for (const raw of input) {
      const defaults = columnDefaults(table, now);
      const bad = unknownColumn(table, raw, defaults);
      if (bad) throw bad;
      const row: Row = { ...defaults };
      for (const [key, value] of Object.entries(raw)) {
        if (value !== undefined) row[key] = clone(value);
      }
      if (row.id === undefined) row.id = this.nextId(ID_PREFIX[table]);
      const violation =
        checkViolation(table, row) ?? uniqueViolation(table, row, [...this.rows(table), ...prepared]);
      if (violation) throw violation;
      prepared.push(row);
    }
    this.rows(table).push(...prepared);
    return prepared;
  }

  /**
   * @internal UPDATE ... WHERE predicate. Checks every updated row against the
   * table as it would look afterwards; commits only when `accept(count)` agrees
   * (PostgREST rolls back a .single() that matched != 1 row). Throws PgError.
   */
  updateRows(
    table: SimTableName,
    predicate: (row: Row) => boolean,
    patch: Row | ((row: Row) => Row),
    accept: (count: number) => boolean = () => true
  ): Row[] {
    const all = this.rows(table);
    const targets = all.filter(predicate);
    const updated = targets.map((row) => {
      const changes = typeof patch === "function" ? patch(row) : patch;
      const bad = unknownColumn(table, changes, columnDefaults(table, ""));
      if (bad) throw bad;
      const next: Row = { ...row };
      for (const [key, value] of Object.entries(changes)) {
        if (value !== undefined) next[key] = clone(value);
      }
      return next;
    });
    const after = all.map((row) => {
      const i = targets.indexOf(row);
      return i === -1 ? row : updated[i];
    });
    for (const next of updated) {
      const violation =
        checkViolation(table, next) ?? uniqueViolation(table, next, after.filter((row) => row !== next));
      if (violation) throw violation;
    }
    if (!accept(targets.length)) return updated;
    targets.forEach((row, i) => {
      for (const key of Object.keys(row)) delete row[key];
      Object.assign(row, updated[i]);
    });
    return targets;
  }

  /** @internal DELETE ... WHERE predicate. Returns the removed rows. */
  deleteRows(table: SimTableName, predicate: (row: Row) => boolean): Row[] {
    const all = this.rows(table);
    const removed = all.filter(predicate);
    const kept = all.filter((row) => !predicate(row));
    all.length = 0;
    all.push(...kept);
    return removed;
  }

  // -------------------------------------------------------------------------
  // Repository (mirrors src/lib/storage/store.ts function by function)
  // -------------------------------------------------------------------------

  private asSupabaseError(err: unknown, label: string): never {
    if (err instanceof PgError) throw new Error(`Supabase ${label}: ${err.pg.message}`);
    throw err;
  }

  /** store.readStore: five tables, newest-first by created_at, settings limit 1, deep copies. */
  readStore(): ClinicStore {
    return {
      patients: clone(newestFirst(this.tables.patients, "created_at")),
      bookings: clone(newestFirst(this.tables.bookings, "created_at")),
      reminder_settings: clone(this.tables.reminder_settings.slice(0, 1)),
      reminder_logs: clone(newestFirst(this.tables.reminder_logs, "created_at")),
      review_items: clone(newestFirst(this.tables.review_items, "created_at"))
    };
  }

  /** readStoreForUi: same query, bookings without raw_data (replaced by {}), no cache. */
  readStoreForUi(): ClinicStore {
    const store = this.readStore();
    return { ...store, bookings: store.bookings.map((booking) => ({ ...booking, raw_data: {} })) };
  }

  /** store.getSettings: newest updated_at; inserts store.ts defaults when the table is empty. */
  getSettings(): ReminderSettings {
    const [latest] = newestFirst(this.tables.reminder_settings, "updated_at");
    if (latest) return clone(latest);
    try {
      const [inserted] = this.insertRows("reminder_settings", [
        {
          days_after_booking: 30,
          send_time: "09:00",
          max_per_day: 25,
          sms_template:
            "Hej {{firstName}}! Det har gått 30 dagar sedan ditt senaste besök hos {{clinicName}}. Vill du boka en ny tid? Du kan boka här: {{bookingLink}}",
          sms_template_2:
            "Hej {{firstName}}! Vi saknar dig på {{clinicName}}. Det har nu gått 60 dagar sedan ditt besök. Boka enkelt online: {{bookingLink}}",
          sms_template_3:
            "Hej {{firstName}}! Det har gått 90 dagar sedan vi sågs på {{clinicName}}. Vi hoppas att allt är bra – kom gärna tillbaka! Boka här: {{bookingLink}}",
          sms_steps: null,
          booking_link: "",
          clinic_name: "Kliniken",
          is_active: true,
          dry_run_mode: true,
          allow_same_number_override: false
        }
      ]);
      return clone(inserted) as unknown as ReminderSettings;
    } catch (err) {
      this.asSupabaseError(err, "reminder_settings insert defaults");
    }
  }

  /** store.updateSettings: merge onto the getSettings() row. */
  updateSettings(input: Partial<ReminderSettings>): ReminderSettings {
    const current = this.getSettings();
    const updated: Row = {
      ...current,
      ...input,
      days_after_booking: Number(input.days_after_booking ?? current.days_after_booking),
      max_per_day: Number(input.max_per_day ?? current.max_per_day),
      is_active: input.is_active ?? current.is_active,
      dry_run_mode: input.dry_run_mode ?? current.dry_run_mode,
      allow_same_number_override: input.allow_same_number_override ?? current.allow_same_number_override ?? false,
      updated_at: new Date().toISOString()
    };
    try {
      const [row] = this.updateRows("reminder_settings", (r) => r.id === current.id, updated, (n) => n === 1);
      return clone(row) as unknown as ReminderSettings;
    } catch (err) {
      this.asSupabaseError(err, "reminder_settings update");
    }
  }

  addReminderLog(log: Omit<ReminderLog, "id" | "created_at">): ReminderLog {
    try {
      const [row] = this.insertRows("reminder_logs", [log as unknown as Row]);
      return clone(row) as unknown as ReminderLog;
    } catch (err) {
      this.asSupabaseError(err, "reminder_logs insert");
    }
  }

  /** store.updateReminderLog: update by id, guarded by expectedStatus; .single() throws on 0 rows. */
  updateReminderLog(
    id: string,
    patch: Partial<Pick<ReminderLog, "status" | "provider_message_id" | "error" | "sent_at">>,
    expectedStatus?: ReminderLog["status"]
  ): ReminderLog {
    let count = 0;
    let rows: Row[];
    try {
      rows = this.updateRows(
        "reminder_logs",
        (r) => r.id === id && (!expectedStatus || r.status === expectedStatus),
        patch as Row,
        (n) => ((count = n), n === 1)
      );
    } catch (err) {
      this.asSupabaseError(err, "reminder_logs update");
    }
    if (count !== 1) throw new Error(`Supabase reminder_logs update: ${PGRST116_MESSAGE}`);
    return clone(rows[0]) as unknown as ReminderLog;
  }

  resetPatientCycle(patientId: string, bookingId: string | null): ReminderLog {
    return this.addReminderLog({
      patient_id: patientId,
      booking_id: bookingId,
      phone: null,
      message: "",
      status: "cycle_reset",
      sequence_number: null,
      step_id: null,
      step_day: null,
      is_cycle_reset: true,
      provider_message_id: null,
      skip_reason: null,
      error: null,
      sent_at: null
    });
  }

  /**
   * store.addReviewItem is a plain insert: it does NOT dedupe on content_hash,
   * so a repeated hash hits review_items_content_hash_idx (002) and throws.
   */
  addReviewItem(item: Omit<ReviewItem, "id" | "created_at" | "updated_at">): ReviewItem {
    try {
      const [row] = this.insertRows("review_items", [item as unknown as Row]);
      return clone(row) as unknown as ReviewItem;
    } catch (err) {
      this.asSupabaseError(err, "review_items insert");
    }
  }

  updateReviewItem(
    id: string,
    patch: Partial<Pick<ReviewItem, "status" | "description" | "suggested_action" | "raw_data">>
  ): ReviewItem | null {
    let count = 0;
    let rows: Row[];
    try {
      rows = this.updateRows(
        "review_items",
        (r) => r.id === id,
        { ...patch, updated_at: new Date().toISOString() },
        (n) => ((count = n), n === 1)
      );
    } catch (err) {
      this.asSupabaseError(err, "review_items update");
    }
    return count === 1 ? (clone(rows[0]) as unknown as ReviewItem) : null;
  }

  /** store.updatePatient: patch + updated_at; null when the id does not exist. */
  updatePatient(id: string, patch: Partial<Patient>): Patient | null {
    let count = 0;
    let rows: Row[];
    try {
      rows = this.updateRows(
        "patients",
        (r) => r.id === id,
        { ...patch, updated_at: new Date().toISOString() },
        (n) => ((count = n), n === 1)
      );
    } catch (err) {
      this.asSupabaseError(err, "patients update");
    }
    return count === 1 ? (clone(rows[0]) as unknown as Patient) : null;
  }

  /** store.bulkUpsertPatients: upsert on id (insert new, overwrite given columns of existing). All or nothing. */
  bulkUpsertPatients(patients: Patient[]): Patient[] {
    if (patients.length === 0) return [];
    const snapshot = this.tables.patients.map((row) => ({ ...row }));
    const results: Row[] = [];
    try {
      for (const patient of patients) {
        const exists = this.tables.patients.some((row) => row.id === patient.id);
        if (exists) {
          results.push(...this.updateRows("patients", (r) => r.id === patient.id, patient as unknown as Row));
        } else {
          results.push(...this.insertRows("patients", [patient as unknown as Row]));
        }
      }
    } catch (err) {
      this.tables.patients.length = 0;
      this.tables.patients.push(...snapshot);
      this.asSupabaseError(err, "patients bulk upsert");
    }
    return clone(results) as unknown as Patient[];
  }

  insertDailySnapshot(snapshot: Omit<DailySnapshot, "id" | "snapped_at">): void {
    try {
      this.insertRows("daily_snapshots", [snapshot as unknown as Row]);
    } catch (err) {
      if (err instanceof PgError) throw new Error(`Supabase daily_snapshots insert: ${err.pg.message}`);
      throw err;
    }
  }

  getDailySnapshots(limitDays = 90): DailySnapshot[] {
    const since = Date.now() - limitDays * 24 * 60 * 60 * 1000;
    return clone(
      newestFirst(this.tables.daily_snapshots, "snapped_at").filter((row) => Date.parse(row.snapped_at) >= since)
    );
  }

  createScheduledSms(
    input: Omit<ScheduledSms, "id" | "status" | "reminder_log_id" | "error" | "claimed_at" | "completed_at" | "attempt_count" | "created_at">
  ): ScheduledSms {
    try {
      const [row] = this.insertRows("scheduled_sms", [input as unknown as Row]);
      return clone(row) as unknown as ScheduledSms;
    } catch (err) {
      this.asSupabaseError(err, "scheduled_sms insert");
    }
  }

  listScheduledSms(): ScheduledSms[] {
    return clone(newestFirst(this.tables.scheduled_sms, "created_at").slice(0, 250));
  }

  /** store.cancelScheduledSms: only from pending; null when not found or not pending. */
  cancelScheduledSms(id: string): ScheduledSms | null {
    let count = 0;
    const rows = this.updateRows(
      "scheduled_sms",
      (r) => r.id === id && r.status === "pending",
      { status: "cancelled", completed_at: new Date().toISOString() },
      (n) => ((count = n), n === 1)
    );
    return count === 1 ? (clone(rows[0]) as unknown as ScheduledSms) : null;
  }

  getActiveScheduledSmsPatientIds(): Set<string> {
    return new Set(
      this.tables.scheduled_sms
        .filter((row) => (row.status === "pending" || row.status === "processing") && row.patient_id !== null)
        .map((row) => row.patient_id as string)
    );
  }

  /**
   * claim_due_scheduled_sms (016): sweep processing rows claimed more than 30
   * minutes ago to unknown, then claim pending rows with scheduled_for <= now,
   * oldest scheduled_for first, limit clamped to 1..100.
   */
  claimDueScheduledSms(limit = 25): ScheduledSms[] {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    this.updateRows(
      "scheduled_sms",
      (r) => r.status === "processing" && r.claimed_at != null && timeMs(r.claimed_at) < now - 30 * 60_000,
      (r) => ({
        status: "unknown",
        completed_at: nowIso,
        error: r.error ?? "Bearbetningen avbröts - leveransstatus okänd"
      })
    );
    const cap = Math.max(1, Math.min(limit ?? 25, 100));
    const due = oldestFirst(
      this.tables.scheduled_sms.filter((row) => row.status === "pending" && Date.parse(row.scheduled_for) <= now),
      "scheduled_for"
    ).slice(0, cap);
    const ids = new Set(due.map((row) => row.id));
    const claimed = this.updateRows(
      "scheduled_sms",
      (r) => ids.has(r.id as string),
      (r) => ({ status: "processing", claimed_at: nowIso, attempt_count: Number(r.attempt_count) + 1, error: null })
    );
    // RETURNING order is unspecified in SQL; keep the claim order.
    return clone(oldestFirst(claimed, "scheduled_for")) as unknown as ScheduledSms[];
  }

  /** store.linkScheduledSmsReservation: only while processing, else "claim was lost". */
  linkScheduledSmsReservation(id: string, reminderLogId: string): void {
    let count = 0;
    this.updateRows(
      "scheduled_sms",
      (r) => r.id === id && r.status === "processing",
      { reminder_log_id: reminderLogId },
      (n) => ((count = n), n <= 1)
    );
    if (count === 0) throw new Error("Scheduled SMS claim was lost before provider delivery");
  }

  /** store.completeScheduledSms: only from processing; otherwise .single() fails and it throws. */
  completeScheduledSms(
    id: string,
    outcome: Extract<ScheduledSms["status"], "sent" | "skipped" | "failed" | "unknown" | "dry_run">,
    reminderLogId: string | null,
    error: string | null
  ): ScheduledSms {
    let count = 0;
    let rows: Row[];
    try {
      rows = this.updateRows(
        "scheduled_sms",
        (r) => r.id === id && r.status === "processing",
        {
          status: outcome,
          ...(reminderLogId ? { reminder_log_id: reminderLogId } : {}),
          error,
          completed_at: new Date().toISOString()
        },
        (n) => ((count = n), n === 1)
      );
    } catch (err) {
      this.asSupabaseError(err, "scheduled_sms complete");
    }
    if (count !== 1) throw new Error(`Supabase scheduled_sms complete: ${PGRST116_MESSAGE}`);
    return clone(rows[0]) as unknown as ScheduledSms;
  }

  /**
   * refresh_passed_booking_metadata (027), which the daily cron calls before it
   * reads the store: refresh_patient_booking_metadata for every patient with a
   * non-cancelled booking whose booking_at <= now() and is newer than the
   * stored last_booking_at (or none is stored). Never moves the column
   * backwards: a patient whose only newer booking was cancelled is not
   * selected. Returns how many patients were refreshed.
   */
  refreshPassedBookingMetadata(): number {
    const now = Date.now();
    const stale = this.tables.patients.filter((patient) =>
      this.tables.bookings.some(
        (booking) =>
          booking.patient_id === patient.id &&
          booking.cancelled === false &&
          booking.booking_at !== null &&
          Date.parse(booking.booking_at) <= now &&
          (patient.last_booking_at === null || Date.parse(booking.booking_at) > Date.parse(patient.last_booking_at))
      )
    );
    for (const patient of stale) this.refreshBookingMetadata(patient.id);
    return stale.length;
  }

  /**
   * mark_pending_unknown (013): pending -> unknown with the fixed Swedish error,
   * plus one delivery_unknown review item per row, in one transaction.
   */
  markPendingUnknown(logIds: readonly string[]): PgErrorShape | null {
    const ids = new Set(logIds);
    const logSnapshot = this.tables.reminder_logs.map((row) => ({ ...row }));
    try {
      const flipped = this.updateRows("reminder_logs", (r) => ids.has(r.id as string) && r.status === "pending", {
        status: "unknown",
        error: "Leveransstatus okänd - kontrollera SMS-leverantören"
      });
      this.insertRows(
        "review_items",
        flipped.map((log) => ({
          type: "delivery_unknown",
          severity: "high",
          // format('%s', NULL) renders an empty string.
          title: `Okänd SMS-leverans - SMS ${log.sequence_number ?? ""}`,
          description:
            "Reservationen skapades men leveransstatusen kunde inte bekräftas. Kontrollera leverantören och markera som skickat eller misslyckat.",
          suggested_action: "Verifiera med SMS-leverantören och välj åtgärd nedan.",
          status: "open",
          raw_data: {
            reminder_log_id: log.id,
            patient_id: log.patient_id,
            sequence_number: log.sequence_number,
            phone: log.phone
          },
          content_hash: `delivery_unknown:${log.id}`
        }))
      );
      return null;
    } catch (err) {
      this.tables.reminder_logs.length = 0;
      this.tables.reminder_logs.push(...logSnapshot);
      if (err instanceof PgError) return err.pg;
      throw err;
    }
  }

  /**
   * resolve_delivery_unknown (013), the RPC behind POST
   * /api/review/resolve-delivery: the same checks in the same order, then the
   * log goes unknown -> outcome (sent_at = now for "sent", null for "failed")
   * and the review item is resolved, in one transaction. Returns the RPC's
   * error as supabase-js surfaces a RAISE EXCEPTION (code P0001, the raised
   * text) or null. Nothing is written when it fails.
   */
  resolveDeliveryUnknownRpc(reviewItemId: string, logId: string, outcome: string): PgErrorShape | null {
    const raise = (message: string) => ({ code: "P0001", message, details: null, hint: null });
    if (outcome !== "sent" && outcome !== "failed") return raise(`Invalid outcome: ${outcome}`);
    const review = this.tables.review_items.find((row) => row.id === reviewItemId);
    if (!review) return raise(`Review item ${reviewItemId} not found`);
    if (review.status !== "open") return raise(`Review item ${reviewItemId} is already ${review.status}`);
    if (review.type !== "delivery_unknown") return raise(`Review item ${reviewItemId} has wrong type: ${review.type}`);
    const referenced = (review.raw_data as { reminder_log_id?: unknown } | null)?.reminder_log_id;
    if (referenced == null || String(referenced) !== logId) {
      // RAISE renders a NULL argument as <NULL>.
      return raise(`Log ID mismatch: review item references ${referenced == null ? "<NULL>" : String(referenced)}, got ${logId}`);
    }

    const now = new Date().toISOString();
    try {
      // updateRows checks every constraint before committing, so a refused log
      // update leaves both tables untouched, as the rolled-back transaction would.
      const flipped = this.updateRows("reminder_logs", (r) => r.id === logId && r.status === "unknown", {
        status: outcome,
        sent_at: outcome === "sent" ? now : null
      });
      if (flipped.length === 0) return raise(`Log ${logId} not found or not in unknown status`);
    } catch (err) {
      if (err instanceof PgError) return err.pg;
      throw err;
    }
    this.updateRows("review_items", (r) => r.id === reviewItemId, { status: "resolved", updated_at: now });
    return null;
  }

  // -------------------------------------------------------------------------
  // Scenario API: configuration
  // -------------------------------------------------------------------------

  /** The live settings row (the one readStore and getSettings both see). */
  settings(): ReminderSettings {
    return clone(this.tables.reminder_settings[0]);
  }

  /** Change the settings row. Only the given fields change; updated_at = now. */
  configure(options: ConfigureOptions): this {
    const patch: Row = { updated_at: new Date().toISOString() };
    if (options.steps !== undefined) patch.sms_steps = clone(options.steps.map((step) => ({ ...step })));
    if (options.maxPerDay !== undefined) patch.max_per_day = options.maxPerDay;
    if (options.dryRun !== undefined) patch.dry_run_mode = options.dryRun;
    if (options.isActive !== undefined) patch.is_active = options.isActive;
    if (options.allowSameNumberOverride !== undefined) patch.allow_same_number_override = options.allowSameNumberOverride;
    if (options.clinicName !== undefined) patch.clinic_name = options.clinicName;
    if (options.bookingLink !== undefined) patch.booking_link = options.bookingLink;
    const first = this.tables.reminder_settings[0];
    if (!first) throw new Error("configure: no reminder_settings row");
    this.updateRows("reminder_settings", (r) => r === (first as unknown as Row), patch);
    return this;
  }

  /** Id of the step with trigger `day` in the CURRENT settings. */
  stepId(day: number): string {
    return stepId(day, this.settings().sms_steps ?? []);
  }

  // -------------------------------------------------------------------------
  // Scenario API: patients and bookings
  // -------------------------------------------------------------------------

  private resolveWhen(when: SimWhen): string {
    if ("at" in when) {
      const ms = Date.parse(when.at);
      if (Number.isNaN(ms)) throw new Error(`invalid instant ${when.at}`);
      return new Date(ms).toISOString();
    }
    return atSimDay(when.day, when.hourUtc ?? 0, when.minute ?? 0);
  }

  private requirePatient(patientId: string): Patient {
    const patient = this.tables.patients.find((row) => row.id === patientId);
    if (!patient) throw new Error(`no patient ${patientId}`);
    return patient;
  }

  /** The live patient row (copy). */
  patient(patientId: string): Patient {
    return clone(this.requirePatient(patientId));
  }

  /**
   * Create a patient with one visit (booking), then derive last_booking_at the
   * way the chosen arrival path does. Rows are written at the current fake time.
   * Returns the patient id ("patient-0001", ... unless `id` is given).
   *
   * Note the default visit is today at 11:00 UTC; with the clock at 00:00
   * (createClinic's default) that is a future visit, which an import cannot
   * record — advance the clock, pass a past visitDay, or allowFuture.
   */
  addPatient(options: AddPatientOptions = {}): string {
    const via = options.via ?? "import";
    const visitAt = options.visitAt
      ? this.resolveWhen({ at: options.visitAt })
      : atSimDay(options.visitDay ?? currentSimDay(), options.visitHourUtc ?? 11);
    if (via === "import" && Date.parse(visitAt) > Date.now() && !options.allowFuture) {
      throw new Error(
        `addPatient: visit ${visitAt} is after the current fake time ${new Date().toISOString()}. ` +
          "A CSV import only records past visits: advance the clock first, pick an earlier visit, " +
          "or pass allowFuture: true for a future booking (last_booking_at then stays null, as in production)."
      );
    }

    const n = (this.counters.get("patient") ?? 0) + 1;
    const fullName = options.name ?? `Patient ${String(n).padStart(4, "0")}`;
    const rawPhone = options.phone === undefined ? `07${String(n).padStart(8, "0")}` : options.phone;

    if (via === "confirmedMatch") {
      const reviewItemId = this.stageNewPatientBooking({
        name: fullName,
        visitAt,
        phone: rawPhone,
        email: options.email,
        treatment: options.treatment
      });
      const confirmedId = this.confirmNewPatient(reviewItemId, { id: options.id });
      // The RPC never sets do_not_contact; this stands for the operator
      // flagging the new patient right away.
      if (options.doNotContact) this.updatePatient(confirmedId, { do_not_contact: true });
      return confirmedId;
    }

    const id = options.id ?? this.nextId("patient");
    if (options.id) this.counters.set("patient", n);
    const [firstName, ...rest] = fullName.split(" ");

    this.insertRows("patients", [
      {
        id,
        full_name: fullName,
        first_name: firstName || null,
        last_name: rest.join(" ") || null,
        phone: rawPhone,
        normalized_phone: normalizePhone(rawPhone),
        email: options.email ?? null,
        do_not_contact: options.doNotContact ?? false,
        source: "bokadirekt_csv"
      }
    ]);

    this.insertBooking(id, visitAt, { treatment: options.treatment });
    this.importRefresh(id);
    return id;
  }

  /**
   * The BokaDirekt webhook for a customer no patient matches
   * (handleBokaDirektWebhook -> stageForReview): ONLY an open
   * pending_booking_match review item carrying the booking payload, at the
   * current fake time. No patient, no booking, no cycle_reset. Returns the
   * review item id, to pass to confirmNewPatient() or cancel with
   * webhookCancel(raw_data.booking.Id).
   *
   * Throws when the phone or email already belongs to a patient: production
   * would auto-match that booking instead (use webhookRebook()).
   */
  stageNewPatientBooking(options: StageBookingOptions = {}): string {
    const visitAt = options.visitAt
      ? this.resolveWhen({ at: options.visitAt })
      : atSimDay(options.visitDay ?? currentSimDay(), options.visitHourUtc ?? 11);
    const k = Number(this.nextId("staged").split("-")[1]);
    const fullName = options.name ?? `Webb Patient ${String(k).padStart(4, "0")}`;
    const [firstName, ...rest] = fullName.split(" ");
    const rawPhone = options.phone === undefined ? `0790${String(k).padStart(6, "0")}` : options.phone;
    const phoneKey = normalizePhone(rawPhone);
    const emailKey = normalizeEmail(options.email ?? null);
    if (!phoneKey && !emailKey) {
      // handleBokaDirektWebhook throws before staging such a payload.
      throw new Error("stageNewPatientBooking: BokaDirekt payload has no customer identity or contact info");
    }
    const matched = this.tables.patients.find(
      (p) => (phoneKey && p.normalized_phone === phoneKey) || (emailKey && normalizeEmail(p.email) === emailKey)
    );
    if (matched) {
      throw new Error(
        `stageNewPatientBooking: ${matched.id} already has this phone/email, so the webhook would auto-match it; use webhookRebook()`
      );
    }

    const eventCreated = new Date().toISOString();
    const booking = {
      Id: this.nextId("ext"),
      BookingStartDate: visitAt,
      ServiceName: options.treatment ?? "Behandling",
      EventCreated: eventCreated,
      Cancelled: false,
      BookedOnline: true,
      Customer: {
        Id: null,
        FirstName: firstName || null,
        LastName: rest.join(" ") || null,
        MobilePhoneNumber: rawPhone,
        PhoneNumber: null,
        EmailAdress: options.email ?? null
      }
    };
    const [row] = this.insertRows("review_items", [
      {
        type: "pending_booking_match",
        severity: "medium",
        title: `New BokaDirekt booking - ${fullName} - no existing patient`,
        description: `Incoming: ${fullName}, ${rawPhone ?? "no phone"}, ${emailKey ?? "no email"}`,
        suggested_action: "Confirm to create a new patient, or match this booking to an existing patient.",
        status: "open",
        raw_data: {
          booking,
          match_patient_id: null,
          match_patient_name: null,
          match_tier: "none",
          match_on: "no existing patient matched BokaDirekt ID, phone, or email",
          conflict_reasons: [],
          identity_lookups: []
        },
        content_hash: `bokadirekt:review:BookingCreated:${booking.Id}:${eventCreated}`
      }
    ]);
    return row.id as string;
  }

  /**
   * The operator confirms a staged booking as a NEW patient
   * (POST /api/review/confirm-booking-match with a null patient ->
   * confirm_booking_match, 018) at the current fake time: the RPC's review item
   * checks, then apply_bokadirekt_booking with a null patient (023) — insert
   * the patient and the booking, refresh_patient_booking_metadata (so a visit
   * already in the past sets last_booking_at, a future one leaves it null),
   * one cycle_reset, cancel pending scheduled SMS — then the item is resolved.
   * Returns the new patient id ("patient-0001", ... unless `id` is given).
   */
  confirmNewPatient(reviewItemId: string, options: { id?: string } = {}): string {
    const item = this.tables.review_items.find((row) => row.id === reviewItemId);
    if (!item) throw new Error(`confirm_booking_match: Review item ${reviewItemId} not found`);
    if (item.status !== "open") throw new Error(`confirm_booking_match: Review item ${reviewItemId} is already ${item.status}`);
    if (item.type !== "pending_booking_match") {
      throw new Error(`confirm_booking_match: Review item ${reviewItemId} has wrong type: ${item.type}`);
    }
    const booking = (item.raw_data as { booking?: StagedBookingPayload }).booking;
    if (!booking) throw new Error("Review item does not contain a valid booking payload");

    const customer = booking.Customer;
    const fullName = [customer.FirstName, customer.LastName].filter(Boolean).join(" ").trim() || "Okand patient";
    const rawPhone = customer.MobilePhoneNumber ?? customer.PhoneNumber;
    const n = (this.counters.get("patient") ?? 0) + 1;
    const id = options.id ?? this.nextId("patient");
    if (options.id) this.counters.set("patient", n);

    this.insertRows("patients", [
      {
        id,
        bokadirekt_customer_id: customer.Id || null,
        full_name: fullName,
        first_name: customer.FirstName || null,
        last_name: customer.LastName || null,
        phone: rawPhone || null,
        normalized_phone: normalizePhone(rawPhone) || null,
        email: normalizeEmail(customer.EmailAdress) || null,
        latest_treatment: booking.ServiceName || null,
        source: "bokadirekt_webhook"
      }
    ]);
    this.applyWebhookBooking(id, booking.BookingStartDate, booking.ServiceName ?? undefined, {
      externalId: booking.Id,
      eventCreatedAt: booking.EventCreated,
      rawData: booking
    });
    this.updateRows("review_items", (r) => r.id === reviewItemId, { status: "resolved", updated_at: new Date().toISOString() });
    return id;
  }

  private insertBooking(
    patientId: string,
    bookingAt: string,
    options: {
      cancelled?: boolean;
      status?: string;
      treatment?: string;
      source?: string;
      externalId?: string;
      eventCreatedAt?: string | null;
      rawData?: Row;
    } = {}
  ): string {
    const patient = this.requirePatient(patientId);
    const webhook = options.source === "bokadirekt_webhook";
    const [row] = this.insertRows("bookings", [
      {
        external_booking_id: options.externalId ?? this.nextId("ext"),
        patient_id: patientId,
        patient_name: patient.full_name,
        phone: patient.phone,
        normalized_phone: patient.normalized_phone,
        email: patient.email,
        booking_at: bookingAt,
        treatment: options.treatment ?? "Behandling",
        status: options.status ?? (options.cancelled ? "Cancelled" : "Booked"),
        cancelled: options.cancelled ?? false,
        source: options.source ?? "bokadirekt_csv",
        raw_data: options.rawData ?? {},
        event_created_at: options.eventCreatedAt !== undefined ? options.eventCreatedAt : webhook ? new Date().toISOString() : null
      }
    ]);
    return row.id as string;
  }

  /** The CSV import's recalculation (bokadirekt.ts): 022's definition plus has_future_booking. */
  private importRefresh(patientId: string): void {
    const now = Date.now();
    const bookings = this.tables.bookings.filter((b) => b.patient_id === patientId);
    const hasFuture = bookings.some((b) => !b.cancelled && b.booking_at !== null && Date.parse(b.booking_at) > now);
    const latest = this.lastAttendedBooking(patientId);
    this.updateRows("patients", (r) => r.id === patientId, {
      last_booking_at: latest?.booking_at ?? null,
      latest_treatment: latest?.treatment ?? null,
      has_future_booking: hasFuture,
      updated_at: new Date(now).toISOString()
    });
  }

  /** patient_last_attended_booking (022): latest non-cancelled booking with booking_at <= now(). */
  private lastAttendedBooking(patientId: string): Booking | undefined {
    const now = Date.now();
    const [latest] = this.tables.bookings
      .map((booking, index) => ({ booking, index }))
      .filter(
        ({ booking }) =>
          booking.patient_id === patientId &&
          booking.cancelled === false &&
          booking.booking_at !== null &&
          Date.parse(booking.booking_at) <= now
      )
      .sort((a, b) => Date.parse(b.booking.booking_at!) - Date.parse(a.booking.booking_at!) || a.index - b.index);
    return latest?.booking;
  }

  /**
   * refresh_patient_booking_metadata (022) for one patient, or every patient
   * when omitted: "some write touched this patient" (import, webhook, cancel).
   * Sets last_booking_at, latest_treatment, updated_at only. NEVER called when
   * time advances on its own; the only time-driven caller is the daily cron's
   * refresh_passed_booking_metadata sweep (027, refreshPassedBookingMetadata).
   */
  refreshBookingMetadata(patientId?: string): void {
    const ids = patientId ? [this.requirePatient(patientId).id] : this.tables.patients.map((p) => p.id);
    const now = new Date().toISOString();
    for (const id of ids) {
      const latest = this.lastAttendedBooking(id);
      this.updateRows("patients", (r) => r.id === id, {
        last_booking_at: latest?.booking_at ?? null,
        latest_treatment: latest?.treatment ?? null,
        updated_at: now
      });
    }
  }

  /**
   * Record another booking for an existing patient via the CSV import path: the
   * booking row, then (unless refresh: false) the import's recalculation of
   * last_booking_at / latest_treatment / has_future_booking. No cycle_reset and
   * no scheduled-SMS cancellation — the import does neither. Returns the booking id.
   */
  addBooking(patientId: string, when: SimWhen, options: AddBookingOptions = {}): string {
    const bookingId = this.insertBooking(patientId, this.resolveWhen(when), options);
    if (options.refresh ?? true) this.importRefresh(patientId);
    return bookingId;
  }

  private applyWebhookBooking(
    patientId: string,
    bookingAt: string,
    treatment?: string,
    staged: { externalId?: string; eventCreatedAt?: string | null; rawData?: Row } = {}
  ): string {
    const now = new Date().toISOString();
    this.updateRows("patients", (r) => r.id === patientId, { updated_at: now });
    const bookingId = this.insertBooking(patientId, bookingAt, { treatment, source: "bokadirekt_webhook", ...staged });
    this.refreshBookingMetadata(patientId);
    this.resetPatientCycle(patientId, bookingId);
    this.cancelPendingScheduledSms(patientId, "Avbruten: patienten bokade en ny tid");
    return bookingId;
  }

  /** cancel_pending_scheduled_sms (022): pending only, never processing. Returns the count. */
  private cancelPendingScheduledSms(patientId: string, reason: string): number {
    const now = new Date().toISOString();
    return this.updateRows("scheduled_sms", (r) => r.patient_id === patientId && r.status === "pending", {
      status: "cancelled",
      completed_at: now,
      error: reason
    }).length;
  }

  /**
   * apply_bokadirekt_booking (023) for an EXISTING patient and a NEW booking:
   * insert the booking (created_at = now), refresh_patient_booking_metadata
   * (past, non-cancelled only — a future appointment does not move
   * last_booking_at), write exactly one cycle_reset log (booking_id = the new
   * booking), cancel the patient's pending scheduled SMS. Returns the booking id.
   */
  webhookRebook(patientId: string, when: SimWhen): string {
    this.requirePatient(patientId);
    return this.applyWebhookBooking(patientId, this.resolveWhen(when));
  }

  /**
   * A BookingCancelled webhook: cancel_bokadirekt_booking (023) by BokaDirekt
   * booking id. When the booking row exists: cancelled = true, status
   * "Cancelled", updated_at = now; DELETES the cycle_reset log(s) written for
   * it; refresh_patient_booking_metadata. Either way it then resolves open
   * pending_booking_match review items for that id, so cancelling a booking
   * that was only staged (never confirmed) closes its review item. Does NOT
   * touch scheduled SMS. Returns whether a booking row was found (the RPC
   * returns void).
   */
  webhookCancel(externalBookingId: string): boolean {
    const booking = this.tables.bookings.find((row) => row.external_booking_id === externalBookingId);
    this.applyCancellation(booking, externalBookingId);
    return booking !== undefined;
  }

  /**
   * webhookCancel() for a booking known by its internal id. Returns false and
   * changes nothing when no booking has that id: without the row there is no
   * BokaDirekt id for the RPC's review-item update to match. Use webhookCancel()
   * for a booking that was only staged.
   */
  cancelBooking(bookingId: string): boolean {
    const booking = this.tables.bookings.find((row) => row.id === bookingId);
    if (!booking) return false;
    this.applyCancellation(booking, booking.external_booking_id);
    return true;
  }

  private applyCancellation(booking: Booking | undefined, externalBookingId: string | null): void {
    const now = new Date().toISOString();
    if (booking) {
      this.updateRows("bookings", (r) => r.id === booking.id, { cancelled: true, status: "Cancelled", updated_at: now });
      this.deleteRows("reminder_logs", (r) => r.booking_id === booking.id && r.is_cycle_reset === true);
      if (booking.patient_id) this.refreshBookingMetadata(booking.patient_id);
    }
    // SQL's `=` never matches NULL, so a row without a BokaDirekt id resolves nothing.
    if (externalBookingId === null) return;
    this.updateRows(
      "review_items",
      (r) =>
        r.type === "pending_booking_match" &&
        r.status === "open" &&
        ((r.raw_data as { booking?: { Id?: unknown } } | null)?.booking?.Id ?? null) === externalBookingId,
      { status: "resolved", updated_at: now }
    );
  }

  // -------------------------------------------------------------------------
  // Scenario API: scheduled SMS
  // -------------------------------------------------------------------------

  /**
   * The operator schedules an SMS: calls the REAL POST handler of
   * app/api/scheduled-sms/route.ts with the body the UI sends (clinic time zone
   * Europe/Stockholm) at the current fake time. The route reads and writes
   * through the mocked repository, so a change to its checks, step choice or
   * stored row shows up in every scenario that schedules. Returns the created
   * row; throws ScheduleSmsRejected with the route's status and Swedish error
   * for any non-2xx answer.
   *
   * stepDay is resolved to a step id here because the route only takes ids; a
   * day missing from the current settings is a scenario bug, not a route
   * answer, so it throws a plain Error.
   */
  async scheduleSms(options: ScheduleSmsOptions): Promise<ScheduledSms> {
    let scheduledFor: string;
    if (options.at !== undefined) scheduledFor = this.resolveWhen({ at: options.at });
    else if (options.day !== undefined) scheduledFor = atSimDay(options.day, options.hourUtc ?? 9, options.minute ?? 0);
    else throw new Error("scheduleSms: give `at` or `day`");

    let stepIdForRoute = options.stepId;
    if (options.stepDay !== undefined) {
      const byDay = (this.settings().sms_steps ?? []).find((step) => step.day === options.stepDay);
      if (!byDay?.id) throw new Error(`scheduleSms: no step with day ${options.stepDay} in the current settings`);
      stepIdForRoute = byDay.id;
    }

    // Relative path: "@" maps to ./src, and the route lives under app/.
    const { POST } = await import("../../../app/api/scheduled-sms/route");
    const response = await POST(
      new Request("http://sim.local/api/scheduled-sms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patientId: options.patientId,
          scheduledFor,
          ...(stepIdForRoute !== undefined ? { stepId: stepIdForRoute } : {}),
          timeZone: "Europe/Stockholm"
        })
      })
    );
    const body = (await response.json()) as ScheduledSms & { error?: string | null };
    if (!response.ok) throw new ScheduleSmsRejected(response.status, body.error ?? `HTTP ${response.status}`);
    return body;
  }

  /** Scheduled SMS rows for a patient (copies, oldest first). */
  scheduledFor(patientId: string): ScheduledSms[] {
    return clone(oldestFirst(this.tables.scheduled_sms.filter((row) => row.patient_id === patientId), "created_at"));
  }

  // -------------------------------------------------------------------------
  // Scenario API: operator actions
  // -------------------------------------------------------------------------

  /**
   * The operator settles a delivery_unknown review item ("it arrived" /
   * "it did not") via POST /api/review/resolve-delivery, i.e. the
   * resolve_delivery_unknown RPC at the current fake time. Returns the updated
   * log. Throws `resolve_delivery_unknown: <raised text>` when the RPC refuses
   * (the route answers 409 with that text); nothing changes then.
   */
  resolveDeliveryUnknown(reviewItemId: string, logId: string, outcome: "sent" | "failed"): ReminderLog {
    const error = this.resolveDeliveryUnknownRpc(reviewItemId, logId, outcome);
    if (error) throw new Error(`resolve_delivery_unknown: ${error.message}`);
    return clone(this.tables.reminder_logs.find((row) => row.id === logId)!);
  }

  // -------------------------------------------------------------------------
  // Scenario API: running the engine
  // -------------------------------------------------------------------------

  /** processDailyReminders() once, at the current fake time. */
  async runDailyCron(): Promise<DailyCronResult> {
    const { processDailyReminders } = await import("@/lib/reminders/process");
    return processDailyReminders();
  }

  /** processScheduledSms() once, at the current fake time. */
  async runScheduledWorker(): Promise<ScheduledWorkerResult> {
    const { processScheduledSms } = await import("@/lib/reminders/process");
    return processScheduledSms();
  }

  /**
   * Run the daily cron on each of the next `n` calendar days.
   *
   * Day semantics: the first day is TODAY if the clock is strictly before
   * today's cron instant (cronHourUtc:cronMinute UTC), otherwise TOMORROW. Each
   * day the clock is set to exactly that day's cron instant and the cron runs
   * there. The clock is left at the last run's instant, so a second runDays()
   * call continues with the following day and never repeats one.
   *
   * Example: createClinic() (day 0, 00:00) then runDays(20) runs days 0..19 at
   * 08:00 UTC.
   */
  async runDays(n: number, options: RunDaysOptions = {}): Promise<SimDayRun[]> {
    const cronHour = options.cronHourUtc ?? CRON_HOUR_UTC;
    const minuteOption = options.cronMinute ?? 0;
    const minuteOn = (simDay: number): number => {
      const minute = typeof minuteOption === "function" ? minuteOption(simDay) : minuteOption;
      // Past 59 the "within the hour" model breaks and consecutive days could
      // overlap, so refuse rather than silently fire in the next hour.
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw new Error(`runDays: cronMinute must be an integer 0-59, got ${minute} for sim day ${simDay}`);
      }
      return minute;
    };
    const cronAt = (simDay: number) => atSimDay(simDay, cronHour, minuteOn(simDay));
    const worker = options.scheduledWorker === true ? "afterCron" : options.scheduledWorker || null;
    let day = currentSimDay();
    if (Date.now() >= Date.parse(cronAt(day))) day += 1;

    const runs: SimDayRun[] = [];
    for (let i = 0; i < n; i++) {
      const at = cronAt(day + i);
      setNow(at);
      let scheduled: ScheduledWorkerResult | undefined;
      if (worker === "beforeCron") scheduled = await this.runScheduledWorker();
      const result = await this.runDailyCron();
      if (worker === "afterCron") scheduled = await this.runScheduledWorker();
      runs.push({ simDay: day + i, at, result, ...(scheduled ? { scheduled } : {}) });
    }
    return runs;
  }

  /**
   * Emulate the pg_cron heartbeat (020): advance in 15-minute ticks aligned to
   * :00/:15/:30/:45 UTC, strictly after now up to and including `until`, and run
   * processScheduledSms() on each tick where trigger_scheduled_sms would fire
   * (a pending row is due, or a processing row is stuck > 30 min). The daily
   * cron does NOT run. Ends with the clock at `until`.
   */
  async runWorkerTicksUntil(until: string): Promise<{ at: string; result: ScheduledWorkerResult }[]> {
    const end = Date.parse(until);
    if (Number.isNaN(end)) throw new Error(`runWorkerTicksUntil: invalid instant ${until}`);
    const tickMs = WORKER_TICK_MINUTES * 60_000;
    const results: { at: string; result: ScheduledWorkerResult }[] = [];
    for (let t = Math.floor(Date.now() / tickMs) * tickMs + tickMs; t <= end; t += tickMs) {
      setNow(new Date(t));
      const due = this.tables.scheduled_sms.some(
        (row) =>
          (row.status === "pending" && Date.parse(row.scheduled_for) <= t) ||
          (row.status === "processing" && row.claimed_at !== null && Date.parse(row.claimed_at) < t - 30 * 60_000)
      );
      if (due) results.push({ at: new Date(t).toISOString(), result: await this.runScheduledWorker() });
    }
    if (end > Date.now()) setNow(new Date(end));
    return results;
  }

  // -------------------------------------------------------------------------
  // Scenario API: observing
  // -------------------------------------------------------------------------

  /** calculatePatientReminderStatus() as the cron would compute it right now. */
  async statusOf(patientId: string): Promise<PatientReminderStatus> {
    const { calculatePatientReminderStatus } = await import("@/lib/reminders/eligibility");
    const store = this.readStore();
    const patient = store.patients.find((row) => row.id === patientId);
    if (!patient) throw new Error(`no patient ${patientId}`);
    return calculatePatientReminderStatus(
      patient, store.reminder_settings[0], store.bookings, store.reminder_logs, store.review_items
    );
  }

  /** Raw reminder_logs rows for a patient (copies, oldest first). */
  logsFor(patientId: string): ReminderLog[] {
    return clone(oldestFirst(this.tables.reminder_logs.filter((row) => row.patient_id === patientId), "created_at"));
  }

  /** Every reminder_log of the patient, oldest first, annotated with sim time and visit distance. */
  timeline(patientId: string): TimelineEntry[] {
    const patient = this.tables.patients.find((row) => row.id === patientId);
    return oldestFirst(
      this.tables.reminder_logs.filter((row) => row.patient_id === patientId),
      "created_at"
    ).map((log) => {
      const booking = log.booking_id ? this.tables.bookings.find((row) => row.id === log.booking_id) : undefined;
      const visitAt = booking?.booking_at ?? patient?.last_booking_at ?? null;
      return {
        logId: log.id,
        at: log.created_at,
        simDay: simDayOf(log.created_at),
        daysSinceVisitDate: visitAt ? calendarDaysBetween(visitAt, log.created_at) : null,
        hoursSinceVisit: visitAt ? (Date.parse(log.created_at) - Date.parse(visitAt)) / HOUR_MS : null,
        visitAt,
        status: log.status,
        stepDay: log.step_day ?? null,
        stepId: log.step_id ?? null,
        sequenceNumber: log.sequence_number ?? null,
        skipReason: log.skip_reason ?? null,
        error: log.error ?? null,
        bookingId: log.booking_id ?? null,
        isCycleReset: log.is_cycle_reset,
        message: log.message
      };
    });
  }

  /** Timeline entries that consumed a step: sent, delivered or dry_run. */
  sendsFor(patientId: string): TimelineEntry[] {
    return this.timeline(patientId).filter((entry) => SENT_STATUSES.includes(entry.status));
  }

  /** The first step-consuming message (sent/delivered/dry_run), or null. */
  firstMessageFor(patientId: string): TimelineEntry | null {
    return this.sendsFor(patientId)[0] ?? null;
  }

  /** sendSms() calls whose recipient was this patient. */
  providerCallsFor(patientId: string): ProviderCall[] {
    return this.sent.filter((call) => call.patientId === patientId);
  }

  /** Readable table of timelines, for assertion messages. Default: every patient. */
  formatTimeline(patientIds?: readonly string[]): string {
    const ids = patientIds ?? this.tables.patients.map((row) => row.id);
    const header = ["patient", "at (UTC)", "day", "d+visit", "status", "step", "detail"];
    const lines: string[][] = [header];
    for (const id of ids) {
      const entries = this.timeline(id);
      if (entries.length === 0) lines.push([id, "-", "-", "-", "(no logs)", "-", ""]);
      for (const entry of entries) {
        lines.push([
          id,
          entry.at.slice(0, 16).replace("T", " "),
          String(entry.simDay),
          entry.daysSinceVisitDate === null ? "-" : String(entry.daysSinceVisitDate),
          entry.status,
          entry.stepDay === null ? "-" : `d${entry.stepDay}`,
          [entry.skipReason, entry.error].filter(Boolean).join(": ")
        ]);
      }
    }
    const widths = header.map((_, col) => Math.max(...lines.map((line) => line[col].length)));
    return lines.map((line) => line.map((cell, col) => cell.padEnd(widths[col])).join(" | ").trimEnd()).join("\n");
  }

  /** @internal Used by providerMock.sendSms. */
  async recordSend(input: SendSmsInput): Promise<SendSmsResult> {
    // Captured before the response runs so a throwing response is still
    // attributed to the moment and patient the engine called for.
    const call = {
      to: input.to,
      message: input.message,
      at: new Date().toISOString(),
      simDay: currentSimDay(),
      patientId: this.tables.patients.find((row) => row.normalized_phone === input.to)?.id ?? null
    };
    let result: SendSmsResult;
    try {
      result = await this.provider.respondToSend(input);
    } catch (err) {
      // A throw stands for "the provider was reached but the call never came
      // back", so it must be visible in providerCallsFor() like any other call.
      const message = err instanceof Error ? err.message : String(err);
      this.sent.push({ ...call, result: { success: false, error: message }, threw: message });
      throw err;
    }
    this.sent.push({ ...call, result: clone(result) });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Active clinic + module mocks
// ---------------------------------------------------------------------------

let active: FakeClinic | null = null;

/**
 * Fresh in-memory database, installed as the target of every mock. Starts the
 * fake clock at `start` (default DEFAULT_START, day 0 00:00 UTC) with one
 * settings row: PRODUCTION_STEPS, max_per_day 25, dry run OFF, active.
 */
export function createClinic(options: { start?: string } = {}): FakeClinic {
  active = new FakeClinic(options.start ?? DEFAULT_START);
  return active;
}

/**
 * The cron result of a run (or a bare result) narrowed to the active shape.
 * Throws when automation was off, so a scenario whose setup accidentally
 * disabled the cron fails loudly instead of reading undefined counters.
 */
export function activeResult(run: SimDayRun | DailyCronResult): ActiveCronResult {
  const result = "simDay" in run ? run.result : run;
  if (result.results === undefined) throw new Error(`cron did not evaluate patients: ${JSON.stringify(result)}`);
  return result;
}

/** The clinic the mocks currently delegate to. */
export function currentClinic(): FakeClinic {
  if (!active) throw new Error("fakeClinic: no active clinic — call createClinic() in beforeEach");
  return active;
}

function unsupportedRepository(name: string) {
  return () => {
    throw new Error(`fakeSupabase: unsupported repository function ${name}`);
  };
}

/** Module mock for "@/lib/data/repository". Every function delegates to currentClinic(). */
export const repositoryMock = {
  addReminderLog: vi.fn(async (log: Omit<ReminderLog, "id" | "created_at">) => currentClinic().addReminderLog(log)),
  addReviewItem: vi.fn(async (item: Omit<ReviewItem, "id" | "created_at" | "updated_at">) =>
    currentClinic().addReviewItem(item)
  ),
  bulkUpsertPatients: vi.fn(async (patients: Patient[]) => currentClinic().bulkUpsertPatients(patients)),
  claimDueScheduledSms: vi.fn(async (limit = 25) => currentClinic().claimDueScheduledSms(limit)),
  completeScheduledSms: vi.fn(
    async (
      id: string,
      outcome: Extract<ScheduledSms["status"], "sent" | "skipped" | "failed" | "unknown" | "dry_run">,
      reminderLogId: string | null,
      error: string | null
    ) => currentClinic().completeScheduledSms(id, outcome, reminderLogId, error)
  ),
  getSettings: vi.fn(async () => currentClinic().getSettings()),
  insertDailySnapshot: vi.fn(async (snapshot: Omit<DailySnapshot, "id" | "snapped_at">) =>
    currentClinic().insertDailySnapshot(snapshot)
  ),
  getActiveScheduledSmsPatientIds: vi.fn(async () => currentClinic().getActiveScheduledSmsPatientIds()),
  linkScheduledSmsReservation: vi.fn(async (id: string, reminderLogId: string) =>
    currentClinic().linkScheduledSmsReservation(id, reminderLogId)
  ),
  nowIso: vi.fn(() => new Date().toISOString()),
  readStore: vi.fn(async () => currentClinic().readStore()),
  updateReminderLog: vi.fn(
    async (
      id: string,
      patch: Partial<Pick<ReminderLog, "status" | "provider_message_id" | "error" | "sent_at">>,
      expectedStatus?: ReminderLog["status"]
    ) => currentClinic().updateReminderLog(id, patch, expectedStatus)
  ),
  // Not used by process.ts, but cheap to mirror and handy for scenarios.
  cancelScheduledSms: vi.fn(async (id: string) => currentClinic().cancelScheduledSms(id)),
  createId: vi.fn((prefix: string) => currentClinic().nextId(prefix)),
  createScheduledSms: vi.fn(
    async (
      input: Omit<ScheduledSms, "id" | "status" | "reminder_log_id" | "error" | "claimed_at" | "completed_at" | "attempt_count" | "created_at">
    ) => currentClinic().createScheduledSms(input)
  ),
  getDailySnapshots: vi.fn(async (limitDays = 90) => currentClinic().getDailySnapshots(limitDays)),
  listScheduledSms: vi.fn(async () => currentClinic().listScheduledSms()),
  readStoreForUi: vi.fn(async () => currentClinic().readStoreForUi()),
  resetPatientCycle: vi.fn(async (patientId: string, bookingId: string | null) =>
    currentClinic().resetPatientCycle(patientId, bookingId)
  ),
  touchBooking: vi.fn((booking: Booking) => ({ ...booking, updated_at: new Date().toISOString() })),
  touchPatient: vi.fn((patient: Patient) => ({ ...patient, updated_at: new Date().toISOString() })),
  updatePatient: vi.fn(async (id: string, patch: Partial<Patient>) => currentClinic().updatePatient(id, patch)),
  updateReviewItem: vi.fn(
    async (id: string, patch: Partial<Pick<ReviewItem, "status" | "description" | "suggested_action" | "raw_data">>) =>
      currentClinic().updateReviewItem(id, patch)
  ),
  updateSettings: vi.fn(async (input: Partial<ReminderSettings>) => currentClinic().updateSettings(input)),
  // Present so an accidental caller fails with a clear message rather than
  // vitest's generic "no export defined on the mock".
  bulkAddReviewItems: unsupportedRepository("bulkAddReviewItems"),
  bulkUpsertBookings: unsupportedRepository("bulkUpsertBookings"),
  getIncomingSms: unsupportedRepository("getIncomingSms"),
  getIncomingSmsForPatient: unsupportedRepository("getIncomingSmsForPatient"),
  insertIncomingSms: unsupportedRepository("insertIncomingSms"),
  markIncomingSmsReplied: unsupportedRepository("markIncomingSmsReplied"),
  readStoreForImport: unsupportedRepository("readStoreForImport"),
  upsertBooking: unsupportedRepository("upsertBooking"),
  upsertPatient: unsupportedRepository("upsertPatient"),
  writeStore: unsupportedRepository("writeStore"),
  updateStore: unsupportedRepository("updateStore")
};

/** Module mock for "@/lib/data/readStoreForUi". No TTL cache: every call reads the live tables. */
export const readStoreForUiMock = {
  readStoreForUi: vi.fn(async () => currentClinic().readStoreForUi())
};

/** Module mock for "@/lib/sms/provider". The real provider (46elks / webhook) is never reachable. */
export const providerMock = {
  sendSms: vi.fn(async (input: SendSmsInput) => currentClinic().recordSend(input)),
  verifyDelivery: vi.fn(async (providerMessageId: string) => currentClinic().provider.respondToVerify(providerMessageId)),
  fetchDeliveryStatus: vi.fn(async (): Promise<VerifyDeliveryResult> => {
    throw new Error("fakeSupabase: unsupported provider function fetchDeliveryStatus");
  })
};

// ---------------------------------------------------------------------------
// Supabase client mock
// ---------------------------------------------------------------------------

type QueryResult = { data: unknown; error: PgErrorShape | null };

// Names test tooling may probe on any object (pretty-format, expect, thenable
// checks). Answering undefined keeps the guard from firing on inspection.
const PROBE_PROPS = new Set([
  "toJSON", "asymmetricMatch", "$$typeof", "nodeType", "tagName", "nodeName", "constructor",
  "@@__IMMUTABLE_ITERABLE__@@", "@@__IMMUTABLE_RECORD__@@", "_isMockFunction", "inspect"
]);

/** Throw "fakeSupabase: unsupported ..." for any member the fake does not implement. */
function guard<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "symbol" || prop in obj) return Reflect.get(obj, prop, receiver);
      if (PROBE_PROPS.has(prop)) return undefined;
      throw new Error(`fakeSupabase: unsupported ${label} member "${prop}"`);
    }
  });
}

function compareValues(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    const isoish = /^\d{4}-\d{2}-\d{2}/;
    if (isoish.test(a) && isoish.test(b)) {
      const ta = Date.parse(a);
      const tb = Date.parse(b);
      if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return null;
}

/**
 * The subset of the PostgREST query builder the engine uses, over the fake
 * tables: select / insert / update, eq / neq / lt / lte / gt / gte / in / is /
 * not(col, "is", null), order, limit, single, maybeSingle, and await.
 * Anything else throws "fakeSupabase: unsupported ...".
 */
class FakeQuery {
  private action: "select" | "insert" | "update" | null = null;
  private payload: Row[] | Row | null = null;
  private returning = false;
  private columns = "*";
  private filters: ((row: Row) => boolean)[] = [];
  private orders: { column: string; ascending: boolean }[] = [];
  private limitCount: number | null = null;
  private cardinality: "many" | "single" | "maybeSingle" = "many";

  constructor(private readonly clinic: FakeClinic, private readonly table: SimTableName) {}

  private unsupported(what: string): never {
    throw new Error(`fakeSupabase: unsupported ${what} on ${this.table}`);
  }

  select(columns = "*", options?: unknown): this {
    if (options !== undefined) this.unsupported("select options");
    if (/[():!]/.test(columns)) this.unsupported(`select("${columns}") (embedding/aliases)`);
    if (this.action === null) this.action = "select";
    else if (this.action === "select" || this.returning) this.unsupported("second select()");
    else this.returning = true;
    this.columns = columns;
    return this;
  }

  insert(values: Row | Row[], options?: unknown): this {
    if (options !== undefined) this.unsupported("insert options");
    if (this.action !== null) this.unsupported("insert() after another action");
    this.action = "insert";
    this.payload = values;
    return this;
  }

  update(patch: Row, options?: unknown): this {
    if (options !== undefined) this.unsupported("update options");
    if (this.action !== null) this.unsupported("update() after another action");
    this.action = "update";
    this.payload = patch;
    return this;
  }

  private addFilter(fn: (row: Row) => boolean): this {
    if (this.action === "insert") this.unsupported("filter on insert");
    this.filters.push(fn);
    return this;
  }

  eq(column: string, value: unknown): this {
    if (value === null) this.unsupported(`eq("${column}", null) — use is()`);
    return this.addFilter((row) => row[column] !== null && row[column] !== undefined && compareValues(row[column], value) === 0);
  }

  neq(column: string, value: unknown): this {
    if (value === null) this.unsupported(`neq("${column}", null) — use not("${column}", "is", null)`);
    return this.addFilter((row) => {
      const c = compareValues(row[column], value);
      return c !== null && c !== 0;
    });
  }

  lt(column: string, value: unknown): this {
    return this.addFilter((row) => (compareValues(row[column], value) ?? 0) < 0 && row[column] != null);
  }

  lte(column: string, value: unknown): this {
    return this.addFilter((row) => row[column] != null && (compareValues(row[column], value) ?? 1) <= 0);
  }

  gt(column: string, value: unknown): this {
    return this.addFilter((row) => (compareValues(row[column], value) ?? 0) > 0);
  }

  gte(column: string, value: unknown): this {
    return this.addFilter((row) => row[column] != null && (compareValues(row[column], value) ?? -1) >= 0);
  }

  in(column: string, values: readonly unknown[]): this {
    return this.addFilter((row) => row[column] != null && values.some((value) => compareValues(row[column], value) === 0));
  }

  is(column: string, value: null | boolean): this {
    return this.addFilter((row) => (value === null ? row[column] == null : row[column] === value));
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator !== "is" || value !== null) this.unsupported(`not("${column}", "${operator}", ...)`);
    return this.addFilter((row) => row[column] != null);
  }

  order(column: string, options?: { ascending?: boolean }): this {
    if (options && Object.keys(options).some((key) => key !== "ascending")) this.unsupported("order options other than ascending");
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  limit(count: number, options?: unknown): this {
    if (options !== undefined) this.unsupported("limit options");
    this.limitCount = count;
    return this;
  }

  single(): this {
    this.cardinality = "single";
    return this;
  }

  maybeSingle(): this {
    this.cardinality = "maybeSingle";
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }

  private project(row: Row): Row {
    const copy = clone(row);
    if (this.columns.trim() === "*") return copy;
    const out: Row = {};
    for (const column of this.columns.split(",").map((c) => c.trim()).filter(Boolean)) {
      if (!(column in copy)) this.unsupported(`unknown column "${column}" in select`);
      out[column] = copy[column];
    }
    return out;
  }

  private sorted(rows: Row[]): Row[] {
    const indexed = rows.map((row, index) => ({ row, index }));
    indexed.sort((a, b) => {
      for (const { column, ascending } of this.orders) {
        const c = compareValues(a.row[column], b.row[column]);
        // Postgres default: NULLS LAST ascending, NULLS FIRST descending.
        const nullA = a.row[column] == null;
        const nullB = b.row[column] == null;
        if (nullA !== nullB) return (nullA ? 1 : -1) * (ascending ? 1 : -1);
        if (c) return ascending ? c : -c;
      }
      // Ties are unordered in Postgres; later insertion first when descending.
      const lastDesc = this.orders.length > 0 && !this.orders[this.orders.length - 1].ascending;
      return lastDesc ? b.index - a.index : a.index - b.index;
    });
    return indexed.map((entry) => entry.row);
  }

  private shape(rows: Row[]): QueryResult {
    if (this.cardinality === "many") return { data: rows, error: null };
    if (rows.length === 1) return { data: rows[0], error: null };
    if (rows.length === 0 && this.cardinality === "maybeSingle") return { data: null, error: null };
    return {
      data: null,
      error: { code: "PGRST116", message: PGRST116_MESSAGE, details: `The result contains ${rows.length} rows`, hint: null }
    };
  }

  private cardinalityAccepts(count: number): boolean {
    if (this.cardinality === "single") return count === 1;
    if (this.cardinality === "maybeSingle") return count <= 1;
    return true;
  }

  private execute(): QueryResult {
    const matches = (row: Row) => this.filters.every((fn) => fn(row));
    switch (this.action) {
      case null:
        return this.unsupported("await without select/insert/update");
      case "select": {
        let rows = this.sorted((this.clinic.tables[this.table] as unknown as Row[]).filter(matches));
        if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
        return this.shape(rows.map((row) => this.project(row)));
      }
      case "insert": {
        if (this.orders.length > 0 || this.limitCount !== null) this.unsupported("order/limit on insert");
        if (this.cardinality !== "many" && !this.returning) this.unsupported("single() without select() on insert");
        const input = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
        if (!this.cardinalityAccepts(input.length)) return this.shape(input);
        try {
          const stored = this.clinic.insertRows(this.table, input);
          return this.returning ? this.shape(stored.map((row) => this.project(row))) : { data: null, error: null };
        } catch (err) {
          if (err instanceof PgError) return { data: null, error: err.pg };
          throw err;
        }
      }
      case "update": {
        if (this.orders.length > 0 || this.limitCount !== null) this.unsupported("order/limit on update");
        if (this.cardinality !== "many" && !this.returning) this.unsupported("single() without select() on update");
        if (this.filters.length === 0) {
          // Supabase ships pg-safeupdate: an unfiltered UPDATE is refused.
          return { data: null, error: { code: "21000", message: "UPDATE requires a WHERE clause", details: null, hint: null } };
        }
        try {
          let count = 0;
          const rows = this.clinic.updateRows(this.table, matches, this.payload as Row, (n) => {
            count = n;
            return this.cardinalityAccepts(n);
          });
          if (!this.cardinalityAccepts(count)) return this.shape(rows);
          return this.returning ? this.shape(rows.map((row) => this.project(row))) : { data: null, error: null };
        } catch (err) {
          if (err instanceof PgError) return { data: null, error: err.pg };
          throw err;
        }
      }
    }
  }
}

/**
 * Module mock for "@/lib/supabase/client" (export it as `supabase`). from()
 * covers the seven sim tables; rpc() covers mark_pending_unknown and
 * resolve_delivery_unknown (013), claim_due_scheduled_sms (016) and
 * refresh_passed_booking_metadata (027). Anything else throws.
 */
export const supabaseMock = guard(
  {
    from: vi.fn((table: string) => {
      if (!(TABLE_NAMES as readonly string[]).includes(table)) {
        throw new Error(`fakeSupabase: unsupported table "${table}"`);
      }
      return guard(new FakeQuery(currentClinic(), table as SimTableName), `query builder (${table})`);
    }),
    rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}): Promise<QueryResult> => {
      const clinic = currentClinic();
      if (fn === "mark_pending_unknown") {
        const ids = args.p_log_ids;
        if (!Array.isArray(ids)) throw new Error("fakeSupabase: mark_pending_unknown needs p_log_ids: string[]");
        return { data: null, error: clinic.markPendingUnknown(ids as string[]) };
      }
      if (fn === "refresh_passed_booking_metadata") {
        return { data: clinic.refreshPassedBookingMetadata(), error: null };
      }
      if (fn === "claim_due_scheduled_sms") {
        const limit = typeof args.p_limit === "number" ? args.p_limit : 25;
        return { data: clinic.claimDueScheduledSms(limit), error: null };
      }
      if (fn === "resolve_delivery_unknown") {
        const { p_review_item_id: reviewId, p_log_id: logId, p_outcome: outcome } = args;
        if (typeof reviewId !== "string" || typeof logId !== "string" || typeof outcome !== "string") {
          throw new Error("fakeSupabase: resolve_delivery_unknown needs p_review_item_id, p_log_id, p_outcome strings");
        }
        return { data: null, error: clinic.resolveDeliveryUnknownRpc(reviewId, logId, outcome) };
      }
      throw new Error(`fakeSupabase: unsupported rpc "${fn}"`);
    })
  },
  "supabase client"
);
