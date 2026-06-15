## File audit and reorganization notes

This document summarizes which top-level files look like AI- or migration-generated helpers vs. core application assets, and how we reorganized the project structure.

### Likely one-off / cleanup-style artifacts

These were created to help migrate or experiment, not required for normal runtime. We did **not** delete them, but we moved them into a more appropriate location.

- **`reorganize-project.js`**
  - Purpose: one-time script to move legacy files (e.g. `server.js`, `client/...`, `migrations/...`) into `src/` and `docs/`.
  - The moves it performs already match the current tree (`src/server/index.js`, `src/client/main/...`, `src/database/...`, `docs/db.md`, etc.).
  - Action: **kept**, but moved to `scripts/reorganize-project.js` as an archived migration helper.

- **`ec2-setup-commands.sh`**
  - Purpose: raw EC2 setup command dump, now superseded by `setup-server.sh`, `DEPLOYMENT.md`, and `QUICK_DEPLOY.md`.
  - Action: **kept**, but moved to `scripts/ec2-setup-commands.sh` for historical reference.

- **`cookies.txt`**
  - Purpose: HTTP cookie jar (likely from `curl`/browser export). Not referenced by code or scripts and not needed at build/runtime.
  - Action: left in place for now; safe to delete later or move under an infra/testing folder if desired.

### AI-assisted but important and integrated

These files are almost certainly AI-authored or heavily AI-assisted, but they are clearly useful and integrated into the workflow, so we **kept** them:

- **`DEPLOYMENT.md`** and **`QUICK_DEPLOY.md`**
  - Detailed and quick deployment guides.
  - Contain a lot of operational knowledge for EC2 + Nginx + PM2 deployment.
  - Action: **kept**, moved under `infra/` (see reorg below) and their internal paths updated.

- **`setup-server.sh`** and **`deploy.sh`**
  - Referenced directly in `QUICK_DEPLOY.md` as the main automation path.
  - Action: **kept**, moved under `scripts/` and docs updated to reference `scripts/...`.

- **`nginx.conf`, `nginx-http-only.conf`, `ecosystem.config.cjs`**
  - Infra configs referenced by deployment docs.
  - Action: **kept**, moved under `infra/` and docs updated accordingly.

### Needs human/data-governance judgment

These are not runtime code, but may be important for operations or research workflows:

- **`participant_credentials.csv`**
  - Likely contains real or template participant credentials.
  - Not required by the application code itself, but may be used by admins/researchers.
  - Recommendation: consider moving out of the repo or into a protected location, rather than deleting, depending on data-governance decisions.

- **`rds-ca.pem`**
  - RDS root certificate, potentially used for TLS DB connections.
  - Not referenced explicitly in the code we inspected, but may still be used in some setups.
  - Recommendation: confirm with whoever set up the database. If it is not in use, it can be moved under something like `config/certs/` or managed outside the repo.

### Reorganization applied

The high-level goal was to reduce root-level clutter and group related concerns while avoiding breakage of build tooling.

We **did not** move core build/tooling configs (`vite*.config.js`, `tailwind.config.js`, `postcss.config.cjs`, `.eslintrc.json`, `.prettierrc`), because many tools discover them by filename at the project root. Moving them would require non-trivial reconfiguration.

Instead, we focused on infra, scripts, and large static assets:

- **New directories**
  - `scripts/` – operational and maintenance scripts.
  - `assets/audio/voices/` – large static audio assets.
  - `infra/` – deployment and operations artifacts (guides and server configs).

- **Moves performed**
  - `reorganize-project.js` → `scripts/reorganize-project.js`
  - `ec2-setup-commands.sh` → `scripts/ec2-setup-commands.sh`
  - `deploy.sh` → `scripts/deploy.sh`
  - `setup-server.sh` → `scripts/setup-server.sh`
  - `OAI_VOICES/*` → `assets/audio/voices/*` (and the original `OAI_VOICES` folder is no longer used)
  - `DEPLOYMENT.md` → `infra/DEPLOYMENT.md`
  - `QUICK_DEPLOY.md` → `infra/QUICK_DEPLOY.md`
  - `nginx.conf` → `infra/nginx.conf`
  - `nginx-http-only.conf` → `infra/nginx-http-only.conf`
  - `ecosystem.config.cjs` → `infra/ecosystem.config.cjs`

Deployment docs were updated so that all path references (e.g. to `setup-server.sh`, `deploy.sh`, `nginx.conf`, `ecosystem.config.cjs`) match the new locations.
