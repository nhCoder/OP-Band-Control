import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { COVERAGE_CANDIDATES } from '../webroot/js/catalog.js';

const policy = readFileSync(
  new URL('../helper-src/io/github/opband/BandPolicy.java', import.meta.url),
  'utf8',
);
const backend = readFileSync(
  new URL('../helper-src/io/github/opband/TelephonyBackend.java', import.meta.url),
  'utf8',
);
const controller = readFileSync(new URL('../bin/control.sh', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../customize.sh', import.meta.url), 'utf8');
const metadata = readFileSync(new URL('../module.prop', import.meta.url), 'utf8');

function javaArray(name) {
  const match = policy.match(new RegExp(`static final int\\[\\] ${name} = \\{([\\s\\S]*?)\\};`));
  assert.ok(match, `missing Java array ${name}`);
  return [...match[1].matchAll(/\d+/g)].map(([value]) => Number(value));
}

function shellCsv(name) {
  const match = controller.match(new RegExp(`^${name}=([0-9,]+)$`, 'm'));
  assert.ok(match, `missing controller policy ${name}`);
  return match[1].split(',').map(Number);
}

test('helper and controller share one finite generic standards-level input policy', () => {
  const lte = javaArray('LTE_INPUTS');
  const nr = javaArray('NR_INPUTS');
  assert.deepEqual(shellCsv('LTE_ALLOWED_CSV'), lte);
  assert.deepEqual(shellCsv('NR_ALLOWED_CSV'), nr);

  assert.ok(lte.includes(1) && lte.includes(32) && lte.includes(88));
  assert.ok(nr.includes(1) && nr.includes(78) && nr.includes(261));
  assert.ok(!lte.includes(15) && !lte.includes(64));
  assert.ok(!nr.includes(4) && !nr.includes(259));
  assert.match(backend, /deviceCapabilityClaim", false/);
});

test('all one-way supplemental inputs remain guarded', () => {
  assert.deepEqual(javaArray('LTE_SUPPLEMENTAL_DOWNLINK'), [29, 32, 67, 69]);
  assert.deepEqual(javaArray('NR_SUPPLEMENTAL_DOWNLINK'), [29, 75, 76]);
  assert.deepEqual(javaArray('NR_SUPPLEMENTAL_UPLINK'), [80, 81, 82, 83, 84, 86, 89, 95]);
  assert.match(controller, /nr:80\|nr:81\|nr:82\|nr:83\|nr:84\|nr:86\|nr:89\|nr:95/);
  assert.match(controller, /UNSAFE_SUPPLEMENTAL_ONLY/);
  assert.match(backend, /hasOrdinaryServingBand\(lte, nr\)/);
  assert.match(backend, /NR_SUPPLEMENTAL_UPLINK_SET\.contains\(band\)/);
});

test('coverage profile hints are a complete policy subset', () => {
  const lte = new Set(javaArray('LTE_INPUTS'));
  const nr = new Set(javaArray('NR_INPUTS'));
  assert.ok(COVERAGE_CANDIDATES.lte.every((band) => lte.has(band)));
  assert.ok(COVERAGE_CANDIDATES.nr.every((band) => nr.has(band)));
  assert.ok([14, 31, 68, 72].every((band) => COVERAGE_CANDIDATES.lte.includes(band)));
  assert.ok([14, 18].every((band) => COVERAGE_CANDIDATES.nr.includes(band)));
  assert.ok(!COVERAGE_CANDIDATES.nr.includes(13));
});

test('status separates runtime discovery from the mutation input policy', () => {
  assert.match(backend, /root\.put\("discoveredBands", bandDiscovery\.json\(\)\)/);
  assert.match(backend, /root\.put\("catalog", bandDiscovery\.catalogJson\(\)\)/);
  assert.match(backend, /root\.put\("inputPolicy", inputPolicy\(\)\)/);
  assert.match(backend, /value\.put\("serving", pair\(servingLte, servingNr\)\)/);
  assert.match(backend, /value\.put\("observed", pair\(observedLte, observedNr\)\)/);
  assert.match(backend, /value\.put\("selection", pair\(selectionLte, selectionNr\)\)/);
  assert.match(backend, /value\.put\("supplementalUplinkNr", ints\(BandPolicy\.NR_SUPPLEMENTAL_UPLINK\)\)/);
});

test('runtime discovery retains every identity band instead of only the first', () => {
  assert.match(backend, /addIdentityBands\(live, info\)/);
  assert.match(backend, /addObservedBands\(\s*live, "LTE", \(\(CellInfoLte\) info\)\.getCellIdentity\(\)\.getBands\(\)\)/);
  assert.match(backend, /addObservedBands\(\s*live, "NR",[\s\S]*?CellIdentityNr[\s\S]*?CellInfoNr[\s\S]*?getBands\(\)\)/);
});

test('privileged backend and installer contain no device or conversion gate', () => {
  const scopedSource = [policy, backend, controller, installer, metadata].join('\n');
  assert.doesNotMatch(scopedSource, /CPH2747|OnePlus|converted|conversionHint/i);
  assert.match(backend, /value\.put\("manufacturer", string\(Build\.MANUFACTURER\)\)/);
  assert.match(backend, /value\.put\("model", string\(Build\.MODEL\)\)/);
  assert.match(backend, /value\.put\("rom", string\(Build\.DISPLAY\)\)/);
});

test('installer keeps the API safety floor without an artificial ABI gate', () => {
  assert.match(installer, /Android 12 \/ API 31 or newer is required/);
  assert.doesNotMatch(installer, /Unsupported architecture|arm64 is required/);
  assert.match(installer, /device_arch=.*ro\.product\.cpu\.abi/);
});
