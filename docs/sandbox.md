# Follow-up sandbox

Time-travel tests for the SMS follow-ups: the 5/14/90/180/365-day production config and the
5/10/90/180/365 variant. They drive the real, unchanged `processDailyReminders()` and
`processScheduledSms()`. No engine code was changed. Every test asserts what the engine does
**today**, and each gap it found is labelled as a gap, not fixed.

State on 2026-09-25:

- `npm test`: 227 tests passing plus 12 `it.todo`, across 20 files. The simulator accounts for 58
  of the tests and all 12 todos.
- `npm run sandbox:test`: 8/8 passing against the local stack. On 2026-09-24 it passed at 09:43
  UTC and at 19:58 UTC, which puts one run on each side of the cohort's 11:00 UTC visit time. It
  passed again on 2026-09-25 with the seed guard in place, and twice more after the guard was
  widened and the seed made a single statement.

## Why two layers

The engine reads time from two clocks:

- **JS**, via `Date.now()` and `new Date()`: elapsed days in `eligibility.ts`, `dueAt` in
  `queue.ts`, and `nowIso` for the rows the app writes.
- **Postgres**, via `now()`: the 022 `last_booking_at` refresh, `claim_due_scheduled_sms`, and
  every `created_at` default.

Injecting a clock into the app would mean editing the code under test, and it still could not move
`now()` inside a PostgREST request. So neither layer touches app code. Each one moves time from the
outside instead:

| | Layer 1: in-memory simulator | Layer 2: local Supabase |
|---|---|---|
| Time travel | A fake `Date` (vitest), accurate to the millisecond. The fake tables stamp rows from it, so there is only one clock | Both clocks stay real. `sandbox_advance_days(n)` shifts every stored instant back n days, which is the same as moving both clocks forward |
| Data layer | A stateful fake of the repository, the Supabase client and the SMS provider, built to the migrations' columns, CHECKs and unique indexes | Real migrations 001–026, real PostgREST, real SQL functions |
| Speed | 58 scenarios in about 9 s, including 420-day journeys and 450-patient backlogs | 8 tests in about 12 s, after a first image pull of several GB |
| Runs in | `npm test`, no Docker needed | `npm run sandbox:test`, needs Docker |
| Cannot show | PostgREST `max_rows` (R6), real SQL, uuid and timestamp-format quirks, concurrency | A chosen time of day (it runs at the real wall-clock time), and long journeys at low cost |

## Rules

This repo's CLI cache (`supabase/.temp/project-ref`, which is tracked) links it to the
**production** project. Several CLI commands target that project without any `--linked` flag.

- **Only use the four commands the sandbox relies on:** `start`, `db reset --local`, `status` and
  `stop`. The npm scripts and `setup.ts` use nothing else.
- **Never run these:**
  - `db push`, with or without `--include-seed`. With it, the CLI runs `seed.sql` against
    production (see the next rule).
  - `db reset --linked` and `link`.
  - `config push`. It uploads this `config.toml`'s `[auth]` and `[api]` settings to production and
    overwrites the live ones: `site_url` and the redirect URLs would point at `127.0.0.1`, and the
    signup and confirmation rules would become the local ones. Signup is off in this file so that
    such a push at least cannot open signup, but the other values would still be wrong.
  - Anything with `--linked` or `--db-url`.
  - `migration repair`.
  - `psql -f supabase/seed.sql`, a GUI "run script", or any other client that runs `seed.sql`
    against a remote database.
- **`supabase/seed.sql` is for the sandbox only, and it refuses anywhere else.** Without that,
  running it against production would:
  - unschedule the live `scheduled-sms-worker` pg_cron job,
  - create the `sandbox_*` functions,
  - call `sandbox_reset()`, which truncates every patient, booking and log and rewrites the
    settings (dry run on, `https://sandbox.invalid` booking link).

  **The whole file is one `DO` block,** so a refusal aborts all of it, whatever the client does
  after an error. When the seed was separate statements, plain `psql -f` without `ON_ERROR_STOP`
  printed the refusal, then ran the rest anyway: it unscheduled the cron job, installed the
  functions and exited 0. The block first creates `sandbox_assert_local()` and calls it. If that
  refuses, the block raises `sandbox seed refused: this database holds real data — seed.sql is
  local-only` and rolls back, taking the function with it. Only after the check passes does it
  unschedule the cron job, create the other functions and call `sandbox_reset()`. Do not split
  the file back into separate statements.

  **What counts as real data.** The check is mostly an allow-list. It enumerates every public
  table from the catalog, and it refuses if any one of these holds:
  - a `patients` or `bookings` row whose `source` is not `'sandbox'`,
  - a `reminder_logs` row with a status other than `dry_run`, `skipped` or `cycle_reset`, or
    with a `provider_message_id`, a `sent_at` or no patient. The webhook provider can leave
    `provider_message_id` null on a real send, so the status is checked as well,
  - a `scheduled_sms` row whose status is `sent`, `failed` or `unknown`, or which has no patient,
  - settings with dry run off, or a booking link and clinic name other than the sandbox's
    (`https://sandbox.invalid/boka`, `Sandbox-kliniken`) or migration 009's untouched default.
    A fresh database still has the 009 row when the seed checks it,
  - a `daily_snapshots` row taken with dry run off,
  - any row in any other public table. Today that means `incoming_sms`, `review_items` and
    `sms_conversions`, which the sandbox never writes. A table added by a later migration is
    refused too, until someone adds it to the list in `seed.sql`,
  - a phone number outside the fiction range, in any text column whose name contains `phone`,
  - a Vault secret named `app_base_url` or `cron_secret`. Production has both for the 020
    heartbeat, and the local stack has neither. This check is skipped only when Vault is absent
    or unreadable, and it runs last, so skipping it never skips the others.

  A fresh database built by `db reset --local` has none of these, so the check passes there.
  A production database has to fail every one of them to get through, even one with no patients
  left, no provider ids and no Vault secrets. The guard is a backstop for a mistake, not a reason
  to run `db push --include-seed`. Never copy anything from `seed.sql` into
  `supabase/migrations/`.
