import {
  applySelection,
  BackendError,
  clearLogs,
  confirmSelection,
  environment,
  readDashboard,
  readLogs,
  resetSelection,
  rollbackSelection,
  setReapply,
  showNativeToast,
} from './api.js';
import {
  backendProfileId,
  deriveBandCandidates,
  filterByInputPolicy,
  getProfile,
  isSupplementalOnly,
  profilePreset,
  profileOperation,
  PROFILES,
  SUPPLEMENTAL_DOWNLINK,
  SUPPLEMENTAL_UPLINK,
  uiProfileId,
  uniqueBands,
} from './catalog.js';
import { icon } from './icons.js';
import { normalizeSubscriptions, subscriptionLabel } from './subscriptions.js';
import { validateSelection } from './validation.js';

const app = document.querySelector('#app');

const state = {
  tab: 'overview',
  status: null,
  settings: null,
  selectedSubId: -1,
  selected: { lte: new Set(), nr: new Set() },
  profile: 'adaptive',
  dirty: false,
  loading: false,
  refreshing: false,
  logs: '',
  logsLoaded: false,
  modal: null,
  toast: null,
  signalHistory: [],
  pendingToken: '',
  rollbackAt: 0,
  candidateCache: new Map(),
};

let refreshTimer = 0;
let pendingTimer = 0;
let toastTimer = 0;
let holdFrame = 0;
let holdStart = 0;
let holdTriggered = false;
let subscriptionSwitchToken = 0;

init();

async function init() {
  try {
    await loadDashboard(-1, true);
    refreshTimer = window.setInterval(() => refreshDashboard(), 6_000);
  } catch (error) {
    renderFatal(error);
  }
}

async function loadDashboard(subId, initial = false, guardToken = 0) {
  const { status: rawStatus, settings: rawSettings } = await readDashboard(subId);
  const status = normalizeStatus(rawStatus);
  const settings = normalizeSettings(rawSettings);

  if (guardToken && guardToken !== subscriptionSwitchToken) return false;
  if (guardToken && subId >= 0 && status.selectedSubId !== subId) {
    throw new BackendError('The selected SIM is no longer available.');
  }

  state.status = status;
  state.settings = settings;
  state.selectedSubId = status.selectedSubId;
  const settingsForSelectedSubscription = settings.subId === status.selectedSubId;
  const savedForSelectedSubscription = settingsForSelectedSubscription && settings.applied;
  state.profile = uiProfileId(settingsForSelectedSubscription
    ? settings.profile
    : status.selection.auto ? 'adaptive' : 'custom');
  state.pendingToken = settings.pendingToken;
  state.rollbackAt = settings.rollbackAt;
  state.signalHistory = seedSignalHistory(primaryMetric(status, 'rsrp'));

  const savedLte = savedForSelectedSubscription ? settings.lte : status.selection.lte;
  const savedNr = savedForSelectedSubscription ? settings.nr : status.selection.nr;
  includeCandidateBands(status, savedLte, savedNr);
  state.selected = {
    lte: new Set(savedLte),
    nr: new Set(savedNr),
  };
  state.dirty = false;

  if (state.pendingToken && state.rollbackAt > Date.now()) {
    state.modal = { type: 'pending' };
  }

  state.loading = false;
  render();
  if (initial && state.modal) focusModal();
  return true;
}

async function refreshDashboard() {
  if (state.refreshing || state.loading || !state.status) return;
  if (state.modal && state.modal.type !== 'pending') return;
  const requestedSubId = state.selectedSubId;
  const switchToken = subscriptionSwitchToken;
  state.refreshing = true;
  try {
    const { status: rawStatus, settings: rawSettings } = await readDashboard(requestedSubId);
    if (switchToken !== subscriptionSwitchToken || requestedSubId !== state.selectedSubId) return;

    const nextStatus = normalizeStatus(rawStatus);
    const nextSettings = normalizeSettings(rawSettings);
    const settingsForSelectedSubscription = nextSettings.subId === nextStatus.selectedSubId;
    const savedForSelectedSubscription = settingsForSelectedSubscription && nextSettings.applied;
    const selectedLte = savedForSelectedSubscription ? nextSettings.lte : nextStatus.selection.lte;
    const selectedNr = savedForSelectedSubscription ? nextSettings.nr : nextStatus.selection.nr;
    includeCandidateBands(nextStatus, selectedLte, selectedNr);
    const subscriptionChanged = nextStatus.selectedSubId !== requestedSubId;
    const candidatesChanged = catalogKey(state.status.catalog) !== catalogKey(nextStatus.catalog);
    state.status = nextStatus;
    state.settings = nextSettings;
    state.selectedSubId = nextStatus.selectedSubId;
    if (subscriptionChanged) {
      state.signalHistory = seedSignalHistory(primaryMetric(nextStatus, 'rsrp'));
      state.dirty = false;
    } else {
      appendSignal(primaryMetric(nextStatus, 'rsrp'));
    }

    if (!state.dirty) {
      state.profile = uiProfileId(settingsForSelectedSubscription
        ? nextSettings.profile
        : nextStatus.selection.auto ? 'adaptive' : 'custom');
      state.selected = {
        lte: new Set(selectedLte),
        nr: new Set(selectedNr),
      };
    }

    let requiresRender = subscriptionChanged || candidatesChanged;
    let rolledBack = false;
    if (!nextSettings.pendingToken && state.pendingToken && state.modal?.type === 'pending') {
      state.pendingToken = '';
      state.rollbackAt = 0;
      state.modal = null;
      requiresRender = true;
      rolledBack = true;
    } else {
      state.pendingToken = nextSettings.pendingToken;
      state.rollbackAt = nextSettings.rollbackAt;
    }

    if (requiresRender) render();
    else patchLiveDashboard(nextStatus, nextSettings);

    if (rolledBack) showToast('The unconfirmed change was rolled back.', 'error');
    if (subscriptionChanged) showToast('The previously selected SIM is no longer active.', 'error');
  } catch (error) {
    updateConnectionError(error);
  } finally {
    state.refreshing = false;
  }
}

function render() {
  stopPendingTimer();
  const status = state.status;
  const settings = state.settings;
  const capability = status.capability;
  const deviceLine = [status.device.model || 'Unknown device', status.device.rom || status.device.release].filter(Boolean).join(' · ');
  const connectionState = status.connected ? 'ok' : capability.read ? 'warning' : 'error';
  const connectionText = status.connected
    ? 'Modem connected'
    : capability.read
      ? 'Radio is not currently registered'
      : 'Modem status unavailable';
  const selectedSubscription = status.subscriptions.find(
    (subscription) => subscription.subId === status.selectedSubId,
  );

  app.innerHTML = `
    <div class="app-shell">
      <div class="shell-inner">
        <header class="app-header">
          <div class="brand-mark" aria-hidden="true"><i></i><i></i></div>
          <div class="brand-copy">
            <h1>OP Band Control</h1>
            <p>${escapeHtml(deviceLine)}</p>
          </div>
          <button class="header-action" type="button" data-action="device-info" aria-label="Device and safety information">
            ${icon('more', 21)}
          </button>
        </header>

        <div class="connection-strip" data-state="${connectionState}">
          <span class="status-dot" aria-hidden="true"></span>
          <span data-live="connection-text">${escapeHtml(connectionText)}</span>
          <span class="connection-meta" data-live="connection-meta">${status.preview ? 'Preview data' : escapeHtml(subscriptionLabel(selectedSubscription))}</span>
        </div>

        <nav class="tab-rail" role="tablist" aria-label="Module sections">
          ${tabButton('overview', 'Overview')}
          ${tabButton('bands', 'Bands')}
          ${tabButton('profiles', 'Profiles')}
          ${tabButton('logs', 'Logs')}
        </nav>

        <main id="main">
          <section class="page" id="page-overview" role="tabpanel" aria-labelledby="tab-overview" ${state.tab === 'overview' ? '' : 'hidden'}>
            ${renderOverview(status)}
          </section>
          <section class="page" id="page-bands" role="tabpanel" aria-labelledby="tab-bands" ${state.tab === 'bands' ? '' : 'hidden'}>
            ${renderBands(status)}
          </section>
          <section class="page" id="page-profiles" role="tabpanel" aria-labelledby="tab-profiles" ${state.tab === 'profiles' ? '' : 'hidden'}>
            ${renderProfiles(status, settings)}
          </section>
          <section class="page" id="page-logs" role="tabpanel" aria-labelledby="tab-logs" ${state.tab === 'logs' ? '' : 'hidden'}>
            ${renderLogs()}
          </section>
        </main>
      </div>

      ${state.tab === 'logs' ? '' : renderActionDock(capability)}
      ${renderModal()}
      <div class="busy-overlay" ${state.loading ? '' : 'hidden'} role="status" aria-live="assertive">
        <span class="spinner" aria-hidden="true"></span>
        <p>${escapeHtml(state.loading || '')}</p>
      </div>
      <div class="toast-region" aria-live="polite" aria-atomic="true">
        ${state.toast ? `<div class="toast-message" data-kind="${escapeHtml(state.toast.kind)}">${escapeHtml(state.toast.message)}</div>` : ''}
      </div>
    </div>
  `;

  bindEvents();
  if (state.modal?.type === 'pending') startPendingTimer();
}

