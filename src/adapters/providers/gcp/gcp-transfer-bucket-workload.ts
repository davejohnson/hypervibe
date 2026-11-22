// Docker Hub rclone/rclone:1.68.2, Linux amd64 manifest.
export const BUCKET_COPY_IMAGE =
  'docker.io/rclone/rclone@sha256:41388051445353047e007aa8978ebe224a1efdd6edc55fb746656d19ddf59de2';

// The future executor must bind HV_RAILWAY_CONFIG to an approved numbered Secret
// Manager version. Its lines are the schema, bucket, HTTPS endpoint, region, URL
// style, S3 access key ID, secret key, object count and total bytes. The last two
// must come from fresh Railway bucketInstanceDetails for the reviewed instance.
export const BUCKET_COPY_SCRIPT = String.raw`set -ef
exec 2>/dev/null
export LC_ALL=C
umask 077
fail() { echo "$1"; exit 1; }
config_error() { fail 'The reviewed Railway source configuration is required.'; }
valid_bucket() {
  case "$1" in ''|*[!a-z0-9._-]*|[!a-z0-9]*|*[!a-z0-9]) return 1;; esac
}
valid_bucket "$HV_SOURCE_BUCKET" && valid_bucket "$HV_TARGET_BUCKET" || config_error
[ -n "$HV_RAILWAY_CONFIG" ] || config_error
{
  IFS= read -r schema && IFS= read -r bucket && IFS= read -r endpoint &&
  IFS= read -r region && IFS= read -r style && IFS= read -r key &&
  IFS= read -r secret && IFS= read -r count && IFS= read -r bytes && ! IFS= read -r extra
} <<HV_SOURCE_INPUT || config_error
$HV_RAILWAY_CONFIG
HV_SOURCE_INPUT
unset HV_RAILWAY_CONFIG
[ "$schema" = railway-bucket-v1 ] && [ "$bucket" = "$HV_SOURCE_BUCKET" ] || config_error
case "$endpoint" in
  https://t3.storageapi.dev|https://storage.railway.app) ;;
  *) config_error;;
esac
case "$region" in ''|*[!A-Za-z0-9-]*) config_error;; esac
case "$style" in path) path_style=true;; virtual) path_style=false;; *) config_error;; esac
case "$key" in ''|*[!A-Za-z0-9_+=./-]*) config_error;; esac
case "$secret" in ''|*[!A-Za-z0-9_+=./-]*) config_error;; esac
case "$count" in ''|*[!0-9]*) config_error;; esac
case "$bytes" in ''|*[!0-9]*) config_error;; esac

work=$(mktemp -d) || fail 'Private working storage is unavailable.'
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
auth_error() { fail 'A restricted Google Cloud copy token could not be obtained.'; }

# GCS requires both create and delete permission to replace an object. Limit
# even a concurrently broadened job identity to create and view on this bucket.
# https://cloud.google.com/iam/docs/create-downscoped-short-lived-credentials
# https://cloud.google.com/storage/docs/access-control/iam-permissions
metadata_url=http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
wget -q -T 15 -O "$work/identity" --header='Metadata-Flavor: Google' "$metadata_url" || auth_error
token() {
  tr -d '[:space:]' < "$1" | sed -n 's/^.*"access_token":"\([A-Za-z0-9._~+=\/-][A-Za-z0-9._~+=\/-]*\)".*$/\1/p'
}
original=$(token "$work/identity")
[ -n "$original" ] || auth_error
urlencode() { od -An -tx1 -v | tr -d ' \n' | sed 's/../%&/g'; }
resource="//storage.googleapis.com/projects/_/buckets/$HV_TARGET_BUCKET"
boundary=$(printf '{"accessBoundary":{"accessBoundaryRules":[{"availableResource":"%s","availablePermissions":["inRole:roles/storage.objectCreator"]},{"availableResource":"%s","availablePermissions":["inRole:roles/storage.objectViewer"]}]}}' "$resource" "$resource" | urlencode)
{
  printf 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange&requested_token_type=urn:ietf:params:oauth:token-type:access_token&subject_token_type=urn:ietf:params:oauth:token-type:access_token&subject_token='
  printf '%s' "$original" | urlencode
  printf '&options=%s' "$boundary"
} > "$work/request"
wget -q -T 30 -O "$work/restricted" --header='Content-Type: application/x-www-form-urlencoded' \
  --post-file="$work/request" https://sts.googleapis.com/v1/token || auth_error
restricted=$(token "$work/restricted")
[ -n "$restricted" ] && [ "$restricted" != "$original" ] || auth_error
rm -f "$work/identity" "$work/request" "$work/restricted"
unset original

cat > "$work/rclone.conf" <<HV_RCLONE
[source]
type = s3
provider = Other
endpoint = $endpoint
region = $region
force_path_style = $path_style
access_key_id = $key
secret_access_key = $secret
no_check_bucket = true
encoding = None
[destination]
type = google cloud storage
bucket_policy_only = true
no_check_bucket = true
encoding = None
env_auth = false
token = {"access_token":"$restricted","token_type":"Bearer"}
HV_RCLONE
unset key secret restricted
# Only fixed bucket names and flags enter argv. Provider diagnostics can contain
# customer object names and are never emitted by this workload.
run_rclone() {
  env -i PATH="$PATH" rclone --config "$work/rclone.conf" --retries 1 --no-unicode-normalization \
    "$@" 2>/dev/null
}
source_inventory() {
  observed=$(run_rclone size --json "source:$HV_SOURCE_BUCKET") &&
    [ "$observed" = "{\"count\":$count,\"bytes\":$bytes,\"sizeless\":0}" ]
}
transfer() {
  run_rclone "$@" "source:$HV_SOURCE_BUCKET" "destination:$HV_TARGET_BUCKET" >/dev/null
}
source_inventory || fail 'The documents do not match the reviewed Railway object count and byte total.'
if ! transfer check --download --one-way --differ "$work/conflicts" --missing-on-dst "$work/missing" --error "$work/errors"; then
  [ ! -s "$work/conflicts" ] && [ ! -s "$work/errors" ] && [ -s "$work/missing" ] ||
    fail 'The existing documents could not be verified. The copy stopped.'
fi
transfer copy --ignore-existing || fail 'Some missing documents could not be added.'
transfer check --download --one-way || fail 'The copied documents did not pass byte verification.'
source_inventory || fail 'The source inventory changed during the copy.'
echo 'Every source document matched the destination by bytes.'
`;
