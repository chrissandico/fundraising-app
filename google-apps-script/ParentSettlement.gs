/**
 * ============================================================
 * Markham Waxers U13A Raffle — Parent Settlement Emails
 * ============================================================
 * Sends each sales rep's family ONE summary email listing every
 * raffle order recorded under their player, with the full amount
 * they need to e-Transfer to the team's collection address.
 *
 * HOW THIS DIFFERS FROM A PER-PLAYER-TAB SCRIPT:
 *  - Reads the master "All Orders" tab ONCE (the single source of
 *    truth the order backend writes), instead of opening 17
 *    per-player tabs whose names must match exactly.
 *  - Dedupes by reference code AND client order ID, and excludes
 *    test orders on several signals (status, probe IDs, test
 *    buyer names/emails) — not just a "testing" status. Orders
 *    whose status marks them duplicate / cancelled / refunded /
 *    void / invalid are likewise kept out of the totals.
 *  - Preview mode logs EVERY counted and excluded order (ref,
 *    buyer, amount, status) so a total can be audited from the
 *    log alone, and every run cross-checks All Orders against
 *    each player's own tab, warning about any reference code
 *    that exists in one but not the other — and about any order
 *    whose EMT Status text differs between the two places (the
 *    settlement always reads All Orders).
 *  - Always regenerates (Prof's workflow, 2026-11-24): every run
 *    creates a fresh draft / sends a fresh email for EVERY family
 *    with orders — nothing is ever skipped as "already done".
 *    Prof deletes the drafts in Gmail manually after each run.
 *    Every draft/send is still recorded in a "Settlement Log" tab
 *    with a fingerprint of the exact order set, but the log is a
 *    history/audit record only and never blocks a run. NOTE: this
 *    means SEND emails every family every time it is confirmed —
 *    the confirmation dialog is the only double-send guard.
 *  - Sends a real plain-text body alongside the HTML (an empty
 *    text body renders blank in some mail apps and hurts spam
 *    scoring), and HTML-escapes buyer names so a stray "&" or "<"
 *    in a name can't break the table.
 *  - One family's bad email address can't abort the whole run —
 *    failures are logged and reported at the end.
 *
 * SETUP:
 *  1. In the orders spreadsheet: Extensions → Apps Script.
 *  2. DELETE any earlier test settlement script in the project
 *     (two onOpen functions in one project conflict).
 *  3. Add a NEW file named "ParentSettlement" and paste this in.
 *  4. Confirm SETTLEMENT_COLLECTION_EMAIL below is the real team
 *     collection inbox.
 *  5. Save, reload the spreadsheet, and use the new
 *     "Raffle Settlement" menu: Preview first, then Create
 *     Drafts, review them in Gmail, then either send the drafts
 *     yourself or use Send Emails.
 *
 * Nothing is ever sent by Preview. Drafts are the default path.
 * ============================================================
 */

// The team inbox that collects each family's full settlement.
// CONFIRM this is the real collection address before sending.
var SETTLEMENT_COLLECTION_EMAIL = "waxers2014a@gmail.com";

var SETTLEMENT_TEAM_NAME = "Markham Waxers U13A";
var SETTLEMENT_LOG_SHEET = "Settlement Log";

// All Orders column positions (0-based), matching Code.gs MASTER_HEADERS:
// Timestamp, Buyer Name, Email, Phone, Participant, Package, Qty,
// Amount ($), Ref Code, Ticket Numbers, EMT Status (Manual),
// Client Order ID, Receipt Emailed, Family Emailed
var SETTLEMENT_COL = {
  BUYER: 1, EMAIL: 2, PARTICIPANT: 4, PACKAGE: 5, QTY: 6,
  AMOUNT: 7, REF: 8, TICKETS: 9, STATUS: 10, CLIENT_ID: 11
};

/** Adds the "Raffle Settlement" menu when the spreadsheet opens. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu("Raffle Settlement")
      .addItem("1. Preview settlement (no emails)", "previewParentSettlement")
      .addItem("2. Create settlement drafts in Gmail", "draftParentSettlement")
      .addSeparator()
      .addItem("3. SEND settlement emails now", "sendParentSettlement")
      .addToUi();
  } catch (e) {
    console.warn("Menu unavailable in this context: " + e);
  }
}

function previewParentSettlement() { return runParentSettlement_("PREVIEW"); }
function draftParentSettlement() { return runParentSettlement_("DRAFT"); }
function sendParentSettlement() { return runParentSettlement_("SEND"); }

/**
 * Main entry. mode: "PREVIEW" (log only), "DRAFT" (Gmail drafts),
 * or "SEND" (emails immediately, after an on-screen confirmation).
 */
