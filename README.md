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
| Auth | Supabase Auth — email + password with a 5-digit emailed verification code (custom, see setup step 1; no admin approval needed for signup), Google OAuth. Role stored on `profiles.role` |
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
  auth/callback/            Google OAuth redirect handler (exchanges code for a session)
components/                shared UI (brand-styled) + nav shell + file upload + Google button
lib/
  supabase/                 browser / server / admin (service-role) Supabase clients
  auth.ts                   session + role-guard helpers
  mpesa.ts                  Daraja API integration (STK push; B2C payout stubbed, documented)
  constants.ts              CBC subjects, marketplace categories, revenue split
supabase/
  migrations/0001_init.sql  full schema, triggers, RLS policies, storage bucket policies
  migrations/0002_coach_activation_fee.sql  platform_settings, activation payments ledger
  migrations/0003_payments_toggle.sql       global payments on/off switch
  migrations/0004_lock_down_roles.sql       blocks self-promotion to admin (signup + update)
  migrations/0005_registration_codes.sql    5-digit registration code storage + rate limits
  seed.sql                  CBC subjects seed data
legacy-prototype/           the original static clickable prototype (archived)
capacitor.config.ts         Android packaging config (see section 5)
```

## First-time database setup (required — nothing works without it)

Supabase Auth exists on a fresh project, but **the app's tables and functions do not**. On an
empty project, open the Supabase **SQL Editor** for the *same project whose URL is
`NEXT_PUBLIC_SUPABASE_URL` in Vercel*, paste all of [`supabase/setup-all.sql`](supabase/setup-all.sql)
and run it **once**. (It is `0001`→`0005` + the seed, in order.) Signs of a missing setup: login
loops back to `/login`, registration/password-reset return "database setup is incomplete".

## Password reset ("Forgot your password?")

Separate from the 5-digit registration code. `/login` → **Forgot your password?** →
`/forgot-password` (`POST /api/auth/forgot-password`) emails a one-time link →
`/reset-password?token_hash=…` (`POST /api/auth/reset-password`) sets the new password, signs
the account out everywhere, and points back to `/login`.

- It is always Supabase Auth recovery, and **needs a real sending mailbox — one of these two**:
  1. **Vercel env (recommended; registration needs it too):** set `SMTP_USER` + `SMTP_PASS`
     (Gmail app password). We mint a Supabase recovery token (`auth.admin.generateLink`) and email
     the link with our mailer (`lib/mailer.ts`). **No Supabase dashboard setting is needed.**
  2. **Supabase's own email** (used automatically when those env vars are absent —
     `auth.resetPasswordForEmail`). Requires, in the Supabase dashboard:
     **Authentication → URL Configuration**: Site URL `https://rutechbranding.ink`, and add
     `https://rutechbranding.ink/reset-password` and `https://www.rutechbranding.ink/reset-password` (or the two `/**` forms) to
     Redirect URLs; **Authentication → Emails → SMTP Settings**: enable custom SMTP (Gmail:
     host `smtp.gmail.com`, port `465`, username = the Gmail address, password = a Gmail app
     password, sender = that Gmail address). Supabase's built-in mailer only reaches your own
     team members, so without custom SMTP real users get nothing. The default "Reset Password"
     template works as-is.
- The link is built from `NEXT_PUBLIC_SITE_URL` (default `https://rutechbranding.ink`, see
  `lib/site.ts`), never from the request's origin, and the code refuses a `*.vercel.app` value.
  `/reset-password` accepts both link shapes (`?token_hash=…` from route 1, `#access_token=…`
  from route 2).
- The token is only spent when the new password is submitted (so email link-scanners can't use
  it up), works from any device/browser, and expires per Supabase's **Authentication → Sign In /
  Providers → Email → Email OTP Expiration**.
- The form answers the same whether or not the email is registered (no account discovery),
  and is rate-limited per email (3/hour) and per IP. Requires migration `0005` (`hit_rate_limit`).

## Creating the first admin

Roles can't be set from the app or the browser. Signup only ever creates `student` or
`teacher` accounts, and `profiles.role` can't be updated from a signed-in session
(migration `0004_lock_down_roles.sql`). To make someone an admin, have them sign up
normally, then run this in the Supabase SQL Editor:

```sql
update profiles set role = 'admin'
where id = (select id from auth.users where email = 'you@example.com');
```

To review who is currently an admin:

```sql
select p.id, u.email, p.created_at
from profiles p join auth.users u on u.id = p.id
where p.role = 'admin';
```

## Coach activation fee (admin-configurable)

Coaches (teacher accounts) pay a one-time activation fee via M-Pesa STK Push. The price is
**data, not code**: it lives in the `platform_settings` table (key `coach_activation_fee_kes`)
and is edited at **`/admin/settings`** — no redeploy needed.

- Run `supabase/migrations/0002_coach_activation_fee.sql` **before** deploying this version
  (the teacher dashboard reads the new `teacher_profiles.activated` column).