- **The `sandbox_*` functions check too.** `sandbox_reset()`, `sandbox_advance_days()`,
  `sandbox_apply_settings()` and `sandbox_add_patient()` first call `sandbox_assert_local()`,
  the same function the seed uses, and it raises `sandbox refused: this database holds real
  data`. So even a copy of them on a real database refuses before it truncates anything. Only
  `service_role` (and the owner, `postgres`) can execute them.
  - Everything a test writes must therefore pass the check. Rows carry `source = 'sandbox'`,
    phones come from the fiction range, and dry run stays on. The R4 test relabels the booking
    that the real 023 RPC writes as `bokadirekt_webhook`. The engine never reads
    `bookings.source`.
  - If a failed test leaves such a row behind, or you switch dry run off locally, every later
    `sandbox_reset()` refuses. Run `npm run sandbox:reset` to rebuild the local database.
- **Never read `.env.local`.** It holds the production keys and the 46elks credentials.
  - `src/test/sandbox/setup.ts` takes the URL and key from `supabase status -o env` instead.
  - It refuses to run unless the API host is `127.0.0.1` or `localhost`.
  - It also refuses unless the API port equals the `[api] port` in `supabase/config.toml`
    (54421). Another local stack on this machine (crm-khyte-local on 54321, idwi-kalender on
    55321) is also on loopback, so the host check alone would let the tests reach it.
  - It deletes every public Supabase variable and every SMS-provider variable from the test
    process.
- **The CLI loads the repo-root `.env` files** into its own process. This is inferred from how the
  CLI works and not verified, because `.env.local` must not be opened. A `SUPABASE_<SECTION>_<KEY>`
  variable in those files can override a `config.toml` key. Never add `env(...)` references or a
  `[db.vault]` block to `config.toml`.
- **Fixtures cannot reach real people or links:**
  - Fixture phone numbers come from the range PTS reserves for fiction, 070-1740605 to 070-1740699.
  - Links use `https://sandbox.invalid/…`.
  - `dry_run_mode` is on after every reset.
  - Layer 2 replaces the SMS provider with a mock that throws.
- Running the pinned CLI rewrites the tracked `supabase/.temp/cli-latest`. Do not commit that
  change.

## Layer 1: in-memory simulator

| Path | Contents |
|---|---|
| `src/test/sim/clock.ts` | Fake `Date`, sim-day helpers, `CRON_HOUR_UTC` |
| `src/test/sim/fakeClinic.ts` | The fake clinic, the module mocks, the step fixtures |
| `src/test/sim/smoke.sim.test.ts` | Self-checks of the harness |
| `src/lib/reminders/simulation/thresholds.sim.test.ts` | R2, full journeys, late discovery, inactive steps, the new-patient variant of R4 |
| `src/lib/reminders/simulation/backlog.sim.test.ts` | Queue order, overflow, R3 |
| `src/lib/reminders/simulation/rebooking.sim.test.ts` | R4a/b/c/d, cancelled rebooking, cancellation of a scheduled SMS |
| `src/lib/reminders/simulation/dryRunAndScheduled.sim.test.ts` | R5, scheduled SMS, delivery unknown, provider failure, stale pending, automation off |

```sh
npm test                                                   # everything, simulator included
npx vitest run src/lib/reminders/simulation src/test/sim   # simulator only
```

### Writing a scenario

Name the file `*.sim.test.ts`, because the default config only collects `*.test.ts`, and put it in
`src/lib/reminders/simulation/`. Copy the four `vi.mock` lines exactly. Their factories must import
`@/test/sim/fakeClinic` directly. Test bodies can use the `@/test/sim` barrel.

