/**
 * Markham Waxers Raffle — Google Apps Script backend
 * ==================================================
 * Paste this entire file into a Google Apps Script project bound to your
 * master Google Sheet (Extensions > Apps Script), then deploy it as a Web App:
 *
 *   Deploy > New deployment > Web app
 *   - Execute as: Me
 *   - Who has access: Anyone
 *
 * Copy the resulting "/exec" URL into CONFIG.APPS_SCRIPT_URL in index.html.
 * Full step-by-step: docs/apps-script-setup.md
 *
 * IMPORTANT after editing this file: Apps Script does NOT update the live
 * "/exec" URL automatically. Go to Deploy > Manage deployments, edit the
 * Web app deployment and create a "New version" — otherwise your changes
 * won't go live.
 *
 * What the backend does per order:
 *  1. Validates the payload and the participant against the roster below.
 *  2. Recomputes the total server-side (the client's totalAmount must match
 *     or the order is rejected — pricing can't be tampered with).
 *  3. Issues a unique sequential reference code and sequential ticket numbers
 *     under a single script lock (safe under concurrent submissions).
 *  4. Returns the original result if the same clientOrderId is submitted
 *     twice (idempotency — no duplicate tickets on double-click/retry).
 *  5. Appends the order to the master "All Orders" tab AND the participant's
 *     own tab.
 *  6. Emails the buyer a receipt and, when the sales rep's family has an
 *     email address on file, emails that family a new-order notification.
 *     Email failures do not fail the order; the response and the master
 *     sheet record whether each message was sent.
 *  7. Sales deadline: NEW orders are rejected once SALES_DEADLINE_MS passes
 *     (Wed Nov 25, 2026, midnight Toronto time). Retries of orders placed before
 *     the deadline still return their original tickets (see step 4).
 */

var CONFIG = {
  TICKET_PREFIX: "TK-",
  TICKET_COUNTER_KEY: "MW_RAFFLE_TICKET_COUNTER",
  TICKET_COUNTER_START: 1000,          // first ticket issued will be TK-1000
  REF_CODE_PREFIX: "MW-EMT-",
  REF_COUNTER_KEY: "MW_RAFFLE_REF_COUNTER",
  REF_COUNTER_START: 1000,             // first reference code will be MW-EMT-1000
  ORG_NAME: "Markham Waxers",
  MASTER_SHEET_NAME: "All Orders",
  ROSTER_SHEET_NAME: "Roster",
  SINGLE_TICKET_PRICE: 20,             // price per ticket for custom quantities
  PACKAGE_PRICES: { 1: 20, 3: 50, 8: 100 },  // must match PACKAGES in index.html
  SALES_DEADLINE_MS: Date.UTC(2026, 10, 26, 5, 0, 0), // midnight at the end of Wed Nov 25, 2026 Toronto time (12:00 AM Nov 26, EST = UTC-5). NEW orders at/after this instant are rejected; keep in sync with CONFIG.SALES_DEADLINE in index.html.
  SHEET_HEADERS: [
    "Timestamp", "Buyer Name", "Email", "Phone",
    "Package", "Qty", "Amount ($)", "Ref Code",
    "Ticket Numbers", "EMT Status (Manual)"
  ],
  MASTER_HEADERS: [
    "Timestamp", "Buyer Name", "Email", "Phone", "Participant",
    "Package", "Qty", "Amount ($)", "Ref Code",
    "Ticket Numbers", "EMT Status (Manual)",
    "Client Order ID", "Receipt Emailed", "Family Emailed"
  ]
};

/* ---------- PARTICIPANT ROSTER — server-side source of truth ----------
   PARTICIPANT_NAMES must match the `name` values in the PARTICIPANTS array
   in index.html exactly. Orders naming anyone not listed here are rejected.

   EMT email addresses deliberately do NOT live in this file (or anywhere
   in the public repo / web page). They live in the "Roster" tab of this
   spreadsheet — row 1 headers "Participant" | "EMT Email", one row per
   sales rep — which only the fundraising organizers can see. getEmtEmail()
   reads that tab at order time, so email changes take effect immediately
   with no redeploy. A participant with no row (or a blank email) is
   treated as "family contacts the buyer directly": the confirmation screen
   and the receipt email tell the buyer the family will reach out to
   arrange payment, and the order is flagged accordingly in the sheet.
   Display format is first name + last initial (Prof's call, Oct 2026).
   Reps whose Roster-tab email is blank (currently Brandon J. and Mike C.)
   automatically get the contact-directly flow. Names must match index.html
   and the Roster tab exactly — all three places. */
