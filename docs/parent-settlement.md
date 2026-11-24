# Parent Settlement Emails — How To

**Purpose:** email each sales rep's family one summary of every raffle order
recorded under their player, with the full amount they need to e-Transfer to
the team's collection address.

**Script:** `google-apps-script/ParentSettlement.gs` — a separate file in the
same Apps Script project as the order backend (`Code.gs`). It only *reads*
the sheet and creates/sends Gmail mail; it never changes order data.

## Setup (one time)

1. Open the orders spreadsheet → **Extensions → Apps Script**.
2. If an earlier test settlement script is still in the project, **delete that
   file** — two `onOpen` functions in one project conflict.
3. Click **+** next to *Files* → **Script**, name it `ParentSettlement`,
   delete the stub, and paste the whole of `ParentSettlement.gs`.
4. In the pasted code, confirm `SETTLEMENT_COLLECTION_EMAIL` (top of the
   file) is the real team collection inbox.
5. Save (Ctrl/Cmd+S), reload the spreadsheet. A **Raffle Settlement** menu
   appears next to Help.

## Running it

Always in this order:

1. **Raffle Settlement → 1. Preview settlement (no emails)** — shows who
   would get an email and the totals, and reconciles the order rows read
   (valid + duplicates + test orders). Nothing is created or sent.
2. **→ 2. Create settlement drafts in Gmail** — one draft per family in the
   script owner's Gmail Drafts. Review them.
3. Send the drafts yourself from Gmail, **or** use
   **→ 3. SEND settlement emails now** (asks for confirmation first).

## Rules the script applies

- **Source:** the master **All Orders** tab only. Per-player tabs are not
  used, so a renamed or missing player tab can no longer skip a family.
- **Recipients:** the **Roster** tab email for each participant. Families
  with no email on file (currently Brandon J. and Mike C.) are skipped and
  reported — add the address to the Roster tab and re-run; no redeploy
  needed.
- **Excluded from totals:** orders whose EMT Status contains "duplicate",
  "cancel", "refund", "void" or "invalid" (listed in the email as *not
  counted*), repeat rows with the same reference
  code or client order ID, and test orders (status/name mentions of
  "test", `probe-` client IDs, `@muse.ai` buyer emails).
- **Auditable:** Preview logs every counted and excluded order (reference
  code, buyer, amount, status), so any family total can be verified from
  the execution log alone.
- **Cross-checked:** every run compares All Orders against each player's
  own tab and warns about any reference code that exists in one but not
  the other, and about any order whose EMT Status text differs between
  the two places — the classic causes of "my count differs from the
  email". The settlement always reads **All Orders**, so payment
  statuses must be maintained there, not only in the player tabs.
- **Totals:** the email asks for the **full valid total** under the player —
  orders, tickets and the total only. **No payment statuses appear anywhere
  in the email** (no per-order status, no Paid/outstanding breakdown).
  Step 1 of the email tells the family to reply with the buyer's name +
  reference code instead of covering an unpaid buyer out of pocket.
  (Statuses still appear in the Preview execution log, where they are
  useful for auditing.)
- **Repeat-safe:** every draft/send is written to a **Settlement Log** tab
  with a fingerprint of the exact order set. Re-running never emails a
  family twice for the same orders; if new orders arrive for a family,
  only that family gets a fresh email (delete any stale draft for them
  first if you use the drafts flow).
- **Failures don't stop the run:** a bad address or Gmail error is logged
  as FAILED in the Settlement Log and listed in the end-of-run summary.

## The email each family gets

Subject: `Action Required: Waxers Raffle Settlement — <Player> ($X to transfer)`

Contents: the order table (buyer — with the package listed under the
buyer's name — then ticket numbers, qty, amount, reference code — no
payment status), duplicate orders listed as not counted, the totals block, and three
steps — check the list / reply about unpaid buyers, e-Transfer the full
amount to the collection address with memo `Raffle - <Player>`, and send it
ahead of draw night (Thursday, November 26).

## Troubleshooting

- **Menu missing:** reload the spreadsheet; if two script files define
  `onOpen`, remove the older one.
- **A family was skipped as "already drafted/sent":** that's the repeat
  protection working. If you genuinely need to redo them and their orders
  haven't changed, delete their row(s) in the **Settlement Log** tab and
  re-run.
- **Totals look wrong for one family:** run Preview and read that family's
  COUNTED / NOT COUNTED lines in the execution log — every row behind the
  total is listed with its amount and status. If a CROSS-CHECK WARNING
  names the family, a row exists in All Orders but not in their player
  tab (or the reverse); All Orders is the master record, so reconcile
  from there. Status text drives the duplicate/cancelled/test exclusions
  (statuses are never shown in the family email itself).
