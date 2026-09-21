import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decryptJson,
  encryptJson,
  generateKekHex,
  parseKek,
} from './vault.js';
import { assertNoLocationFields, buildMeteringEvent } from './metering.js';
import { MeteringValidationError } from './metering.js';

test('vault AES-256-GCM round-trip', () => {
  const kek = parseKek(generateKekHex());
  const secret = { username: 'up-user', password: 'up-pass-secret' };
  const blob = encryptJson(kek, secret);
  assert.ok(blob.ciphertext.length > 0);
  assert.equal(blob.nonce.length, 12);
  const out = decryptJson<typeof secret>(kek, blob);
  assert.deepEqual(out, secret);
});

test('metering rejects location fields', () => {
  assert.throws(
    () => assertNoLocationFields({ session_id: 'x', lat: 1.2 }),
    MeteringValidationError,
  );
  const ev = buildMeteringEvent({
    id: '1',
    org_id: '00000000-0000-4000-8000-000000000001',
    event_type: 'usage.session_started',
    payload_json: {
      org_id: '00000000-0000-4000-8000-000000000001',
      device_id: 'd1',
      session_id: 's1',
      upstream_id: 'u1',
      ts: new Date().toISOString(),
    },
  });
  assert.ok(!('lat' in ev.payload_json));
  assert.ok(!('lon' in ev.payload_json));
});
