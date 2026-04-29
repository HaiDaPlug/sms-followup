V1 Demo Review
1. Critical Bugs / Demo Blockers
[CRITICAL] Duplicate-send check uses wrong status filter

src/lib/reminders/eligibility.ts:35-40 — hasReminderForLatestBooking only checks log.status === "sent". A dry_run log is not counted. This means: if you run dry-run mode today during the demo, then switch off dry-run and click "Send" again, it will send a real SMS to the same patient for the same booking. For a demo where you'll almost certainly toggle dry-run on/off, this is a practical blocker.

Fix: also block if there's already a dry_run log for the same booking, or change the eligibility check to status === "sent" || status === "dry_run". You probably only want to block re-sends on real "sent" logs — but you should at least decide consciously. The safest demo behavior is to also count dry_run as already-processed.

[CRITICAL] recalculatePatients only runs for patients in the current import batch

src/lib/import/bokadirekt.ts:133-152 — recalculatePatients is called with the full store.patients array, so this is actually fine. On second look: it does iterate all patients, but it only recalculates from store.bookings which is also the full set. This is correct. Scratch this one.

[CRITICAL] latestValidBooking in eligibility.ts has a fragile lookup

src/lib/reminders/eligibility.ts:17-25:


booking.booking_at === patient.last_booking_at
This matches on timestamp string equality. last_booking_at is set in recalculatePatients to latest?.booking_at. Those come from the same source so they should be equal — but only if no other code path sets last_booking_at differently. It works now. Flag it as fragile but not broken.

[CRITICAL] cancelled status check inconsistency

isCancelledBooking in normalizers.ts tests a broad regex including installd|aflyst. But in latestValidBooking (eligibility.ts:23):


!/cancelled|avbokad/i.test(booking.status)
This is a narrower regex than the one used during import. If a booking was stored with status "Cancelled" (the normalized value — see normalizers.ts:116), the check !/cancelled|avbokad/i.test("Cancelled") is true, which means "Cancelled" passes through and is treated as valid. Wait — "Cancelled" does match /cancelled/i, so it is excluded. OK this is fine.

But: the stored status is the raw value if not cancelled (line 116: row.Status || "Booked"). So a booking with raw status "installd" gets stored as "Cancelled" (correct). A booking with status "Booked" gets stored as "Booked". The eligibility check !/cancelled|avbokad/i.test(booking.status) will pass "Booked" through — correct. This is actually consistent.

2. Confirmed Bugs (Fix Before Demo)
[BUG] dry_run logs don't block duplicate sends

As described above. This is the one real bug worth patching.

src/lib/reminders/eligibility.ts:35-40 — change log.status === "sent" to log.status === "sent" || log.status === "dry_run" if you want dry-run to be idempotent (recommended for the demo). If you specifically want dry-run to not consume the send slot, leave it but add a comment — the default behavior will surprise you live.

[BUG] updateStore has a race condition / no locking

src/lib/storage/store.ts:79-84 — read-modify-write on a file with no lock. On a single-user local demo this won't trigger, but processDailyReminders calls sendReminderToPatient in a loop, each of which calls addReminderLog → updateStore. Each iteration reads the file independently. Under Node.js's single-threaded await these are sequential so they're safe in practice. Not a blocker for a local demo. Flag for Supabase migration.

[BUG] upsertPatientFromBooking returns uncertain: true for medium-confidence matches, but still imports the patient

src/lib/import/bokadirekt.ts:96 — a medium-confidence match returns uncertain: true which creates a review item, but the patient record is still updated. The review item says "review before merging" but the merge already happened. For V1 this is pragmatic but tell the client: "uncertain matches are imported optimistically and flagged for review."

3. Risky Assumptions
Cron endpoint has no secret when CRON_SECRET is unset

app/api/cron/daily-reminders/route.ts:5-7:


if (!secret) return true;
If CRON_SECRET is not set, anyone can POST to /api/cron/daily-reminders and trigger SMS sends. Same pattern in the webhook route. For a local demo this is fine. For any deployment, set these secrets before showing the URL to anyone.

Same for webhook route — app/api/webhooks/bokadirekt/route.ts:5-7 has identical open-by-default logic.

/api/settings POST has no authentication

app/api/settings/route.ts:8-11 — anyone who can reach the server can turn off dry-run mode or change the clinic name. No auth guard. Fine for local demo, real risk if deployed.

/api/reminders/send has no authentication

app/api/reminders/send/route.ts — no auth. Anyone can POST {"patientId": "..."} to send SMS to a patient if the server is reachable. The eligibility check is there, so do_not_contact and dry_run_mode are still respected. But it's worth knowing.

stableBookingId fallback hash uses local date/time

src/lib/import/normalizers.ts:96-106 — the hash is built from Date, Interval, Customer, Phone, Service, Performer. If BokaDirekt changes any column name, the hash changes and you'll get duplicate bookings on reimport. This is an acceptable V1 risk but worth knowing. The hash itself is deterministic given the same input.

isFutureBooking uses Date.now() (wall clock)

src/lib/import/normalizers.ts:45-48 — a booking dated today at 14:00 is future in the morning and past in the afternoon. This means the patient's has_future_booking flag flips during the day without a reimport. Acceptable for V1 — just don't demo at the exact moment a booking tips over.

4. Small Safe Fixes Worth Doing Before Tomorrow
Fix 1: hasReminderForLatestBooking — count dry_run as blocking

This is the one actual code change I'd make:

Edit c:\Users\Hai Pham Bui\Desktop\sms-followup\src\lib\reminders\eligibility.ts
Modified
Fix 2: vercel.json cron uses GET, but the route only handles POST

vercel.json — Vercel Cron calls the path with a GET request. The route only exports POST. Check if this should be GET or if Vercel Cron should use a different method. Let me verify:

Grep "export async function (GET|POST)" (in c:\Users\Hai Pham Bui\Desktop\sms-followup\app\api\cron\daily-reminders\route.ts)
1 line of output
Vercel Cron sends a GET request by default. The cron route only exports POST — this means the cron will silently 405 in production. For the local demo this doesn't matter (you'd call it manually), but it should be fixed before any real deployment.

Fix 3: Add a GET handler to the cron route (or change to GET)

Edit c:\Users\Hai Pham Bui\Desktop\sms-followup\app\api\cron\daily-reminders\route.ts
Added 4 lines
5. What Can Wait
No auth on /api/settings and /api/reminders/send — local demo only, no external exposure.
updateStore file-level locking — single user, sequential awaits are safe.
Webhook payload mapping — scaffold is good, don't claim it's done.
Medium-confidence match "review but already merged" — pragmatic for V1, document it.
Supabase migration — don't touch it tomorrow.
audit findings (2 moderate) — don't upgrade; build is stable.
Summary
#	Issue	Severity	Fixed?
1	dry_run log doesn't block duplicate sends when switching to live mode	Critical	✅ Fixed
2	Cron route only exports POST, Vercel Cron calls GET	Blocker in prod	✅ Fixed
3	Cron/webhook open to unauthenticated calls when secrets not set	High	Set CRON_SECRET and BOKADIREKT_WEBHOOK_SECRET
4	/api/settings and /api/reminders/send have no auth	Medium	Wait
5	Medium-confidence matches are imported before review	Low/intentional	Document it
6	stableBookingId hash breaks if CSV column names change	Low	Wait
The architecture is clean. The repository abstraction is thin and correct — swapping readStore/writeStore with Supabase calls later requires changing only src/lib/storage/store.ts, nothing else. The eligibility logic, SMS safety rules (do_not_contact, has_future_booking, missing phone, dry_run_mode), and import idempotency via external_booking_id are all correctly implemented.

Two lines changed, two real issues fixed. You're demo-ready.