```ts
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { atSimDay, createClinic, restoreClock, setNow, type FakeClinic } from "@/test/sim";

vi.mock("@/lib/data/repository", async () => (await import("@/test/sim/fakeClinic")).repositoryMock);
vi.mock("@/lib/data/readStoreForUi", async () => (await import("@/test/sim/fakeClinic")).readStoreForUiMock);
vi.mock("@/lib/supabase/client", async () => ({ supabase: (await import("@/test/sim/fakeClinic")).supabaseMock }));
vi.mock("@/lib/sms/provider", async () => (await import("@/test/sim/fakeClinic")).providerMock);

let clinic: FakeClinic;

beforeEach(() => {
  clinic = createClinic(); // empty database, clock at sim day 0 00:00 UTC
});

afterEach(() => {
  restoreClock();
});

it("an 11:00 UTC visit gets the 5-day SMS on day 6, not day 5 (R2)", async () => {
  // An import only records visits that already happened.
  setNow(atSimDay(0, 12));
  const id = clinic.addPatient({ visitDay: 0, visitHourUtc: 11 });

  // Day 0's 08:00 cron has already passed, so this runs days 1..10.
  await clinic.runDays(10);

  expect(clinic.sendsFor(id).map((e) => [e.simDay, e.stepDay]), clinic.formatTimeline()).toEqual([[6, 5]]);
});
```

**Clock** (`clock.ts`). Sim day 0 is the UTC date the clock starts on. The default start,
`DEFAULT_START`, is Monday 2026-03-02 00:00 UTC, with no DST change for weeks on either side. Day N
starts at 00:00 UTC. The clock only moves when a call moves it, and it never moves backwards.

| Call | What it does |
|---|---|
| `createClinic({ start? })` | Creates a new empty database and starts the clock. The one settings row has `PRODUCTION_STEPS`, `max_per_day` 25, dry run **off**, automation active |
| `setNow(iso)`, `advanceHours(n)`, `advanceDays(n)` | Moves the clock forward |
| `atSimDay(day, hourUtc?, minute?)` | Returns an ISO instant. `simDayOf(iso)` and `currentSimDay()` convert the other way |
| `restoreClock()` | Uninstalls the fake clock. Call it in `afterEach` |

**Setup**

| Call | What it does |
|---|---|
| `clinic.configure({ steps, maxPerDay, dryRun, isActive, … })` | Edits the settings row |
| `PRODUCTION_STEPS`, `STEPS_5_10`, `stepId(day, steps?)` | Step fixtures with the migration-009 templates. The 10-day and 14-day steps share an id, as they do after migration 010 |
| `clinic.addPatient({ visitDay, visitHourUtc, visitAt, name, phone, doNotContact, via, allowFuture })` | Creates a patient with one visit. `visitHourUtc` defaults to **11**. With `via: "import"` (the default) a visit later than the fake now is refused unless `allowFuture` is set. `via: "confirmedMatch"` stages the booking through the webhook and has the operator confirm it (018/023) |
| `clinic.addBooking(patientId, { day, hourUtc })` | Adds another booking through the CSV import path, which writes no cycle reset |
| `clinic.webhookRebook(patientId, { day, hourUtc })` | Runs the new-booking branch of 023: inserts the booking, runs the 022 refresh, writes one cycle_reset and cancels pending scheduled SMS |
| `clinic.cancelBooking(bookingId)`, `clinic.webhookCancel(externalId)` | Runs `cancel_bokadirekt_booking` |
| `clinic.stageNewPatientBooking(…)`, then `clinic.confirmNewPatient(reviewItemId)` | A webhook booking from an unknown customer, confirmed by the operator at a later time |
| `clinic.refreshBookingMetadata(id?)` | Stands in for "some other write" that recomputes `last_booking_at`. As in production, nothing runs it just because time passes |
| `await clinic.scheduleSms({ patientId, stepDay, day, hourUtc })` | Goes through the real `POST /api/scheduled-sms` handler. Throws `ScheduleSmsRejected` when the route refuses |
| `clinic.provider.queue({ success: false, uncertain: true, error: "timeout" })` | Scripts the provider's next answers. `setHandler(fn)` sets an answer for every call |
| `clinic.resolveDeliveryUnknown(reviewId, logId, "sent")` | The operator's resolve action (the 013 RPC) |
| `clinic.tables.*`, `clinic.deleteRows(table, fn)` | Direct edits, with **no** constraint checks |

**Run**

| Call | What it does |
|---|---|
| `await clinic.runDays(n, { cronHourUtc, cronMinute, scheduledWorker })` | Runs the daily cron once per day. `cronHourUtc` defaults to 8. It starts today if the clock is before today's cron instant, otherwise tomorrow, and it leaves the clock at the last run. `cronMinute` can be a function of the sim day, because Vercel Hobby fires the cron anywhere within its hour. Returns `{ simDay, at, result, scheduled? }[]` |
| `await clinic.runDailyCron()`, `await clinic.runScheduledWorker()` | One run at the current fake time |
| `await clinic.runWorkerTicksUntil(iso)` | Emulates the 15-minute pg_cron ticks (020). The worker runs only on ticks where something is due |
| `activeResult(run)` | Narrows a cron result to the active shape, and throws if automation was off |

