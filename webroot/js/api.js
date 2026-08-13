import { enableEdgeToEdge, hasKernelSUBridge, nativeToast, spawn } from './vendor/kernelsu.js';
import { uniqueBands } from './catalog.js';

const MODULE_DIR = '/data/adb/modules/opbandcontrol';
const BUSYBOX = '/data/adb/ksu/bin/busybox';
const CONTROL = `${MODULE_DIR}/bin/control.sh`;
const MOCK_KEY = 'opbandcontrol.mock.v1';

export class BackendError extends Error {
  constructor(message, details = '') {
    super(message);
    this.name = 'BackendError';
    this.details = details;
  }
}

export const environment = Object.freeze({
  isKernelSU: hasKernelSUBridge(),
  moduleDir: MODULE_DIR,
});

enableEdgeToEdge(true);

export async function readDashboard(subId) {
  const numericSub = Number(subId);
  const statusArgs = Number.isInteger(numericSub) && numericSub >= 0
    ? ['status', String(numericSub)]
    : ['status'];
  const [status, settings] = await Promise.all([
    callJson(statusArgs),
    callJson(['settings']),
  ]);
  return { status, settings };
}

export async function applySelection({ subId, lte, nr, profile }) {
  return callJson([
    'apply',
    String(Number(subId)),
    toCsv(lte),
    toCsv(nr),
    String(profile),
  ]);
}

export async function resetSelection(subId) {
  const numericSub = Number(subId);
  return callJson(Number.isInteger(numericSub) && numericSub >= 0 ? ['reset', String(numericSub)] : ['reset']);
}

export async function confirmSelection(token) {
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(String(token))) {
    throw new BackendError('Invalid confirmation token');
  }
  return callJson(['confirm', String(token)]);
}

export async function rollbackSelection(token) {
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(String(token))) {
    throw new BackendError('Invalid rollback token');
  }
  return callJson(['rollback', String(token)]);
}

export async function setReapply(enabled) {
  return callJson(['set-reapply', enabled ? 'on' : 'off']);
}

export async function readLogs(limit = 200) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
  const result = await callJson(['logs', String(safeLimit)]);
  return typeof result.logs === 'string' ? result.logs : '';
}

export async function clearLogs() {
  return callJson(['clear-logs']);
}

export function showNativeToast(message) {
  nativeToast(message);
}

async function callJson(args) {
  if (!environment.isKernelSU) {
    return mockCall(args);
  }

  const result = await spawnControl(args);
  let payload;
  try {
    payload = JSON.parse(result.stdout.trim() || '{}');
  } catch (error) {
    throw new BackendError('The module returned an unreadable response', result.stdout || result.stderr);
  }

  if (result.code !== 0 || payload.ok === false) {
    const backendError = payload.error;
    const message = typeof backendError === 'string'
      ? backendError
      : backendError?.message || payload.message || 'The modem command failed';
    const details = payload.details || backendError?.details || result.stderr;
    throw new BackendError(message, details);
  }
  return payload;
}

function spawnControl(args) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let child;

    try {
      child = spawn(BUSYBOX, ['sh', CONTROL, ...args], {
        cwd: MODULE_DIR,
        env: {
          ASH_STANDALONE: '1',
          KSU_MODULE: 'opbandcontrol',
        },
      });
    } catch (error) {
      reject(new BackendError('Unable to start the module backend', error.message));
      return;
    }

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      reject(new BackendError('Unable to start the module backend', error?.message || String(error)));
    });
    child.on('exit', (code) => {
      resolve({ code: Number(code), stdout, stderr });
    });
  });
}

function toCsv(values) {
  const bands = uniqueBands(values);
  return bands.length ? bands.join(',') : '-';
}

function loadMock() {
  const defaults = {
    profile: 'adaptive',
    lte: [],
    nr: [],
    subId: 1,
    reapply: false,
    applied: false,
    logs: '[preview] KernelSU bridge not found; showing safe demonstration data.\n',
    pendingToken: '',
    rollbackAt: 0,
  };
  try {
    const stored = JSON.parse(localStorage.getItem(MOCK_KEY) || '{}');
    return { ...defaults, ...stored };
  } catch (_) {
    return defaults;
  }
}

function saveMock(state) {
  localStorage.setItem(MOCK_KEY, JSON.stringify(state));
}