function runParentSettlement_(mode) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* headless run */ }

  if (mode === "SEND") {
    if (!ui) throw new Error("SEND mode needs the spreadsheet UI for confirmation.");
    var resp = ui.alert(
      "Send settlement emails?",
      "This will EMAIL every family with orders right away (not drafts). Continue?",
      ui.ButtonSet.YES_NO
    );
    if (resp !== ui.Button.YES) { ui.alert("Cancelled — nothing sent."); return; }
  }

  var rosterSheet = ss.getSheetByName("Roster");
  var masterSheet = ss.getSheetByName("All Orders");
  if (!rosterSheet) throw new Error('Tab "Roster" not found.');
  if (!masterSheet) throw new Error('Tab "All Orders" not found.');

  // --- Roster: participant -> family email (order preserved) ---
  var rosterRows = rosterSheet.getDataRange().getValues();
  var rosterOrder = [];
  var familyEmail = {};
  for (var r = 1; r < rosterRows.length; r++) {
    var name = settlementStr_(rosterRows[r][0]);
    if (!name) continue;
    rosterOrder.push(name);
    familyEmail[name] = settlementStr_(rosterRows[r][1]);
  }

  // --- All Orders: group valid orders by participant ---
  var rows = masterSheet.getDataRange().getValues();
  var seenRefs = {}, seenClientIds = {};
  var byParticipant = {};   // name -> {orders:[], duplicates:[]}
  var stats = { rows: 0, test: 0, testAmount: 0, dupAmount: 0, validAmount: 0 };
  var unknownParticipants = {};

  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    var participant = settlementStr_(row[SETTLEMENT_COL.PARTICIPANT]);
    var ref = settlementStr_(row[SETTLEMENT_COL.REF]);
    var amount = parseFloat(row[SETTLEMENT_COL.AMOUNT]) || 0;
    if (!participant || !ref) continue;
    stats.rows++;
    if (!(participant in familyEmail)) unknownParticipants[participant] = true;

    var order = {
      buyer: settlementStr_(row[SETTLEMENT_COL.BUYER]),
      buyerEmail: settlementStr_(row[SETTLEMENT_COL.EMAIL]),
      pkg: settlementStr_(row[SETTLEMENT_COL.PACKAGE]),
      qty: parseInt(row[SETTLEMENT_COL.QTY], 10) || 0,
      amount: amount,
      ref: ref,
      tickets: settlementStr_(row[SETTLEMENT_COL.TICKETS]),
      status: settlementStr_(row[SETTLEMENT_COL.STATUS]),
      clientId: settlementStr_(row[SETTLEMENT_COL.CLIENT_ID])
    };

    if (!byParticipant[participant]) {
      byParticipant[participant] = { orders: [], duplicates: [], test: [], all: {} };
    }
    var group0 = byParticipant[participant];
    if (!group0.all[ref]) group0.all[ref] = order;

    if (settlementIsTestOrder_(order)) {
      stats.test++; stats.testAmount += amount;
      group0.test.push(order);
      continue;
    }
    var isDupStatus = settlementExcludedByStatus_(order.status);
    var isDupKey = seenRefs[ref] || (order.clientId && seenClientIds[order.clientId]);
    seenRefs[ref] = true;
    if (order.clientId) seenClientIds[order.clientId] = true;

    if (isDupStatus || isDupKey) {
      byParticipant[participant].duplicates.push(order);
      stats.dupAmount += amount;
    } else {
      byParticipant[participant].orders.push(order);
      stats.validAmount += amount;
    }
  }

  // --- Settlement Log: history/audit record only. It is written on
  // every run but never read to block one (see header note). ---
  var logSheet = (mode === "PREVIEW") ? ss.getSheetByName(SETTLEMENT_LOG_SHEET)
                                      : settlementGetLogSheet_(ss);

  // --- Per family ---
  var done = [], skipped = [], failed = [];
  var grandTotal = 0;

  rosterOrder.forEach(function (participant) {
    var email = familyEmail[participant];
    var group = byParticipant[participant] || { orders: [], duplicates: [], test: [], all: {} };

    function skip(reason) {
      skipped.push(participant + " — " + reason);
      if (mode !== "PREVIEW") {
        settlementLog_(logSheet, "SKIPPED", participant, email, 0, 0, 0, "", reason);
      }
    }

    if (!email) { skip("no email on file in the Roster tab"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skip("Roster email looks invalid: " + email); return; }
    if (group.orders.length === 0) { skip("no orders to settle"); return; }

    var total = 0, tickets = 0;
    group.orders.forEach(function (o) {
      total += o.amount; tickets += o.qty;
    });
    var fingerprint = settlementFingerprint_(participant, group.orders, total);

    var built = settlementBuildEmail_(participant, group, total, tickets);

    try {
      if (mode === "PREVIEW") {
        console.log("[PREVIEW] " + participant + " <" + email + "> — " +
          group.orders.length + " orders, " + tickets + " tickets, " +
          settlementMoney_(total) + " | " + built.subject);
        group.orders.forEach(function (o) {
          console.log("    + COUNTED " + o.ref + " | " + o.buyer + " | " +
            settlementMoney_(o.amount) + " | " + (o.status || "(no status)"));
        });
        group.duplicates.forEach(function (o) {
          console.log("    - NOT COUNTED " + o.ref + " | " + o.buyer + " | " +
            settlementMoney_(o.amount) + " | " + (o.status || "(no status)"));
        });
        group.test.forEach(function (o) {
          console.log("    - EXCLUDED (test) " + o.ref + " | " + o.buyer + " | " +
            settlementMoney_(o.amount) + " | " + (o.status || "(no status)"));
        });
      } else if (mode === "DRAFT") {
        GmailApp.createDraft(email, built.subject, built.text, {
          htmlBody: built.html, name: SETTLEMENT_TEAM_NAME + " Raffle"
        });
        settlementLog_(logSheet, "DRAFTED", participant, email,
          group.orders.length, tickets, total, fingerprint, built.subject);
      } else { // SEND
        GmailApp.sendEmail(email, built.subject, built.text, {
          htmlBody: built.html, name: SETTLEMENT_TEAM_NAME + " Raffle"
        });
        settlementLog_(logSheet, "SENT", participant, email,
          group.orders.length, tickets, total, fingerprint, built.subject);
      }
      done.push(participant + " (" + settlementMoney_(total) + ")");
      grandTotal += total;
    } catch (e) {
      failed.push(participant + " — " + e.message);
      if (mode !== "PREVIEW") {
        settlementLog_(logSheet, "FAILED", participant, email,
          group.orders.length, tickets, total, fingerprint, String(e.message || e));
      }
    }
  });

  Object.keys(unknownParticipants).forEach(function (p) {
    skipped.push(p + " — has orders in All Orders but is NOT in the Roster tab");
  });

  // --- Summary (reconciles: valid + duplicates + test = all order rows) ---
  var verb = mode === "PREVIEW" ? "Previewed" : (mode === "DRAFT" ? "Drafted" : "Sent");
  var lines = [
    verb + " " + done.length + " family email(s), totalling " + settlementMoney_(grandTotal) + ".",
    "Orders check: " + stats.rows + " order rows read — valid " +
      settlementMoney_(stats.validAmount) + ", duplicate/cancelled excluded " +
      settlementMoney_(stats.dupAmount) + ", test orders excluded " + stats.test +
      " (" + settlementMoney_(stats.testAmount) + ")."
  ];
  var crossWarnings = settlementCrossCheck_(ss, rosterOrder, byParticipant);
  if (crossWarnings.length) {
    lines.push("\nCROSS-CHECK WARNINGS (All Orders vs player tabs):\n• " +
      crossWarnings.join("\n• "));
  }
  if (skipped.length) lines.push("\nSkipped (" + skipped.length + "):\n• " + skipped.join("\n• "));
  if (failed.length) lines.push("\nFAILED (" + failed.length + "):\n• " + failed.join("\n• "));
  var summary = lines.join("\n");
  console.log(summary);
  if (ui) ui.alert(summary);
  return summary;
}

