import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../webroot/js/app.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('../webroot/js/api.js', import.meta.url), 'utf8');
const catalog = readFileSync(new URL('../webroot/js/catalog.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../webroot/styles/app.css', import.meta.url), 'utf8');

test('routine polling patches live fields without rebuilding the app root', () => {
  assert.match(app, /else patchLiveDashboard\(nextStatus, nextSettings\)/);
  assert.match(app, /function patchLiveDashboard\(/);
});

test('overview, bands, and profiles share synchronized subscription controls', () => {
  assert.match(app, /renderSubscriptionToolbar\(status, 'overview-subscription'/);
  assert.match(app, /renderSubscriptionToolbar\(status, 'bands-subscription'/);
  assert.match(app, /renderSubscriptionToolbar\(status, 'profiles-subscription', 'Apply profile to'\)/);
  assert.match(app, /querySelectorAll\('\[data-action="subscription"\]'\)/);
});

test('review apply uses the hold control without typed confirmation', () => {
  assert.doesNotMatch(app, /Type <code>APPLY<\/code>/);
  assert.doesNotMatch(app, /placeholder="APPLY"/);
  assert.match(app, /data-action="hold-apply" data-idle-label="\$\{holdLabel\}">/);
  assert.match(app, /document\.querySelector\('\[data-action="hold-apply"\]'\)/);
  assert.match(app, /const expected = 'RESET'/);
});

test('LTE+ safeguard preserves an already-automatic radio state', () => {
  assert.match(app, /operation === 'reset' \|\| operation === 'preserve'/);
  assert.match(app, /If this SIM is already using automatic bands, the radio is left untouched/);
  assert.match(app, /profileOperation\(state\.profile\) === 'preserve'/);
});

test('preview dual-SIM status honors the requested subscription', () => {
  assert.match(api, /mockStatus\(state, requestedSubId\)/);
  assert.match(api, /return mockStatus\(state, rest\[0\]\)/);
  assert.match(api, /\[1, 2\]\.includes\(numericSubId\)/);
});

test('band controls use per-SIM runtime discovery instead of a model catalog', () => {
  const combined = `${app}\n${api}\n${catalog}`;
  assert.doesNotMatch(combined, /CPH2747|OnePlus certified|OxygenOS|conversionHint/);
  assert.doesNotMatch(app, /raw\.catalog/);
  assert.match(app, /raw\.discoveredBands/);
  assert.match(app, /deriveBandCandidates\(\{/);
  assert.match(app, /selection:\s*\{[\s\S]*lte: uniqueBands\(\[\.\.\.status\.selection\.lte, \.\.\.lte\]\)/);
  assert.match(app, /Runtime-discovered|runtime band candidates/);
  assert.match(app, /not a complete hardware-support list/);
  assert.match(app, /filterByInputPolicy\(status\?\.catalog, status\?\.inputPolicy\)/);
  assert.match(app, /Monitor only/);
});

test('numbered profiles are disabled when discovered candidates are insufficient', () => {
  assert.match(app, /const preset = profilePreset\(profile\.id, selectableCatalog\(status\)\)/);
  assert.match(app, /preset\.available \? '' : 'disabled'/);
  assert.match(catalog, /lte: available \? availableLte : \[\]/);
  assert.match(catalog, /Needs at least one discovered LTE anchor and one non-supplemental NR candidate/);
});

test('preview LTE+ safeguard clears stale mock restrictions without a watchdog', () => {
  assert.match(api, /if \(profile === 'lte-plus'\) \{/);
  assert.match(api, /operation: 'preserve'/);
  assert.match(api, /message: 'Automatic radio state preserved; no band write was sent\.'/);
  assert.match(api, /state\.lte = \[\];[\s\S]*state\.nr = \[\];[\s\S]*state\.applied = false;[\s\S]*state\.reapply = false;/);
  assert.match(api, /state\.pendingToken = '';[\s\S]*state\.rollbackAt = 0;/);
});

test('saved profile state is only reused for its matching subscription', () => {
  assert.match(app, /settings\.subId === status\.selectedSubId/);
  assert.match(app, /nextSettings\.subId === nextStatus\.selectedSubId/);
  assert.equal(app.match(/state\.profile = uiProfileId\(settingsForSelectedSubscription/g)?.length, 2);
  assert.match(app, /savedForSelectedSubscription \? settings\.lte : status\.selection\.lte/);
  assert.match(app, /savedForSelectedSubscription \? nextSettings\.nr : nextStatus\.selection\.nr/);
});

test('boot reapply is scoped to the selected subscription', () => {
  assert.match(app, /settings\.subId === status\.selectedSubId && settings\.applied/);
  assert.match(app, /settings\.subId === state\.selectedSubId/);
  assert.match(app, /reapply\.disabled = !available/);
});

test('signal chart starts from real samples instead of fabricated history', () => {
  assert.doesNotMatch(app, /-110, -105, -100, -95, -90, -92/);
  assert.match(app, /if \(!values\.length\) return \{ line: '', area: '' \}/);
  assert.match(app, /return \[value\]/);
});

test('dashboard selection is disabled while form controls remain operable', () => {
  assert.match(css, /body[\s\S]*user-select: none/);
  assert.match(css, /input,[\s\S]*select,[\s\S]*textarea,[\s\S]*user-select: text/);
});
