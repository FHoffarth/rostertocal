#!/usr/bin/env bash
# Generate a local CA and a server certificate for on-device validation.
#
# Everything stays on this machine and this LAN: the CA is created here,
# used here, and trusted only by the phones you install it on. No
# third-party service, no tunnel, nothing hosted.
#
# Run from the project root, in Git Bash:
#     bash validation/make-cert.sh
#
# Output (all gitignored - the keys are private):
#     validation/certs/ca.crt       <- install THIS on the phone
#     validation/certs/server.crt   <- served by vite preview
#     validation/certs/server.key   <- served by vite preview
set -euo pipefail

CERT_DIR="$(cd "$(dirname "$0")" && pwd)/certs"
DAYS_CA=1825
DAYS_LEAF=825   # Apple rejects server certs valid for longer than 825 days

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

# --- collect the addresses the phone will actually dial -----------------
# PowerShell enumerates every adapter reliably; parsing ipconfig misses
# adapters whose labels are localised.
IPS=$(
  powershell.exe -NoProfile -Command \
    "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.IPAddress -notlike '127.*' -and \$_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress" \
    2>/dev/null | tr -d '\r' | tr -d ' ' || true
)
[ -n "${LAN_IP:-}" ] && IPS=$(printf '%s\n%s\n' "$IPS" "$LAN_IP")

if [ -z "$(printf '%s' "$IPS" | tr -d '[:space:]')" ]; then
  echo "No LAN IPv4 address found. Retry as: LAN_IP=192.168.x.y bash $0" >&2
  exit 1
fi

SAN="DNS:localhost,IP:127.0.0.1"
for ip in $IPS; do
  SAN="$SAN,IP:$ip"
done
echo "Certificate will cover: $SAN"

# MSYS_NO_PATHCONV stops Git Bash rewriting an openssl /CN=... subject
# into a Windows path.
export MSYS_NO_PATHCONV=1

# --- certificate authority ----------------------------------------------
if [ ! -f ca.key ]; then
  openssl genrsa -out ca.key 2048 2>/dev/null
  openssl req -x509 -new -nodes -key ca.key -sha256 -days "$DAYS_CA" -out ca.crt \
    -subj "/CN=RosterToCal Local Validation CA/O=RosterToCal local only" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  echo "created a new local CA"
else
  echo "reusing the existing local CA (delete validation/certs to start over)"
fi

# --- server certificate --------------------------------------------------
openssl genrsa -out server.key 2048 2>/dev/null
openssl req -new -key server.key -out server.csr -subj "/CN=rostertocal-local"
printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$SAN" > leaf.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days "$DAYS_LEAF" -sha256 -extfile leaf.ext
rm -f server.csr leaf.ext

echo
echo "Files in validation/certs:"
ls -1 ca.crt server.crt server.key
echo
echo "CA fingerprint (check this matches on the phone):"
openssl x509 -in ca.crt -noout -fingerprint -sha256
echo
echo "Server cert covers:"
openssl x509 -in server.crt -noout -ext subjectAltName | tail -1
echo
echo "Next:  npm run validate:https"
