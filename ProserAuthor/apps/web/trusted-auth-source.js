const { BlockList, isIP } = require('node:net');

function trustedProxyHopCount(rawValue) {
  return Math.min(5, Math.max(0, Number.parseInt(rawValue || '0', 10) || 0));
}

function normalizeIp(value) {
  const withoutZone = String(value || '')
    .trim()
    .split('%')[0];
  const mapped = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped && isIP(mapped[1]) === 4 ? mapped[1] : withoutZone;
}

function trustedProxyPeerAllowed(remoteAddress, configuredPeers) {
  const peer = normalizeIp(remoteAddress);
  const peerFamily = isIP(peer);
  const entries = String(configuredPeers || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!peerFamily || entries.length === 0) return false;

  const blockList = new BlockList();
  try {
    for (const entry of entries) {
      const [rawAddress, rawPrefix, extra] = entry.split('/');
      if (extra !== undefined) return false;
      const address = normalizeIp(rawAddress);
      const family = isIP(address);
      if (!family) return false;
      const type = family === 4 ? 'ipv4' : 'ipv6';
      if (rawPrefix === undefined) {
        blockList.addAddress(address, type);
        continue;
      }
      const prefix = Number(rawPrefix);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128))
        return false;
      blockList.addSubnet(address, prefix, type);
    }
  } catch {
    return false;
  }
  return blockList.check(peer, peerFamily === 4 ? 'ipv4' : 'ipv6');
}

function resolveTrustedAuthSource(req, configuredHops, configuredPeers) {
  const trustedProxyHops = trustedProxyHopCount(configuredHops);
  const socketPeer = normalizeIp(req.socket.remoteAddress) || 'unknown';
  if (trustedProxyHops === 0 || !trustedProxyPeerAllowed(socketPeer, configuredPeers)) {
    return { valid: true, source: socketPeer };
  }

  const rawForwarded = req.headers['x-forwarded-for'];
  if (typeof rawForwarded !== 'string') return { valid: false, source: socketPeer };
  const forwarded = rawForwarded.split(',').map((value) => normalizeIp(value));
  if (forwarded.length < trustedProxyHops || forwarded.some((value) => !value || !isIP(value))) {
    return { valid: false, source: socketPeer };
  }
  return { valid: true, source: forwarded[forwarded.length - trustedProxyHops] };
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