/** Builds the subject + plain-text + HTML bodies for one family. */
function settlementBuildEmail_(participant, group, total, tickets) {
  var asOf = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MMMM d, yyyy");
  var subject = "Action Required: Waxers Raffle Settlement — " + participant +
                " (" + settlementMoney_(total) + " to transfer)";

  // ----- plain text -----
  var text = [];
  text.push("Hi " + participant + " family,");
  text.push("");
  text.push("Here are the raffle ticket orders recorded under " + participant +
            " in the " + SETTLEMENT_TEAM_NAME + " raffle, as of " + asOf + ":");
  text.push("");
  group.orders.forEach(function (o) {
    text.push("  - " + o.buyer + " — " + o.pkg + ", " + o.qty +
              (o.qty === 1 ? " ticket" : " tickets") + " — " + settlementMoney_(o.amount) +
              " — Ref " + o.ref);
    if (o.tickets) text.push("      Tickets: " + o.tickets);
  });
  if (group.duplicates.length) {
    text.push("");
    text.push("Not counted (duplicate / cancelled / refunded):");
    group.duplicates.forEach(function (o) {
      text.push("  - " + o.buyer + " — " + settlementMoney_(o.amount) + " — Ref " + o.ref);
    });
  }
  text.push("");
  text.push("TOTALS");
  text.push("  Orders: " + group.orders.length);
  text.push("  Tickets: " + tickets);
  text.push("  FULL AMOUNT TO TRANSFER: " + settlementMoney_(total));
  text.push("");
  text.push("WHAT TO DO");
  text.push("1. Check the list above. If any buyer has not paid you yet, or anything " +
            "looks wrong, reply to this email with the buyer's name and reference " +
            "code.");
  text.push("2. e-Transfer the full amount of " + settlementMoney_(total) + " to:");
  text.push("     " + SETTLEMENT_COLLECTION_EMAIL);
  text.push("   Memo: Raffle - " + participant);
  text.push("3. DEADLINE: send it BEFORE MIDNIGHT on Wednesday, November 25 — " +
            "all payments must be in by then, ahead of draw night, Thursday, November 26.");
  text.push("");
  text.push("Thank you for supporting the team!");
  text.push(SETTLEMENT_TEAM_NAME + " Fundraising Committee");

  // ----- HTML -----
  var rowsHtml = group.orders.map(function (o) {
    return "<tr>" +
      "<td><strong>" + settlementEsc_(o.buyer) + "</strong>" +
        (o.pkg ? "<br><span style=\"color:#666;font-size:11px;\">" +
          settlementEsc_(o.pkg) + "</span>" : "") + "</td>" +
      "<td>" + settlementEsc_(o.tickets) + "</td>" +
      "<td style=\"text-align:center;\">" + o.qty + "</td>" +
      "<td style=\"text-align:right;\">" + settlementMoney_(o.amount) + "</td>" +
      "<td><code>" + settlementEsc_(o.ref) + "</code></td></tr>";
  }).join("");
  var dupHtml = "";
  if (group.duplicates.length) {
    dupHtml = "<p style=\"font-family:Arial,sans-serif;font-size:13px;color:#888;\">" +
      "Not counted (duplicate / cancelled / refunded): " +
      group.duplicates.map(function (o) {
        return settlementEsc_(o.buyer) + " — " + settlementMoney_(o.amount) +
               " — Ref " + settlementEsc_(o.ref);
      }).join("; ") + "</p>";
  }
  var html =
    "<p>Hi " + settlementEsc_(participant) + " family,</p>" +
    "<p>Here are the raffle ticket orders recorded under <strong>" +
      settlementEsc_(participant) + "</strong> in the " + SETTLEMENT_TEAM_NAME +
      " raffle, as of " + asOf + ":</p>" +
    "<table border=\"1\" cellpadding=\"8\" cellspacing=\"0\" style=\"border-collapse:collapse;" +
      "font-family:Arial,sans-serif;font-size:13px;width:100%;max-width:650px;\">" +
      "<thead><tr style=\"background-color:#f2f2f2;text-align:left;\">" +
      "<th>Buyer</th><th>Ticket Numbers</th><th style=\"text-align:center;\">Qty</th>" +
      "<th style=\"text-align:right;\">Amount</th><th>Ref Code</th>" +
      "</tr></thead><tbody>" + rowsHtml + "</tbody></table>" +
    dupHtml +
    "<div style=\"margin-top:15px;font-family:Arial,sans-serif;font-size:14px;\">" +
      "<p>Orders: " + group.orders.length + " &nbsp;•&nbsp; Tickets: " + tickets + "<br>" +
      "<strong>Total Amount to Transfer: <span style=\"font-size:16px;color:#1b5e20;\">" +
        settlementMoney_(total) + "</span></strong></p></div>" +
    "<hr style=\"border:0;border-top:1px solid #ddd;margin:20px 0;\">" +
    "<h4 style=\"margin-bottom:8px;\">What to do</h4>" +
    "<ol style=\"line-height:1.6;font-family:Arial,sans-serif;font-size:13px;\">" +
      "<li><strong>Check the list.</strong> If any buyer has not paid you yet, or anything " +
        "looks wrong, reply to this email with the buyer's name and reference code.</li>" +
      "<li><strong>Send Interac e-Transfer</strong> for the full amount of <strong>" +
        settlementMoney_(total) + "</strong> to:<br>" +
        "&bull; <strong>EMT Address:</strong> <code>" + SETTLEMENT_COLLECTION_EMAIL + "</code><br>" +
        "&bull; <strong>Memo:</strong> <code>Raffle - " + settlementEsc_(participant) + "</code></li>" +
      "<li><strong>Deadline: send it before midnight on Wednesday, November 25</strong> — " +
        "all payments must be in by then, ahead of draw night, Thursday, November 26.</li>" +
    "</ol>" +
    "<p style=\"font-family:Arial,sans-serif;font-size:13px;color:#555;\">" +
      "Thank you for supporting the team!<br><strong>" + SETTLEMENT_TEAM_NAME +
      " Fundraising Committee</strong></p>";

  return { subject: subject, text: text.join("\n"), html: html };
}

