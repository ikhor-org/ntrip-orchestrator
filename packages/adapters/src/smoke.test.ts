import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cposAdapter,
  getCposStubDisabled,
  getRoutableAdapter,
  isCposRoutingAllowed,
  listRoutableAdapters,
} from './index.js';

test('routable adapters exclude CPOS', () => {
  const types = listRoutableAdapters().map((a) => a.type);
  assert.ok(types.includes('ntrip_basic'));
  assert.ok(!types.includes('cpos_customer'));
  assert.equal(getRoutableAdapter('cpos_customer'), undefined);
});

test('CPOS stub is disabled and not routing-allowed by default', () => {
  assert.equal(cposAdapter.enabled, false);
  assert.equal(getCposStubDisabled().enabled, false);
  assert.equal(isCposRoutingAllowed(), false);
});
