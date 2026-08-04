# RLS rollout — apply and verify

Migration `021_enable_rls.sql` enables row level security on all nine
application tables.

**Read this first:** an RLS misconfiguration does **not** raise an error. It
returns zero rows. A broken policy looks like "the analytics page shows 0",
not like a stack trace. Verify by loading pages, not just by running SQL.

## Why it's needed

`NEXT_PUBLIC_SUPABASE_ANON_KEY` is served to every browser — that's by design,
and RLS is what makes it safe. Without RLS, anyone who opens devtools can take
that key plus the project URL and read `patients`, `bookings` and
`reminder_logs` directly from the REST API, bypassing the Next.js middleware.
That's every customer name, phone number and message body.

## Why it's low risk

Every write path and nearly every read path uses the **service role** key,
which bypasses RLS entirely. The only anon-key data reader in the codebase is
`getAnalyticsData`, which is why exactly four read policies exist.

## Apply

```bash
npx supabase db push
```

## Verify — in this order

**1. Analytics still works.** Load `/app/analytics`. Numbers should be
identical to before. **Zeros where there was data means a policy is missing** —
roll back and tell me.

**2. Dashboard, patients, review, SMS history.** These read via service role,
so they should be entirely unaffected. Confirm anyway.

**3. RLS is actually on everywhere:**

```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;
-- rowsecurity must be true for all nine application tables
```

**4. Policies exist and are scoped to `authenticated`:**

```sql
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
order by tablename;
-- expect exactly four SELECT policies, all {authenticated}, never {anon}
```

**5. The anon key is genuinely locked out** — the actual security check.
Run from a terminal, substituting your project URL and anon key:

```bash
curl "https://<project>.supabase.co/rest/v1/patients?select=full_name&limit=1" \
  -H "apikey: <ANON_KEY>"
```

Before this migration that returned patient names. It must now return an empty
array or a permission error. **If it still returns names, stop and investigate** —
that's the vulnerability this migration exists to close.

**6. Scheduled SMS and webhooks still work.** Both run as service role.
`select public.trigger_scheduled_sms();` should behave exactly as before.

## Rollback

Per table, if analytics breaks and you need it working immediately:

```sql
alter table public.patients        disable row level security;
alter table public.bookings        disable row level security;
alter table public.reminder_logs   disable row level security;
alter table public.sms_conversions disable row level security;
```

This reopens the exposure, so treat it as a temporary unblock and re-apply once
the policy gap is fixed.

## After it's confirmed working

**Rotate the anon key.** The current one has been usable without restriction
for the life of the project, so treat it as compromised. Supabase dashboard →
Settings → API → rotate, then update `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Vercel
and `.env.local`.

## If you add a table later

New tables are **not** covered automatically. Enable RLS on them in the same
migration that creates them. Only add a `select ... to authenticated` policy if
an anon-key path genuinely needs to read it — if it's only touched by
service-role code, leave it with no policy at all.