function patchLiveDashboard(status, settings) {
  patchConnectionStrip(status);
  patchOverview(status);
  syncSubscriptionSelectors();
  patchBandControls(status);
  patchProfileControls(status, settings);
  patchCapabilityCallouts(status.capability);
  patchActionDock(status.capability);
  patchBusyOverlay();
}

function patchConnectionStrip(status) {
  const strip = document.querySelector('.connection-strip');
  if (!strip) return;
  const capability = status.capability;
  const selected = status.subscriptions.find((subscription) => subscription.subId === state.selectedSubId);
  strip.dataset.state = status.connected ? 'ok' : capability.read ? 'warning' : 'error';
  setText(strip.querySelector('[data-live="connection-text"]'), status.connected
    ? 'Modem connected'
    : capability.read
      ? 'Radio is not currently registered'
      : 'Modem status unavailable');
  setText(strip.querySelector('[data-live="connection-meta"]'), status.preview
    ? 'Preview data'
    : subscriptionLabel(selected));
}

function patchOverview(status) {
  const overview = document.querySelector('#page-overview');
  if (!overview) return;
  const serving = status.serving.length ? status.serving : [{ rat: 'LTE', band: null, primary: true }];
  const mode = status.mode || deriveMode(serving, status.connected);
  const combo = serving
    .filter((carrier) => carrier.band)
    .map(formatBand)
    .join(' + ') || 'Waiting for serving-cell data';
  const rsrp = primaryMetric(status, 'rsrp');
  const sinr = primaryMetric(status, 'sinr');
  const primary = serving.find((carrier) => carrier.primary) || serving[0];
  const level = signalLevel(status, rsrp);
  const profile = getProfile(state.profile);
  const previewBands = uniqueBandObjects(status);
  const carriers = serving.slice(0, 4);
  const carrierStack = overview.querySelector('[data-live="carrier-stack"]');
  patchHtml(
    carrierStack,
    JSON.stringify(carriers.map(({ rat, band, primary: isPrimary }) => [rat, band, isPrimary])),
    carriers.map((carrier) => `<span class="carrier-node" title="${escapeHtml(carrierRole(carrier))}">${escapeHtml(shortBand(carrier))}</span>`).join(''),
  );
  setText(overview.querySelector('[data-live="mode"]'), mode);
  setText(overview.querySelector('[data-live="band-combo"]'), combo);

  const summary = overview.querySelector('[data-live="signal-summary"]');
  summary?.setAttribute('aria-label', `Signal quality ${qualityLabel(level)}`);
  const bars = overview.querySelector('[data-live="signal-bars"]');
  if (bars) bars.dataset.level = String(level);
  setText(overview.querySelector('[data-live="signal-label"]'), qualityLabel(level));

  const { line, area } = signalChartGeometry();
  overview.querySelector('.signal-chart .trace')?.setAttribute('d', line);
  overview.querySelector('.signal-chart .area')?.setAttribute('d', area);
  patchMetric(overview, 'rsrp', 'RSRP', formatMetric(rsrp, 'dBm'));
  patchMetric(overview, 'sinr', 'SINR', formatMetric(sinr, 'dB'));
  patchMetric(overview, 'pci', 'PCI', formatPlain(primary?.pci));
  patchMetric(overview, 'channel', primary?.rat === 'NR' ? 'NR-ARFCN' : 'EARFCN', formatPlain(primary?.channel));

  patchHtml(
    overview.querySelector('[data-live="band-preview"]'),
    JSON.stringify(previewBands.slice(0, 10)),
    renderBandPreview(previewBands),
  );
  const symbol = overview.querySelector('[data-live="profile-symbol"]');
  patchHtml(symbol, state.profile, icon(state.profile === 'adaptive' ? 'unlock' : 'radio', 19));
  setText(overview.querySelector('[data-live="profile-name"]'), profile.name);
  setText(overview.querySelector('[data-live="profile-effect"]'), profile.effect);
}

function patchMetric(root, key, label, value) {
  const metricNode = root.querySelector(`[data-live-metric="${key}"]`);
  if (!metricNode) return;
  setText(metricNode.querySelector('dt'), label);
  const valueNode = metricNode.querySelector('dd');
  if (valueNode && valueNode.innerHTML !== value) valueNode.innerHTML = value;
}

function syncSubscriptionSelectors(preferredSubId = state.selectedSubId) {
  const subscriptions = state.status?.subscriptions || [];
  const key = JSON.stringify(subscriptions.map((subscription) => [
    subscription.subId,
    subscription.slotIndex,
    subscription.carrierName,
    subscription.displayName,
  ]));
  document.querySelectorAll('[data-action="subscription"]').forEach((select) => {
    if (select.dataset.subscriptionKey !== key) {
      select.innerHTML = renderSubscriptionOptions(state.status);
      select.dataset.subscriptionKey = key;
    }
    if (subscriptions.some((subscription) => subscription.subId === preferredSubId)) {
      select.value = String(preferredSubId);
    }
    select.disabled = Boolean(state.loading) || subscriptions.length === 0;
  });
}

function patchBandControls(status) {
  const observed = {
    lte: new Set(status.observed.lte),
    nr: new Set(status.observed.nr),
  };
  const serving = {
    lte: new Set(status.serving.filter((carrier) => carrier.rat === 'LTE').map((carrier) => carrier.band)),
    nr: new Set(status.serving.filter((carrier) => carrier.rat === 'NR').map((carrier) => carrier.band)),
  };

  document.querySelectorAll('[data-band-rat]').forEach((button) => {
    const rat = button.dataset.bandRat;
    const band = Number(button.dataset.band);
    if (!['lte', 'nr'].includes(rat) || !Number.isInteger(band)) return;
    const isSelected = state.selected[rat].has(band);
    const isObserved = observed[rat].has(band);
    const isServing = serving[rat].has(band);
    const sdl = SUPPLEMENTAL_DOWNLINK[rat].includes(band);
    const sul = SUPPLEMENTAL_UPLINK[rat].includes(band);
    const policyAllowed = bandAllowed(status, rat, band);
    const origin = candidateOrigin(status, rat, band);
    const displayOrigin = policyAllowed ? origin : `${origin} · Monitor only`;
    button.setAttribute('aria-pressed', String(isSelected));
    button.disabled = !policyAllowed && !isSelected;
    button.dataset.policyAllowed = String(policyAllowed);
    button.setAttribute(
      'aria-label',
      `${rat === 'nr' ? 'NR n' : 'LTE B'}${band}${sdl ? ', supplemental downlink' : ''}${sul ? ', supplemental uplink' : ''}, ${displayOrigin.toLowerCase()}`,
    );
    setText(button.querySelector('.candidate-origin'), displayOrigin);
    const markers = button.querySelectorAll('.tiny-marker');
    if (markers[0]) markers[0].dataset.active = String(isObserved);
    if (markers[1]) markers[1].dataset.active = String(isServing);
  });

  ['lte', 'nr'].forEach((rat) => {
    const heading = document.querySelector(`#${rat}-heading`);
    const count = heading?.closest('.band-group')?.querySelector('.band-count');
    setText(count, `${state.selected[rat].size} of ${status.catalog[rat].length} selected`);
  });
}

function patchProfileControls(status, settings) {
  document.querySelectorAll('[data-profile]').forEach((button) => {
    const preset = profilePreset(button.dataset.profile, selectableCatalog(status));
    button.setAttribute('aria-pressed', String(button.dataset.profile === state.profile));
    button.disabled = !preset.available;
    button.setAttribute('aria-disabled', String(!preset.available));
  });
  const reapply = document.querySelector('[data-action="reapply"]');
  const available = settings.subId === state.selectedSubId && settings.applied;
  reapply?.setAttribute('aria-checked', String(Boolean(available && settings.reapply)));
  if (reapply) reapply.disabled = !available;
}

