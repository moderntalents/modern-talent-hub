# Modern Talent Hub (MTH)

A production Next.js + Supabase application for Modern Talent Hub — a Kenyan CBC e-learning
and co-curricular talent marketplace. Student, Teacher and Admin accounts are backed by real
authentication, a real Postgres database, real file storage, and a real (not simulated)
M-Pesa payment integration with an auditable 70/30 revenue-split wallet ledger.

The original clickable prototype (static `index.html`, in-memory mock data, simulated
payments) is preserved for reference in [`legacy-prototype/`](legacy-prototype/) but is no
longer the live app.

## Tech stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Server Components + Server Actions), TypeScript |
| Styling | Tailwind CSS v4, brand tokens ported 1:1 from the original prototype |
| Auth | Supabase Auth (email + password), role stored on `profiles.role` |
| Database | Supabase Postgres, full schema + Row Level Security in `supabase/migrations/0001_init.sql` |
| File storage | Supabase Storage (private buckets, signed URLs) |
| Payments | Safaricom Daraja API (M-Pesa STK Push), real HTTP calls — no simulated success |
| Hosting | Vercel |
| Mobile | PWA (installable) now; Capacitor scaffold for a native Android build later |

## Local setup

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project's keys
npm run dev
```

You need a Supabase project first — see section 2 below.

## Project structure

```
app/                      Next.js routes (App Router)
  (student|teacher|admin)/ role-gated dashboards, each its own layout + pages
  api/mpesa/                STK push + payment callback webhook
  api/withdrawals/          withdrawal request + admin processing endpoints
  login/, signup/           auth pages
components/                shared UI (brand-styled) + nav shell + file upload
lib/
  supabase/                 browser / server / admin (service-role) Supabase clients
  auth.ts                   session + role-guard helpers
  mpesa.ts                  Daraja API integration (STK push; B2C payout stubbed, documented)
  constants.ts              CBC subjects, marketplace categories, revenue split
supabase/
  migrations/0001_init.sql  full schema, triggers, RLS policies, storage bucket policies
  seed.sql                  CBC subjects seed data
