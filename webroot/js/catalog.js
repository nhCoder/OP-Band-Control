export const CPH2747_CATALOG = Object.freeze({
  lte: Object.freeze([1, 2, 3, 4, 5, 7, 8, 12, 13, 17, 18, 19, 20, 25, 26, 28, 30, 32, 34, 38, 39, 40, 41, 42, 48, 66, 71]),
  nr: Object.freeze([1, 2, 3, 5, 7, 8, 12, 13, 20, 25, 26, 28, 30, 38, 40, 41, 48, 66, 71, 75, 77, 78]),
});

export const SUPPLEMENTAL_DOWNLINK = Object.freeze({
  lte: Object.freeze([32]),
  nr: Object.freeze([75]),
});

export const COVERAGE_BANDS = Object.freeze({
  lte: Object.freeze([5, 8, 12, 13, 17, 18, 19, 20, 26, 28, 71]),
  nr: Object.freeze([5, 8, 12, 13, 20, 26, 28, 71]),
});

export const CAPACITY_BANDS = Object.freeze({
  lte: Object.freeze([1, 2, 3, 4, 7, 25, 30, 38, 39, 40, 41, 42, 48, 66]),
  nr: Object.freeze([1, 2, 3, 7, 25, 30, 38, 40, 41, 48, 66, 77, 78]),
});

export const PROFILES = Object.freeze([
  Object.freeze({
    id: 'adaptive',
    backendId: 'adaptive',
    name: 'Adaptive',
    shortName: 'Adaptive',
    description: 'Clears band restrictions so the modem and network can adapt as conditions change.',
    effect: 'Automatic bands · LTE and NR available',
  }),
  Object.freeze({
    id: 'coverage',
    backendId: 'coverage',
    name: 'Coverage',
    shortName: 'Coverage',
    description: 'Selects lower-frequency candidates from this device catalog for range and stability.',
    effect: 'Regional availability still varies',
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
    description: 'Keeps at least one LTE anchor and selected NR carriers eligible for dual connectivity.',
    effect: 'Requires carrier-side NSA and a compatible LTE anchor',
  }),
]);

export function getProfile(id) {
  if (id === 'custom') {
    return {
      id: 'custom',
      backendId: 'custom',
      name: 'Custom selection',
      shortName: 'Custom selection',
      description: 'Uses the LTE and NR bands selected on the Bands page.',
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

export function intersect(values, available) {
  const allowed = new Set(available);
  return values.filter((value) => allowed.has(value));
}

export function uniqueBands(values) {
  return [...new Set((values || []).map(Number).filter((value) => Number.isInteger(value) && value > 0 && value <= 261))].sort((a, b) => a - b);
}