function patchCapabilityCallouts(capability) {
  const mode = capability.write ? 'ok' : 'error';
  const heading = capability.write ? 'Selection path available' : 'Read-only on this firmware';
  const copy = capability.write
    ? `${capability.reason || 'Android radio selection APIs are available.'} Writes remain experimental until verified on this exact firmware build.`
    : `${capability.reason || 'The radio selection API could not be verified.'} Live monitoring remains available; apply controls are disabled.`;
  const key = JSON.stringify([mode, heading, copy]);
  const content = `
    ${icon(capability.write ? 'shield' : 'warning', 19)}
    <span><strong>${escapeHtml(heading)}.</strong> ${escapeHtml(copy)}</span>`;
  document.querySelectorAll('[data-live="capability"]').forEach((callout) => {
    callout.dataset.state = mode;
    patchHtml(callout, key, content);
  });
}

function patchActionDock(capability) {
  const canMutate = capability.write && state.selectedSubId >= 0;
  const reset = document.querySelector('[data-action="reset-open"]');
  const review = document.querySelector('[data-action="review"]');
  if (reset) reset.disabled = !canMutate;
  if (review) review.disabled = !(canMutate && currentProfileAvailable());
}

function patchBusyOverlay() {
  const overlay = document.querySelector('.busy-overlay');
  if (!overlay) return;
  overlay.hidden = !state.loading;
  setText(overlay.querySelector('p'), state.loading || '');
}

function patchHtml(target, key, html) {
  if (!target || target.dataset.liveKey === key) return;
  target.innerHTML = html;
  target.dataset.liveKey = key;
}

function setText(target, value) {
  const text = String(value ?? '');
  if (target && target.textContent !== text) target.textContent = text;
}

function renderOverview(status) {
  const serving = status.serving.length ? status.serving : [{ rat: 'LTE', band: null, primary: true }];
  const mode = status.mode || deriveMode(serving, status.connected);
  const combo = serving
    .filter((carrier) => carrier.band)
    .map(formatBand)
    .join(' + ') || 'Waiting for serving-cell data';
  const rsrp = primaryMetric(status, 'rsrp');
  const sinr = primaryMetric(status, 'sinr');
  const primary = serving.find((carrier) => carrier.primary) || serving[0];
  const level = signalLevel(status, rsrp);
  const profile = getProfile(state.profile);
  const previewBands = uniqueBandObjects(status);

  return `
    <div class="section-header">
      <div>
        <p class="eyebrow">Live radio</p>
      </div>
      <span class="updated">Updated now</span>
    </div>

    ${renderSubscriptionToolbar(status, 'overview-subscription', 'Viewing subscription')}

    <div class="radio-hero">
      <div class="carrier-stack" data-live="carrier-stack" aria-label="Active carrier stack">
        ${serving.slice(0, 4).map((carrier) => `<span class="carrier-node" title="${escapeHtml(carrierRole(carrier))}">${escapeHtml(shortBand(carrier))}</span>`).join('')}
      </div>
      <div class="radio-main">
        <div class="mode-line">
          <div>
            <h2 class="mode-name" data-live="mode">${escapeHtml(mode)}</h2>
            <p class="band-combo" data-live="band-combo">${escapeHtml(combo)}</p>
          </div>
          <div class="signal-summary" data-live="signal-summary" aria-label="Signal quality ${qualityLabel(level)}">
            <span class="signal-bars" data-live="signal-bars" data-level="${level}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
            <span class="signal-label" data-live="signal-label">${qualityLabel(level)}</span>
          </div>
        </div>

        ${renderSignalChart()}

        <dl class="metrics">
          ${metric('RSRP', formatMetric(rsrp, 'dBm'), 'rsrp')}
          ${metric('SINR', formatMetric(sinr, 'dB'), 'sinr')}
          ${metric('PCI', formatPlain(primary?.pci), 'pci')}
          ${metric(primary?.rat === 'NR' ? 'NR-ARFCN' : 'EARFCN', formatPlain(primary?.channel), 'channel')}
        </dl>
      </div>
    </div>

    <div class="overview-grid">
      <section class="overview-section">
        <h3 class="mini-heading">Active & observed bands</h3>
        <div class="band-preview" data-live="band-preview">
          ${renderBandPreview(previewBands)}
        </div>
        <button class="inline-action" type="button" data-go-tab="bands">Choose bands ${icon('arrow', 17)}</button>
      </section>
      <section class="overview-section">
        <h3 class="mini-heading">Network profile</h3>
        <button class="profile-compact" type="button" data-go-tab="profiles" data-live="profile-compact">
          <span class="profile-symbol" data-live="profile-symbol">${icon(state.profile === 'adaptive' ? 'unlock' : 'radio', 19)}</span>
          <span>
            <strong data-live="profile-name">${escapeHtml(profile.name)}</strong>
            <span data-live="profile-effect">${escapeHtml(profile.effect)}</span>
          </span>
          <span class="chevron">${icon('chevron', 18)}</span>
        </button>
      </section>
    </div>

    ${renderCapability(status.capability)}
  `;
}

function renderSubscriptionToolbar(status, id, label) {
  const hasSubscriptions = status.subscriptions.length > 0;
  return `
    <div class="page-toolbar">
      <div class="field">
        <label for="${id}">${escapeHtml(label)}</label>
        <select id="${id}" data-action="subscription" ${hasSubscriptions && !state.loading ? '' : 'disabled'}>
          ${renderSubscriptionOptions(status)}
        </select>
      </div>
    </div>`;
}

function renderSubscriptionOptions(status) {
  if (!status.subscriptions.length) return '<option selected>No active SIM detected</option>';
  return status.subscriptions.map((subscription) => `
    <option value="${subscription.subId}" ${subscription.subId === state.selectedSubId ? 'selected' : ''}>
      ${escapeHtml(subscriptionLabel(subscription, true))}
    </option>`).join('');
}

function renderBandPreview(previewBands) {
  return previewBands.length
    ? previewBands.slice(0, 10).map(({ rat, band, serving: active }) => `<span class="band-tag" data-serving="${active}">${rat === 'NR' ? 'n' : 'B'}${band}</span>`).join('')
    : '<span class="section-copy">No band data is available yet.</span>';
}

function renderBands(status) {
  const observedLte = new Set(status.observed.lte);
  const observedNr = new Set(status.observed.nr);
  const servingLte = new Set(status.serving.filter((item) => item.rat === 'LTE').map((item) => item.band));
  const servingNr = new Set(status.serving.filter((item) => item.rat === 'NR').map((item) => item.band));
  const source = status.catalog.source || 'No runtime band candidates discovered for this SIM';

  return `
    <div class="section-header">
      <div>
        <h2 class="section-title">Discovered band candidates</h2>
        <p class="section-copy">Select from bands reported at runtime for this SIM. This is not a complete hardware-support list, and a selected band is eligible—not guaranteed to serve or aggregate.</p>
      </div>
    </div>

    ${renderSubscriptionToolbar(status, 'bands-subscription', 'Data subscription')}

    <p class="source-note">
      ${icon('info', 18)}
      <span><strong>${escapeHtml(source)}.</strong> New candidates can appear as the radio reports them. A detected band outside this build’s Android input policy remains visible as monitor-only.</span>
    </p>

    ${renderBandGroup('NR', status.catalog.nr, state.selected.nr, observedNr, servingNr, status)}
    ${renderBandGroup('LTE', status.catalog.lte, state.selected.lte, observedLte, servingLte, status)}

    <div class="warning-callout">
      ${icon('warning', 19)}
      <span>One-way supplemental bands (SDL or SUL) cannot form a usable request by themselves. Monitor-only candidates are visible but cannot be added to a new request.</span>
    </div>
  `;
}