legacy-prototype/           the original static clickable prototype (archived)
capacitor.config.ts         Android packaging config (see section 5)
```

## 1. What changed from prototype to functional application

The prototype was a single 394 KB `index.html` with all markup/CSS/JS inline and an
in-memory JS object standing in for a database — everything reset on page reload and no
interaction actually left the browser tab. Specifically replaced:

- **Authentication** — "Login as Student/Teacher" buttons that just flipped local state →
  real Supabase email/password accounts, secured by `middleware.ts` (redirects unauthenticated
  or wrong-role users) and Postgres Row Level Security (every table denies access by default
  unless a policy in `0001_init.sql` explicitly allows it).
- **CBC subjects & lessons** — hardcoded `SUBJECTS`/`COURSES` JS objects → `subjects` and
  `lessons` database tables, editable by teachers and rendered from real queries.
- **Materials & assignments** — fake filenames with no actual files (`Fractions_Worksheet.pdf`
  as a string) → real file uploads to Supabase Storage (`lesson-materials`,
  `assignment-submissions` buckets) with real signed download URLs, real teacher grading.
- **Marketplace** — a static `TEACHERS` array → an `activities` table teachers create/manage
  themselves (`/teacher/activities`), publicly browsable once published.
- **Payments** — a fake M-Pesa PIN pad that always "succeeded" after a timer → a real STK
  Push request to Safaricom's Daraja API (`lib/mpesa.ts`, `/api/mpesa/stkpush`) and a real
  webhook (`/api/mpesa/callback`) that reconciles the actual payment result. If M-Pesa
  credentials aren't configured, the app returns a clear "not configured" error — it never
  pretends a payment succeeded.
- **Teacher wallet & revenue split** — a JS variable incremented on a fake "PAID" event →
  a Postgres trigger (`handle_transaction_completed`) that atomically applies the 70/30 split
  and credits `teacher_profiles.wallet_balance` only when a transaction is genuinely marked
  `completed` by the M-Pesa callback. The balance can't drift from the transaction ledger
  because the database itself enforces it, not application code.
- **Withdrawals** — an instant fake "Processing → Paid" animation → a real
  `withdrawal_requests` table with full status tracking (`pending` → `processing` →
  `successful`/`failed`, or `reversed` if a successful payout is later clawed back). A
  request never completes on its own; an admin (`/admin/withdrawals`) must attest the money
  was actually sent before marking it `successful`, and the database refuses to accept a
  request larger than the real wallet balance (`trg_check_withdrawal_amount`).
- **Admin console** — static "approve" buttons with no backing data → real teacher-approval
  and withdrawal-processing workflows against the live database.
- **Device-frame/jump-rail shell** — already removed in an earlier pass of this project — the
  app now renders as a normal full-screen, responsive web app with a real top bar/sidebar and
  bottom tab bar (mobile) built in `components/nav/AppShell.tsx`.
- **PWA** — added `public/manifest.json`, real icons generated from the original logo, and a
  service worker (`public/sw.js`) so the app is installable on Android/desktop.

## 2. What still requires external services / API keys

Nothing here is faked — these are genuinely not possible to provision from inside this
environment (account creation and third-party credentials require you):

1. **A Supabase project** (free tier is enough to start). Create one at
   [supabase.com](https://supabase.com), then in the SQL Editor run, in order:
   `supabase/migrations/0001_init.sql` then `supabase/seed.sql`.
   Copy the Project URL, `anon` key and `service_role` key into your environment
   (see `.env.example`) as `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`.
2. **A Safaricom Daraja app** (M-Pesa). Register at
   [developer.safaricom.co.ke](https://developer.safaricom.co.ke) for sandbox
   `MPESA_CONSUMER_KEY`/`MPESA_CONSUMER_SECRET` immediately; a **production** Paybill/Till
   requires Safaricom's business approval process. Set `MPESA_SHORTCODE`, `MPESA_PASSKEY`,
   generate `MPESA_CALLBACK_SECRET` (`openssl rand -hex 32`), and set `MPESA_CALLBACK_URL`
   to your deployed `/api/mpesa/callback/<that secret>` URL — must be public HTTPS, so this
   only works once deployed, not on localhost. The secret matters: Daraja doesn't
   cryptographically sign its callbacks, so without it anyone who learned a transaction's
   `checkoutRequestId` (which is legitimately shown to the paying student) could otherwise
   forge a fake "payment successful" callback — see
   `app/api/mpesa/callback/[secret]/route.ts`.
3. **M-Pesa B2C payouts** (automatic teacher withdrawal disbursement) — intentionally **not
   implemented**. Safaricom's B2C API needs a separate, further business approval
   (initiator credentials + a security certificate) that a fresh developer account doesn't
   have. Until you complete that and wire it into `lib/mpesa.ts` (`initiateB2CPayout`),
   withdrawals are reviewed and paid out manually by an admin from `/admin/withdrawals`,
   who records the real M-Pesa/bank reference after sending the money themselves.
4. A **custom domain / production URL** for `MPESA_CALLBACK_URL` and
   `capacitor.config.ts`'s `server.url` — both need your actual Vercel deployment URL.

## 3. What to push to GitHub

Everything in this repository except what's already git-ignored (`node_modules`, `.next`,
`.env*`, Android build output). Concretely, that means the whole project as it stands —
`app/`, `components/`, `lib/`, `supabase/`, `public/`, config files, and `legacy-prototype/`.
**Never commit a real `.env.local`** — only `.env.example` (with blank/placeholder values)
belongs in git; put real keys in Vercel's Environment Variables UI instead.

## 4. Deploying to Vercel

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. On [vercel.com/new](https://vercel.com/new), import the repository — Vercel auto-detects
   Next.js, no build settings needed.
3. In the Vercel project's **Settings → Environment Variables**, add everything from
   `.env.example` with your real Supabase and (once you have them) Daraja values.
4. Deploy. Once live, set `MPESA_CALLBACK_URL` to
   `https://<your-deployment>.vercel.app/api/mpesa/callback/<MPESA_CALLBACK_SECRET>` and
   redeploy (env var changes need a redeploy to take effect).
5. Every subsequent `git push` to `main` redeploys automatically.

Note: `proxy.ts`, Server Actions and the two `/api/mpesa` and `/api/withdrawals` routes
all require the Node.js runtime features Vercel provides out of the box — no extra
configuration needed beyond the environment variables above.

## 5. Packaging for Android (Google Play)

The app is wrapped with [Capacitor](https://capacitorjs.com) (`@capacitor/core`,
`@capacitor/cli`, `@capacitor/android` are already installed as dev dependencies, and
`capacitor.config.ts` is committed) as a **WebView shell that loads your live Vercel
deployment** — the same approach as many hybrid apps — rather than bundling the site inside
the APK, so the installed app always reflects your latest deploy. Steps this environment
cannot perform for you (no Android SDK/Studio, and Google account creation is something only
you can do):

1. Set `capacitor.config.ts`'s `server.url` (or the `NEXT_PUBLIC_APP_URL` env var it reads)
   to your real production URL, then run:
   ```bash
   npx cap add android
   npx cap sync android
   ```
2. Install [Android Studio](https://developer.android.com/studio), open the generated
   `android/` folder, and let it finish Gradle sync.
3. Generate a signing keystore (`keytool -genkey -v -keystore mth-release.keystore ...`) —
   **keep this file and its password safe**; you'll need the exact same one for every future
   Play Store update.
4. Build a release AAB: in Android Studio, **Build → Generate Signed Bundle / APK → Android
   App Bundle**, selecting your keystore.
5. Create a [Google Play Console](https://play.google.com/console) developer account
   (one-time USD 25 registration fee, identity verification required — this has to be you).
6. In Play Console: create the app listing, fill in the **Data safety** form honestly (this
   app collects account info, and payment/financial data via M-Pesa), set a content rating,
   upload a privacy policy URL (required — write one covering what student/teacher data you
   store and how M-Pesa payment data flows through Safaricom), upload the signed AAB to a
   testing or production track, and submit for review.

None of step 5–6 can be done on your behalf — they require your own Google identity and
payment method by Google's policy.
