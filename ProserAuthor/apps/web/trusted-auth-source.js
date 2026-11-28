const {
  normalizeIpAddress,
  resolveClientAddress,
  trustedProxies,
} = require('@hivemagnus/hive-common/rate-limit');

function trustedProxyHopCount(rawValue) {
  return Math.min(5, Math.max(0, Number.parseInt(rawValue || '0', 10) || 0));
}

/** A plain IP address (IPv4-mapped IPv6 as IPv4, zone dropped), or '' when it is not one. */
function normalizeIp(value) {
  return normalizeIpAddress(String(value ?? '')) ?? '';
}

let parsedPeers = { config: undefined, proxies: undefined };

/**
 * The configured proxy allowlist, parsed once per distinct value. Any entry
 * that is not an IP address or CIDR range makes the whole list trust nothing.
 */
function configuredProxies(configuredPeers) {
  const config = String(configuredPeers || '');
  if (parsedPeers.config !== config) {
    const entries = config
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    let proxies;
    try {
      proxies = entries.length ? trustedProxies(entries) : undefined;
    } catch {
      proxies = undefined;
    }
    parsedPeers = { config, proxies };
  }
  return parsedPeers.proxies;
}

function trustedProxyPeerAllowed(remoteAddress, configuredPeers) {
  const peer = normalizeIp(remoteAddress);
  const proxies = configuredProxies(configuredPeers);
  return Boolean(peer && proxies && proxies.has(peer));
}

const TRUSTS_NOTHING = trustedProxies(undefined);
// A trusted proxy that sent no X-Forwarded-For, a chain shorter than the hop
// count, or a counted hop that is not an address is refused (400).
const REFUSED = new Set(['proxy_without_forwarding', 'invalid_forwarding']);

/**
 * The sign-in source: the socket peer, or the hop-th X-Forwarded-For entry
 * from the right when the peer is an allowed proxy. Only the counted hops are
 * read; entries further left were written by the client and are ignored.
 */
function resolveTrustedAuthSource(req, configuredHops, configuredPeers) {
  const client = resolveClientAddress({
    peer: req.socket.remoteAddress,
    forwardedFor: req.headers['x-forwarded-for'],
    trusted: configuredProxies(configuredPeers) ?? TRUSTS_NOTHING,
    trustedHops: trustedProxyHopCount(configuredHops),
  });
  return { valid: !REFUSED.has(client.decision), source: client.address };
}

function attachTrustedAuthSource(
  req,
  configuredHops = process.env.LOCAL_AUTH_TRUSTED_PROXY_HOPS,
  configuredPeers = process.env.LOCAL_AUTH_TRUSTED_PROXY_PEERS,
) {
  const resolved = resolveTrustedAuthSource(req, configuredHops, configuredPeers);

  // This header is private to the Node ingress. Always overwrite a value
  // supplied by the client before Next/Auth.js can observe it.
  req.headers['x-proser-auth-source'] = resolved.source;
  return resolved.valid;
}

module.exports = {
  attachTrustedAuthSource,
  resolveTrustedAuthSource,
  trustedProxyHopCount,
  trustedProxyPeerAllowed,
};