function renderBandGroup(rat, bands, selected, observed, serving, status) {
  const key = rat === 'NR' ? 'nr' : 'lte';
  return `
    <section class="band-group" aria-labelledby="${key}-heading">
      <div class="band-group-heading">
        <h3 id="${key}-heading">${rat}</h3>
        <span class="band-count">${selected.size} of ${bands.length} selected</span>
      </div>
      <div class="band-selector">
        ${bands.length ? bands.map((band) => {
          const isSelected = selected.has(band);
          const isObserved = observed.has(band);
          const isServing = serving.has(band);
          const sdl = SUPPLEMENTAL_DOWNLINK[key].includes(band);
          const sul = SUPPLEMENTAL_UPLINK[key].includes(band);
          const policyAllowed = bandAllowed(status, key, band);
          const origin = candidateOrigin(status, key, band);
          const displayOrigin = policyAllowed ? origin : `${origin} · Monitor only`;
          return `
            <button
              class="band-option"
              type="button"
              data-band-rat="${key}"
              data-band="${band}"
              data-policy-allowed="${policyAllowed}"
              aria-pressed="${isSelected}"
              aria-label="${rat === 'NR' ? 'NR n' : 'LTE B'}${band}${sdl ? ', supplemental downlink' : ''}${sul ? ', supplemental uplink' : ''}, ${escapeHtml(displayOrigin.toLowerCase())}"
              ${policyAllowed || isSelected ? '' : 'disabled'}
            >
              <span class="band-identity"><span>${rat === 'NR' ? 'n' : 'B'}${band}${sdl ? '<small> SDL</small>' : sul ? '<small> SUL</small>' : ''}</span><small class="candidate-origin">${escapeHtml(displayOrigin)}</small></span>
              <span>
                <span class="band-check">${icon('check', 12)}</span>
                <span class="band-markers" aria-hidden="true"><i class="tiny-marker" data-active="${isObserved}"></i><i class="tiny-marker" data-active="${isServing}"></i></span>
              </span>
            </button>`;
        }).join('') : `<p class="band-empty">No ${rat} candidate has been reported for this SIM yet.</p>`}
      </div>
    </section>
  `;
}

function renderProfiles(status, settings) {
  const reapplyAvailable = settings.subId === status.selectedSubId && settings.applied;
  const reapplyEnabled = reapplyAvailable && settings.reapply;
  return `
    <div class="section-header">
      <div>
        <h2 class="section-title">Network profiles</h2>
        <p class="section-copy">Templates prepare band selections; the carrier and modem still control registration, secondary cells, and aggregation.</p>
      </div>
    </div>

    ${renderSubscriptionToolbar(status, 'profiles-subscription', 'Apply profile to')}

    <div class="profile-list">
      ${PROFILES.map((profile) => {
        const preset = profilePreset(profile.id, selectableCatalog(status));
        return `
        <button class="profile-option" type="button" data-profile="${profile.id}" aria-pressed="${state.profile === profile.id}" aria-disabled="${!preset.available}" ${preset.available ? '' : 'disabled'}>
          <span class="profile-radio" aria-hidden="true"></span>
          <span>
            <span class="profile-name">${escapeHtml(profile.name)}</span>
            <span class="profile-description">${escapeHtml(profile.description)}</span>
            <span class="profile-effect">${escapeHtml(preset.available ? profile.effect : `Unavailable · ${preset.reason}`)}</span>
          </span>
        </button>
      `;}).join('')}
    </div>

    ${state.profile === 'custom' ? `
      <div class="source-note">
        ${icon('radio', 18)}
        <span><strong>Custom selection active.</strong> Choose a template above or continue with the selections on the Bands page.</span>
      </div>` : ''}

    <div class="settings-row">
      <div>
        <strong>Reapply after reboot</strong>
        <p>Off by default. A failed boot reapply disables itself; use only after this exact selection is proven stable.</p>
      </div>
      <button class="switch" type="button" role="switch" aria-checked="${reapplyEnabled}" data-action="reapply" aria-label="Reapply after reboot" ${reapplyAvailable ? '' : 'disabled'}></button>
    </div>

    <div class="warning-callout">
      ${icon('warning', 19)}
      <span>LTE+ safeguard leaves an already-automatic radio untouched and only clears an existing module band restriction. It does not claim to force carrier aggregation.</span>
    </div>

    ${renderCapability(status.capability)}
  `;
}

function renderLogs() {
  return `
    <div class="section-header">
      <div>
        <h2 class="section-title">Module logs</h2>
        <p class="section-copy">Operations and rollback events only. Subscriber identities, phone numbers, and precise cell identifiers are not intentionally logged.</p>
      </div>
    </div>
    <div class="log-toolbar">
      <button class="utility-button" type="button" data-action="refresh-logs">${icon('refresh', 17)} Refresh</button>
      <button class="utility-button" type="button" data-action="copy-logs">${icon('copy', 17)} Copy</button>
      <button class="utility-button" type="button" data-action="clear-logs">${icon('trash', 17)} Clear</button>
    </div>
    ${state.logsLoaded
      ? `<pre class="log-view" tabindex="0">${escapeHtml(state.logs || 'No module events recorded yet.')}</pre>`
      : `<div class="empty-state">${icon('terminal', 32)}<p>Open this page to load recent module events.</p></div>`}
  `;
}

function renderCapability(capability) {
  const mode = capability.write ? 'ok' : 'error';
  const heading = capability.write ? 'Selection path available' : 'Read-only on this firmware';
  const copy = capability.write
    ? `${capability.reason || 'Android radio selection APIs are available.'} Writes remain experimental until verified on this exact firmware build.`
    : `${capability.reason || 'The radio selection API could not be verified.'} Live monitoring remains available; apply controls are disabled.`;
  return `
    <div class="capability-callout" data-live="capability" data-state="${mode}">
      ${icon(capability.write ? 'shield' : 'warning', 19)}
      <span><strong>${escapeHtml(heading)}.</strong> ${escapeHtml(copy)}</span>
    </div>
  `;
}

function renderActionDock(capability) {
  const canMutate = capability.write && state.selectedSubId >= 0;
  const canReview = canMutate && currentProfileAvailable();
  return `
    <div class="action-dock">
      <div class="action-inner">
        <button class="button button--secondary" type="button" data-action="reset-open" ${canMutate ? '' : 'disabled'}>
          ${icon('refresh', 18)} Restore defaults
        </button>
        <button class="button button--primary" type="button" data-action="review" ${canReview ? '' : 'disabled'}>
          ${icon('clipboard', 18)} Review & apply
        </button>
      </div>
    </div>
  `;
}