/** Statuses that keep an order out of the totals (listed as "not counted"). */
function settlementExcludedByStatus_(status) {
  return /duplicate|cancel|refund|void|invalid/i.test(status || "");
}

/**
 * Cross-check: every reference code in All Orders for a participant
 * should also appear in that player's own tab, and vice versa.
 * Returns human-readable warnings for any mismatch. A missing
 * player tab is not a warning (All Orders is the source of truth).
 */
function settlementCrossCheck_(ss, rosterOrder, byParticipant) {
  var warnings = [];
  rosterOrder.forEach(function (participant) {
    var tab = ss.getSheetByName(participant);
    if (!tab) return;
    var group = byParticipant[participant] || { all: {} };
    var tabRefs = {};
    var tabRows = tab.getDataRange().getValues();
    for (var i = 1; i < tabRows.length; i++) {
      var ref = settlementStr_(tabRows[i][7]);   // player tab: Ref Code is column H
      if (!ref) continue;
      tabRefs[ref] = { buyer: settlementStr_(tabRows[i][1]),
                       amount: parseFloat(tabRows[i][6]) || 0,
                       status: settlementStr_(tabRows[i][9]) };
    }
    var statusDiffs = [];
    Object.keys(group.all).forEach(function (ref) {
      if (!tabRefs[ref]) {
        warnings.push(participant + ": " + ref + " (" + group.all[ref].buyer + ", " +
          settlementMoney_(group.all[ref].amount) + ") is in All Orders but NOT in the " +
          participant + " tab");
      } else if (tabRefs[ref].status.toLowerCase() !==
                 (group.all[ref].status || "").toLowerCase()) {
        statusDiffs.push(ref + " (All Orders: \"" + group.all[ref].status +
          "\" vs tab: \"" + tabRefs[ref].status + "\")");
      }
    });
    if (statusDiffs.length) {
      warnings.push(participant + ": EMT Status differs between All Orders and the tab for " +
        statusDiffs.join(", ") + " — the settlement reads All Orders");
    }
    Object.keys(tabRefs).forEach(function (ref) {
      if (!group.all[ref]) {
        warnings.push(participant + ": " + ref + " (" + tabRefs[ref].buyer + ", " +
          settlementMoney_(tabRefs[ref].amount) + ") is in the " + participant +
          " tab but NOT in All Orders");
      }
    });
  });
  return warnings;
}

