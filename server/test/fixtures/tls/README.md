# Test-only TLS fixture

`cert.pem` / `key.pem` are a **throwaway, self-signed** certificate for
`CN=localhost` / `127.0.0.1`, used only by `test/tls-policy.test.js` to stand up
a local HTTPS server. They protect nothing and must never be used as a real
deployment certificate. They are committed (as Node's own test suite does)
because the `openssl` binary on a developer's PATH varies wildly (one dev box
had OpenSSL 1.0.1h from 2014), so generating at test time isn't reproducible.

Regenerate (valid ~100 years):

```bash
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 36500 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout key.pem -out cert.pem
```