function renderModal() {
  if (!state.modal) return '<div class="modal-backdrop" hidden></div>';
  const type = state.modal.type;

  if (type === 'review') {
    const profile = getProfile(state.profile);
    const requested = describeRequested();
    const operation = profileOperation(state.profile);
    const clearsRestrictions = operation === 'reset' || operation === 'preserve';
    const preservesAutomaticSelection = operation === 'preserve';
    const restoresLteEligibility = state.profile === 'lte-plus';
    const holdLabel = 'Hold to apply';
    const subscription = state.status.subscriptions.find(
      (item) => item.subId === state.selectedSubId,
    );
    return sheet(`
      <div class="sheet-header">
        <h2 id="sheet-title">${restoresLteEligibility ? 'Apply LTE+ safeguard' : 'Review changes'}</h2>
        <button class="sheet-close" type="button" data-action="modal-close">Close</button>
      </div>
      <dl class="review-table">
        <div class="review-row"><dt>Current mode</dt><dd>${escapeHtml(currentModeDescription())}</dd></div>
        <div class="review-row"><dt>Requested profile</dt><dd>${escapeHtml(profile.name)}</dd></div>
        <div class="review-row"><dt>Band request</dt><dd>${escapeHtml(requested)}</dd></div>
        <div class="review-row"><dt>Subscription</dt><dd>${escapeHtml(subscriptionLabel(subscription, true))} · sub ${state.selectedSubId}</dd></div>
      </dl>
      <button class="hold-button" type="button" data-action="hold-apply" data-idle-label="${holdLabel}">
        <span>${icon('shield', 18)} ${holdLabel}</span>
      </button>
      <p class="sheet-warning">${icon(clearsRestrictions ? 'info' : 'warning', 17)} ${clearsRestrictions
        ? preservesAutomaticSelection
          ? 'If this SIM is already using automatic bands, the radio is left untouched. An active module restriction is cleared only when needed. Keyboard and switch users can press Enter twice.'
          : 'This expands band eligibility by clearing the module restriction. It does not fabricate a 4G+ state or override carrier scheduling. Keyboard and switch users can press Enter twice.'
        : 'A 45-second watchdog restores the exact prior selection unless you explicitly confirm service afterward. Keyboard and switch users can press Enter twice.'}</p>
    `);
  }

  if (type === 'reset') {
    const subscription = state.status.subscriptions.find(
      (item) => item.subId === state.selectedSubId,
    );
    return sheet(`
      <div class="sheet-header">
        <h2 id="sheet-title">Restore automatic bands</h2>
        <button class="sheet-close" type="button" data-action="modal-close">Close</button>
      </div>
      <p class="section-copy">This clears the module’s band scan restriction for ${escapeHtml(subscriptionLabel(subscription))}. It does not restart the modem, toggle airplane mode, or rewrite Qualcomm NV/EFS.</p>
      <label class="confirm-label" for="confirm-text"><span>Type <code>RESET</code> to continue</span><span id="confirm-count">0/5</span></label>
      <input class="confirm-input" id="confirm-text" autocomplete="off" autocapitalize="characters" maxlength="5" inputmode="text" placeholder="RESET" />
      <button class="button button--danger" type="button" data-action="reset-confirm" disabled>${icon('refresh', 18)} Restore defaults</button>
    `);
  }

  if (type === 'pending') {
    return sheet(`
      <div class="sheet-header">
        <h2 id="sheet-title">Check service now</h2>
      </div>
      <p class="section-copy">Confirm only after mobile data and the services you rely on are working. Calls, SMS, IMS/VoLTE, roaming, and handover can be affected even when signal bars look normal.</p>
      <dl class="review-table">
        <div class="review-row"><dt>Requested mode</dt><dd>${escapeHtml(describeRequested())}</dd></div>
        <div class="review-row"><dt>Automatic rollback</dt><dd id="rollback-countdown">${escapeHtml(countdownText())}</dd></div>
      </dl>
      <div class="action-inner">
        <button class="button button--secondary" type="button" data-action="rollback-now">Undo now</button>
        <button class="button button--primary" type="button" data-action="keep-change">Keep this change</button>
      </div>
      <p class="sheet-warning">${icon('shield', 17)} Closing KernelSU does not cancel the watchdog.</p>
    `, false);
  }

  if (type === 'device') {
    const device = state.status.device;
    return sheet(`
      <div class="sheet-header">
        <h2 id="sheet-title">Device & safety</h2>
        <button class="sheet-close" type="button" data-action="modal-close">Close</button>
      </div>
      <dl class="review-table">
        <div class="review-row"><dt>Manufacturer</dt><dd>${escapeHtml(device.manufacturer || 'Unknown')}</dd></div>
        <div class="review-row"><dt>Reported model</dt><dd>${escapeHtml(device.model || 'Unknown')}</dd></div>
        <div class="review-row"><dt>Product</dt><dd>${escapeHtml(device.product || 'Unknown')}</dd></div>
        <div class="review-row"><dt>Android</dt><dd>${escapeHtml(`${device.release || 'Unknown'} · API ${device.sdk || '—'}`)}</dd></div>
        <div class="review-row"><dt>Band candidates</dt><dd>${escapeHtml(state.status.catalog.source)}</dd></div>
      </dl>
      <div class="source-note">
        ${icon('info', 19)}
        <span>Device identity is reported by Android. Band candidates are learned from runtime radio data and the current selection; they are not a claim of complete hardware support.</span>
      </div>
      <p class="section-copy">This module uses Android’s system-selection channel API only. It never writes DIAG NV/EFS, IMEI, calibration, carrier policy, or persist.radio properties, and it never makes SELinux permissive.</p>
    `);
  }

  return '';
}

function sheet(content, closeOnBackdrop = true) {
  return `
    <div class="modal-backdrop" data-close-backdrop="${closeOnBackdrop}" role="presentation">
      <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1">
        ${content}
      </section>
    </div>
  `;
}

function bindEvents() {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });
  document.querySelectorAll('[data-go-tab]').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.goTab));
  });
  document.querySelectorAll('[data-band-rat]').forEach((button) => {
    button.addEventListener('click', () => toggleBand(button.dataset.bandRat, Number(button.dataset.band)));
  });
  document.querySelectorAll('[data-profile]').forEach((button) => {
    button.addEventListener('click', () => chooseProfile(button.dataset.profile));
  });

  document.querySelectorAll('[data-action="subscription"]').forEach((select) => {
    select.addEventListener('change', changeSubscription);
  });
  document.querySelector('[data-action="device-info"]')?.addEventListener('click', () => openModal('device'));
  document.querySelector('[data-action="review"]')?.addEventListener('click', openReview);
  document.querySelector('[data-action="reset-open"]')?.addEventListener('click', () => openModal('reset'));
  document.querySelector('[data-action="modal-close"]')?.addEventListener('click', closeModal);
  document.querySelector('[data-action="reapply"]')?.addEventListener('click', toggleReapply);
  document.querySelector('[data-action="refresh-logs"]')?.addEventListener('click', loadLogs);
  document.querySelector('[data-action="copy-logs"]')?.addEventListener('click', copyLogs);
  document.querySelector('[data-action="clear-logs"]')?.addEventListener('click', clearLogView);
  document.querySelector('[data-action="reset-confirm"]')?.addEventListener('click', () => performReset(false));
  document.querySelector('[data-action="keep-change"]')?.addEventListener('click', keepPendingChange);
  document.querySelector('[data-action="rollback-now"]')?.addEventListener('click', rollbackPendingChange);

  const backdrop = document.querySelector('.modal-backdrop:not([hidden])');
  backdrop?.addEventListener('click', (event) => {
    if (event.target === backdrop && backdrop.dataset.closeBackdrop === 'true') closeModal();
  });

  const confirmation = document.querySelector('#confirm-text');
  confirmation?.addEventListener('input', updateConfirmation);
  setupHoldButton();
}

function tabButton(id, label) {
  return `<button class="tab-button" id="tab-${id}" type="button" role="tab" data-tab="${id}" aria-selected="${state.tab === id}" aria-controls="page-${id}">${label}</button>`;
}

async function switchTab(tab) {
  if (!['overview', 'bands', 'profiles', 'logs'].includes(tab)) return;
  state.tab = tab;
  render();
  if (tab === 'logs' && !state.logsLoaded) await loadLogs();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleBand(rat, band) {
  if (!['lte', 'nr'].includes(rat) || !Number.isInteger(band)) return;
  const selection = state.selected[rat];
  if (!bandAllowed(state.status, rat, band) && !selection.has(band)) {
    showToast('This detected band is monitor-only under the current Android input policy.', 'error');
    return;
  }
  if (selection.has(band)) selection.delete(band);
  else selection.add(band);
  state.profile = 'custom';
  state.dirty = true;
  render();
}

function chooseProfile(profileId) {
  const preset = profilePreset(profileId, selectableCatalog(state.status));
  if (!preset.available) {
    showToast(preset.reason, 'error');
    return;
  }
  state.profile = profileId;
  state.selected = {
    lte: new Set(preset.lte),
    nr: new Set(preset.nr),
  };
  state.dirty = true;
  render();
}

async function changeSubscription(event) {
  const subId = Number(event.target.value);
  const knownSubscription = state.status?.subscriptions.some((subscription) => subscription.subId === subId);
  if (!Number.isInteger(subId) || !knownSubscription) {
    syncSubscriptionSelectors();
    return;
  }
  if (subId === state.selectedSubId) {
    syncSubscriptionSelectors();
    return;
  }
  if (state.loading) {
    syncSubscriptionSelectors();
    return;
  }

  const guardToken = ++subscriptionSwitchToken;
  state.loading = 'Reading selected SIM…';
  patchBusyOverlay();
  syncSubscriptionSelectors(subId);
  try {
    const loaded = await loadDashboard(subId, false, guardToken);
    if (loaded) {
      const selected = state.status.subscriptions.find((subscription) => subscription.subId === subId);
      showToast(`Showing ${subscriptionLabel(selected, true)}.`, 'ok');
    }
  } catch (error) {
    if (guardToken !== subscriptionSwitchToken) return;
    state.loading = false;
    patchBusyOverlay();
    syncSubscriptionSelectors();
    showToast(errorMessage(error), 'error');
  }
}

function openReview() {
  const problem = validateRequested();
  if (problem) {
    showToast(problem, 'error');
    return;
  }
  openModal('review');
}

function openModal(type) {
  state.modal = { type };
  render();
  focusModal();
}

function closeModal() {
  if (state.modal?.type === 'pending') return;
  state.modal = null;
  cancelHold();
  render();
}

function focusModal() {
  window.setTimeout(() => {
    const target = document.querySelector('#confirm-text')
      || document.querySelector('[data-action="hold-apply"]')
      || document.querySelector('.sheet');
    target?.focus();
  }, 30);
}

function updateConfirmation(event) {
  const value = event.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  event.target.value = value;
  const expected = 'RESET';
  const count = document.querySelector('#confirm-count');
  if (count) count.textContent = `${Math.min(value.length, expected.length)}/${expected.length}`;
  const action = document.querySelector('[data-action="reset-confirm"]');
  if (action) action.disabled = value !== expected;
}

function setupHoldButton() {
  const button = document.querySelector('[data-action="hold-apply"]');
  if (!button) return;
  let keyboardArmUntil = 0;
  const idleLabel = button.dataset.idleLabel || 'Hold to apply';

  const start = (event) => {
    if (button.disabled || holdStart) return;
    event.preventDefault();
    holdStart = performance.now();
    holdTriggered = false;
    updateHold(button);
  };
  const stop = () => {
    if (!holdTriggered) cancelHold(button);
  };

  button.addEventListener('pointerdown', start);
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointercancel', stop);
  button.addEventListener('pointerleave', stop);
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (button.disabled) return;
      event.preventDefault();
      if (Date.now() <= keyboardArmUntil) {
        keyboardArmUntil = 0;
        performApply();
        return;
      }
      keyboardArmUntil = Date.now() + 2_500;
      const label = button.querySelector('span');
      if (label) label.innerHTML = `${icon('shield', 18)} Press Enter again`;
      window.setTimeout(() => {
        if (Date.now() > keyboardArmUntil && document.contains(button)) {
          if (label) label.innerHTML = `${icon('shield', 18)} ${idleLabel}`;
        }
      }, 2_550);
      return;
    }
    if (event.key === ' ') start(event);
  });
  button.addEventListener('keyup', (event) => {
    if (event.key === ' ') stop();
  });
}

