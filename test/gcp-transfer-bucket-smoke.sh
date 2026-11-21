# Run from a private test directory containing the rendered "workload" script.
# The caller supplies the genuine binary; only the two cloud endpoints are fixtures.
set -eu
umask 077
export LC_ALL=C
fixture=$(pwd)
real_rclone=$(command -v rclone)
[ -x "$real_rclone" ]
"$real_rclone" version | grep -q '^rclone v1.68.2$'
mkdir bin source target
export HV_SOURCE_BUCKET=railway-docs HV_TARGET_BUCKET=gcp-docs
mkdir "source/$HV_SOURCE_BUCKET" "target/$HV_TARGET_BUCKET"
printf 'same' > "source/$HV_SOURCE_BUCKET/existing"
printf 'next' > "source/$HV_SOURCE_BUCKET/remaining"
printf 'same' > "target/$HV_TARGET_BUCKET/existing"
printf 'target only' > "target/$HV_TARGET_BUCKET/extra"
printf '\000\001\037\377' > "source/$HV_SOURCE_BUCKET/Private & unusual [filename]"
printf '%s\n' "$real_rclone" > real-rclone
cat > local-config <<LOCAL
[source]
type = alias
remote = $fixture/source
[destination]
type = alias
remote = $fixture/target
LOCAL
cat > bin/wget <<'FAKE_GOOGLE'
#!/bin/sh
set -eu
base=$(dirname "$(dirname "$0")")
out=
body=
while [ "$#" -gt 1 ]; do
  case "$1" in -O) out=$2; shift;; --post-file=*) body=${1#--post-file=};; esac
  shift
done
case "$1" in
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token)
    printf '{"access_token":"Original.synthetic-token+/="}' > "$out";;
  https://sts.googleapis.com/v1/token)
    [ -f "$body" ]
    cp "$body" "$base/observed-sts-request"
    [ ! -f "$base/refuse-token" ] || exit 1
    printf '{"access_token":"Restricted.synthetic-token","token_type":"Bearer"}' > "$out";;
  *) exit 1;;
esac
FAKE_GOOGLE
cat > bin/rclone <<'TEST_REMOTES'
#!/bin/sh
set -eu
base=$(dirname "$(dirname "$0")")
[ "$1" = --config ]
grep -qx 'type = google cloud storage' "$2"
grep -qx 'env_auth = false' "$2"
grep -qx 'token = {"access_token":"Restricted.synthetic-token","token_type":"Bearer"}' "$2"
grep -qx 'endpoint = https://t3.storageapi.dev' "$2"
grep -qx 'secret_access_key = source-secret' "$2"
[ -z "${HV_RAILWAY_CONFIG-}" ]
shift 2
printf '%s\n' "$@" >> "$base/arguments"
[ ! -f "$base/expire-token" ] || exit 1
real=$(cat "$base/real-rclone")
# Interrupt the fixture after one real file has committed at the destination.
if [ -f "$base/interrupt-copy" ] && [ "$3" = copy ]; then
  "$real" --config "$base/local-config" copyto 'source:railway-docs/Private & unusual [filename]' 'destination:gcp-docs/Private & unusual [filename]'
  exit 1
fi
exec "$real" --config "$base/local-config" "$@"
TEST_REMOTES
chmod 700 bin/rclone bin/wget
PATH="$fixture/bin:$PATH"
export PATH
HV_RAILWAY_CONFIG=$(printf '%s\n' railway-bucket-v1 "$HV_SOURCE_BUCKET" https://t3.storageapi.dev auto virtual source-id source-secret 3 12)
export HV_RAILWAY_CONFIG
# An unavailable or expired restricted credential must leave the destination unmodified.
touch refuse-token
if sh workload > output 2>&1; then exit 1; fi
[ ! -e arguments ] && [ ! -e "target/$HV_TARGET_BUCKET/Private & unusual [filename]" ]
rm refuse-token
touch expire-token
if sh workload > output 2>&1; then exit 1; fi
[ ! -e "target/$HV_TARGET_BUCKET/Private & unusual [filename]" ]
rm expire-token
# A source object omitted by the file listing cannot silently pass as a complete copy.
printf 'new' > "source/$HV_SOURCE_BUCKET/unreviewed"
if sh workload > output 2>&1; then exit 1; fi
[ "$(cat output)" = 'The documents do not match the reviewed Railway object count and byte total.' ]
[ ! -e "target/$HV_TARGET_BUCKET/unreviewed" ]
rm "source/$HV_SOURCE_BUCKET/unreviewed"
# A same-size mismatch must be detected by bytes before adding new documents.
printf 'else' > "target/$HV_TARGET_BUCKET/existing"
if sh workload > output 2>&1; then exit 1; fi
[ "$(cat "target/$HV_TARGET_BUCKET/existing")" = else ]
[ ! -e "target/$HV_TARGET_BUCKET/Private & unusual [filename]" ]
[ "$(cat output)" = 'The existing documents could not be verified. The copy stopped.' ]
printf 'same' > "target/$HV_TARGET_BUCKET/existing"
touch interrupt-copy
if sh workload > output 2>&1; then exit 1; fi
[ "$(cat output)" = 'Some missing documents could not be added.' ]
cmp "source/$HV_SOURCE_BUCKET/Private & unusual [filename]" "target/$HV_TARGET_BUCKET/Private & unusual [filename]"
[ ! -e "target/$HV_TARGET_BUCKET/remaining" ]
rm interrupt-copy
sh workload > output 2>&1
cmp "source/$HV_SOURCE_BUCKET/Private & unusual [filename]" "target/$HV_TARGET_BUCKET/Private & unusual [filename]"
[ "$(cat "target/$HV_TARGET_BUCKET/extra")" = 'target only' ]
[ "$(cat output)" = 'Every source document matched the destination by bytes.' ]
[ "$(cat "target/$HV_TARGET_BUCKET/remaining")" = next ]
# Only the synthetic endpoint fixture and prepared config ever saw secret text.
if grep -Eq 'source-secret|synthetic-token|Private & unusual' arguments output; then exit 1; fi
# A second run accepts every matching source document and preserves target extras.
sh workload > output 2>&1
[ "$(cat "target/$HV_TARGET_BUCKET/extra")" = 'target only' ]
cat observed-sts-request
