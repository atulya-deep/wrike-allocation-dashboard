# Wrike allocation & utilisation dashboard

Password-protected dashboard of Wrike time logging, budgets and utilisation by project, region, account and use case. Published with GitHub Pages and refreshed from Wrike every day at 05:47 IST.

## How the protection works

`index.html` contains the whole dashboard and its data **encrypted** (AES-256-GCM; key derived from the password with PBKDF2-SHA256, 600,000 iterations). Visitors see only a password box; the page decrypts in their browser. No readable client or people data is stored in this repository.

## Daily refresh

`.github/workflows/deploy.yml` runs every day (and on demand from the Actions tab):

1. `refresh_wrike.py` pulls projects, budget fields and time logs from Wrike's **Account Management** space into `data/` (never committed).
2. `build.py` encrypts the dashboard into `index.html`.
3. The page is deployed to GitHub Pages.

Repository secrets used:

| Secret | What it is |
|---|---|
| `WRIKE_TOKEN` | Wrike permanent API token of a user who can see the Account Management space (Wrike → Apps & Integrations → API) |
| `WRIKE_DASH_PASSWORD` | Password readers type to open the dashboard (12+ characters) |
| `WRIKE_ACCOUNT_ALIASES` | Optional JSON with account-name clean-up rules |

The Team filter comes from Wrike user groups (INDIA Consultant Team, LATAM Consultant Team, EUR team). To change the mapping, set the `WRIKE_TEAM_GROUPS` secret to JSON such as `{"INDIA Consultant Team": "India"}`.

Optional repository variables: `WRIKE_HOST` (default `app-eu.wrike.com`), `WRIKE_SPACE` (default `Account Management`).

Until `WRIKE_TOKEN` is set, the workflow deploys the committed `index.html` snapshot.

## Changing the password

Update the `WRIKE_DASH_PASSWORD` secret and run the workflow from the Actions tab. Browsers that chose "keep me signed in" will be asked again.

## Building locally

```bash
pip install cryptography requests
WRIKE_TOKEN=... python refresh_wrike.py
WRIKE_DASH_PASSWORD='...' python build.py
```
