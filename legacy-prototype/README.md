# Modern Talent Hub (MTH) — archived clickable prototype

> **This folder is archived for reference only.** The live, production application is now the
> Next.js + Supabase app at the repository root — see the root [README.md](../README.md).
> This static, front-end-only prototype (in-memory mock data, simulated payments) has been
> superseded and is kept here purely so the original UX/content reference isn't lost.

A mobile-first Kenyan e-learning and talent marketplace app, presented as a clickable phone
prototype with a jump-rail of every screen. Covers three roles — **Student**, **Teacher**, and
**Admin** — including CBC subjects, course/lesson playback and quizzes, a Sports / Martial Arts /
Performing Arts & Music / Creative Tech & Mind Games marketplace, a simulated M-PESA (Paybill)
payment flow with an automatic 70/30 teacher/platform revenue split, teacher wallets and
withdrawals, and an admin console (approvals, users, transaction log, revenue settings).

This is a **static, front-end-only prototype**: a single self-contained `index.html` with all
CSS and JavaScript inline, and an in-memory mock "database" (plain JS objects/arrays) that
resets on page reload. There is no server, no real database, and no live payment gateway —
it's built to demonstrate the complete UX and business logic (including the revenue split,
wallet math, and transaction ledger) so it can be reviewed, demoed, and eventually wired up to
a real backend.

## Project structure

```
modern-talent-hub/
├── index.html       # The entire application (markup + CSS + JS)
├── package.json      # npm metadata + scripts
├── vercel.json        # Vercel deployment config (static, no build step)
├── .gitignore
└── README.md
```

## Running locally

You need [Node.js](https://nodejs.org/) (18+) installed.

```bash
npm install
npm run dev
```

This starts a static file server at **http://localhost:3000**. Open it in your browser — the
app works the same as it does hosted, since everything is client-side.

There is no separate "build" step (`npm run build` is a no-op) — `index.html` is already the
finished, deployable site.

## Putting this project on GitHub

1. **Create a new repository on GitHub.**
   Go to [github.com/new](https://github.com/new), give it a name (e.g. `modern-talent-hub`),
   leave it empty (no README/license/gitignore — you already have those here), and click
   **Create repository**.

2. **Initialize git in this project folder and push it.**
   Open a terminal in this folder and run:

   ```bash
   git init
   git add .
   git commit -m "Initial commit: Modern Talent Hub prototype"
   git branch -M main
   git remote add origin https://github.com/<your-username>/modern-talent-hub.git
   git push -u origin main
   ```

   Replace `<your-username>` with your GitHub username (and the repo name if you chose a
   different one). GitHub will prompt you to sign in (or use a personal access token) the first
   time you push.

3. **Done.** Refresh the repository page on GitHub and you should see all the files listed
   above.

If you'd rather skip the command line, GitHub Desktop (desktop.github.com) can do the same
three steps (Add existing repository → Publish repository) through a UI.

## Deploying to Vercel

**Option A — from the Vercel dashboard (recommended, no CLI needed):**

1. Push the project to GitHub first (see above).
2. Go to [vercel.com/new](https://vercel.com/new) and sign in (you can sign in with your GitHub
   account directly).
3. Click **Import** next to the `modern-talent-hub` repository.
4. Vercel will detect the `vercel.json` and treat it as a static site — no build settings need
   to be changed. Click **Deploy**.
5. After a few seconds you'll get a live URL like `modern-talent-hub.vercel.app`.

Every future `git push` to `main` will automatically redeploy the site.

**Option B — from the command line, without GitHub:**

```bash
npm install -g vercel
vercel login
vercel --prod
```

Run this from inside the project folder. The CLI will ask a few setup questions the first
time (link to a new or existing project) and then deploy directly — you can do this even
before the project is on GitHub, if you just want a quick live link.

## Notes on the "backend"

The payment flow, teacher/admin wallets, withdrawal statuses, refunds, and the 70/30 revenue
split are all fully wired and mathematically consistent in the browser — but they run on
in-memory JavaScript data, not a real database or payment provider. To take this to production
you would need to add a real backend (e.g. a database, the Safaricom Daraja API for M-PESA
STK/Paybill payments and webhooks, and authenticated admin/teacher APIs) that enforces the same
rules this prototype demonstrates.
