const { createServer } = require('node:https');
const { readFileSync, existsSync } = require('node:fs');
const { parse } = require('node:url');
const next = require('next');
const { attachTrustedAuthSource } = require('./trusted-auth-source');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const tlsEnabled = process.env.TLS_ENABLED === 'true';

const app = next({ dev, hostname, port, dir: __dirname });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  if (tlsEnabled) {
    const certFile = process.env.TLS_CERT_FILE;
    const keyFile = process.env.TLS_KEY_FILE;
    const caFile = process.env.TLS_CA_FILE;

    if (!certFile || !keyFile) {
      console.error('TLS_CERT_FILE and TLS_KEY_FILE required when TLS_ENABLED=true');
      process.exit(1);
    }

    const options = {
      cert: readFileSync(certFile),
      key: readFileSync(keyFile),
    };

    if (caFile && existsSync(caFile)) {
      options.ca = readFileSync(caFile);
    }

    createServer(options, (req, res) => {
      if (!attachTrustedAuthSource(req)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('Invalid forwarding chain');
        return;
      }
      const parsedUrl = parse(req.url, true);
      handle(req, res, parsedUrl);
    }).listen(port, hostname, () => {
      console.log(`> Proser UI ready on https://${hostname}:${port}`);
    });
  } else {
    const { createServer: createHttpServer } = require('node:http');
    createHttpServer((req, res) => {
      if (!attachTrustedAuthSource(req)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('Invalid forwarding chain');
        return;
      }
      const parsedUrl = parse(req.url, true);
      handle(req, res, parsedUrl);
    }).listen(port, hostname, () => {
      console.log(`> Proser UI ready on http://${hostname}:${port}`);
    });
  }
});
