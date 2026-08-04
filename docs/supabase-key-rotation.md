# Supabase key rotation — legacy JWTs to publishable/secret

Supabase replaced the `anon` / `service_role` JWTs with **publishable**
(`sb_publishable_...`) and **secret** (`sb_secret_...`) keys.

Two reasons to do this now:

1. The old anon key was usable without restriction until RLS landed
   (migration 021), so it should be treated as compromised. Rotation closes the
   back-catalogue that RLS alone does not.
2. The new keys can be revoked individually without invalidating everything
   else, which the legacy JWTs could not.

## Naming

| Role | New variable | Legacy variable (still read as fallback) |
|---|---|---|
| Browser / auth / analytics reads | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Server, bypasses RLS | `SUPABASE_SECRET_KEY` | `SUPABASE_SERVICE_ROLE_KEY` |

`src/lib/supabase/keys.ts` resolves the new name first and falls back to the
legacy one, so **the code change can ship before the values are swapped** and
either environment keeps working during the cutover.

## Cutover order

Do it in this order. Swapping values before the resolver is deployed will break
the app, because the old code only reads the legacy names.

1. **Deploy the rename** (this commit). Nothing changes at runtime — the
   fallback keeps reading your existing legacy values.
2. **Create the new keys** in the Supabase dashboard → Settings → API Keys.
   Do **not** disable the legacy keys yet.
3. **Set the new variables** in Vercel and `.env.local`, keeping the legacy ones
   in place for now:
   ```
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   SUPABASE_SECRET_KEY=sb_secret_...
   ```
4. **Redeploy** — `NEXT_PUBLIC_*` values are inlined at build time, so a
   redeploy is required for the publishable key to take effect. Setting it in
   Vercel without redeploying changes nothing.
5. **Verify** (see below).
6. **Remove the legacy variables** from Vercel and `.env.local`, then redeploy.
7. **Disable the legacy keys** in the Supabase dashboard. Do this last — it is
   the irreversible step, and anything still using them breaks immediately.

## Verify after step 4

**Writes still bypass RLS.** This is the one that matters most: the entire app
assumes the server key bypasses RLS, and every write path depends on it. If the
new secret key is scoped differently than the old `service_role`, writes fail.

- [ ] Load `/app/dashboard` — reads via service role
- [ ] Load `/app/analytics` — the only publishable-key read path; must show real
      numbers, not zeros
- [ ] Import a small CSV, or edit a setting — confirms writes still work
- [ ] Log out and back in — confirms auth on the publishable key
- [ ] Trigger a webhook or `select public.trigger_scheduled_sms();` — confirms
      the service-role path outside the browser

**Confirm the new publishable key is still locked out by RLS:**

```bash
curl "https://<project>.supabase.co/rest/v1/patients?select=full_name&limit=1" \
  -H "apikey: <NEW_PUBLISHABLE_KEY>"
```

Must return `42501 permission denied`. If it returns patient names, the new key
is mapped to a more privileged role than the old anon key was — stop and
investigate before disabling the legacy keys.

## Rollback

Before step 7, rollback is just restoring the legacy variables and redeploying —
the resolver falls back to them automatically. After step 7 the legacy keys are
gone and the only way forward is fixing the new-key configuration.

## Other secrets

Not covered here, but worth rotating on the same pass:

- `CRON_SECRET` — **must also be updated in the Supabase Vault** as
  `cron_secret`, or the `pg_cron` scheduled-SMS job starts failing its bearer
  check silently. See `docs/scheduled-sms-setup.md`.
- `BOKADIREKT_WEBHOOK_SECRET` — must be changed in BokaDirekt at the same time.
- `SMS_DELIVERY_WEBHOOK_SECRET` — changing it takes effect on the next send;
  in-flight delivery receipts for already-sent messages will be rejected.
