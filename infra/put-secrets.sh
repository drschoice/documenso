#!/usr/bin/env bash
#
# Load Documenso runtime secrets into AWS Secrets Manager from a local env file
# and the signing certificate.
#
#   - Reads KEY=VALUE pairs from an env file (default: .env.prod)
#   - base64-encodes the signing cert into NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS
#   - defaults NEXT_PRIVATE_DIRECT_DATABASE_URL to NEXT_PRIVATE_DATABASE_URL if unset
#   - verifies every key the task definition references is present & non-empty
#   - writes the whole set to the Secrets Manager secret used by the task def
#
# Values are read locally and sent only to YOUR AWS account. The env file and the
# cert are git-ignored and must never be committed.
#
# Usage:
#   export AWS_REGION=us-east-1
#   ./infra/put-secrets.sh [ENV_FILE] [CERT_FILE] [SECRET_ID]
# Defaults: ENV_FILE=.env.prod  CERT_FILE=cert.p12  SECRET_ID=documenso/app
#
set -euo pipefail

ENV_FILE="${1:-.env.prod}"
CERT_FILE="${2:-cert.p12}"
SECRET_ID="${3:-documenso/app}"
PRIMARY="${PRIMARY:-.aws/primary-container.json}"
REGION="${AWS_REGION:?Set AWS_REGION first, e.g. export AWS_REGION=us-east-1}"

for c in jq aws base64 awk; do
  command -v "$c" >/dev/null 2>&1 || { echo "Missing required command: $c" >&2; exit 1; }
done
[ -f "$ENV_FILE" ]  || { echo "Env file not found: $ENV_FILE" >&2; exit 1; }
[ -f "$CERT_FILE" ] || { echo "Cert file not found: $CERT_FILE" >&2; exit 1; }
[ -f "$PRIMARY" ]   || { echo "Primary-container spec not found: $PRIMARY" >&2; exit 1; }

# 1. Parse the env file into a JSON object. Split on the FIRST '=', skip blanks
#    and #comments, and strip one layer of surrounding double quotes.
env_json="$(
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    { eq = index($0, "="); if (eq == 0) next;
      k = substr($0, 1, eq-1); v = substr($0, eq+1);
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", k);
      printf "%s\t%s\n", k, v }
  ' "$ENV_FILE" \
  | jq -R -s '
      split("\n") | map(select(length > 0))
      | map(index("\t") as $i
            | { (.[:$i]): (.[$i+1:] | sub("^\"";"") | sub("\"$";"")) })
      | add'
)"

# 2. base64 the certificate (GNU coreutils uses -w0; BSD/macOS has no -w flag).
if base64 --help >/dev/null 2>&1 && base64 --help 2>&1 | grep -q -- '-w'; then
  cert_b64="$(base64 -w0 "$CERT_FILE")"
else
  cert_b64="$(base64 "$CERT_FILE" | tr -d '\n')"
fi

# 3. Add the cert and default the direct DB URL to the pooled one if absent.
secret_json="$(
  jq -n --argjson e "$env_json" --arg cert "$cert_b64" '
    $e
    | .NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS = $cert
    | (if (.NEXT_PRIVATE_DIRECT_DATABASE_URL // "") == ""
         then .NEXT_PRIVATE_DIRECT_DATABASE_URL = (.NEXT_PRIVATE_DATABASE_URL // "")
         else . end)'
)"

# 4. Verify every key the primary-container references exists and is non-empty.
missing=()
while IFS= read -r key; do
  val="$(jq -r --arg k "$key" '.[$k] // empty' <<<"$secret_json")"
  [ -n "$val" ] || missing+=("$key")
done < <(jq -r '.secrets[].name' "$PRIMARY")

if [ "${#missing[@]}" -gt 0 ]; then
  echo "These keys are required by $PRIMARY but missing/empty in $ENV_FILE:" >&2
  printf '   - %s\n' "${missing[@]}" >&2
  echo "Add them to $ENV_FILE (or remove them from primary-container.json \"secrets\"), then re-run." >&2
  exit 1
fi

# Keep only the keys the primary-container consumes (drops e.g. POSTGRES_*/PORT,
# which are only used by local docker-compose, not the ECS app).
wanted="$(jq -r '.secrets[].name' "$PRIMARY" | jq -R . | jq -s .)"
secret_json="$(jq --argjson keys "$wanted" 'with_entries(select(.key as $k | $keys | index($k)))' <<<"$secret_json")"

# 5. Write to Secrets Manager via a locked-down temp file so no secret ever
#    appears in the process argument list.
umask 077
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
printf '%s' "$secret_json" > "$tmp"

aws secretsmanager put-secret-value \
  --region "$REGION" \
  --secret-id "$SECRET_ID" \
  --secret-string "file://$tmp" >/dev/null

echo "✓ Loaded $(jq 'keys | length' <<<"$secret_json") keys into secret '$SECRET_ID' in $REGION."
echo "  (Includes $(jq -r '.secrets | length' "$PRIMARY") keys the Express service's primary container consumes.)"
