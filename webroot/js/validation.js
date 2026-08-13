import { isSupplementalOnly, SUPPLEMENTAL_DOWNLINK, uniqueBands } from './catalog.js';

export function validateSelection({ canWrite, profile, lte, nr, inputPolicy = {} }) {
  if (!canWrite) return 'This firmware is currently read-only.';
  // Adaptive clears scan restrictions; LTE+ safeguard preserves automatic
  // selection and only clears an active module restriction. LTE CA is
  // negotiated by the modem/network, so guessed subsets can remove a required
  // PCC/SCC combination and make 4G+ less likely.
  if (profile === 'adaptive' || profile === 'lte-plus') return '';

  const lteBands = uniqueBands(lte);
  const nrBands = uniqueBands(nr);
  const anchorLte = lteBands.filter((band) => !SUPPLEMENTAL_DOWNLINK.lte.includes(band));
  const ordinaryNr = nrBands.filter((band) => !isSupplementalOnly('nr', band));
  const allowedLte = new Set(uniqueBands(inputPolicy.lte));
  const allowedNr = new Set(uniqueBands(inputPolicy.nr));

  if (!lteBands.length && !nrBands.length) return 'Select at least one usable LTE or NR band.';
  if (lteBands.some((band) => !allowedLte.has(band)) || nrBands.some((band) => !allowedNr.has(band))) {
    return 'One or more selected bands are monitor-only under this Android input policy.';
  }
  if (!anchorLte.length && !ordinaryNr.length) return 'Supplemental-only bands cannot be the entire selection.';
  if (profile === 'nsa' && !anchorLte.length) return '5G NSA candidate needs at least one LTE anchor band.';
  if (profile === 'nsa' && !ordinaryNr.length) return '5G NSA candidate needs at least one non-supplemental NR band.';
  return '';
}