- No fee is seeded. Until an admin sets one, activation answers "fee not set" and charges
  nothing. There is no hardcoded fallback price.
- Flow: coach opens `/teacher/activate` → `POST /api/mpesa/activation` reads the *current* fee
  from `platform_settings`, snapshots it on a `coach_activation_payments` row, and sends it as
  the Daraja `Amount`. The client never supplies the amount. The shared callback
  (`/api/mpesa/callback/<secret>`) marks the payment `completed`, and a DB trigger sets
  `teacher_profiles.activated`.
- Fee changes apply to the next payment; each change is recorded in
  `platform_settings_history` (who, when, old → new). Values must be whole KSh between 1 and
  250,000 (enforced by a CHECK constraint as well as the form).
- **Payments switch.** `/admin/settings` has a global ON/OFF (`platform_settings.payments_enabled`,
  migration `0003_payments_toggle.sql`, seeded OFF; a missing row also means OFF). While OFF the
  app is free: coaches are activated automatically on first dashboard visit, students can join
  any published activity, prices display as "Free", and both STK Push endpoints return 403
  instead of charging. Turn it ON when you have a Paybill/Till and Daraja credentials.
  Coaches activated during the free period stay activated.
- Coaches who were already approved before this feature are **not** auto-activated (when
  payments are ON); the
  migration contains a commented-out `update` if you want to grandfather them.

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
   `SUPABASE_SERVICE_ROLE_KEY`. (Either Supabase's legacy `anon` key or the newer
   `sb_publishable_…` key works in `NEXT_PUBLIC_SUPABASE_ANON_KEY`.) Then run the remaining
   migrations `0002`–`0005` in order.

   **Registration verification is our own 5-digit email code, not Supabase's** (Supabase's
   email OTP can't be shorter than 6 digits). `app/signup/page.tsx` calls
   `/api/auth/send-code`, which emails a random 5-digit code; `/api/auth/verify-registration`
   checks it and only then creates the (already confirmed) account. The email contains the
   code and no link. Codes are stored only as a keyed hash, expire after 10 minutes, allow 5
   wrong guesses, and can be re-sent once a minute (5 per hour) — all enforced in
   `0005_registration_codes.sql`. To make it work, set these in Vercel (see `.env.example`):
   `SMTP_USER`, `SMTP_PASS` (a Gmail **app password**) and `VERIFICATION_CODE_SECRET`
   (`openssl rand -hex 32`). No Supabase email template or SMTP setting is involved.
   Keep **Authentication → Providers → Email → Confirm email** switched **on**. Gmail SMTP
   allows roughly 500 messages/day — move `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` to a
   transactional provider (Resend, Brevo, SendGrid) when you outgrow it.
2. **Google OAuth, for the "Continue with Google" button on `/login` and `/signup`**
   (`app/auth/callback/route.ts` handles the redirect back). Two things to configure,
   both outside this codebase:
   - In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an
     OAuth 2.0 Client ID (Web application). Add
     `https://<your-project-ref>.supabase.co/auth/v1/callback` as an Authorized redirect URI
     (find the exact URL in Supabase: **Authentication → Providers → Google**).
   - In the Supabase dashboard, **Authentication → Providers → Google**: toggle it **on** and
     paste the Client ID/Secret from the step above.
   - In **Authentication → URL Configuration**, set **Site URL** to the production site
     (`https://www.rutechbranding.ink`), and add to **Redirect URLs** the exact callback path
     (not just the bare origin) for every place you run this app —
     `https://www.rutechbranding.ink/auth/callback` for production,
     `http://localhost:3000/auth/callback` for local dev, and
     `https://<your-vercel-domain>/auth/callback` for each Vercel/custom domain you deploy to
     (a trailing wildcard like `https://www.rutechbranding.ink/**` also works and covers this
     without needing exact-match entries). `app/auth/callback/route.ts` is the code side of
     this — it already builds the redirect from `window.location.origin` at click time
     (`components/auth/GoogleButton.tsx`), so it automatically adapts to whichever domain the
     user is actually on; nothing is hard-coded there. This Redirect URLs list is what
     Supabase checks that URL against, and it has to be configured here — no code change can
     do it for you.
   Until all of this is done, clicking the Google button shows "Google sign-in isn't
   available yet" (the button checks Supabase's public provider list first, instead of
   sending the user to Supabase's raw JSON error page) — email/password sign-up and login
   work independently of this.
3. **A Safaricom Daraja app** (M-Pesa). Register at
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
4. **M-Pesa B2C payouts** (automatic teacher withdrawal disbursement) — intentionally **not
   implemented**. Safaricom's B2C API needs a separate, further business approval
   (initiator credentials + a security certificate) that a fresh developer account doesn't
   have. Until you complete that and wire it into `lib/mpesa.ts` (`initiateB2CPayout`),
   withdrawals are reviewed and paid out manually by an admin from `/admin/withdrawals`,
   who records the real M-Pesa/bank reference after sending the money themselves.
5. A **custom domain / production URL** for `MPESA_CALLBACK_URL` and
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
