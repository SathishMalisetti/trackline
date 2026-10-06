const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertOrigin } = require('../shared/family-session');
const published = 'https://victorious-field-093009200.7.azurestaticapps.net';
const request = (origin, host = 'internal.azurewebsites.net', forwarded) => ({ headers: { origin, host, ...(forwarded ? { 'x-forwarded-host': forwarded } : {}) } });
test('published app origin works when Azure proxies the API to an internal host', () => {
  assert.doesNotThrow(() => assertOrigin(request(published)));
  assert.doesNotThrow(() => assertOrigin(request(published, 'internal.azurewebsites.net', 'internal-proxy')));
});
test('unrelated Azure sites, lookalike domains, HTTP and malformed origins remain denied', () => {
  for (const origin of ['https://attacker.azurestaticapps.net', published + '.attacker.example', published.replace('https:', 'http:'), 'null', 'invalid']) {
    assert.throws(() => assertOrigin(request(origin)), error => error.status === 403);
  }
});
test('direct local and forwarded same-host requests still work', () => {
  assert.doesNotThrow(() => assertOrigin(request('http://localhost:5600', 'localhost:5600')));
  assert.doesNotThrow(() => assertOrigin(request('https://app.example', 'internal', 'app.example')));
});
test('configured app origin overrides defaults and normalizes a trailing slash', () => {
  const saved = process.env.TRACKLINE_APP_ORIGIN;
  try {
    process.env.TRACKLINE_APP_ORIGIN = 'https://custom.example/';
    assert.doesNotThrow(() => assertOrigin(request('https://custom.example')));
    assert.throws(() => assertOrigin(request(published)), error => error.status === 403);
    assert.throws(() => assertOrigin(request('https://another.example', 'another.example')), error => error.status === 403);
    process.env.TRACKLINE_APP_ORIGIN = 'invalid';
    assert.throws(() => assertOrigin(request(published)), error => error.status === 503);
  } finally {
    if (saved === undefined) delete process.env.TRACKLINE_APP_ORIGIN; else process.env.TRACKLINE_APP_ORIGIN = saved;
  }
});
