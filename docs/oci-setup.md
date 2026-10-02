# Oracle Cloud (OCI) Always Free VM — console setup guide

This provisions the free Ubuntu server that hosts `index.html` behind Nginx, and wires up the
GitHub Actions deploy pipeline. Takes about 20–30 minutes, most of it waiting on the VM.

## 1. Create your Oracle Cloud account

1. Go to [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) and sign up for the
   **Always Free** tier (credit card required for verification, not charged).
2. Sign in to the [OCI Console](https://cloud.oracle.com).

## 2. Launch an Always Free Ubuntu instance

1. In the console, open the hamburger menu → **Compute → Instances** → **Create instance**.
2. **Name:** `waxers-raffle-web` (anything you like).
3. **Placement:** keep the default availability domain.
4. **Image:** click *Change image* → choose **Canonical Ubuntu** (22.04 or newer).
5. **Shape:** click *Change shape* → instance type **Virtual machine** → shape series
   **Ampere** (ARM) → select **VM.Standard.A1.Flex** — this is the Always Free ARM shape
   (4 OCPUs / 24 GB RAM free). If you prefer Intel/AMD, choose **VM.Standard.E2.1.Micro**
   instead (also Always Free).
6. **Networking:** keep *Create new virtual cloud network* checked (it creates a public
   subnet for you).
7. **Add SSH keys:** choose **Generate a key pair for me**, then click **Save private key**
   and **Save public key** — store the private `.key` file somewhere safe on your computer.
   (Or paste your own existing public key.)
8. Click **Create** and wait until the instance shows **Running** (a minute or two).
9. Note the instance's **Public IP address** — you'll need it below.

## 3. Open HTTP/HTTPS in the firewall

1. On the instance details page, click the **subnet** link under *Primary VNIC*.
2. Click the **Default Security List**.
3. Click **Add Ingress Rules** and add:
   - Source CIDR `0.0.0.0/0`, destination port **80** (HTTP)
   - Source CIDR `0.0.0.0/0`, destination port **443** (HTTPS, for later)
4. SSH into the VM and open the ports in Ubuntu's firewall too:
   ```bash
   ssh -i /path/to/your-private.key ubuntu@<PUBLIC_IP>
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save   # keeps rules after reboot (installs if prompted)
   ```

## 4. Install Nginx

Still SSH'd into the VM:

```bash
sudo apt update && sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

Visit `http://<PUBLIC_IP>` in a browser — you should see the Nginx welcome page.

## 5. Prepare the web root for automated deploys

The GitHub workflow copies `index.html` to your home folder, then moves it into
`/var/www/html/` with sudo. Make sure the `ubuntu` user can do that without a password prompt:

```bash
# Confirm your user can sudo without a password (default on OCI Ubuntu images):
sudo -n true && echo "passwordless sudo OK"
```

If that prints OK, you're done — no changes needed. (The workflow uses `sudo cp` + `sudo systemctl reload nginx`.)

## 6. Add the GitHub repo secrets

In this GitHub repo, go to **Settings → Secrets and variables → Actions → New repository secret**
and add these three:

| Secret | Value |
|---|---|
| `OCI_HOST` | The VM's public IP address from step 2 |
| `OCI_USER` | `ubuntu` |
| `OCI_SSH_KEY` | The **entire contents** of the private `.key` file you saved in step 2 (including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines) |

> Never commit the private key to the repo — secrets only.

## 7. Test the pipeline

1. Push any change to the `main` branch (the initial push of this repo already counts).
2. Go to the repo's **Actions** tab and watch the **Deploy to Oracle Cloud** run.
3. When it goes green, visit `http://<PUBLIC_IP>` — you should see the Waxers raffle page
   instead of the Nginx welcome page.

## Optional next steps (after launch works)

- **Custom domain:** point a DNS A-record at the public IP, then install Certbot
  (`sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx`) for free HTTPS.
- **Lock down SSH:** restrict port 22 ingress to your own IP in the security list.
