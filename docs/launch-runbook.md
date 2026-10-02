# Launch runbook — Markham Waxers Raffle

End-to-end: from zero to a live, tested raffle page. About 90 minutes, most of it waiting.

## Phase 1 — Google Sheet + backend (~15 min)

1. Create a blank spreadsheet at sheets.google.com. Name it "Markham Waxers Raffle — Orders". Leave it empty — the script builds the tabs itself.
2. In the spreadsheet: **Extensions → Apps Script**. Delete the starter code, paste the full contents of `google-apps-script/Code.gs` from the repo, save.
3. Set the function dropdown to `doGet`, click **Run**. Approve the permission prompt: Review permissions → your account → Advanced → "Go to Waxers Raffle Backend (unsafe)" → Allow. (Normal — it's your own script asking for Sheets + Gmail.)
4. **Deploy → New deployment** → gear icon → **Web app**. Execute as: Me. Who has access: Anyone. Deploy, copy the URL ending in `/exec`.
5. Open that URL in a browser — you should see "Markham Waxers Raffle backend is running."

## Phase 2 — Oracle Cloud server (~30 min)

6. Sign up at oracle.com/cloud/free (Always Free), sign in at cloud.oracle.com.
7. Menu → **Compute → Instances → Create instance**. Name: `waxers-raffle-web`.
8. **Image:** Change image → Canonical Ubuntu 22.04 or newer.
9. **Shape:** Change shape → Virtual machine → **VM.Standard.A1.Flex** (Ampere ARM — the Always Free one).
10. **Networking:** leave "create new virtual cloud network" checked. **SSH keys:** generate a key pair, save both files somewhere safe.
11. Create, wait for Running, and note the **public IP**.
12. Open the firewall: on the instance page click the subnet → Default Security List → Add Ingress Rules → allow ports **80** (and 443 for later) from `0.0.0.0/0`.
13. Lock down the key and SSH in:
    ```
    chmod 400 your-key-file
    ssh -i your-key-file ubuntu@<PUBLIC_IP>
    ```
14. Install Nginx and open the firewall (persistent across reboots):
    ```
    sudo apt update && sudo apt install -y nginx
    sudo systemctl enable nginx && sudo systemctl start nginx
    sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
    sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
    sudo netfilter-persistent save
    ```
15. Confirm passwordless sudo (the deploy workflow needs it):
    ```
    sudo -n true && echo "passwordless sudo OK"
    ```
    This prints OK by default on OCI Ubuntu images. If it doesn't, the deploy step will fail.
16. Visit `http://<PUBLIC_IP>` — you should see the Nginx welcome page.

## Phase 3 — Wire up auto-deploy (~10 min)

17. In the repo: **Settings → Secrets and variables → Actions** → add three secrets:
    - `OCI_HOST` = the public IP
    - `OCI_USER` = `ubuntu`
    - `OCI_SSH_KEY` = the full contents of your private key file (including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines)
18. That's it — `.github/workflows/deploy.yml` is already in the repo. Every push to `main` now deploys `index.html` to the server automatically.

## Phase 4 — Real data + connect the backend (~20 min)

19. **Roster (both files — names must match exactly):** replace the sample `PARTICIPANTS` array in `index.html` AND the `PARTICIPANTS` object in `google-apps-script/Code.gs` with the real player/family names and their Interac e-Transfer emails. The backend rejects any name not in its roster, so keep the two lists identical.
20. **Prizes:** replace the sample `PRIZES` array in `index.html` with real names, descriptions, values, and image URLs.
21. **Rules:** update the consent text with the official raffle rules and draw date.
22. **Demo banner:** delete the amber "Demo mode" banner at the top of `index.html`.
23. **Backend re-deploy:** you edited Code.gs after Phase 1, so go to **Deploy → Manage deployments**, edit the Web app deployment, and create a **New version** — otherwise the live `/exec` URL keeps serving the old code.
24. Send the `/exec` URL from Phase 1 to Glint — it'll be wired into `CONFIG.APPS_SCRIPT_URL` in `index.html` and pushed. That push triggers the deploy workflow, so the live page comes up with real data on the first green run.

## Phase 5 — Test before launch (~10 min)

25. Visit `http://<PUBLIC_IP>` — the raffle page should load with real prizes and roster, and no demo banner.
26. Place a test order. Check:
    - A new tab appears in the sheet named after the player, with your row.
    - A master **All Orders** tab appears with the same order.
    - The buyer gets the email receipt with ticket numbers starting at TK-1000 and a reference code like MW-EMT-1000.
27. Clean up: delete the test tab and test rows. To restart numbering at TK-1000 / MW-EMT-1000, run this once in the Apps Script editor:
    ```javascript
    function resetCounters() {
      var p = PropertiesService.getScriptProperties();
      p.setProperty("MW_RAFFLE_TICKET_COUNTER", "1000");
      p.setProperty("MW_RAFFLE_REF_COUNTER", "1000");
    }
    ```

## Optional — HTTPS (after launch works)

- Point a DNS A-record at the public IP, then on the VM:
  ```
  sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx
  ```
  The page collects names, emails, and phone numbers — worth the two minutes.
- Lock down SSH: restrict port 22 ingress to your own IP in the security list.