function updateHold(button) {
  const elapsed = performance.now() - holdStart;
  const progress = Math.min(1, elapsed / 1_350);
  button.style.setProperty('--hold-progress', progress.toFixed(3));
  if (progress >= 1) {
    holdTriggered = true;
    holdStart = 0;
    window.cancelAnimationFrame(holdFrame);
    performApply();
    return;
  }
  holdFrame = window.requestAnimationFrame(() => updateHold(button));
}

function cancelHold(button = document.querySelector('[data-action="hold-apply"]')) {
  window.cancelAnimationFrame(holdFrame);
  holdFrame = 0;
  holdStart = 0;
  if (button) button.style.setProperty('--hold-progress', '0');
}

async function performApply() {
  if (state.loading) return;
  const problem = validateRequested();
  if (problem) {
    showToast(problem, 'error');
    closeModal();
    return;
  }

  if (profileOperation(state.profile) === 'reset') {
    await performReset(true);
    return;
  }

  state.modal = null;
  state.loading = profileOperation(state.profile) === 'preserve'
    ? 'Checking LTE+ safeguard state…'
    : 'Applying guarded band request…';
  render();
  try {
    const result = await applySelection({
      subId: state.selectedSubId,
      lte: [...state.selected.lte],
      nr: [...state.selected.nr],
      profile: backendProfileId(state.profile),
    });
    state.loading = false;
    state.dirty = false;
    state.pendingToken = String(result.pendingToken || '');
    state.rollbackAt = normalizeEpoch(result.rollbackAt);
    if (state.pendingToken && state.rollbackAt > Date.now()) {
      state.modal = { type: 'pending' };
      render();
      focusModal();
    } else {
      showToast(result.message || 'Band request applied.', 'ok');
      await loadDashboard(state.selectedSubId, false);
    }
  } catch (error) {
    state.loading = false;
    showToast(errorMessage(error), 'error');
    render();
  }
}

async function performReset(fromApply = false) {
  if (state.loading) return;
  if (state.selectedSubId < 0) {
    showToast('No active SIM is available for reset.', 'error');
    return;
  }
  const restoringLteEligibility = fromApply && state.profile === 'lte-plus';
  state.modal = null;
  state.loading = 'Restoring automatic band selection…';
  render();
  try {
    const result = await resetSelection(state.selectedSubId);
    state.loading = false;
    state.profile = 'adaptive';
    state.selected = { lte: new Set(), nr: new Set() };
    state.dirty = false;
    state.pendingToken = '';
    state.rollbackAt = 0;
    const message = restoringLteEligibility
      ? 'Band restrictions cleared. LTE+ remains available whenever the carrier activates secondary cells.'
      : result.message || (fromApply ? 'Adaptive profile restored.' : 'Automatic bands restored.');
    showToast(message, 'ok');
    await loadDashboard(state.selectedSubId, false);
  } catch (error) {
    state.loading = false;
    showToast(errorMessage(error), 'error');
    render();
  }
}

async function keepPendingChange() {
  if (state.loading || !state.pendingToken) return;
  state.loading = 'Confirming the guarded change…';
  render();
  try {
    await confirmSelection(state.pendingToken);
    state.loading = false;
    state.modal = null;
    state.pendingToken = '';
    state.rollbackAt = 0;
    showToast('Change kept. Restore defaults remains available.', 'ok');
    await loadDashboard(state.selectedSubId, false);
  } catch (error) {
    state.loading = false;
    showToast(errorMessage(error), 'error');
    render();
  }
}

async function rollbackPendingChange() {
  if (state.loading || !state.pendingToken) return;
  state.loading = 'Restoring the exact prior selection…';
  render();
  try {
    await rollbackSelection(state.pendingToken);
    state.loading = false;
    state.modal = null;
    state.pendingToken = '';
    state.rollbackAt = 0;
    state.dirty = false;
    showToast('Previous radio selection restored.', 'ok');
    await loadDashboard(state.selectedSubId, false);
  } catch (error) {
    state.loading = false;
    showToast(errorMessage(error), 'error');
    render();
  }
}

async function toggleReapply() {
  const settingsMatch = state.settings.subId === state.selectedSubId;
  const current = settingsMatch && state.settings.applied && state.settings.reapply;
  const next = !current;
  if (next && (!settingsMatch || !state.settings.applied)) {
    showToast('Apply and confirm a stable restriction before enabling boot reapply.', 'error');
    return;
  }
  state.loading = next ? 'Enabling guarded boot reapply…' : 'Disabling boot reapply…';
  render();
  try {
    await setReapply(next);
    state.settings.reapply = next;
    state.loading = false;
    showToast(next ? 'Boot reapply enabled.' : 'Boot reapply disabled.', 'ok');
    render();
  } catch (error) {
    state.loading = false;
    showToast(errorMessage(error), 'error');
    render();
  }
}

async function loadLogs() {
  state.loading = 'Reading module logs…';
  render();
  try {
    state.logs = await readLogs(300);
    state.logsLoaded = true;
    state.loading = false;
    render();
  } catch (error) {
    state.loading = false;
    state.logsLoaded = true;
    state.logs = `Unable to read logs: ${errorMessage(error)}`;
    render();
  }
}

async function clearLogView() {
  state.loading = 'Clearing module logs…';
  render();
  try {
    await clearLogs();
    state.logs = '';
    state.logsLoaded = true;
    state.loading = false;
    showToast('Logs cleared.', 'ok');
    render();
  } catch (error) {
    state.loading = false;
    showToast(errorMessage(error), 'error');
    render();
  }
}

async function copyLogs() {
  const text = state.logs || '';
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  showToast('Logs copied.', 'ok');
}

function validateRequested() {
  if (state.selectedSubId < 0) return 'No active SIM was detected.';
  if (!currentProfileAvailable()) {
    return state.profile === 'custom'
      ? 'Select at least one discovered LTE or NR candidate.'
      : profilePreset(state.profile, selectableCatalog(state.status)).reason;
  }
  return validateSelection({
    canWrite: state.status.capability.write,
    profile: state.profile,
    lte: [...state.selected.lte],
    nr: [...state.selected.nr],
    inputPolicy: state.status.inputPolicy,
  });
}

function currentProfileAvailable() {
  if (!state.status) return false;
  if (state.profile === 'custom') {
    return state.selected.lte.size + state.selected.nr.size > 0;
  }
  return profilePreset(state.profile, selectableCatalog(state.status)).available;
}

function startPendingTimer() {
  updatePendingCountdown();
  pendingTimer = window.setInterval(updatePendingCountdown, 250);
}

function stopPendingTimer() {
  window.clearInterval(pendingTimer);
  pendingTimer = 0;
}

function updatePendingCountdown() {
  const target = document.querySelector('#rollback-countdown');
  if (target) target.textContent = countdownText();
  if (state.rollbackAt && Date.now() >= state.rollbackAt) {
    stopPendingTimer();
    window.setTimeout(refreshDashboard, 600);
  }
}

function countdownText() {
  const remaining = Math.max(0, state.rollbackAt - Date.now());
  return remaining > 0 ? `${Math.ceil(remaining / 1000)} seconds` : 'Rollback in progress…';
}

