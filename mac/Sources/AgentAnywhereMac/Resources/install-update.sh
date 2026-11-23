#!/bin/sh
# Invoked with argv by Updater after bridge shutdown. No eval and no elevated privileges.
set -eu
pid="$1"
destination="$2"
stage="$3"
candidate="$stage/AgentAnywhere.app"
backup="$stage/previous.app"
case "$pid" in ''|*[!0-9]*) exit 1 ;; esac
test -d "$candidate"
test -d "$destination"
test ! -e "$backup"
touch "$stage/ready"

# Bound the wait: a refused quit must leave the installed app untouched.
attempt=0
while kill -0 "$pid" 2>/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 120 ]; then
        echo "Update aborted: the original app did not exit. Staged files: $stage"
        exit 1
    fi
    sleep 1
done

restore() {
    if [ -d "$backup" ]; then
        if [ -e "$destination" ]; then
            /bin/mv "$destination" "$stage/failed.app" || return 1
        fi
        /bin/mv "$backup" "$destination" || return 1
        /usr/bin/open "$destination" || true
        echo "Update failed; restored the previous app. Details: $stage"
    fi
}
trap 'restore; exit 1' HUP INT TERM
if ! /bin/mv "$destination" "$backup"; then
    echo "Update failed: could not move the original app."
    /usr/bin/open "$destination" || true
    exit 1
fi
if ! /bin/mv "$candidate" "$destination"; then
    restore
    exit 1
fi
if ! /usr/bin/open "$destination"; then
    restore
    exit 1
fi
trap - HUP INT TERM
echo "Update installed. Previous app retained at $backup"
# Keep the previous app for manual recovery; launch success is not a health check.
