import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backendProfileId,
  COVERAGE_CANDIDATES,
  deriveBandCandidates,
  filterByInputPolicy,
  profilePreset,
  profileOperation,
  SUPPLEMENTAL_DOWNLINK,
  SUPPLEMENTAL_UPLINK,
  uniqueBands,
} from '../webroot/js/catalog.js';
import { validateSelection } from '../webroot/js/validation.js';
import { normalizeSubscriptions, subscriptionLabel } from '../webroot/js/subscriptions.js';

const INPUT_POLICY = { lte: [3, 29, 32], nr: [29, 75, 78, 80] };

test('selectable candidates come only from runtime radio data, current selection, and cache', () => {
  const result = deriveBandCandidates({
    serving: [{ rat: 'LTE', band: 3 }, { rat: 'NR', band: 78 }],
    observed: { lte: [1, 3], nr: [41] },
    selection: { lte: [20], nr: [28] },
    cached: { lte: [8], nr: [77] },
  });
  assert.deepEqual(result.lte, [1, 3, 8, 20]);
  assert.deepEqual(result.nr, [28, 41, 77, 78]);
  assert.match(result.source, /Runtime-discovered and cached/);
});

test('an existing restriction remains selectable even when it is not currently observed', () => {
  const result = deriveBandCandidates({
    observed: { lte: [], nr: [] },
    selection: { lte: [66], nr: [77] },
  });
  assert.deepEqual(result.lte, [66]);
  assert.deepEqual(result.nr, [77]);
});

test('numbered profiles are empty and unavailable when discovery is insufficient', () => {
  assert.deepEqual(profilePreset('coverage', { lte: [3], nr: [78] }), {
    available: false,
    lte: [],
    nr: [],
    reason: 'No discovered coverage-band candidate is available for this SIM yet.',
  });
  assert.equal(profilePreset('nsa', { lte: [3], nr: [] }).available, false);
  assert.deepEqual(profilePreset('nsa', { lte: [3], nr: [] }).lte, []);
  assert.equal(profilePreset('adaptive', {}).available, true);
  assert.equal(profilePreset('lte-plus', {}).available, true);
});

test('supplemental downlink and uplink bands are tracked explicitly', () => {
  assert.deepEqual(SUPPLEMENTAL_DOWNLINK.lte, [29, 32, 67, 69]);
  assert.deepEqual(SUPPLEMENTAL_DOWNLINK.nr, [29, 75, 76]);
  assert.deepEqual(SUPPLEMENTAL_UPLINK.nr, [80, 81, 82, 83, 84, 86, 89, 95]);
});

test('detected bands outside the backend input policy remain monitor-only', () => {
  assert.deepEqual(filterByInputPolicy(
    { lte: [3, 88], nr: [78, 259] },
    { lte: [3], nr: [78] },
  ), { lte: [3], nr: [78] });
  assert.ok(!COVERAGE_CANDIDATES.nr.includes(13));
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
  assert.match(validateSelection({ canWrite: false, profile: 'custom', lte: [3], nr: [], inputPolicy: INPUT_POLICY }), /read-only/);
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

test('sole SDL or SUL selection is rejected', () => {
  assert.match(validateSelection({ canWrite: true, profile: 'custom', lte: [32], nr: [75], inputPolicy: INPUT_POLICY }), /cannot be the entire selection/);
  assert.match(validateSelection({ canWrite: true, profile: 'custom', lte: [], nr: [80], inputPolicy: INPUT_POLICY }), /cannot be the entire selection/);
  assert.equal(profilePreset('nsa', { lte: [3], nr: [80] }).available, false);
});

test('monitor-only discovered bands cannot be submitted', () => {
  assert.match(validateSelection({
    canWrite: true,
    profile: 'custom',
    lte: [3],
    nr: [259],
    inputPolicy: INPUT_POLICY,
  }), /monitor-only/);
});

test('LTE+ safeguard is a safe automatic-selection action', () => {
  assert.equal(validateSelection({ canWrite: true, profile: 'lte-plus', lte: [], nr: [] }), '');
  assert.equal(validateSelection({ canWrite: true, profile: 'lte-plus', lte: [3], nr: [78] }), '');
});

test('NSA candidate requires a usable LTE anchor and NR carrier', () => {
  assert.match(validateSelection({ canWrite: true, profile: 'nsa', lte: [], nr: [78], inputPolicy: INPUT_POLICY }), /LTE anchor/);
  assert.match(validateSelection({ canWrite: true, profile: 'nsa', lte: [3], nr: [75], inputPolicy: INPUT_POLICY }), /non-supplemental NR/);
  assert.match(validateSelection({ canWrite: true, profile: 'nsa', lte: [3], nr: [80], inputPolicy: INPUT_POLICY }), /non-supplemental NR/);
  assert.equal(validateSelection({ canWrite: true, profile: 'nsa', lte: [3], nr: [78], inputPolicy: INPUT_POLICY }), '');
});
