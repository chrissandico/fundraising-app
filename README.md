# Markham Waxers — Community Raffle Fundraiser

A single-file web app (`index.html`) for selling raffle tickets online. Supporters pick a ticket
package, choose a player or family to support (which updates the Interac e-Transfer email on
screen), submit their details, and get ticket numbers plus an email receipt. Orders are logged
into per-player tabs in a master Google Sheet via a Google Apps Script backend.

**Status: sample data.** Prizes, the player/family roster, and EMT emails in `index.html` are
placeholders. Swap in the real data before launch (see "Going live" below).

## Repo structure

| Path | What it is |
|---|---|
| `index.html` | The entire frontend — Tailwind via CDN, vanilla JS. Edit `CONFIG`, `PARTICIPANTS`, and `PRIZES` at the top of the `<script>` block. |
| `google-apps-script/Code.gs` | Backend: validates orders, issues sequential ticket numbers (`TK-1000`…), appends rows to per-player sheet tabs, sends email receipts. |
| `.github/workflows/deploy.yml` | CI/CD: on every push to `main`, copies `index.html` to the Oracle Cloud VM's Nginx web root. |
| `docs/apps-script-setup.md` | Step-by-step: deploy the backend as a Google Apps Script Web App. |
| `docs/oci-setup.md` | Step-by-step: create the Always Free Ubuntu VM in the OCI console and wire up deploy secrets. |

## How it works

1. Buyer selects a package (Single $10 / 5 for $40 / 15 for $100 / custom qty at $10 each).
2. Buyer selects a player/family → the page shows that person's Interac e-Transfer email.
3. Buyer enters name, email, phone, accepts the legal terms, and submits.
4. `index.html` POSTs the order JSON to the Apps Script Web App.
5. Apps Script validates the participant against its own roster, recomputes the total server-side
   (a mismatched client total is rejected), issues the next sequential ticket numbers plus a unique
   payment reference code (`MW-EMT-1000`…) under one lock, appends the order to the master
   **All Orders** tab and the player's tab, and emails the buyer a receipt. A retried submission
   returns the original order instead of issuing duplicate tickets (idempotent).
6. Families manually flip `EMT Status (Manual)` to verified once the e-Transfer lands in their bank account.

## Going live — checklist

Full step-by-step runbook: `docs/launch-runbook.md` (sheet + backend, server, auto-deploy, real data, testing).

- [ ] **Backend:** follow `docs/apps-script-setup.md`, paste the `/exec` URL into `CONFIG.APPS_SCRIPT_URL` in `index.html`. After any future edit to `Code.gs`, redeploy as a **New version** (Deploy → Manage deployments) or changes won't go live.
- [ ] **Roster:** replace the sample `PARTICIPANTS` array with real names + Interac e-Transfer emails **in both `index.html` and `Code.gs`** (the server copy is authoritative — keep the names identical). Tab names in the sheet match `name` exactly.
- [ ] **Prizes:** replace the sample `PRIZES` array with real names, descriptions, values, and image URLs.
- [ ] **Rules:** update the consent text with the official raffle rules and draw date.
- [ ] **Server:** follow `docs/oci-setup.md` — create the VM, install Nginx, add the three repo secrets (`OCI_HOST`, `OCI_USER`, `OCI_SSH_KEY`).
- [ ] **Deploy:** push to `main` → GitHub Actions deploys `index.html` to `/var/www/html/`.
- [ ] **Test:** place a test order end-to-end (sheet row + email receipt + ticket numbers), then remove the demo banner at the top of `index.html`.

## Local preview

Just open `index.html` in a browser (internet required for the Tailwind CDN). With no
`APPS_SCRIPT_URL` configured it runs in demo mode — the form validates but won't submit.
