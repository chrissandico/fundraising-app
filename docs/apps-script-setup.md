# Google Apps Script backend — deployment guide

This deploys `google-apps-script/Code.gs` as the Web App endpoint that `index.html` posts
orders to. You only need a Google account and a Google Sheet. Takes about 10 minutes.

## 1. Create the master spreadsheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new blank spreadsheet.
2. Name it something like **Markham Waxers Raffle — Orders**.
3. Leave it empty — the script creates one tab per player/family automatically on the first order.

## 2. Open the script editor

1. In the spreadsheet, click **Extensions → Apps Script**. A new script project opens in a new tab.
2. Delete any code in the default `Code.gs` file.
3. Copy the entire contents of `google-apps-script/Code.gs` from this repo and paste it in.
4. Press **Ctrl+S** (or Cmd+S) to save. Name the project **Waxers Raffle Backend** if prompted.

## 3. Run once to grant permissions

1. In the toolbar, make sure the function dropdown says `doGet`, then click **Run**.
2. Google will ask you to authorize: click **Review permissions** → choose your account →
   **Advanced** → **Go to Waxers Raffle Backend (unsafe)** → **Allow**.
   (The "unsafe" warning is normal — it's your own script asking for Sheets + Gmail access.)
3. The run will finish with no visible output. That's expected.

## 4. Deploy as a Web App

1. Click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill in:
   - **Description:** `Raffle orders v1`
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
4. Click **Deploy**, then **Authorize access** if prompted again.
5. Copy the **Web app URL** — it ends in `/exec`. It looks like:
   `https://script.google.com/macros/s/AKfyc.../exec`

## 5. Connect the frontend

1. Open `index.html` and find the `CONFIG` block near the top of the `<script>`.
2. Set `APPS_SCRIPT_URL: "https://script.google.com/macros/s/YOUR_ID/exec"` (your copied URL).
3. Commit and push — the site will now submit real orders.

## 6. Test it

1. Paste the `/exec` URL into a browser address bar and hit Enter. You should see:
   `Markham Waxers Raffle backend is running.`
2. On the live site, place a test order. Check:
   - A new tab appears in the spreadsheet named after the selected player/family, with your row.
   - The buyer email receives the receipt with ticket numbers starting at `TK-1000`.
3. Delete the test tab/row afterwards, or reset the counter by running this once in the
   script editor (change `1000` if you want a different start):
   ```javascript
   function resetCounter() {
     PropertiesService.getScriptProperties().setProperty("MW_RAFFLE_TICKET_COUNTER", "1000");
   }
   ```

## Notes

- **Ticket numbers** are sequential and gap-free (`TK-1000`, `TK-1001`, …). A script lock
  prevents duplicates even if two people submit at the same moment.
- **Email receipts** are sent from the Google account that deployed the script, via Gmail.
  Gmail's daily sending limits apply (plenty for a fundraiser).
- **Sheet tab names** come from the player/family name in the dropdown. Avoid renaming tabs
  manually — new orders always go to the tab matching the selected name.
- **EMT verification** is manual by design: families check their bank account, then update
  the `EMT Status (Manual)` column in their tab.
- If you ever edit `Code.gs`, redeploy with **Deploy → Manage deployments → Edit → New version**
  so the live `/exec` URL picks up the changes.
