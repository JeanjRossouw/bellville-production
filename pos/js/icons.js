// Line icons for the till (and anywhere else that wants one): 24×24 strokes
// that take the text colour, so they sit quietly next to a label.
const P = {
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h3l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.3a1.5 1.5 0 0 0 1.5-1.1L21 7.5H6.4"/>',
  chart: '<path d="M3.5 20.5h17"/><path d="M6.5 16.5v-5"/><path d="M11.5 16.5v-9"/><path d="M16.5 16.5v-6"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19.5c.6-3.3 3-5 6-5s5.4 1.7 6 5"/><path d="M15.5 4.9a3.2 3.2 0 0 1 0 6.2"/><path d="M17.5 14.7c1.9.6 3.1 2.1 3.5 4.8"/>',
  list: '<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M9 3.5V2.5h6v1"/><path d="M8.5 9.5h7M8.5 13h7M8.5 16.5h4"/>',
  inbox: '<path d="M3.5 13.5h4.5l1.5 2.5h5l1.5-2.5h4.5"/><path d="M5.5 5.5h13l2 8v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-5z"/>',
  box: '<path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z"/><path d="M3.5 7.5 12 11.5l8.5-4"/><path d="M12 11.5v9"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
  file: '<path d="M6 2.5h8l4.5 4.5v13A1.5 1.5 0 0 1 17 21.5H6A1.5 1.5 0 0 1 4.5 20V4A1.5 1.5 0 0 1 6 2.5z"/><path d="M13.5 2.5v5h5"/><path d="M8 13h8M8 17h5"/>',
  receipt: '<path d="M5.5 2.5h13v19l-2.2-1.5-2.1 1.5-2.2-1.5-2.2 1.5-2.1-1.5-2.2 1.5z"/><path d="M9 8h6M9 12h6M9 16h3.5"/>',
  undo: '<path d="M9 14.5 4 9.5l5-5"/><path d="M4 9.5h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  till: '<rect x="3" y="10.5" width="18" height="10" rx="1.5"/><path d="M6 10.5V5a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 18 5v5.5"/><path d="M9.5 7h5"/><path d="M7 14.5h2M11 14.5h2M15 14.5h2M7 17.5h10"/>',
  refresh: '<path d="M20 11.5A8 8 0 0 0 6 6.3L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M4 12.5a8 8 0 0 0 14 5.2l2.5-2.2"/><path d="M20.5 20.5v-5h-5"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c.8-4 3.8-6 7.5-6s6.7 2 7.5 6"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20.5 20.5-5.2-5.2"/>',
  camera: '<path d="M4.5 7.5h3l1.7-2.5h5.6l1.7 2.5h3a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V9a1.5 1.5 0 0 1 1.5-1.5z"/><circle cx="12" cy="13" r="3.5"/>',
  barcode: '<path d="M4 5.5v13M7 5.5v13M10.5 5.5v13M13 5.5v13M16.5 5.5v13M20 5.5v13"/>',
  star: '<path d="m12 3.3 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.6l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
  tag: '<path d="M3.5 12.3V4.8a1.3 1.3 0 0 1 1.3-1.3h7.5l8.2 8.2a1.3 1.3 0 0 1 0 1.8l-7.5 7.5a1.3 1.3 0 0 1-1.8 0z"/><circle cx="8" cy="8" r="1.4"/>',
  quote: '<path d="M6 2.5h8l4.5 4.5v13A1.5 1.5 0 0 1 17 21.5H6A1.5 1.5 0 0 1 4.5 20V4A1.5 1.5 0 0 1 6 2.5z"/><path d="M13.5 2.5v5h5"/><path d="M8.5 16.5l1.2-3.5 5.5-5.5 2.3 2.3-5.5 5.5z"/>',
  gift: '<rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5v8h14v-8"/><path d="M12 8.5v12"/><path d="M12 8.5S10.8 3.5 8 3.5a2.5 2.5 0 0 0 0 5zM12 8.5s1.2-5 4-5a2.5 2.5 0 0 1 0 5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  truck: '<path d="M2.5 5.5h11v11h-11z"/><path d="M13.5 9.5h4l3 3.5v3.5h-7"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  printer: '<path d="M6.5 9V3.5h11V9"/><rect x="3.5" y="9" width="17" height="8" rx="1.5"/><path d="M6.5 14.5h11v6h-11z"/>',
  shop: '<path d="M3.5 9.5 5 4.5h14l1.5 5"/><path d="M3.5 9.5a2.8 2.8 0 0 0 5.7 0 2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.7 0"/><path d="M5 12v8.5h14V12"/><path d="M10 20.5v-5h4v5"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="1.5"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 9.5h19"/><path d="M6 15h4"/>'
};

export function icon(name, cls) {
  const d = P[name]; if (!d) return '';
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}