var PARTICIPANT_NAMES = [
  "Christian B.",
  "Tyler B.",
  "Theodore C.",
  "Konstantinos G.",
  "Alexander L.",
  "Jerry L.",
  "Jonathan L.",
  "Ian M.",
  "Xavier M.",
  "Callum O.",
  "Joshua O.",
  "Preston S.",
  "Wilson W.",
  "Benny Y.",
  "Nolan D.",
  "Brandon J.",
  "Mike C."
];

/** Health check — open the /exec URL in a browser, you should see this. */
function doGet() {
  return ContentService
    .createTextOutput(CONFIG.ORG_NAME + " Raffle backend is running.")
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Receives the order payload from index.html, validates it against the
 * server-side roster and price schedule, assigns a unique reference code and
 * sequential ticket numbers, logs the order, emails the buyer a receipt, and
 * notifies the sales rep's family when an email address is on file.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("Empty request body.");
    }
    var data = JSON.parse(e.postData.contents);
    validatePayload(data);

    // The roster of names is authoritative: reject unknown participants.
    // The EMT email is looked up from the spreadsheet's Roster tab below —
    // never from anything the client sends.
    var participantName = String(data.selectedParticipant);
    if (PARTICIPANT_NAMES.indexOf(participantName) === -1) {
      throw new Error("Unknown participant. Please refresh the page and try again.");
    }

    // Recompute the total server-side; the client's number must match exactly.
    var qty = Number(data.ticketCount);
    var expectedTotal = computeTotal(qty);
    if (Number(data.totalAmount) !== expectedTotal) {
      throw new Error("Total amount mismatch. Please refresh the page and try again.");
    }
    data.totalAmount = expectedTotal;

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var master = getOrCreateMasterSheet(ss);

    // "" means the family has no EMT email on file — the buyer is told the
    // family will contact them directly to arrange payment.
    var emtEmail = getEmtEmail(ss, participantName);
    data.emtEmail = emtEmail;

    // Idempotency: a retried submission (double-click, network retry) returns
    // the original result instead of issuing new tickets.
    var clientOrderId = String(data.clientOrderId);
    var existing = findOrderByClientId(master, clientOrderId);
    if (existing) {
      return jsonResponse({
        status: "success",
        tickets: existing.tickets,
        referenceCode: existing.refCode,
        emailSent: existing.emailSent,
        familyEmailSent: existing.familyEmailSent,
        emtEmail: emtEmail || null,
        paymentMethod: emtEmail ? "emt" : "contact",
        duplicate: true
      });
    }

    // Sales deadline safeguard: no NEW orders at/after the deadline. This
    // runs after the idempotency check on purpose — a network retry of an
    // order placed before the deadline still returns its original tickets.
    if (Date.now() >= CONFIG.SALES_DEADLINE_MS) {
      throw new Error("Ticket sales closed at midnight on Wednesday, November 25. Thank you for supporting the Markham Waxers U13A!");
    }

    // One lock for both counters: ticket numbers and reference codes stay
    // unique even under concurrent submissions.
    var allocation = allocateTicketsAndRef(qty);
    data.assignedTickets = allocation.tickets;
    data.referenceCode = allocation.refCode;

    // Failed email must not fail the order — the tickets are valid. The
    // buyer receipt and family notification are attempted independently, so
    // one bad or missing address does not suppress the other message.
    var emailSent = true;
    try {
      sendEmailReceipt(data);
    } catch (emailErr) {
      emailSent = false;
    }

    var familyEmailSent = false;
    if (emtEmail) {
      try {
        sendFamilyNotification(data);
        familyEmailSent = true;
      } catch (familyEmailErr) {
        familyEmailSent = false;
      }
    }

    var timestamp = String(data.timestamp);
    var ticketList = allocation.tickets.join(", ");
    var payStatus = emtEmail ? "Pending Verification" : "Family to contact buyer";

    master.appendRow([
      timestamp,
      data.buyerName,
      data.buyerEmail,
      data.buyerPhone,
      participantName,
      data.packageSelected,
      qty,
      expectedTotal,
      allocation.refCode,
      ticketList,
      payStatus,   // families update this manually once payment lands
      clientOrderId,
      emailSent ? "Yes" : "No",
      familyEmailSent ? "Yes" : (emtEmail ? "No" : "No email on file")
    ]);

    var sheet = getOrCreateParticipantSheet(ss, participantName);
    sheet.appendRow([
      timestamp,
      data.buyerName,
      data.buyerEmail,
      data.buyerPhone,
      data.packageSelected,
      qty,
      expectedTotal,
      allocation.refCode,
      ticketList,
      payStatus
    ]);

    return jsonResponse({
      status: "success",
      tickets: allocation.tickets,
      referenceCode: allocation.refCode,
      emailSent: emailSent,
      familyEmailSent: familyEmailSent,
      emtEmail: emtEmail || null,
      paymentMethod: emtEmail ? "emt" : "contact"
    });
  } catch (err) {
    return jsonResponse({ status: "error", message: String(err && err.message || err) });
  }
}

