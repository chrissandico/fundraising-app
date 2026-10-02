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
 */

var CONFIG = {
  TICKET_PREFIX: "TK-",
  COUNTER_KEY: "MW_RAFFLE_TICKET_COUNTER",
  COUNTER_START: 1000,          // first ticket issued will be TK-1000
  ORG_NAME: "Markham Waxers",
  SHEET_HEADERS: [
    "Timestamp", "Buyer Name", "Email", "Phone",
    "Package", "Qty", "Amount ($)", "Ref Code",
    "Ticket Numbers", "EMT Status (Manual)"
  ]
};

/** Health check — open the /exec URL in a browser, you should see this. */
function doGet() {
  return ContentService
    .createTextOutput(CONFIG.ORG_NAME + " Raffle backend is running.")
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Receives the order payload from index.html, assigns sequential ticket
 * numbers, logs the row to the participant's sheet tab, and emails a receipt.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("Empty request body.");
    }
    var data = JSON.parse(e.postData.contents);
    validatePayload(data);

    // Sequential, gap-free ticket numbers (lock prevents duplicates on
    // near-simultaneous submissions).
    var tickets = allocateTicketNumbers(Number(data.ticketCount));
    data.assignedTickets = tickets;

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getOrCreateParticipantSheet(ss, String(data.selectedParticipant));
    sheet.appendRow([
      data.timestamp,
      data.buyerName,
      data.buyerEmail,
      data.buyerPhone,
      data.packageSelected,
      data.ticketCount,
      Number(data.totalAmount),
      data.referenceCode,
      tickets.join(", "),
      "Pending Verification"   // families update this manually after EMT lands
    ]);

    sendEmailReceipt(data);

    return jsonResponse({ status: "success", tickets: tickets, referenceCode: data.referenceCode });
  } catch (err) {
    return jsonResponse({ status: "error", message: String(err && err.message || err) });
  }
}

/* ---------------- validation ---------------- */

function validatePayload(d) {
  var required = ["buyerName", "buyerEmail", "buyerPhone", "selectedParticipant",
                  "emtEmail", "packageSelected", "ticketCount", "totalAmount",
                  "referenceCode", "timestamp"];
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

/* ---------------- sequential ticket numbers ----------------
 * Uses a script-level lock + persistent counter so concurrent orders
 * never receive the same ticket numbers.
 */
function allocateTicketNumbers(count) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000); // wait up to 15s for the lock
  try {
    var props = PropertiesService.getScriptProperties();
    var current = parseInt(props.getProperty(CONFIG.COUNTER_KEY) || CONFIG.COUNTER_START, 10);
    var tickets = [];
    for (var i = 0; i < count; i++) {
      tickets.push(CONFIG.TICKET_PREFIX + (current + i));
    }
    props.setProperty(CONFIG.COUNTER_KEY, String(current + count));
    return tickets;
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- sheet tabs ----------------
 * One tab per player/family, named exactly as selected in the dropdown.
 */
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
