#!/usr/bin/env bash
# generate-certs.sh — Generate self-signed TLS certificates for local development.
#
# Creates a local CA, then issues server certificates trusted by both
# proser-factory and proser-ui.  The CA cert can be added to your OS or
# browser trust store to silence "untrusted" warnings during development.
#
# Usage:
#   bash scripts/generate-certs.sh           # generates into ./certs/
#   bash scripts/generate-certs.sh /tmp/tls  # custom output directory
#
# Output:
#   <dir>/ca.crt         — CA certificate (add to trust store)
#   <dir>/ca.key         — CA private key
#   <dir>/server.crt     — Server certificate (covers localhost + LAN names)
#   <dir>/server.key     — Server private key

set -euo pipefail

CERT_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/certs}"
DAYS=825  # macOS limit for self-signed certs

mkdir -p "$CERT_DIR"

echo "==> Generating certificates in $CERT_DIR"

# ── 1. Certificate Authority ─────────────────────────────────
if [ ! -f "$CERT_DIR/ca.key" ]; then
  echo "--- Creating Certificate Authority ---"
  openssl genrsa -out "$CERT_DIR/ca.key" 2048
  openssl req -x509 -new -nodes \
    -key "$CERT_DIR/ca.key" \
    -sha256 -days "$DAYS" \
    -out "$CERT_DIR/ca.crt" \
    -subj "/CN=Proser Dev CA/O=Proser/OU=Development"
else
  echo "--- CA already exists, reusing ---"
fi

# ── 2. Server certificate (SAN-based) ────────────────────────
echo "--- Creating server certificate ---"

# Write a SAN config file
cat > "$CERT_DIR/san.cnf" <<EOF
[req]
req_extensions = v3_req
distinguished_name = req_distinguished_name
prompt = no

[req_distinguished_name]
CN = localhost
O  = Proser
OU = Development

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = proser
DNS.3 = *.local
IP.1  = 127.0.0.1
IP.2  = ::1
EOF

openssl genrsa -out "$CERT_DIR/server.key" 2048

openssl req -new \
  -key "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.csr" \
  -config "$CERT_DIR/san.cnf"

openssl x509 -req \
  -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/server.crt" \
  -days "$DAYS" \
  -sha256 \
  -extfile "$CERT_DIR/san.cnf" \
  -extensions v3_req

# Clean up intermediate files
rm -f "$CERT_DIR/server.csr" "$CERT_DIR/san.cnf" "$CERT_DIR/ca.srl"

# Restrict key file permissions
chmod 600 "$CERT_DIR/ca.key" "$CERT_DIR/server.key"
chmod 644 "$CERT_DIR/ca.crt" "$CERT_DIR/server.crt"

echo ""
echo "==> Certificates generated successfully!"
echo ""
echo "Files:"
echo "  CA cert:     $CERT_DIR/ca.crt"
echo "  CA key:      $CERT_DIR/ca.key"
echo "  Server cert: $CERT_DIR/server.crt"
echo "  Server key:  $CERT_DIR/server.key"
echo ""
echo "To trust the CA on this machine (Ubuntu/Debian):"
echo "  sudo cp $CERT_DIR/ca.crt /usr/local/share/ca-certificates/proser-dev-ca.crt"
echo "  sudo update-ca-certificates"
echo ""
echo "Then set in your .env files:"
echo "  TLS_CERT_FILE=$CERT_DIR/server.crt"
echo "  TLS_KEY_FILE=$CERT_DIR/server.key"