function showToast(message, kind = 'ok') {
  window.clearTimeout(toastTimer);
  state.toast = { message, kind };
  showNativeToast(message);
  const region = document.querySelector('.toast-region');
  if (region) region.innerHTML = `<div class="toast-message" data-kind="${escapeHtml(kind)}">${escapeHtml(message)}</div>`;
  toastTimer = window.setTimeout(() => {
    state.toast = null;
    const current = document.querySelector('.toast-region');
    if (current) current.innerHTML = '';
  }, 3_800);
}

function updateConnectionError(error) {
  const strip = document.querySelector('.connection-strip');
  if (!strip) return;
  strip.dataset.state = 'error';
  const label = strip.querySelector('span:nth-child(2)');
  if (label) label.textContent = `Refresh failed · ${errorMessage(error)}`;
}

function renderFatal(error) {
  const message = errorMessage(error);
  app.innerHTML = `
    <main class="boot-screen">
      <div class="brand-mark" aria-hidden="true"><i></i><i></i></div>
      <h1 class="section-title">Could not open the radio backend</h1>
      <p class="section-copy">${escapeHtml(message)}</p>
      <button class="button button--primary" type="button" id="retry">${icon('refresh', 18)} Retry</button>
    </main>`;
  document.querySelector('#retry')?.addEventListener('click', () => window.location.reload());
}

function normalizeStatus(raw = {}) {
  const device = raw.device || {};
  const normalizedSubscriptions = normalizeSubscriptions(
    raw.subscriptions,
    raw.selectedSubId ?? raw.subId,
  );
  const { subscriptions, selectedSubId, slotIndex } = normalizedSubscriptions;
  const servingSource = raw.serving || raw.active || raw.channels || [];
  const serving = Array.isArray(servingSource)
    ? servingSource.map(normalizeCarrier).filter((carrier) => carrier.rat === 'LTE' || carrier.rat === 'NR')
    : [];
  serving.sort((a, b) => Number(b.rat === 'NR') - Number(a.rat === 'NR') || Number(b.primary) - Number(a.primary));

  const observed = raw.observed || {};
  const discoveredRaw = raw.discoveredBands || {};
  const discoveredServing = discoveredRaw.serving || {};
  const discoveredObserved = discoveredRaw.observed || {};
  const discoveredSelection = discoveredRaw.selection || {};
  const discoveredAll = discoveredRaw.all || {};
  const inputPolicyRaw = raw.inputPolicy || {};
  const model = stringValue(device.model ?? raw.model ?? 'Unknown device');
  const selectionRaw = raw.selection || raw.currentSelection || {};
  const selectionLte = uniqueBands([...parseBands(selectionRaw.lte), ...parseBands(discoveredSelection.lte)]);
  const selectionNr = uniqueBands([...parseBands(selectionRaw.nr), ...parseBands(discoveredSelection.nr)]);
  const hasExplicitSelection = selectionLte.length + selectionNr.length > 0;
  const selection = {
    auto: hasExplicitSelection ? false : Boolean(selectionRaw.auto ?? selectionRaw.isAuto ?? true),
    lte: selectionLte,
    nr: selectionNr,
  };
  const normalizedObserved = {
    lte: uniqueBands([...parseBands(observed.lte), ...parseBands(discoveredObserved.lte), ...serving.filter((item) => item.rat === 'LTE').map((item) => item.band)]),
    nr: uniqueBands([...parseBands(observed.nr), ...parseBands(discoveredObserved.nr), ...serving.filter((item) => item.rat === 'NR').map((item) => item.band)]),
  };
  const cachedCandidates = state.candidateCache.get(selectedSubId) || { lte: [], nr: [] };
  const candidates = deriveBandCandidates({
    serving,
    observed: normalizedObserved,
    selection,
    cached: {
      lte: uniqueBands([...cachedCandidates.lte, ...parseBands(discoveredAll.lte), ...parseBands(discoveredServing.lte)]),
      nr: uniqueBands([...cachedCandidates.nr, ...parseBands(discoveredAll.nr), ...parseBands(discoveredServing.nr)]),
    },
  });
  if (selectedSubId >= 0) {
    state.candidateCache.set(selectedSubId, { lte: candidates.lte, nr: candidates.nr });
  }
  const capabilityRaw = raw.capability || raw.capabilities || {};
  const write = Boolean(capabilityRaw.write ?? capabilityRaw.canWrite ?? capabilityRaw.setSupported ?? raw.writeSupported);
  const read = Boolean(capabilityRaw.read ?? capabilityRaw.canRead ?? true);
  const timestamp = normalizeEpoch(raw.timestamp || Date.now());
  const overallSignalLevel = signalLevelValue(raw.signalLevel);
  const carrierAggregationActive = Boolean(raw.carrierAggregationActive);
  const normalizedMode = normalizeMode(raw.mode ?? raw.networkMode, serving, Boolean(raw.connected ?? serving.length));

  return {
    preview: Boolean(raw.preview),
    timestamp,
    device: {
      model,
      product: stringValue(device.product ?? device.device ?? raw.product),
      manufacturer: stringValue(device.manufacturer ?? raw.manufacturer ?? 'Unknown'),
      sdk: finiteNumber(device.sdk ?? raw.sdk, 0),
      release: stringValue(device.release ?? raw.release),
      rom: stringValue(device.rom ?? device.os ?? raw.rom),
    },
    subscriptions,
    selectedSubId,
    slotIndex,
    connected: Boolean(raw.connected ?? raw.registered ?? serving.length),
    mode: carrierAggregationActive && normalizedMode === 'LTE' ? 'LTE+' : normalizedMode,
    signalLevel: overallSignalLevel,
    carrierAggregationActive,
    serving,
    discovered: {
      serving: {
        lte: uniqueBands([...parseBands(discoveredServing.lte), ...serving.filter((item) => item.rat === 'LTE').map((item) => item.band)]),
        nr: uniqueBands([...parseBands(discoveredServing.nr), ...serving.filter((item) => item.rat === 'NR').map((item) => item.band)]),
      },
      observed: normalizedObserved,
      selection: { lte: selection.lte, nr: selection.nr },
    },
    observed: normalizedObserved,
    catalog: candidates,
    inputPolicy: {
      lte: uniqueBands(parseBands(inputPolicyRaw.lte)),
      nr: uniqueBands(parseBands(inputPolicyRaw.nr)),
      supplementalDownlinkLte: uniqueBands(parseBands(inputPolicyRaw.supplementalDownlinkLte)),
      supplementalDownlinkNr: uniqueBands(parseBands(inputPolicyRaw.supplementalDownlinkNr)),
      supplementalUplinkNr: uniqueBands(parseBands(inputPolicyRaw.supplementalUplinkNr)),
      basis: stringValue(inputPolicyRaw.basis || 'No mutation input policy was reported'),
      deviceCapabilityClaim: Boolean(inputPolicyRaw.deviceCapabilityClaim),
    },
    selection,
    capability: {
      read,
      write,
      reason: stringValue(capabilityRaw.reason ?? capabilityRaw.message),
      experimental: true,
    },
  };
}

function includeCandidateBands(status, lte, nr) {
  const candidates = deriveBandCandidates({
    serving: status.serving,
    observed: status.observed,
    selection: {
      lte: uniqueBands([...status.selection.lte, ...lte]),
      nr: uniqueBands([...status.selection.nr, ...nr]),
    },
    cached: status.catalog,
  });
  status.catalog = candidates;
  if (status.selectedSubId >= 0) {
    state.candidateCache.set(status.selectedSubId, { lte: candidates.lte, nr: candidates.nr });
  }
}

function catalogKey(catalog = {}) {
  return `${uniqueBands(catalog.lte).join(',')}|${uniqueBands(catalog.nr).join(',')}`;
}

function selectableCatalog(status) {
  return filterByInputPolicy(status?.catalog, status?.inputPolicy);
}

function bandAllowed(status, rat, band) {
  return status?.inputPolicy?.[rat]?.includes(band) === true;
}

function candidateOrigin(status, rat, band) {
  const radioRat = rat === 'nr' ? 'NR' : 'LTE';
  const labels = [];
  if (status.serving.some((item) => item.rat === radioRat && item.band === band)) labels.push('Active now');
  else if (status.discovered.serving[rat].includes(band)) labels.push('Serving report');
  if (status.selection[rat].includes(band)) labels.push('Current selection');
  if (labels.length) return labels.join(' · ');
  if (status.observed[rat].includes(band)) return 'Observed / cached';
  return 'Session cache';
}