**Observe**

| Call | What it returns |
|---|---|
| `clinic.sendsFor(id)` | The logs that consumed a step (`sent`, `delivered`, `dry_run`), each with `simDay`, `daysSinceVisitDate` (calendar days), `hoursSinceVisit` (elapsed hours), `stepDay`, `stepId`, `bookingId` and `error` |
| `clinic.timeline(id)`, `clinic.logsFor(id)`, `clinic.firstMessageFor(id)` | Every log with annotations, every raw log, and the first send |
| `clinic.providerCallsFor(id)`, `clinic.sent` | What reached the fake provider |
| `await clinic.statusOf(id)` | What `calculatePatientReminderStatus` returns right now |
| `clinic.tables.daily_snapshots` | The cron's cohort counts for each run, which prove it ran even on days it sent nothing |
| `clinic.formatTimeline(ids?)` | A readable table. Pass it as the `expect` message |

**Conventions**

- **Visit hour.** The engine counts whole elapsed days, `floor((now − last_booking_at) / 24 h)`,
  and the cron fires at 08:00 UTC.
  - A visit at **07:00 UTC** makes elapsed days and calendar days agree, so step N lands on day N.
    Use it when timing is not what the scenario is about.
  - A visit at **11:00 UTC**, the `addPatient` default, lands step N on day N + 1 (R2).
  - The boundary is inclusive: a visit at 08:00:00 UTC has exactly 120 h at the day-5 cron and is
    still on time.
- **Time does not pass during a run.** All rows written in one run share one `created_at`. When
  reads sort newest first, ties are broken by the later insertion.
- **Known gaps.** Write a gap as `describe("known gap Rn: …")` containing:
  - a `// Current: … Desired: …` comment,
  - assertions on current behaviour,
  - `it.todo("desired: …")`.

  When a fix lands, these assertions fail on purpose. Flip them, and turn the `todo` into a real
  test.
- **Heavy scenarios need a timeout.** `backlog.sim.test.ts` passes 60 s, because files run in
  parallel and a scenario with hundreds of patients can pass vitest's 5 s default.

**What the fake does not model**

- **No PostgREST `max_rows`.** `readStore()` returns every row, so R6 shows up only in Layer 2.
- **Ids and timestamps.** Ids are deterministic strings (`log-0001`), not uuids. Timestamps end in
  `Z`, where PostgREST writes `+00:00`.
- **Schema checks.** Only the columns the app types use exist. Foreign keys and RLS are not
  enforced, and direct edits to `tables` skip every check.
- **Webhook and import coverage.** The webhook is emulated for new bookings only, not for
  re-deliveries or a booking moved to another patient. The CSV import only recomputes
  `last_booking_at`, `latest_treatment` and `has_future_booking`.
- **No concurrency.** A 23505 happens only when a scenario builds the colliding state itself.
- **Unsupported calls fail loudly.** A query chain or RPC the fake does not implement throws
  `fakeSupabase: unsupported …` instead of passing silently.

## Layer 2: local Supabase in Docker

### Prerequisites

- **Docker Desktop running**, with about 10 GB free on the drive that holds Docker's disk image,
  for the first pull. On 2026-09-24 the first `sandbox:start` filled C: partway through the pull.
  Docker's image store went read-only and the engine stopped until space was freed.
- **Ports 54420–54429 free.** Every port is the CLI default + 100, because crm-khyte-local already
  holds 54321. idwi-kalender uses 55321.
- **No global CLI install needed.** The scripts run `npx --yes supabase@2.117.0`, which is pinned
  in both `package.json` and `setup.ts`. The CLI version decides which image tags get pulled, so
  bump both pins together.

### Commands

```sh
npm run sandbox:start   # pull images (first time only), apply migrations 001-026, run seed.sql
npm run sandbox:test    # src/test/sandbox/*.sandbox.ts; each test begins with sandbox_reset()
npm run sandbox:reset   # rebuild the database from migrations + seed; needed after editing either
npm run sandbox:stop    # stop the containers and keep the data volume
```

`sandbox:reset` keeps the running auth container, so an `[auth]` edit in `config.toml` (such as
the signup switch) takes effect only after `sandbox:stop` and then `sandbox:start`.

`npm test` never runs these tests, because it only collects `*.test.ts`. `sandbox:test` refuses to
run in these cases:

- **The stack is down.** It fails fast with "Local Supabase is not running".
- **The API is not this repo's stack.** The host must be loopback and the port 54421 (see Rules).
- **The database holds non-sandbox data.** `sandbox_reset()` raises "sandbox refused"; run
  `npm run sandbox:reset`.
- **The clocks disagree.** The database clock is more than 5 s off the host clock. WSL2 VMs drift
  after the host sleeps. Restart Docker Desktop, or run `wsl --shutdown`, to resync.

