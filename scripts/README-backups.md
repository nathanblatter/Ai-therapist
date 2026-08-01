# AI-Therapist backups & restore test (ai-therapist-97)

Encrypted, off-box nightly backup of the `ai_therapist` Postgres database and
the MinIO `ai-therapist-recordings` bucket. Mirrors the proven flightdeck backup
pattern on this Mac Mini, but adds **asymmetric (age) encryption** because
therapy data is far more sensitive.

Everything lives under `~/docker-services/` — never inside this repo or on
`~/Desktop` (which macOS can sync to iCloud). Only the files committed here
(`backup-ai-therapist.sh`, `com.nathan.ai-therapist-backup.plist`, this doc) are
in the repo; installation is a host step, documented below.

## Files in the repo

| File | Purpose |
|---|---|
| `scripts/backup-ai-therapist.sh` | The nightly backup script (safe to run by hand). |
| `scripts/com.nathan.ai-therapist-backup.plist` | launchd job, fires 04:10 daily. |
| `scripts/README-backups.md` | This doc (install + restore-test procedure). |

## One-time host setup

1. **Install age** (verified NOT currently installed):
   ```sh
   brew install age
   ```
2. **Generate the keypair OFF this machine** (or generate here, then delete the
   private key from here after copying it off). Store the private key in a
   password manager AND printed:
   ```sh
   age-keygen -o ai-therapist-backup.key   # contains the age1... public + AGE-SECRET-KEY private
   ```
   Put ONLY the `age1...` public recipient string into the env file below. The
   private key must never live on the Mac Mini.
3. **Create the env file** `~/docker-services/ai-therapist-backup.env` (chmod 600):
   ```sh
   AGE_RECIPIENT=age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   BACKUP_DEST=root@imac-nas:/mnt/nas/backups/ai-therapist/
   MINIO_ROOT_USER=<minio user>
   MINIO_ROOT_PASSWORD=<minio password>
   ```
   `BACKUP_DEST` reuses the same NAS + Tailscale + SSH key setup flightdeck
   already uses (BatchMode SSH, key already trusted by imac-nas).
4. **Make the script executable** (committed with +x, but verify):
   ```sh
   chmod +x ~/Desktop/Ai-therapist/scripts/backup-ai-therapist.sh
   ```
5. **Install the launchd job** (do NOT commit the installed copy; this is a host
   action):
   ```sh
   cp ~/Desktop/Ai-therapist/scripts/com.nathan.ai-therapist-backup.plist \
      ~/Library/LaunchAgents/com.nathan.ai-therapist-backup.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nathan.ai-therapist-backup.plist
   # kickstart once to verify it runs cleanly:
   launchctl kickstart -k gui/$(id -u)/com.nathan.ai-therapist-backup
   tail -f ~/docker-services/ai-therapist-backups.log
   ```
   To uninstall: `launchctl bootout gui/$(id -u)/com.nathan.ai-therapist-backup`.

### Notes / gotchas

- Docker path is hardcoded `/usr/local/bin/docker` (matches
  `verify-flightdeck-backup.sh`). If Docker Desktop moves to
  `/opt/homebrew/bin/docker`, update the script.
- `age` path is `/opt/homebrew/bin/age` (Apple Silicon Homebrew).
- The backup uses `pg_dump ... ai_therapist` (single DB) — NEVER `pg_dumpall` —
  because `docker-services-postgres-1` is shared with other projects.
- Local staging pruned at 14 days, remote at 60 days (same windows as flightdeck).

## Restore-test procedure (quarterly, or automate on a monthly launchd like `verify-flightdeck-backup.sh`)

1. Copy the newest `ai-therapist-db-*.sql.gz.age` to the machine holding the age
   private key (or bring the key to the Mini for the test only — then remove it).
2. Decrypt + decompress:
   ```sh
   age -d -i ai-therapist-backup.key ai-therapist-db-<stamp>.sql.gz.age | gunzip > restore.sql
   ```
3. Spin up a THROWAWAY postgres matching the prod major version (never restore
   into the shared container):
   ```sh
   docker exec docker-services-postgres-1 postgres --version   # note the major
   docker run --rm -d --name att-verify -e POSTGRES_PASSWORD=x -p 55441:5432 postgres:<major>
   ```
4. Load + sanity-check:
   ```sh
   PGPASSWORD=x createdb -h localhost -p 55441 -U postgres ai_therapist_verify
   PGPASSWORD=x psql -h localhost -p 55441 -U postgres -d ai_therapist_verify -f restore.sql
   PGPASSWORD=x psql -h localhost -p 55441 -U postgres -d ai_therapist_verify -c \
     "SELECT COUNT(*) FROM therapy_sessions;
      SELECT MAX(created_at) FROM messages;          -- must be within ~48h of dump stamp
      SELECT COUNT(*) FROM research_pseudonyms;"
   docker rm -f att-verify
   ```
5. Recordings:
   ```sh
   age -d -i ai-therapist-backup.key ai-therapist-recordings-<stamp>.tar.gz.age | tar -tzf - | head
   ```
   Spot-play one WAV; cross-check the object count against
   `SELECT COUNT(*) FROM therapy_sessions WHERE recording_object_key IS NOT NULL`.
6. Log the result. On failure, file an urgent flightdeck bug on the
   `ai-therapist` board (same failure hook `verify-flightdeck-backup.sh` uses).
