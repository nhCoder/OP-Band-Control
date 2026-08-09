import { SUPPLEMENTAL_DOWNLINK, uniqueBands } from './catalog.js';

export function validateSelection({ canWrite, profile, lte, nr }) {
  if (!canWrite) return 'This firmware is currently read-only.';
  // Adaptive clears scan restrictions; LTE+ safeguard preserves automatic
  // selection and only clears an active module restriction. LTE CA is
  // negotiated by the modem/network, so guessed subsets can remove a required
  // PCC/SCC combination and make 4G+ less likely.
  if (profile === 'adaptive' || profile === 'lte-plus') return '';

  const lteBands = uniqueBands(lte);
  const nrBands = uniqueBands(nr);
  const anchorLte = lteBands.filter((band) => !SUPPLEMENTAL_DOWNLINK.lte.includes(band));
  const uplinkNr = nrBands.filter((band) => !SUPPLEMENTAL_DOWNLINK.nr.includes(band));

  if (!lteBands.length && !nrBands.length) return 'Select at least one usable LTE or NR band.';
  if (!anchorLte.length && !uplinkNr.length) return 'B32 and n75 cannot be the only selected bands.';
  if (profile === 'nsa' && !anchorLte.length) return '5G NSA candidate needs at least one LTE anchor band.';
  if (profile === 'nsa' && !uplinkNr.length) return '5G NSA candidate needs at least one non-SDL NR band.';
  return '';
}