The test files run one at a time because they share one database.

### Seed functions and cohort

| Function | What it does |
|---|---|
| `sandbox_reset()` | Truncates every public table except `reminder_settings`, restores the settings (steps 5/14/90/180/365 with fixed ids `5a4db0c5-0000-4000-8000-000000000{005,014,090,180,365}`, dry run on, `max_per_day` 25), then inserts the cohort |
| `sandbox_add_patient(key, phone_index, visit_at, label)` | Adds one patient with one attended visit. `last_booking_at` comes from the production `refresh_patient_booking_metadata()` |
| `sandbox_advance_days(n)` | Time travel (see below) |
| `sandbox_now()` | Returns Postgres `now()`, for the clock-skew check |
| `sandbox_apply_settings()` | Resets the settings row. `sandbox_reset()` calls it |
| `sandbox_assert_local()` | Raises if the database holds real data (see Rules). Every function above except `sandbox_now()` calls it first |

The cohort is one patient per age, in days since the last visit: 0, 3, 4, 5, 6, 9, 10, 13, 14, 15,
16, 60, 89, 90, 91, 179, 180, 200, 364, 365, 400.

- **Visit time.** Each visit is at **11:00 UTC**, after the 08:00 UTC cron.
- **Ids.** The patient is `00000000-5a4d-4000-8000-<age zero-padded to 12 digits>`, so Dag 5 is
  `…-000000000005`. The booking is `00000000-b00c-4000-8000-<same>`.
- **Phone numbers.** A patient's number is the fiction-range number at its age's position in the
  list. The test file keeps the same list in the same order.
- **Age 0.** Before 11:00 UTC, age 0's visit has not happened yet, so it has no `last_booking_at`.

### Time travel

```sql
select public.sandbox_advance_days(9);   -- psql; or supabase.rpc("sandbox_advance_days", { p_days: 9 })
```

Moving both clocks forward N days is the same as moving every stored instant back N days, and the
second needs no clock mocking in two runtimes. The function subtracts N days from every
`timestamptz`, `timestamp` and `date` column of every public base table. It finds the columns in
the catalog, so a column added by a later migration is shifted too. It runs for the service role
only: execute is revoked from anon and authenticated.

What it deliberately does **not** do:

- **It does not refresh `last_booking_at`.** Production recomputes that column only on writes
  (webhook RPCs, imports), never because time passed. A refresh here would hide R4.
- **It does not shift JSON payloads** (`raw_data`). No engine path reads time from them.

The tests derive every expectation from the stored timestamps and the elapsed hours at run time,
not from today's date. They also wait out the 60 s before 11:00 UTC, so an assertion and the
engine never fall on opposite sides of the cohort's visit time.

### What the tests cover

| Test | What it shows |
|---|---|
| Daily cron, cohort | Each due patient gets its highest crossed step as a dry run, oldest due first. Nobody under 5 elapsed days gets a log row. Logs point at the cohort visit, and the Swedish template renders as-is |
| **R2** | Two patients placed 117 h and 333 h back, which is an 11:00 visit as seen by the 08:00 cron on calendar days 5 and 14. The first gets nothing. The second gets **step 5**, not 14 |
| Time travel, +9 days | The patients who got the 5-day step now get the 14-day step. No step is consumed twice and nothing is skipped |
| **R4** | The real 023 path (`apply_bokadirekt_booking_auto_matched`) rebooks three cohort patients 2 days ahead, then 3 days pass. `last_booking_at` never moves, and the new cycle is anchored on the old visit (numbers below) |
| Scheduled SMS | `claim_due_scheduled_sms` claims by Postgres `now()` only once time travel has made the row due. The daily cron skips a patient that has a pending row. The row completes as `dry_run`, linked to its log |
| **R6** bookings | With 1121 bookings, `readStore()` sees only the 1000 newest by `created_at` |
| **R6** patients | With 1121 patients, the **oldest** patients drop out of `readStore()` |
| **R6** reminder_logs | With 1100 newer log rows, consumed steps drop out of view and collide as "Redan reserverad" |

The claim that each "Redan reserverad" collision takes one of the 25 daily slots comes from the
code: `process.ts` caps the batch before the insert. The cohort never fills 25 slots, so Layer 2
never shows a patient displaced. Layer 1's R4c does.

### Looking at the data

- **Studio** is off in `config.toml`, because its image is the largest one the stack pulls. To
  use it, set `[studio] enabled = true`, run `npm run sandbox:stop && npm run sandbox:start`, and
  open <http://127.0.0.1:54423>.
- **Without Studio**, run `docker exec -it supabase_db_sms-followup psql -U postgres` (prefix it
  with `winpty` in Git Bash). You can also use any Postgres client on
  `postgresql://postgres:postgres@127.0.0.1:54422/postgres`, which uses the local-only default
  credentials. `npx supabase@2.117.0 status` prints the same URL. For example:

  ```sql
  select p.last_name, p.last_booking_at, l.created_at, l.status, l.step_day, l.error
  from reminder_logs l join patients p on p.id = l.patient_id
  order by l.created_at;
  ```

