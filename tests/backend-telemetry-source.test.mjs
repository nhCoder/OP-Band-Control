import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const backend = readFileSync(
  new URL('../helper-src/io/github/opband/TelephonyBackend.java', import.meta.url),
  'utf8',
);

test('backend exposes Android signal levels for cells and overall telemetry', () => {
  assert.match(backend, /signalLevelValue\(signal\.getLevel\(\)\)/);
  assert.match(backend, /signalLevelValue\(signalStrength\.getLevel\(\)\)/);
  assert.match(backend, /root\.put\("signalLevel", overallSignalLevel\)/);
  assert.match(backend, /value\.put\("level", level\)/);
});

test('LTE carrier aggregation comes from active physical-channel configs', () => {
  assert.match(backend, /physicalLtePrimaryCount > 0/);
  assert.match(backend, /physicalLteSecondaryCount > 0/);
  assert.match(backend, /return "LTE_CA"/);
  assert.match(backend, /Physical-channel callback timed out/);
  assert.match(backend, /carrierAggregationState/);
  assert.match(backend, /CONNECTION_PRIMARY_SERVING/);
  assert.match(backend, /CONNECTION_SECONDARY_SERVING/);
});

test('reset is idempotent when system selection is already automatic', () => {
  assert.match(
    backend,
    /List<RadioAccessSpecifier> current = getSelection\(telephony\);\s*if \(current\.isEmpty\(\)\) \{\s*return resetResult\(subId, current, false\);/s,
  );
  assert.match(backend, /root\.put\("changed", changed\);/);
  assert.match(backend, /root\.put\("noOp", !changed\);/);
});

test('restore is idempotent when the exact target selection is already active', () => {
  assert.match(backend, /encodeRestoreToken\(current\)\.equals\(encodeRestoreToken\(specifiers\)\)/);
  assert.match(backend, /return restoreResult\(subId, current, false\)/);
});