function normalizeSettings(raw = {}) {
  return {
    profile: stringValue(raw.profile || 'adaptive'),
    lte: parseBands(raw.lte ?? raw.lteBands),
    nr: parseBands(raw.nr ?? raw.nrBands),
    reapply: Boolean(raw.reapply === true || raw.reapply === 'on' || raw.reapply === '1'),
    applied: Boolean(raw.applied === true || raw.applied === 'true' || raw.applied === '1'),
    subId: finiteNumber(raw.subId, -1),
    pendingToken: stringValue(raw.pendingToken),
    rollbackAt: normalizeEpoch(raw.rollbackAt),
  };
}

function normalizeCarrier(item = {}) {
  const ratRaw = stringValue(item.rat ?? item.networkType ?? item.type).toUpperCase();
  const rat = ratRaw.includes('NR') || ratRaw.includes('5G') ? 'NR' : ratRaw.includes('LTE') || ratRaw.includes('4G') ? 'LTE' : ratRaw;
  const primary = item.primary ?? item.isPrimary ?? (Number(item.connectionStatus) === 1);
  return {
    rat,
    band: nullableNumber(item.band),
    primary: Boolean(primary),
    registered: Boolean(item.registered ?? item.isRegistered ?? true),
    channel: nullableNumber(item.channel ?? item.earfcn ?? item.nrarfcn ?? item.arfcn),
    pci: nullableNumber(item.pci ?? item.physicalCellId),
    bandwidthKhz: nullableNumber(item.bandwidthKhz ?? item.bandwidth),
    rsrp: nullableNumber(item.rsrp ?? item.ssRsrp ?? item.csiRsrp),
    rsrq: nullableNumber(item.rsrq ?? item.ssRsrq ?? item.csiRsrq),
    sinr: nullableNumber(item.sinr ?? item.ssSinr ?? item.rssnr),
    level: signalLevelValue(item.level ?? item.signalLevel),
  };
}

function parseBands(value) {
  if (Array.isArray(value)) return uniqueBands(value);
  if (typeof value === 'string') return uniqueBands(value.split(/[,:\s]+/));
  return [];
}

function deriveMode(serving, connected = true) {
  if (!connected) return 'No service';
  const hasNr = serving.some((item) => item.rat === 'NR');
  const lteCount = serving.filter((item) => item.rat === 'LTE').length;
  if (hasNr && lteCount) return '5G NSA';
  if (hasNr) return '5G SA';
  if (lteCount) return 'LTE';
  return 'Radio idle';
}

function normalizeMode(value, serving, connected) {
  const mode = stringValue(value).trim().toUpperCase();
  if (!mode) return deriveMode(serving, connected);
  if (mode === 'NSA') return '5G NSA';
  if (mode === 'SA' || mode === 'NR') return '5G SA';
  if (mode === 'LTE_CA' || mode === 'LTE+') return 'LTE+';
  if (mode === 'NONE') return 'No service';
  if (mode === 'OTHER') return 'Other';
  return stringValue(value);
}

function primaryMetric(status, key) {
  const primary = status.serving.find((carrier) => carrier.primary && carrier[key] != null);
  if (primary) return primary[key];
  const available = status.serving.filter((carrier) => carrier[key] != null).map((carrier) => carrier[key]);
  if (!available.length) return null;
  return key === 'rsrp' ? Math.max(...available) : available[0];
}

function formatBand(carrier) {
  return `${carrier.rat === 'NR' ? 'n' : 'B'}${carrier.band}`;
}

function shortBand(carrier) {
  if (!carrier.band) return '—';
  return `${carrier.rat === 'NR' ? 'n' : 'B'}${carrier.band}`;
}

function carrierRole(carrier) {
  const role = carrier.primary ? 'primary serving cell' : 'secondary or observed carrier';
  return `${formatBand(carrier)}, ${role}`;
}

function uniqueBandObjects(status) {
  const servingKeys = new Set(status.serving.filter((item) => item.band).map((item) => `${item.rat}:${item.band}`));
  const items = [
    ...status.serving.filter((item) => item.band).map((item) => ({ rat: item.rat, band: item.band, serving: true })),
    ...status.observed.nr.map((band) => ({ rat: 'NR', band, serving: servingKeys.has(`NR:${band}`) })),
    ...status.observed.lte.map((band) => ({ rat: 'LTE', band, serving: servingKeys.has(`LTE:${band}`) })),
  ];
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.rat}:${item.band}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function currentModeDescription() {
  const selection = state.status.selection;
  if (selection.auto) return `${state.status.mode} · automatic bands`;
  const parts = [];
  if (selection.lte.length) parts.push(`LTE ${selection.lte.map((band) => `B${band}`).join(', ')}`);
  if (selection.nr.length) parts.push(`NR ${selection.nr.map((band) => `n${band}`).join(', ')}`);
  return parts.join(' · ') || state.status.mode;
}

function describeRequested() {
  if (state.profile === 'lte-plus') {
    return 'Automatic LTE bands (restriction cleared; aggregation remains carrier-controlled)';
  }
  if (state.profile === 'adaptive') return 'Automatic bands (restriction cleared)';
  const parts = [];
  const lte = uniqueBands([...state.selected.lte]);
  const nr = uniqueBands([...state.selected.nr]);
  if (lte.length) parts.push(`LTE ${lte.map((band) => `B${band}`).join(', ')}`);
  if (nr.length) parts.push(`NR ${nr.map((band) => `n${band}`).join(', ')}`);
  return parts.join(' · ') || 'No bands selected';
}

function renderSignalChart() {
  const { line, area } = signalChartGeometry();
  return `
    <div class="signal-chart" aria-label="Recent RSRP samples">
      <svg viewBox="0 0 100 82" preserveAspectRatio="none" role="img" aria-label="Signal history">
        <defs><linearGradient id="signalFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff4653" stop-opacity=".28"/><stop offset="1" stop-color="#ff4653" stop-opacity="0"/></linearGradient></defs>
        <path class="area" d="${area}" />
        <path class="trace" d="${line}" vector-effect="non-scaling-stroke" />
      </svg>
    </div>`;
}

function signalChartGeometry() {
  const values = state.signalHistory.filter(Number.isFinite);
  if (!values.length) return { line: '', area: '' };
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * 100;
    const clamped = Math.max(-120, Math.min(-65, value));
    const y = 78 - ((clamped + 120) / 55) * 62;
    return [x, y];
  });
  if (points.length === 1) points.push([100, points[0][1]]);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${line} L 100 82 L 0 82 Z`;
  return { line, area };
}

function seedSignalHistory(value) {
  if (value == null) return [];
  return [value];
}

function appendSignal(value) {
  if (value == null) return;
  state.signalHistory.push(value);
  if (state.signalHistory.length > 32) state.signalHistory.shift();
}

function metric(label, value, liveKey = '') {
  return `<div class="metric"${liveKey ? ` data-live-metric="${liveKey}"` : ''}><dt>${label}</dt><dd>${value}</dd></div>`;
}

function formatMetric(value, unit) {
  if (value == null) return '—';
  const display = Number(value) < 0 ? `−${Math.abs(Number(value))}` : String(Number(value));
  return `${escapeHtml(display)} <small>${escapeHtml(unit)}</small>`;
}

function formatPlain(value) {
  return value == null ? '—' : escapeHtml(String(value));
}

function signalLevel(status, rsrp) {
  const primary = status.serving.find((carrier) => carrier.primary && carrier.registered);
  if (primary && primary.level != null) return primary.level;
  if (status.signalLevel != null) return status.signalLevel;
  if (!Number.isFinite(rsrp) || rsrp < -140 || rsrp > -44) return 0;
  if (rsrp >= -85) return 4;
  if (rsrp >= -95) return 3;
  if (rsrp >= -105) return 2;
  if (rsrp >= -115) return 1;
  return 0;
}

function signalLevelValue(value) {
  if (value == null || value === '') return null;
  const level = Number(value);
  return Number.isInteger(level) && level >= 0 && level <= 4 ? level : null;
}

function qualityLabel(level) {
  return ['Unknown', 'Weak', 'Fair', 'Good', 'Strong'][level] || 'Unknown';
}

function errorMessage(error) {
  if (error instanceof BackendError) return error.message;
  return error?.message || String(error || 'Unknown error');
}

function normalizeEpoch(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1_000_000_000_000 ? number * 1000 : number;
}

function finiteNumber(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  const number = Number(value);
  return value == null || value === '' || !Number.isFinite(number) ? null : number;
}

function stringValue(value) {
  return value == null ? '' : String(value);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.modal && state.modal.type !== 'pending') closeModal();
});

window.addEventListener('pagehide', () => {
  window.clearInterval(refreshTimer);
  stopPendingTimer();
  cancelHold();
});