### Pointing the app at the sandbox

This is optional, and only safe from a **separate worktree** with its own `.env.local`.

**Why a separate worktree.** Next.js loads `.env.local` from the project root, and this checkout's
file holds the production keys. The `next dev` and `next start -p 3002` servers already running
from this checkout talk to production.

1. `git worktree add --detach ../sms-followup-sandbox HEAD`, then run `npm install` there. Use
   `--detach` because a branch cannot be checked out in two worktrees.
2. In the new worktree, write a new `.env.local` from scratch. Never copy the production file and
   edit it. Take the values from `npx supabase@2.117.0 status -o env`, run in this checkout, and
   check that `API_URL` is `http://127.0.0.1:54421`. The file needs only these lines:

   ```sh
   SUPABASE_URL=http://127.0.0.1:54421
   SUPABASE_SECRET_KEY=<SECRET_KEY>
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54421
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<PUBLISHABLE_KEY>
   CRON_SECRET=<any local string>
   ```

   Set no `SMS_*` or `FORTYSIX_*` variable. Without them `sendSms` fails closed with
   "SMS_PROVIDER_WEBHOOK_URL is not configured", and the seed keeps dry run on anyway. If you
   switch dry run off in the app, the sandbox functions refuse until `npm run sandbox:reset`.
3. Start from a clean shell, because shell variables override `.env` files. Then run
   `npx next dev -p 3100`.
4. The middleware requires a Supabase Auth user. Create one on the local stack with a `POST` to
   `http://127.0.0.1:54421/auth/v1/admin/users`:
   - use the local `SERVICE_ROLE_KEY` as both the `apikey` header and the `Bearer` token,
   - send the body `{"email":"dev@sandbox.invalid","password":"…","email_confirm":true}`.
5. Trigger the daily run with
   `curl -H "Authorization: Bearer <CRON_SECRET>" http://127.0.0.1:3100/api/cron/daily-reminders`.
   The pg_cron worker is removed locally, so scheduled SMS go out only when you call
   `/api/cron/scheduled-sms` the same way.

## What the simulations showed

| | Suspected | Verdict | Shown in |
|---|---|---|---|
| R2 | "Day 5" means 120 elapsed hours at an 08:00 UTC cron | **Confirmed** | Layers 1 and 2 |
| R3 | A large backlog costs fresh patients the 5-day SMS | **Confirmed.** The ~225 (5/14) and ~125 (5/10) figures hold only when the backlog is already due. They rise to 350 and 250 when the backlog is there from the visit day | Layer 1 |
| R4 | A rebooking for a future date leaves the cycle anchored on the old visit | **Confirmed**, plus a worse variant for new patients. **Fixed by 027** (pending rollout) | Layers 1 and 2 |
| R5 | Dry run consumes the step | **Confirmed** | Layer 1 |
| R6 | `readStore()` is capped at 1000 rows per table | **Confirmed** for bookings, patients and reminder_logs | Layer 2 |

### R2: the 5-day SMS lands on day 6 for most visits

These results use production steps and a cron at exactly 08:00:00 UTC.

| Visit time (UTC) | 5-day SMS | 14-day SMS |
|---|---|---|
| 07:00 | day 5, at 121 h | day 14, at 337 h |
| 08:00:00 | day 5, at exactly 120 h (the boundary is inclusive) | day 14, at exactly 336 h |
| 08:01 | day 6 | day 15 |
| 11:00 | day 6, at 141 h | day 15, at 357 h |

- **With 5/10 steps**, an 11:00 visit gets the 10-day SMS on day 11, and the later ones on days 91,
  181 and 366.
- **The cause is the cron hour.** With the cron at 12:00 UTC, the 11:00 visit is back on days 5
  and 14. Moving the cron moves the cutoff; it does not remove it.
- **Vercel Hobby fires the `0 8 * * *` cron anywhere between 08:00 and 08:59**, so visits between
  08:00 and 08:59 go either way from one day to the next. An 08:30 visit got the 5-day SMS on day 5
  (that day's run was at 08:45) but the 14-day SMS on day 15 (that day's run was at 08:15). Visits
  at 09:00 or later always slip.
- **Nearly every imported visit slips.** An import running on Vercel stores the CSV's wall-clock
  time as UTC, because `parseBookingDate` uses the server's time zone. For imported visits the
  on-time cutoff is therefore 08:00 local time all year. This comes from reading the code: the
  simulator takes stored UTC instants and never goes through `parseBookingDate`.
- **Layer 2 agrees.** A visit placed 117 h back got no log row. One placed 333 h back got step 5,
  not step 14.

### R3: a backlog starves the short follow-ups

