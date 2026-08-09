const paths = {
  more: '<circle cx="12" cy="5" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.25" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 5v6h-6"/>',
  clipboard: '<path d="M9 5h6"/><path d="M9 3h6v4H9z"/><rect x="5" y="5" width="14" height="16" rx="2"/><path d="m9 14 2 2 4-4"/>',
  check: '<path d="m6.8 12.2 3.2 3.2 7.2-7.2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  warning: '<path d="M10.3 3.7 2.4 18a2 2 0 0 0 1.8 3h15.6a2 2 0 0 0 1.8-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  radio: '<path d="M5.6 18.4a9 9 0 0 1 0-12.8"/><path d="M8.5 15.5a5 5 0 0 1 0-7"/><circle cx="12" cy="12" r="1.8"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  shield: '<path d="M12 3 20 6v5c0 5.2-3.4 8.4-8 10-4.6-1.6-8-4.8-8-10V6l8-3Z"/><path d="m8.5 12 2.2 2.2 4.8-4.8"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 3h6l1 4H8l1-4Z"/><path d="m7 7 1 14h8l1-14"/><path d="M10 11v6M14 11v6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  arrow: '<path d="M5 12h14"/><path d="m14 7 5 5-5 5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.4-2"/>',
  sim: '<path d="M7 3h7l4 4v14H6V4a1 1 0 0 1 1-1Z"/><path d="M9 11h6v6H9z"/><path d="M12 11v6M9 14h6"/>',
};

export function icon(name, size = 20, label = '') {
  const path = paths[name] || paths.info;
  const accessibility = label
    ? `role="img" aria-label="${escapeAttribute(label)}"`
    : 'aria-hidden="true"';
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" ${accessibility}>${path}</svg>`;
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