/** Test orders: any one strong signal excludes the row from settlement. */
function settlementIsTestOrder_(o) {
  var status = o.status.toLowerCase();
  if (status.indexOf("test") !== -1) return true;
  if (o.clientId.toLowerCase().indexOf("probe-") === 0) return true;
  if (o.buyerEmail.toLowerCase().indexOf("muse.ai") !== -1) return true;
  if (/\btest(ing)?\b/i.test(o.buyer)) return true;
  return false;
}

/** Stable fingerprint of one family's exact order set + total. */
function settlementFingerprint_(participant, orders, total) {
  var refs = orders.map(function (o) { return o.ref; }).sort();
  return participant + "|" + refs.join(",") + "|" + total.toFixed(2);
}

function settlementGetLogSheet_(ss) {
  var sheet = ss.getSheetByName(SETTLEMENT_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SETTLEMENT_LOG_SHEET);
    sheet.appendRow(["Timestamp", "Action", "Participant", "Email",
                     "Orders", "Tickets", "Total", "Fingerprint", "Detail"]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 9).setFontWeight("bold");
  }
  return sheet;
}

function settlementLog_(sheet, action, participant, email, orders, tickets, total, fingerprint, detail) {
  sheet.appendRow([new Date(), action, participant, email || "",
                   orders, tickets, total, fingerprint, detail || ""]);
}

function settlementStr_(v) { return (v === null || v === undefined) ? "" : String(v).trim(); }

function settlementMoney_(n) {
  var parts = (Math.round(n * 100) / 100).toFixed(2).split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return "$" + parts.join(".");
}

function settlementEsc_(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