The queue serves the oldest due date first, and a patient gets the *highest* crossed step. A fresh
patient therefore waits behind every older overdue patient. If the 14-day threshold passes before a
slot frees up, the patient gets the 14-day SMS and the 5-day one is gone for the cycle.

The boundary is the backlog size at which a fresh patient's first message becomes the 14-day (or
10-day) SMS instead of the 5-day one:

| Backlog arrives | 5/14 boundary | 5/10 boundary |
|---|---|---|
| Already due when the 5-day step comes due | **225** = 25 × 9 | **125** = 25 × 5 |
| Present from the visit day (crons on days 0–4 drain 125 before the patient is due) | **350** = 25 × 14 | **250** = 25 × 10 |

Some concrete cases with production steps, in the already-due setup:

- 224 patients ahead: the patient still gets the 5-day SMS, on day 8.
- 225 ahead: the first message is the 14-day SMS, on day 9.
- 300 ahead: the first message is the 14-day SMS, on day 12.

Two realistic backlogs of never-contacted patients (100–400 days), each with one fresh visit a day:

- **300 patients:** nobody loses a step. Fresh visits on days 0–7 all get the 5-day SMS on day 12,
  5 to 12 days late. The day-0 visit gets the 14-day SMS two days after that, on day 14.
- **450 patients, 30 days of fresh visits:** the crons are full on days 0–19.
  - Visits on days 0–4 **never get the 5-day SMS**. Their first message is the 14-day SMS, on
    day 18.
  - Visits on days 5–13 get it late, on day 18 or 19.
  - Visits from day 14 on get it on time.
  - Nobody misses the 14-day SMS.
  - Backlog patients re-enter the queue when they cross 180 or 365 days, and keep taking 2–3 slots
    a day.

The lost step leaves no trace. A patient carried past the cap gets no log row, and no row records a
skip reason for the 5-day step.

### R4: a rebooking anchors the new cycle on the old visit — fixed by 027 (pending rollout)

**Fix.** Migration 027 adds `refresh_passed_booking_metadata()`, and the daily cron runs it before
reading the store. At the first cron after the appointment, the new visit becomes the anchor and
its cycle is filed against the new `booking_id`. The R4 tests in both layers now assert this: with
an 11:00 UTC visit, the 5-day and 14-day SMS go out 5d21h and 14d21h after the new visit (for
example days 13 and 22 in R4a, days 17 and 26 in R4d). There are no "Redan reserverad" collisions,
no slot is burned, and a patient confirmed from the review queue before the first visit gets
follow-ups. Against the real SQL the sweep moves exactly the patients with a newer passed booking
and never moves anyone backwards.

**Before the fix** (kept for history): 023 writes a cycle_reset and runs the 022 refresh, and that
refresh only counts visits at or before `now()`. Nothing ran it again once the new appointment had
passed, so the new cycle was measured from the old visit and its logs were filed against the old
`booking_id`:

- **R4a, short gap.** Visit on day 0 at 11:00, rebooked on day 2 for day 7 at 11:00.
  - Days 3–7 are blocked as Future booking.
  - The 5-day SMS goes out on day 8, 21 hours after the new visit.
  - The 14-day SMS goes out on day 15, 8 days after the new visit.
  - If the metadata is refreshed after the visit instead, they go out on days 13 and 22.
- **R4b, steps already sent.** The 5-day and 14-day SMS were sent, then the patient was rebooked
  on day 80 for day 85.
  - On days 86–90 the cron writes a skipped row with the error "Redan reserverad av parallell
    förfrågan" (`skip_reason` sequence_complete, step null), 5 rows in all.
  - The 90-day SMS goes out on day 91, 6 days after the new visit.
  - The 180-day SMS goes out on day 181, 96 days after the new visit.
- **R4c, cost to other patients.** Each collision counts as processed and takes a `max_per_day`
  slot. With `max_per_day` 1:
  - A patient seen on day 81 is Ready from day 87 but gets the 5-day SMS on day 92.
  - With 5/10 steps, that patient gets the 10-day SMS on day 92 and never the 5-day one.
- **R4d, rebooked between the 5- and 14-day SMS.** Visit on day 0 at 11:00, 5-day SMS sent on
  day 6, then rebooked by webhook on day 8 at 10:00 for day 11 at 11:00.
  - Days 9–11 are blocked as Future booking. The day-11 cron runs at 08:00, before the visit.
  - On days 12–14 the patient is Ready, and each cron writes a "Redan reserverad" skipped row on
    the old booking (`skip_reason` sequence_complete, step null). The reset emptied the cycle, the
    highest step crossed since the old visit is still 5, and that collides with the day-6 row on
    the 025 index. Each run reports processed 1, sent 0, skipped 1, so each collision takes a
    `max_per_day` slot.
  - The 14-day SMS goes out on day 15, filed on the old booking: 14 d 21 h after the old visit
    but only 4 calendar days (93 h) after the new one. The next SMS is the old visit's 90-day, on
    day 91. `last_booking_at` stays at day 0 11:00, and only the cycle_reset refers to the new
    booking.
  - With 5/10 steps (rebooked on day 7 for day 9), days 8–9 are Future booking, day 10 has one
    step-5 collision, and the 10-day SMS goes out on day 11: 2 calendar days (45 h) after the new
    visit.
  - If the metadata is refreshed on day 12 at 07:00, as a CSV import would do, the 5-day SMS goes
    out on day 17 and the 14-day on day 26, both on the new booking, with no collisions.