/* ---------------- validation ---------------- */

function validatePayload(d) {
  var required = ["buyerName", "buyerEmail", "buyerPhone", "selectedParticipant",
                  "packageSelected", "ticketCount", "totalAmount",
                  "clientOrderId", "timestamp"];
  required.forEach(function (k) {
    if (d[k] === undefined || d[k] === null || String(d[k]).trim() === "") {
      throw new Error("Missing required field: " + k);
    }
  });
  var qty = Number(d.ticketCount);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
    throw new Error("ticketCount must be an integer between 1 and 100.");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(d.buyerEmail))) {
    throw new Error("Invalid buyer email address.");
  }
  if (d.termsAccepted !== true) {
    throw new Error("Legal terms must be accepted.");
  }
}

/* ---------------- server-side pricing ----------------
 * Single source of truth for what an order costs. The price schedule must
 * match PACKAGES in index.html; the client's totalAmount is verified
 * against this and rejected on mismatch.
 */
function computeTotal(qty) {
  if (CONFIG.PACKAGE_PRICES[qty] !== undefined) {
    return CONFIG.PACKAGE_PRICES[qty];
  }
  return qty * CONFIG.SINGLE_TICKET_PRICE;
}

/* ---------------- sequential ticket numbers + ref codes ----------------
 * One script-level lock covers both counters so concurrent orders can never
 * receive the same ticket numbers or the same reference code.
 */
function allocateTicketsAndRef(count) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000); // wait up to 15s for the lock
  try {
    var props = PropertiesService.getScriptProperties();
    var t = parseInt(props.getProperty(CONFIG.TICKET_COUNTER_KEY) || CONFIG.TICKET_COUNTER_START, 10);
    var r = parseInt(props.getProperty(CONFIG.REF_COUNTER_KEY) || CONFIG.REF_COUNTER_START, 10);
    var tickets = [];
    for (var i = 0; i < count; i++) {
      tickets.push(CONFIG.TICKET_PREFIX + (t + i));
    }
    props.setProperty(CONFIG.TICKET_COUNTER_KEY, String(t + count));
    props.setProperty(CONFIG.REF_COUNTER_KEY, String(r + 1));
    return { tickets: tickets, refCode: CONFIG.REF_CODE_PREFIX + r };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- idempotency ----------------
 * Looks up a previous order by the client-generated order ID in the master
 * tab (columns I–N: Ref Code, Ticket Numbers, EMT Status, Client Order ID,
 * Receipt Emailed, Family Emailed). Returns the stored result so retries are
 * harmless and do not send duplicate emails.
 */
function findOrderByClientId(master, clientOrderId) {
  var lastRow = master.getLastRow();
  if (lastRow < 2 || !clientOrderId) return null;
  var values = master.getRange(2, 9, lastRow - 1, 6).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][3]) === clientOrderId && values[i][3] !== "") {
      return {
        refCode: String(values[i][0]),
        tickets: String(values[i][1]).split(/,\s*/),
        emailSent: String(values[i][4]) === "Yes",
        familyEmailSent: String(values[i][5]) === "Yes"
      };
    }
  }
  return null;
}

/* ---------------- sheet tabs ---------------- */

function getOrCreateMasterSheet(ss) {
  var sheet = ss.getSheetByName(CONFIG.MASTER_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.MASTER_SHEET_NAME);
    sheet.appendRow(CONFIG.MASTER_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, CONFIG.MASTER_HEADERS.length).setFontWeight("bold");
    sheet.autoResizeColumns(1, CONFIG.MASTER_HEADERS.length);
    return sheet;
  }

  // Sheets created before family notifications have no "Family Emailed"
  // header in column N. Add it without disturbing existing order rows.
  var familyHeader = sheet.getRange(1, CONFIG.MASTER_HEADERS.length);
  if (!familyHeader.getValue()) {
    familyHeader.setValue("Family Emailed");
    familyHeader.setFontWeight("bold");
  }
  return sheet;
}

function sanitizeSheetName(name) {
  // Google Sheets forbids  [ ] * ? / \  in tab names
  return String(name).replace(/[\[\]*?\/\\]/g, "-").trim().substring(0, 100) || "Unassigned";
}

