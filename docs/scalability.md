# Scalability & Commercialisation Notes

**Written:** 2026-05-03
**Context:** Assessment based on current codebase state after initial hardening and feature pass.

---

## Current Architecture Ceiling

The app is built as a single-tenant deployment — one Supabase project, one set of env vars, one Vercel instance per clinic. That's a conscious V1 decision and it's the right one for proving the concept, but it has a hard commercial ceiling.

Right now, adding a second clinic means:
- Spinning up a new Supabase project manually
- Copying env vars
- Creating a new Vercel deployment
- Configuring branding, templates, and settings from scratch

That's a consulting model, not a product model. You get paid once per clinic instead of recurring.

---

## The Real Unlock: Multi-Tenancy

The white-label idea (upload logo → app auto-themes) is the right instinct, but the deeper unlock is **multi-tenancy** — one deployment where each clinic has isolated data, their own settings, their own SMS sequences, and their own login.

### What that requires technically
- **Auth** — currently there is none. Any route is publicly accessible. This needs to be solved regardless of multi-tenancy, but it's the foundation. Supabase Auth is the obvious fit given the existing stack.
- **Row-level security (RLS)** in Supabase — every table gets a `clinic_id` column, RLS policies ensure each authenticated session only sees its own rows. This is the hardest part but Supabase is built for it.
- **Per-tenant settings** — already mostly there. `reminder_settings` is already per-row. You'd just scope it to a clinic.
- **Onboarding flow** — right now setup is manual. A product needs a self-serve flow: sign up, enter clinic name and BokaDirekt credentials or upload first CSV, done.

### What stays the same
The core logic — eligibility, SMS sequencing, import, review queue — is all clinic-agnostic already. There's no hardcoded clinic data in the business logic. The data model would need `clinic_id` added to each table, but the logic itself doesn't change.

### Estimated lift
Realistic 4–6 weeks of focused work to get from "one hardcoded clinic" to "multi-tenant SaaS with self-serve signup". The codebase is clean enough that this isn't a rewrite — it's additive.

---

## The Market

Sweden has thousands of independent health clinics — osteopaths, physiotherapists, naprapaths, chiropractors, massage therapists, dentists. The vast majority use BokaDirekt as their booking system. Almost none of them do automated patient follow-up.

The SMS rebooking rate in healthcare is naturally high — the patient already has a relationship with the clinic and a reason to come back (ongoing treatment, maintenance, prevention). They often just forget or lose momentum. A well-timed, personal-feeling SMS has a meaningful conversion rate.

### Numbers that make the case for a clinic
A clinic with 800 lapsed patients, 5% conversion from SMS outreach, average session value 1000kr:
- **40 rebooked sessions = 40,000kr in recovered revenue**
- That justifies a SaaS fee of 500–1500kr/month without any hesitation

The clinic doesn't need to understand the tech. They need to understand "we sent 800 SMS last month and 40 patients booked". That's a simple ROI conversation.

---

## Pricing Model

The model writes itself:

| Tier | Price | Included |
|------|-------|----------|
| Bas | ~500 kr/month | Up to 500 patients, 1 SMS sequence |
| Pro | ~1200 kr/month | Unlimited patients, custom sequences, webhook sync |
| SMS cost | Pass-through + margin | Mark up 46elks rate ~20–30% |

SMS cost pass-through means you have a second revenue line that scales with usage. As the clinic grows their patient base, your revenue grows with it without any extra work.

---

## What's Missing Before It's a Product

### Must-haves
1. **Auth** — currently zero authentication. Anyone with the URL can send SMS, change settings, view patient data. This is the most urgent gap even for a single-clinic deployment.
2. **Multi-tenancy** — `clinic_id` on every table, RLS policies, scoped queries.
3. **Self-serve onboarding** — sign up → name the clinic → upload first CSV or connect webhook → done. Right now requires manual setup.

### Nice-to-haves for V2
- **White-label theming** — upload logo, extract palette, auto-apply. The CSS variables are already in place (`--sidebar-bg`, `--accent` etc.) so this is mostly a UI problem, not a backend one.
- **BokaDirekt OAuth or API integration** — instead of CSV upload, pull booking data directly. Eliminates the manual import step entirely.
- **Analytics dashboard** — rebooking conversion rate, revenue recovered estimate, best-performing SMS template. Clinics love this and it reinforces the value proposition every time they log in.
- **Multi-channel** — email as fallback when no phone number exists. Already partially modelled (email is stored per patient).
- **Consent management** — GDPR opt-out handling, SMS stop keywords. Needed before any serious volume.

---

## Competitive Landscape

There are generic SMS marketing tools (Klaviyo, Mailchimp SMS, etc.) but they're not built for healthcare or BokaDirekt. The value here isn't the SMS sending — it's the deep BokaDirekt integration, the eligibility logic (don't send if they already booked, reset when they do, sequence correctly), and the Swedish-market focus. That specificity is the moat.

A generic tool requires the clinic to set up automations themselves. This product just works out of the box for their exact workflow.

---

## Summary

| | Today | With multi-tenancy |
|---|---|---|
| Revenue model | One-off per clinic | Recurring monthly per clinic |
| Adding a new clinic | Manual re-deploy | Self-serve signup |
| Scalability | Linear (your time) | Exponential |
| Maintenance | Per-deployment | Single codebase |

The codebase is in good shape. The business logic is sound. The market is real. The gap between "tool for one clinic" and "product for many clinics" is primarily auth + multi-tenancy + onboarding — not a fundamental rethink.
