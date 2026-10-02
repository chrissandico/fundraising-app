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
 *  6. Emails a receipt. If the email fails, the order still succeeds — the
 *     response flags emailSent: false so the page can warn the buyer.
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
  SINGLE_TICKET_PRICE: 10,             // price per ticket for custom quantities
  PACKAGE_PRICES: { 1: 10, 5: 40, 15: 100 },  // must match PACKAGES in index.html
  SHEET_HEADERS: [
    "Timestamp", "Buyer Name", "Email", "Phone",
    "Package", "Qty", "Amount ($)", "Ref Code",
    "Ticket Numbers", "EMT Status (Manual)"
  ],
  MASTER_HEADERS: [
    "Timestamp", "Buyer Name", "Email", "Phone", "Participant",
    "Package", "Qty", "Amount ($)", "Ref Code",
    "Ticket Numbers", "EMT Status (Manual)",
    "Client Order ID", "Receipt Emailed"
  ]
};

/* ---------- PARTICIPANT ROSTER — server-side source of truth ----------
   Replace with the real roster before launch. The keys must match the
   `name` values in the PARTICIPANTS array in index.html exactly.
   Orders naming anyone not listed here are rejected, and the EMT email
   used everywhere comes from this roster — never from the client. */
var PARTICIPANTS = {
  "Player: Lucas Martinez (#10)": "lucas.martinez@markhamwaxers-sample.ca",
  "Player: Ethan Chen (#4)":      "ethan.chen@markhamwaxers-sample.ca",
  "Player: Noah Tremblay (#22)":  "noah.tremblay@markhamwaxers-sample.ca",
  "Player: Liam O'Connor (#7)":   "liam.oconnor@markhamwaxers-sample.ca",
  "Player: Mason Patel (#13)":    "mason.patel@markhamwaxers-sample.ca",
  "Family: The Nguyen Family":    "nguyen.family@markhamwaxers-sample.ca",
  "Family: The Rossi Family":      "rossi.family@markhamwaxers-sample.ca",
  "Family: The Kowalski Family":   "kowalski.family@markhamwaxers-sample.ca"
};

/** Health check — open the /exec URL in a browser, you should see this. */
function doGet() {
  return ContentService
    .createTextOutput(CONFIG.ORG_NAME + " Raffle backend is running.")
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Receives the order payload from index.html, validates it against the
 * server-side roster and price schedule, assigns a unique reference code and
 * sequential ticket numbers, logs the order, and emails a receipt.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("Empty request body.");
    }
    var data = JSON.parse(e.postData.contents);
    validatePayload(data);

    // The roster is authoritative: reject unknown participants and use the
    // roster's EMT email, never one supplied by the client.
    var participantName = String(data.selectedParticipant);
    var emtEmail = PARTICIPANTS[participantName];
    if (!emtEmail) {
      throw new Error("Unknown participant. Please refresh the page and try again.");
    }
    data.emtEmail = emtEmail;

    // Recompute the total server-side; the client's number must match exactly.
    var qty = Number(data.ticketCount);
    var expectedTotal = computeTotal(qty);
    if (Number(data.totalAmount) !== expectedTotal) {
      throw new Error("Total amount mismatch. Please refresh the page and try again.");
    }
    data.totalAmount = expectedTotal;

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var master = getOrCreateMasterSheet(ss);

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
        duplicate: true
      });
    }

    // One lock for both counters: ticket numbers and reference codes stay
    // unique even under concurrent submissions.
    var allocation = allocateTicketsAndRef(qty);
    data.assignedTickets = allocation.tickets;
    data.referenceCode = allocation.refCode;

    // A failed receipt email must not fail the order — the tickets are valid.
    var emailSent = true;
    try {
      sendEmailReceipt(data);
    } catch (emailErr) {
      emailSent = false;
    }

    var timestamp = String(data.timestamp);
    var ticketList = allocation.tickets.join(", ");

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
      "Pending Verification",   // families update this manually after EMT lands
      clientOrderId,
      emailSent ? "Yes" : "No"
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
      "Pending Verification"
    ]);

    return jsonResponse({
      status: "success",
      tickets: allocation.tickets,
      referenceCode: allocation.refCode,
      emailSent: emailSent
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
 * tab (columns I–M: Ref Code, Ticket Numbers, EMT Status, Client Order ID,
 * Receipt Emailed). Returns the stored result so retries are harmless.
 */
function findOrderByClientId(master, clientOrderId) {
  var lastRow = master.getLastRow();
  if (lastRow < 2 || !clientOrderId) return null;
  var values = master.getRange(2, 9, lastRow - 1, 5).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][3]) === clientOrderId && values[i][3] !== "") {
      return {
        refCode: String(values[i][0]),
        tickets: String(values[i][1]).split(/,\s*/),
        emailSent: String(values[i][4]) === "Yes"
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

/* ---------------- email receipt ---------------- */

function sendEmailReceipt(data) {
  var subject = CONFIG.ORG_NAME + " Raffle Confirmation — Ref " + data.referenceCode;

  var textBody =
    "Hi " + data.buyerName + ",\n\n" +
    "Thank you for supporting " + data.selectedParticipant + "!\n\n" +
    "ORDER DETAILS\n" +
    "  Package: " + data.packageSelected + " (" + data.ticketCount + " tickets)\n" +
    "  Total due via Interac e-Transfer: $" + Number(data.totalAmount).toFixed(2) + "\n" +
    "  Send e-Transfer to: " + data.emtEmail + "\n" +
    "  Reference code: " + data.referenceCode + " (include this in your transfer memo)\n\n" +
    "YOUR TICKET NUMBERS\n" +
    "  " + data.assignedTickets.join(", ") + "\n\n" +
    "Please complete your e-Transfer using the reference code above. " +
    "Your tickets are confirmed once payment is verified.\n\n" +
    "Good luck!\n" +
    CONFIG.ORG_NAME + " Fundraising Committee";

  var htmlBody =
    "<p>Hi " + esc(data.buyerName) + ",</p>" +
    "<p>Thank you for supporting <strong>" + esc(data.selectedParticipant) + "</strong>!</p>" +
    "<h3>Order details</h3>" +
    "<ul>" +
    "<li>Package: " + esc(data.packageSelected) + " (" + esc(data.ticketCount) + " tickets)</li>" +
    "<li>Total due via Interac e-Transfer: <strong>$" + Number(data.totalAmount).toFixed(2) + "</strong></li>" +
    "<li>Send e-Transfer to: <strong>" + esc(data.emtEmail) + "</strong></li>" +
    "<li>Reference code: <strong>" + esc(data.referenceCode) + "</strong> (include this in your transfer memo)</li>" +
    "</ul>" +
    "<h3>Your ticket numbers</h3>" +
    "<p><strong>" + esc(data.assignedTickets.join(", ")) + "</strong></p>" +
    "<p>Please complete your e-Transfer using the reference code above. " +
    "Your tickets are confirmed once payment is verified.</p>" +
    "<p>Good luck!<br/>" + esc(CONFIG.ORG_NAME) + " Fundraising Committee</p>";

  GmailApp.sendEmail(data.buyerEmail, subject, textBody, { htmlBody: htmlBody, name: CONFIG.ORG_NAME + " Raffle" });
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