function mockStatus(state, requestedSubId) {
  const auto = !state.applied;
  const selectionLte = auto ? [] : uniqueBands(state.lte);
  const selectionNr = auto ? [] : uniqueBands(state.nr);
  const numericSubId = Number(requestedSubId);
  const selectedSubId = [1, 2].includes(numericSubId)
    ? numericSubId
    : [1, 2].includes(Number(state.subId)) ? Number(state.subId) : 1;
  const secondSim = selectedSubId === 2;
  const serving = secondSim
    ? [{ rat: 'LTE', band: 8, primary: true, registered: true, channel: 3500, pci: 84, bandwidthKhz: 10000, rsrp: -97, rsrq: -12, sinr: 11, level: 2 }]
    : [
      { rat: 'NR', band: 78, primary: false, registered: true, channel: 640000, pci: 431, bandwidthKhz: 100000, rsrp: -88, rsrq: -11, sinr: 19, level: 3 },
      { rat: 'LTE', band: 3, primary: true, registered: true, channel: 1650, pci: 143, bandwidthKhz: 20000, rsrp: -91, rsrq: -10, sinr: 18, level: 3 },
      { rat: 'LTE', band: 1, primary: false, registered: true, channel: 300, pci: 143, bandwidthKhz: 15000, rsrp: -96, rsrq: -13, sinr: 13, level: 2 },
    ];
  const observed = secondSim
    ? { lte: [8, 28], nr: [] }
    : { lte: [1, 3, 7, 8, 28, 40], nr: [28, 41, 78] };
  return {
    ok: true,
    timestamp: Date.now(),
    preview: true,
    device: {
      model: 'Demo device',
      product: 'generic_runtime',
      manufacturer: 'Android',
      sdk: 36,
      release: '16',
      rom: 'Android',
    },
    subscriptions: [
      { subId: 1, slotIndex: 0, carrierName: 'Demo carrier', displayName: 'SIM 1', defaultData: true },
      { subId: 2, slotIndex: 1, carrierName: 'SIM 2', displayName: 'SIM 2', defaultData: false },
    ],
    selectedSubId,
    connected: true,
    mode: secondSim ? 'LTE' : '5G NSA',
    signalLevel: 3,
    carrierAggregationActive: !secondSim,
    serving,
    observed,
    discoveredBands: {
      serving: {
        lte: uniqueBands(serving.filter((item) => item.rat === 'LTE').map((item) => item.band)),
        nr: uniqueBands(serving.filter((item) => item.rat === 'NR').map((item) => item.band)),
      },
      observed,
      selection: { lte: selectionLte, nr: selectionNr },
      all: {
        lte: uniqueBands([...observed.lte, ...selectionLte, ...serving.filter((item) => item.rat === 'LTE').map((item) => item.band)]),
        nr: uniqueBands([...observed.nr, ...selectionNr, ...serving.filter((item) => item.rat === 'NR').map((item) => item.band)]),
      },
    },
    inputPolicy: {
      lte: [1, 3, 7, 8, 28, 29, 32, 40, 66],
      nr: [28, 29, 41, 75, 76, 78, 80],
      supplementalDownlinkLte: [29, 32],
      supplementalDownlinkNr: [29, 75, 76],
      supplementalUplinkNr: [80],
      basis: 'Preview subset of the Android input policy',
      deviceCapabilityClaim: false,
    },
    selection: { auto, lte: selectionLte, nr: selectionNr },
    capability: {
      read: true,
      write: true,
      reason: 'Preview mode · on-device support is verified at runtime',
      experimental: true,
    },
  };
}

async function mockCall(args) {
  await new Promise((resolve) => window.setTimeout(resolve, 120));
  const [verb, ...rest] = args;
  const state = loadMock();
  const now = new Date().toISOString();

  switch (verb) {
    case 'status':
      return mockStatus(state, rest[0]);
    case 'settings':
      return {
        ok: true,
        profile: state.profile,
        lte: uniqueBands(state.lte),
        nr: uniqueBands(state.nr),
        reapply: Boolean(state.reapply),
        applied: Boolean(state.applied),
        subId: Number(state.subId) || 1,
        pendingToken: state.pendingToken,
        rollbackAt: state.rollbackAt,
      };
    case 'apply': {
      const [subId, lteCsv, nrCsv, profile] = rest;
      if (profile === 'lte-plus') {
        state.subId = Number(subId) || 1;
        state.profile = profile;
        state.lte = [];
        state.nr = [];
        state.applied = false;
        state.reapply = false;
        state.pendingToken = '';
        state.rollbackAt = 0;
        state.logs += `[${now}] preview LTE+ safeguard: existing radio selection preserved\n`;
        saveMock(state);
        return {
          ok: true,
          operation: 'preserve',
          changed: false,
          noOp: true,
          profile,
          message: 'Automatic radio state preserved; no band write was sent.',
        };
      }
      const token = `preview-${Date.now()}`;
      state.subId = Number(subId) || 1;
      state.lte = parseCsv(lteCsv);
      state.nr = parseCsv(nrCsv);
      state.profile = profile;
      state.applied = true;
      state.pendingToken = token;
      state.rollbackAt = Date.now() + 45_000;
      state.logs += `[${now}] preview apply: ${profile}; LTE=${lteCsv}; NR=${nrCsv}\n`;
      saveMock(state);
      return { ok: true, pendingToken: token, rollbackAt: state.rollbackAt, message: 'Preview restriction applied' };
    }
    case 'confirm':
      if (rest[0] !== state.pendingToken) throw new BackendError('This pending change has expired');
      state.logs += `[${now}] preview change confirmed\n`;
      state.pendingToken = '';
      state.rollbackAt = 0;
      saveMock(state);
      return { ok: true, confirmed: true };
    case 'rollback':
      if (rest[0] !== state.pendingToken) throw new BackendError('This pending change has expired');
      state.profile = 'adaptive';
      state.lte = [];
      state.nr = [];
      state.applied = false;
      state.pendingToken = '';
      state.rollbackAt = 0;
      state.logs += `[${now}] preview change rolled back\n`;
      saveMock(state);
      return { ok: true, rolledBack: true };
    case 'reset':
      state.subId = Number(rest[0]) || Number(state.subId) || 1;
      state.profile = 'adaptive';
      state.lte = [];
      state.nr = [];
      state.applied = false;
      state.pendingToken = '';
      state.rollbackAt = 0;
      state.logs += `[${now}] preview reset to automatic bands\n`;
      saveMock(state);
      return { ok: true, message: 'Automatic bands restored' };
    case 'set-reapply':
      state.reapply = rest[0] === 'on';
      state.logs += `[${now}] preview boot reapply ${state.reapply ? 'enabled' : 'disabled'}\n`;
      saveMock(state);
      return { ok: true, reapply: state.reapply };
    case 'logs':
      return { ok: true, logs: state.logs };
    case 'clear-logs':
      state.logs = '';
      saveMock(state);
      return { ok: true };
    default:
      throw new BackendError(`Unknown preview command: ${verb}`);
  }
}

function parseCsv(value) {
  if (!value || value === '-') return [];
  return uniqueBands(String(value).split(','));
}