function getOrCreateParticipantSheet(ss, participantName) {
  var sheetName = sanitizeSheetName(participantName);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(CONFIG.SHEET_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, CONFIG.SHEET_HEADERS.length).setFontWeight("bold");
    sheet.autoResizeColumns(1, CONFIG.SHEET_HEADERS.length);
  }
  return sheet;
}

/* ---------------- roster EMT lookup ----------------
 * Reads the spreadsheet's "Roster" tab (row 1 headers, then one row per
 * sales rep: Participant | EMT Email). Returns "" when the tab is missing,
 * the participant has no row, or the email cell is blank — all of which
 * mean "the family contacts the buyer directly to arrange payment".
 */
function getEmtEmail(ss, participantName) {
  var sheet = ss.getSheetByName(CONFIG.ROSTER_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return "";
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === participantName) {
      return String(values[i][1]).trim();
    }
  }
  return "";
}

/* ---------------- email receipt ---------------- */

function sendEmailReceipt(data) {
  var subject = CONFIG.ORG_NAME + " Raffle Confirmation — Ref " + data.referenceCode;
  // Drop the "Family: " label prefix so the email reads naturally, e.g.
  // "Thank you for supporting The Nguyen Family!" instead of
  // "Thank you for supporting Family: The Nguyen Family!"
  var participantDisplay = String(data.selectedParticipant).replace(/^Family:\s*/, "");

  var hasEmt = !!data.emtEmail;
  var totalStr = "$" + Number(data.totalAmount).toFixed(2);
  var paymentText = hasEmt
    ? "  Total due via Interac e-Transfer: " + totalStr + "\n" +
      "  Send e-Transfer to: " + data.emtEmail + "\n" +
      "  Reference code: " + data.referenceCode + " (include this in your e-transfer memo)\n"
    : "  Total due: " + totalStr + "\n" +
      "  Reference code: " + data.referenceCode + "\n" +
      "  Payment: " + participantDisplay + " will contact you directly to arrange payment \u2014 no e-Transfer is needed right now.\n";
  var closingText = hasEmt
    ? "Please complete your e-Transfer using the reference code above. " +
      "All payments must be received by Wednesday, November 25 at midnight. " +
      "Your tickets are confirmed once payment is verified.\n\n"
    : "Your tickets are confirmed once payment has been arranged with " + participantDisplay + ". " +
      "All payments must be received by Wednesday, November 25 at midnight.\n\n";

  var textBody =
    "Hi " + data.buyerName + ",\n\n" +
    "Thank you for supporting " + participantDisplay + "!\n\n" +
    "ORDER DETAILS\n" +
    "  Package: " + data.packageSelected + " (" + data.ticketCount + " tickets)\n" +
    paymentText + "\n" +
    "YOUR TICKET NUMBERS\n" +
    "  " + data.assignedTickets.join(", ") + "\n\n" +
    "DRAW NIGHT\n" +
    "  Thursday, November 26, 2026 \u2014 drawing starts at 7:30 PM, with results ready by 8:00 PM.\n" +
    "  Winners will be notified by email/phone.\n\n" +
    closingText +
    "Good luck!\n" +
    CONFIG.ORG_NAME + " Fundraising Committee";

  var paymentHtml = hasEmt
    ? "<li>Total due via Interac e-Transfer: <strong>" + totalStr + "</strong></li>" +
      "<li>Send e-Transfer to: <strong>" + esc(data.emtEmail) + "</strong></li>" +
      "<li>Reference code: <strong>" + esc(data.referenceCode) + "</strong> (include this in your e-transfer memo)</li>"
    : "<li>Total due: <strong>" + totalStr + "</strong></li>" +
      "<li>Reference code: <strong>" + esc(data.referenceCode) + "</strong></li>" +
      "<li>Payment: <strong>" + esc(participantDisplay) + " will contact you directly to arrange payment</strong> \u2014 no e-Transfer is needed right now.</li>";
  var closingHtml = hasEmt
    ? "<p>Please complete your e-Transfer using the reference code above. " +
      "All payments must be received by <strong>Wednesday, November 25 at midnight</strong>. " +
      "Your tickets are confirmed once payment is verified.</p>"
    : "<p>Your tickets are confirmed once payment has been arranged with " + esc(participantDisplay) + ". " +
      "All payments must be received by <strong>Wednesday, November 25 at midnight</strong>.</p>";

  var htmlBody =
    "<p>Hi " + esc(data.buyerName) + ",</p>" +
    "<p>Thank you for supporting <strong>" + esc(participantDisplay) + "</strong>!</p>" +
    "<h3>Order details</h3>" +
    "<ul>" +
    "<li>Package: " + esc(data.packageSelected) + " (" + esc(data.ticketCount) + " tickets)</li>" +
    paymentHtml +
    "</ul>" +
    "<h3>Your ticket numbers</h3>" +
    "<p><strong>" + esc(data.assignedTickets.join(", ")) + "</strong></p>" +
    "<h3>Draw night</h3>" +
    "<p><strong>Thursday, November 26, 2026</strong> \u2014 drawing starts at 7:30 PM, with results ready by 8:00 PM. Winners will be notified by email/phone.</p>" +
    closingHtml +
    "<p>Good luck!<br/>" + esc(CONFIG.ORG_NAME) + " Fundraising Committee</p>";

  GmailApp.sendEmail(data.buyerEmail, subject, textBody, { htmlBody: htmlBody, name: CONFIG.ORG_NAME + " Raffle" });
}

