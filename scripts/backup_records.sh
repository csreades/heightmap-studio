#!/usr/bin/env bash
# Mirror export records (the targets of the QR codes printed on bases) and
# saved presets into a private git repo; commits and pushes only when
# something changed. Additive by design: nothing is ever deleted from the
# backup, so a lost or wiped exports/ dir can't propagate deletions.
#   HMS_RECORDS_REPO    local clone (default /root/backups/heightmap-studio-records)
#   HMS_RECORDS_REMOTE  remote cloned on first run
set -euo pipefail
export HOME="${HOME:-/root}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${HMS_RECORDS_REPO:-/root/backups/heightmap-studio-records}"
REMOTE="${HMS_RECORDS_REMOTE:-https://github.com/csreades/heightmap-studio-records.git}"

if [ ! -d "$DEST/.git" ]; then
  mkdir -p "$(dirname "$DEST")"
  git clone -q "$REMOTE" "$DEST" 2>/dev/null
  git -C "$DEST" config user.name "$(git -C "$SRC" config user.name)"
  git -C "$DEST" config user.email "$(git -C "$SRC" config user.email)"
fi
exec 9>"$DEST/.git/backup.lock"
flock -n 9 || exit 0

mkdir -p "$DEST/exports" "$DEST/presets"
cp -p "$SRC"/exports/*.json "$DEST/exports/" 2>/dev/null || true
if [ -f "$SRC/exports.jsonl" ]; then cp -p "$SRC/exports.jsonl" "$DEST/exports.jsonl"; fi
cp -pr "$SRC/presets/." "$DEST/presets/"
if [ ! -f "$DEST/README.md" ]; then
  cat > "$DEST/README.md" <<'MD'
# heightmap-studio records (private backup)

Mirror of the export records behind the QR codes printed on bases
(`exports/<guid>.json`, `exports.jsonl`) and saved presets. Written by
`scripts/backup_records.sh` in heightmap-studio every 15 minutes. To
restore after losing the server: copy `exports/` and `exports.jsonl` back
into the heightmap-studio checkout.
MD
fi

cd "$DEST"
git add -A
git diff --cached --quiet && exit 0
n=$(find exports -maxdepth 1 -name '*.json' | wc -l)
git commit -qm "backup: $n export records ($(date -u +%FT%TZ))"
git push -q origin HEAD
echo "pushed backup: $n export records"