- **New-patient variant.** Suppose the operator confirms a new webhook patient from the review
  queue before the first visit. `last_booking_at` stays null, so after the visit the patient drops
  from Future booking to "No valid booking", and received 0 SMS in 20 days. Confirming after the
  visit works normally.
- **Layer 2, through the real SQL.** `last_booking_at` was unchanged after the rebooking.
  - Dag 3 got a dry-run 5-day SMS one day after the new visit, filed on the old booking.
  - Dag 6 collided as "Redan reserverad" on two consecutive days.
  - Dag 364 got the 365-day "long time no see" message one day after the new visit.
- **Not gaps:**
  - Cancelling the rebooking deletes the reset, and the patient continues exactly like a patient
    who was never rebooked.
  - A rebooking cancels the patient's pending scheduled SMS.

### R5: a dry run uses up the step

- **Daily cron.** Dry run was on through day 6, and the 5-day step was logged as `dry_run` on
  day 5. After dry run was switched off:
  - days 7–13 sent nothing,
  - the first real SMS was the 14-day one on day 14, or the 10-day one on day 10 with 5/10 steps.

  The 5-day SMS never goes out for real.
- **Scheduled SMS.** A scheduled SMS that fires while dry run is on consumes its step the same way.
- **Workaround that works today.** Delete the patient's `dry_run` logs *before* switching dry run
  off. The 5-day SMS then goes out on the next cron (day 7), and the 14-day one on day 14.

### R6: `readStore()` sees at most 1000 rows per table

This shows up only in Layer 2. The rows that fall off are always the **oldest** by `created_at`.

- **bookings:** `readStore()` returned 1000 of 1121 rows, and none of the cohort's 21 real visits
  was among them. The cron then filed every dry run with `booking_id` null, which the null-booking
  index guards instead of the booking-scoped one.
- **patients:** `readStore()` returned 1000 of 1121 rows. The whole due cohort was among the
  oldest, and the cron served nobody.
- **reminder_logs:** after 1100 newer rows, the cohort's consumed steps were invisible. The next
  cron picked consumed steps again, and each one collided as "Redan reserverad".
- **In production:** only 1000 of 4,738 bookings are loaded already (session 21), and there were
  984 patients on 2026-09-23. At 1001 patients the oldest ones stop getting follow-ups, without
  any error.

### Migration outcomes (local stack)

The local stack runs Supabase CLI 2.117.0, `postgres:17.6.1.111` and PostgREST v14.5.

- **All 26 migrations, 001–026, applied cleanly**, with no failures. The migrations table lists
  001–026.
- **The indexes match the design.** After 026, `reminder_logs` has the two 025 step indexes
  (`reminder_logs_booking_step_idx`, `reminder_logs_null_booking_step_idx`) and none of the
  position-keyed 013 indexes.
- **020 applied**, so the local image provides the pg_cron, pg_net and vault extensions it
  needs. `seed.sql` then removed its `scheduled-sms-worker` job.
- **The backfill is still untested on real data.** The migrations ran on an empty database.
  025's step-id minting ran on the one settings row that 009 creates. Its `reminder_logs` and
  `scheduled_sms` backfill, and 026's re-run of it, had no rows to convert. The session 20 rollout
  checks in `docs/current_state.md` still apply.

### Other behaviour now pinned by tests

None of these are gaps, but they are worth knowing:

- **Only the highest crossed step is sent, and lower steps are lost for the cycle.** A patient
  found 16 days after the visit gets the 14-day SMS and never the 5-day one. After a 100-day cron
  outage, only the 90-day SMS goes out.
- **One SMS per patient per cron day**, however many thresholds have been crossed.
- **Automation off (`is_active = false`).** The cron writes nothing: no logs and no snapshots.
  Re-enabling it after day 14 sends the 14-day SMS, never the 5-day one. The scheduled worker never
  reads `is_active`, so scheduled SMS still go out.
- **A step scheduled ahead of its turn replaces the steps before it.** With the 14-day step
  scheduled for day 3, the 5-day SMS is never sent, and the next automatic SMS is the 90-day one.
- **A pending scheduled row keeps a Ready patient out of the daily cron** until the worker sends it.
- **A failed send is not retried automatically.** It opens a `failed_sms` review item, and the
  patient is blocked as "Needs review" until someone resolves the item.
- **An uncertain delivery blocks until resolved.** The log is `unknown`, and the patient is
  blocked as "Delivery pending" until someone resolves the item.