/* ---------------- family order notification ----------------
 * Sent to the sales rep's Roster-tab email address — the same private
 * address buyers use for Interac e-Transfer. It gives the family the buyer
 * and payment details they need to watch for and verify the payment.
 * Families with no email address on file cannot be emailed; their orders
 * remain in the existing "family contacts the buyer directly" flow.
 */
function sendFamilyNotification(data) {
  if (!data.emtEmail) return;

  var participantDisplay = String(data.selectedParticipant).replace(/^Family:\s*/, "");
  var subject = "New " + CONFIG.ORG_NAME + " Raffle Order for " + participantDisplay +
    " \u2014 Ref " + data.referenceCode;
  var totalStr = "$" + Number(data.totalAmount).toFixed(2);
  var ticketList = data.assignedTickets.join(", ");

  var textBody =
    "Hi " + participantDisplay + ",\n\n" +
    "A new Markham Waxers raffle order has been submitted with you listed as the sales rep.\n\n" +
    "ORDER DETAILS\n" +
    "  Buyer: " + data.buyerName + "\n" +
    "  Buyer email: " + data.buyerEmail + "\n" +
    "  Buyer phone: " + data.buyerPhone + "\n" +
    "  Package: " + data.packageSelected + " (" + data.ticketCount + " tickets)\n" +
    "  Ticket numbers: " + ticketList + "\n" +
    "  Reference code: " + data.referenceCode + "\n" +
    "  Total due: " + totalStr + "\n\n" +
    "PAYMENT\n" +
    "  The buyer was instructed to send an Interac e-Transfer for " + totalStr +
    " to this email address, with reference code " + data.referenceCode +
    " included in the e-transfer memo.\n" +
    "  Please watch for the payment. Once it arrives, mark reference code " +
    data.referenceCode + " as Paid in the All Orders sheet.\n\n" +
    "All payments must be received by Wednesday, November 25 at midnight.\n\n" +
    "Thank you!\n" +
    CONFIG.ORG_NAME + " Fundraising Committee";

  var htmlBody =
    "<p>Hi " + esc(participantDisplay) + ",</p>" +
    "<p>A new Markham Waxers raffle order has been submitted with you listed as the sales rep.</p>" +
    "<h3>Order details</h3>" +
    "<ul>" +
    "<li>Buyer: <strong>" + esc(data.buyerName) + "</strong></li>" +
    "<li>Buyer email: <strong>" + esc(data.buyerEmail) + "</strong></li>" +
    "<li>Buyer phone: <strong>" + esc(data.buyerPhone) + "</strong></li>" +
    "<li>Package: " + esc(data.packageSelected) + " (" + esc(data.ticketCount) + " tickets)</li>" +
    "<li>Ticket numbers: <strong>" + esc(ticketList) + "</strong></li>" +
    "<li>Reference code: <strong>" + esc(data.referenceCode) + "</strong></li>" +
    "<li>Total due: <strong>" + totalStr + "</strong></li>" +
    "</ul>" +
    "<h3>Payment</h3>" +
    "<p>The buyer was instructed to send an Interac e-Transfer for <strong>" + totalStr +
    "</strong> to this email address, with reference code <strong>" + esc(data.referenceCode) +
    "</strong> included in the e-transfer memo.</p>" +
    "<p>Please watch for the payment. Once it arrives, mark reference code <strong>" +
    esc(data.referenceCode) + "</strong> as Paid in the All Orders sheet.</p>" +
    "<p>All payments must be received by <strong>Wednesday, November 25 at midnight</strong>.</p>" +
    "<p>Thank you!<br/>" + esc(CONFIG.ORG_NAME) + " Fundraising Committee</p>";

  GmailApp.sendEmail(data.emtEmail, subject, textBody, {
    htmlBody: htmlBody,
    name: CONFIG.ORG_NAME + " Raffle",
    replyTo: data.buyerEmail
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
