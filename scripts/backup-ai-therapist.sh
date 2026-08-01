#!/bin/zsh
# Nightly encrypted off-box backup of the ai-therapist Postgres DB and the
# MinIO recordings bucket (ai-therapist-97). Run by launchd
# com.nathan.ai-therapist-backup; safe to run by hand.
#
# Requires in ~/docker-services/ai-therapist-backup.env:
#   AGE_RECIPIENT=age1...            (public key only -- private key is OFF-BOX)
#   BACKUP_DEST=root@imac-nas:/mnt/nas/backups/ai-therapist/
#   MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=...
#
# Encryption is asymmetric (age): this host only ever holds the PUBLIC recipient
# key, so a stolen backup box or NAS cannot decrypt. Generate the keypair once,
# OFF this machine, and store the private key in a password manager + printed:
#   age-keygen -o ai-therapist-backup.key   # keep .key OFF-box; put "age1..." in the env
# Documented symmetric fallback (weaker operationally) if age is unacceptable:
#   openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass file:<keyfile>
set -euo pipefail

ENVFILE="$HOME/docker-services/ai-therapist-backup.env"
STAGE="$HOME/docker-services/ai-therapist-backups"     # NOT in the repo, NOT on Desktop
LOG="$HOME/docker-services/ai-therapist-backups.log"
DOCKER=/usr/local/bin/docker
AGE=/opt/homebrew/bin/age
STAMP=$(date -u '+%Y%m%d-%H%M%S')

source "$ENVFILE"
mkdir -p "$STAGE"

{
  echo "== backup $STAMP"

  # 1. Postgres: dump only the ai_therapist DB, gzip, age-encrypt. Never
  #    touches the other databases in the shared container.
  $DOCKER exec docker-services-postgres-1 \
    pg_dump -U postgres --no-owner ai_therapist \
    | gzip | $AGE -r "$AGE_RECIPIENT" \
    > "$STAGE/ai-therapist-db-$STAMP.sql.gz.age"

  # 2. MinIO recordings bucket: mirror via a throwaway mc container on the
  #    shared docker network, then tar + encrypt. Incremental at the mirror
  #    level (mc mirror --overwrite copies only changes into the cache dir).
  MIRROR="$STAGE/.recordings-mirror"
  mkdir -p "$MIRROR"
  $DOCKER run --rm --network docker-services_default \
    -v "$MIRROR":/backup --entrypoint sh minio/mc -c \
    "mc alias set src http://minio:9000 '$MINIO_ROOT_USER' '$MINIO_ROOT_PASSWORD' >/dev/null \
     && mc mirror --overwrite --remove src/ai-therapist-recordings /backup"
  tar -C "$MIRROR" -cf - . | gzip | $AGE -r "$AGE_RECIPIENT" \
    > "$STAGE/ai-therapist-recordings-$STAMP.tar.gz.age"

  # 3. Push off-box (Tailscale/NAS), prune local 14d / remote 60d.
  # Off-box push is non-fatal: local encrypted backups must survive a dead/
  # renamed NAS (imac-nas was found unresolvable 2026-07-31), and local prune
  # must still run or the Mini fills up.
  if /usr/bin/rsync -av --timeout=300 \
    -e "/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=15" \
    "$STAGE/" --exclude '.recordings-mirror' "$BACKUP_DEST"; then
    /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=15 "${BACKUP_DEST%%:*}" \
      "find ${BACKUP_DEST#*:} -name 'ai-therapist-*.age' -mtime +60 -delete" || true
  else
    echo "WARN: off-box push to $BACKUP_DEST failed -- backups are LOCAL-ONLY tonight"
  fi
  find "$STAGE" -name 'ai-therapist-*.age' -mtime +14 -delete

  echo "== ok $(date -u '+%Y-%m-%d %H:%M:%S')"
} >>"$LOG" 2>&1
