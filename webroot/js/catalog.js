// These are standards-based profile hints, not a device support list. Every
// numbered preset is intersected with bands discovered for the selected SIM.
// Coverage-oriented operating bands whose standardized downlink allocation is
// below 1 GHz. The arrays are a profile hint and stay a strict subset of the
// Android API 35 input policy enforced by the privileged backend.
export const COVERAGE_CANDIDATES = Object.freeze({
  lte: Object.freeze([5, 6, 8, 12, 13, 14, 17, 18, 19, 20, 26, 27, 28, 31, 44, 68, 71, 72, 73, 85, 87, 88]),
  nr: Object.freeze([5, 8, 12, 14, 18, 20, 26, 28, 71]),
});

export const SUPPLEMENTAL_DOWNLINK = Object.freeze({
  lte: Object.freeze([29, 32, 67, 69]),
  nr: Object.freeze([29, 75, 76]),
});

export const SUPPLEMENTAL_UPLINK = Object.freeze({
  lte: Object.freeze([]),
  nr: Object.freeze([80, 81, 82, 83, 84, 86, 89, 95]),
});

export const PROFILES = Object.freeze([
  Object.freeze({
    id: 'adaptive',
    backendId: 'adaptive',
    name: 'Adaptive',
    shortName: 'Adaptive',
    description: 'Clears band restrictions so the modem and network can adapt as conditions change.',
    effect: 'Automatic bands · LTE and NR remain eligible',
  }),
  Object.freeze({
    id: 'coverage',
    backendId: 'coverage',
    name: 'Coverage candidate',
    shortName: 'Coverage candidate',
    description: 'Uses only lower-frequency candidates discovered for the selected SIM.',
    effect: 'Availability depends on runtime-discovered bands',
  }),
  Object.freeze({
    id: 'lte-plus',
    backendId: 'lte-plus',
    name: 'LTE+ safeguard',
    shortName: 'LTE+ safeguard',
    description: 'Preserves automatic band mode; only clears a module restriction if one is still active.',
    effect: 'No radio write when already automatic · all LTE combinations remain eligible',
    operation: 'preserve',
  }),
  Object.freeze({
    id: 'nsa',
    backendId: 'nsa',
    name: '5G NSA candidate',
    shortName: '5G NSA candidate',
    description: 'Uses discovered LTE and NR candidates for a guarded dual-connectivity request.',
    effect: 'Requires a discovered LTE anchor and non-supplemental NR candidate',
  }),
]);

export function getProfile(id) {
  if (id === 'custom') {
    return {
      id: 'custom',
      backendId: 'custom',
      name: 'Custom selection',
      shortName: 'Custom selection',
      description: 'Uses the LTE and NR candidates selected on the Bands page.',
      effect: 'Experimental band scan restriction',
    };
  }
  return PROFILES.find((profile) => profile.id === id) || PROFILES[0];
}

export function backendProfileId(id) {
  return getProfile(id).backendId;
}

export function profileOperation(id) {
  return getProfile(id).operation || (id === 'adaptive' ? 'reset' : 'apply');
}

export function uiProfileId(id) {
  if (id === 'custom') return 'custom';
  const match = PROFILES.find((profile) => profile.backendId === id || profile.id === id);
  return match ? match.id : 'adaptive';
}

export function deriveBandCandidates({ serving = [], observed = {}, selection = {}, cached = {} } = {}) {
  const activeLte = serving.filter((item) => item?.rat === 'LTE').map((item) => item.band);
  const activeNr = serving.filter((item) => item?.rat === 'NR').map((item) => item.band);
  const lte = uniqueBands([
    ...toBandArray(cached.lte),
    ...toBandArray(observed.lte),
    ...toBandArray(selection.lte),
    ...activeLte,
  ]);
  const nr = uniqueBands([
    ...toBandArray(cached.nr),
    ...toBandArray(observed.nr),
    ...toBandArray(selection.nr),
    ...activeNr,
  ]);
  const count = lte.length + nr.length;
  return {
    lte,
    nr,
    source: count
      ? 'Runtime-discovered and cached candidates for this SIM'
      : 'No runtime band candidates discovered for this SIM',
  };
}

export function profilePreset(id, catalog = {}) {
  const availableLte = uniqueBands(catalog.lte);
  const availableNr = uniqueBands(catalog.nr);

  if (id === 'adaptive' || id === 'lte-plus') {
    return { available: true, lte: [], nr: [], reason: '' };
  }

  if (id === 'coverage') {
    const lte = intersect(COVERAGE_CANDIDATES.lte, availableLte);
    const nr = intersect(COVERAGE_CANDIDATES.nr, availableNr);
    const available = lte.length + nr.length > 0;
    return {
      available,
      lte: available ? lte : [],
      nr: available ? nr : [],
      reason: available ? '' : 'No discovered coverage-band candidate is available for this SIM yet.',
    };
  }

  if (id === 'nsa') {
    const anchorLte = availableLte.filter((band) => !SUPPLEMENTAL_DOWNLINK.lte.includes(band));
    const ordinaryNr = availableNr.filter((band) => !isSupplementalOnly('nr', band));
    const available = anchorLte.length > 0 && ordinaryNr.length > 0;
    return {
      available,
      lte: available ? availableLte : [],
      nr: available ? availableNr : [],
      reason: available ? '' : 'Needs at least one discovered LTE anchor and one non-supplemental NR candidate for this SIM.',
    };
  }

  const available = availableLte.length + availableNr.length > 0;
  return {
    available,
    lte: available ? availableLte : [],
    nr: available ? availableNr : [],
    reason: available ? '' : 'No selectable band candidate has been discovered for this SIM yet.',
  };
}

export function intersect(values, available) {
  const allowed = new Set(available);
  return values.filter((value) => allowed.has(value));
}

export function isSupplementalOnly(rat, band) {
  return SUPPLEMENTAL_DOWNLINK[rat]?.includes(band)
    || SUPPLEMENTAL_UPLINK[rat]?.includes(band)
    || false;
}

export function filterByInputPolicy(catalog = {}, inputPolicy = {}) {
  return {
    lte: intersect(uniqueBands(catalog.lte), uniqueBands(inputPolicy.lte)),
    nr: intersect(uniqueBands(catalog.nr), uniqueBands(inputPolicy.nr)),
  };
}

export function uniqueBands(values) {
  return [...new Set((values || []).map(Number).filter((value) => Number.isInteger(value) && value > 0 && value <= 261))].sort((a, b) => a - b);
}

function toBandArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/[,\s:]+/);
  return [];
}
