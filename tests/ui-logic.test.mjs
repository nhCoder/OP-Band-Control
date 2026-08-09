import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backendProfileId,
  CPH2747_CATALOG,
  profileOperation,
  SUPPLEMENTAL_DOWNLINK,
  uniqueBands,
} from '../webroot/js/catalog.js';
import { validateSelection } from '../webroot/js/validation.js';
import { normalizeSubscriptions, subscriptionLabel } from '../webroot/js/subscriptions.js';

test('CPH2747 catalog contains the official headline LTE and NR bands', () => {
  assert.ok(CPH2747_CATALOG.lte.includes(1));
  assert.ok(CPH2747_CATALOG.lte.includes(71));
  assert.ok(CPH2747_CATALOG.nr.includes(41));
  assert.ok(CPH2747_CATALOG.nr.includes(78));
});

test('supplemental-downlink bands are tracked explicitly', () => {
  assert.deepEqual(SUPPLEMENTAL_DOWNLINK.lte, [32]);
  assert.deepEqual(SUPPLEMENTAL_DOWNLINK.nr, [75]);
});

test('uniqueBands rejects malformed and out-of-range values', () => {
  assert.deepEqual(uniqueBands(['3', 1, 3, 0, -1, 'bad', 262, 78]), [1, 3, 78]);
});

test('UI profile ids match backend allowlist ids', () => {
  assert.equal(backendProfileId('lte-plus'), 'lte-plus');
  assert.equal(backendProfileId('nsa'), 'nsa');
  assert.equal(backendProfileId('coverage'), 'coverage');
  assert.equal(backendProfileId('custom'), 'custom');
});

test('LTE+ safeguard preserves automatic selection instead of guessing CA bands', () => {
  assert.equal(profileOperation('lte-plus'), 'preserve');
  assert.equal(profileOperation('adaptive'), 'reset');
  assert.equal(profileOperation('custom'), 'apply');
});

test('adaptive profile is always safe to review as reset', () => {
  assert.equal(validateSelection({ canWrite: true, profile: 'adaptive', lte: [], nr: [] }), '');
});

test('read-only firmware blocks write requests', () => {
  assert.match(validateSelection({ canWrite: false, profile: 'custom', lte: [3], nr: [] }), /read-only/);
});

test('an empty backend SIM list stays empty instead of inventing SIM 1', () => {
  assert.deepEqual(normalizeSubscriptions([], null), {
    subscriptions: [],
    selectedSubId: -1,
    slotIndex: -1,
  });
  assert.equal(subscriptionLabel(null), 'SIM unavailable');
});

test('subscription normalization preserves dual-SIM selection', () => {
  const result = normalizeSubscriptions([
    { subId: 3, slotIndex: 0, carrierName: 'First', defaultData: true },
    { subId: 7, slotIndex: 1, carrierName: 'Second' },
  ], 7);
  assert.equal(result.selectedSubId, 7);
  assert.equal(result.slotIndex, 1);
  assert.equal(subscriptionLabel(result.subscriptions[1], true), 'SIM 2 · Second');
});

test('sole SDL selection is rejected', () => {
  assert.match(validateSelection({ canWrite: true, profile: 'custom', lte: [32], nr: [75] }), /cannot be the only/);
});

test('LTE+ safeguard is a safe automatic-selection action', () => {
  assert.equal(validateSelection({ canWrite: true, profile: 'lte-plus', lte: [], nr: [] }), '');
  assert.equal(validateSelection({ canWrite: true, profile: 'lte-plus', lte: [3], nr: [78] }), '');
});

test('NSA candidate requires a usable LTE anchor and NR carrier', () => {
  assert.match(validateSelection({ canWrite: true, profile: 'nsa', lte: [], nr: [78] }), /LTE anchor/);
  assert.match(validateSelection({ canWrite: true, profile: 'nsa', lte: [3], nr: [75] }), /non-SDL NR/);
  assert.equal(validateSelection({ canWrite: true, profile: 'nsa', lte: [3], nr: [78] }), '');
});
