const state = {
  tripId: localStorage.getItem('triptrack.tripId') || null,
  tripName: localStorage.getItem('triptrack.tripName') || null,
  scheduleDate: null,
  suppliers: [],
  supplierQuery: '',
  supplierRegion: '',
  mapRegion: '',
  places: []
};

const PLACE_TYPES = {
  airport: { emoji: '✈️', label: 'Airport' },
  railway_station: { emoji: '🚆', label: 'Railway station' },
  bus_station: { emoji: '🚌', label: 'Bus station' },
  hotel: { emoji: '🏨', label: 'Hotel' }
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) showAuth(false);
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const NUMERIC_FORM_FIELDS = new Set(['sort_order', 'qty', 'unit_price', 'gps_lat', 'gps_lng']);

function formValues(form) {
  const values = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (value !== '') values[key] = NUMERIC_FORM_FIELDS.has(key) ? Number(value) : value;
  }
  return values;
}

function toast(message) {
  const status = document.getElementById('sync-status');
  const previous = status.textContent;
  status.textContent = message;
  setTimeout(() => refreshSyncStatus().catch(() => (status.textContent = previous)), 2500);
}

// --- Sync bar ---

async function refreshSyncStatus() {
  const status = await api('GET', '/api/sync/status');
  const label = document.getElementById('sync-status');
  const button = document.getElementById('sync-button');
  const last = status.last_sync_at ? new Date(status.last_sync_at).toLocaleTimeString() : 'never';
  label.textContent = `${status.pending} pending · synced ${last}`;
  label.classList.toggle('dirty', status.pending > 0);
  button.disabled = !status.sync_url;
  button.title = status.sync_url ? '' : 'Set TRIPTRACK_SYNC_URL to enable sync';
}

async function runSyncNow() {
  const button = document.getElementById('sync-button');
  button.disabled = true;
  try {
    await api('POST', '/api/sync/run');
    toast('Sync complete');
  } catch (error) {
    toast(`Sync failed: ${error.message}`);
  } finally {
    button.disabled = false;
    refreshSyncStatus().catch(() => {});
  }
}

// --- Today view ---

function statTile(label, value) {
  const tile = el('div', 'stat-tile');
  tile.append(el('div', 'stat-value', String(value)));
  tile.append(el('div', 'stat-label', label));
  return tile;
}

async function renderToday() {
  document.getElementById('today-title').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });

  const today = todayIso();
  let todayVisits = [];
  let tripVisits = [];
  let followUps = [];
  if (state.tripId) {
    [todayVisits, tripVisits] = await Promise.all([
      api('GET', `/api/trips/${state.tripId}/visits?date=${today}`),
      api('GET', `/api/trips/${state.tripId}/visits`)
    ]);
  }
  try {
    followUps = await api('GET', '/api/samples/follow-ups');
  } catch {
    followUps = [];
  }

  document.getElementById('today-stats').replaceChildren(
    statTile('Visits today', todayVisits.length),
    statTile('Trip visits', tripVisits.length),
    statTile('Suppliers', state.suppliers.length),
    statTile('Follow-ups', followUps.length)
  );

  const list = document.getElementById('today-visits');
  list.replaceChildren();
  if (!state.tripId) {
    list.append(el('p', 'muted', 'Create or select a trip on the Trips tab to start planning visits.'));
    return;
  }
  if (todayVisits.length === 0) {
    const upcoming = tripVisits.find((v) => v.visit_date > today);
    list.append(
      el('p', 'muted', upcoming ? `No visits today — next visit is on ${upcoming.visit_date}.` : 'No visits scheduled today.')
    );
    return;
  }
  for (const visit of todayVisits) {
    const supplier = state.suppliers.find((s) => s.id === visit.supplier_id);
    const item = el('div', 'item');
    const left = el('div');
    left.append(el('div', 'title', `${visit.scheduled_time || '—'} · ${supplier ? supplier.name : 'Unknown supplier'}`));
    left.append(el('div', 'sub', [visit.purpose, supplier?.address_cn || supplier?.address_en].filter(Boolean).join(' · ') || '—'));
    const right = el('div', 'head-actions');
    right.append(el('span', `status status-${visit.status}`, visit.status));
    if (supplier) right.append(mapLink(supplier));
    item.append(left, right);
    item.addEventListener('click', () => {
      state.scheduleDate = today;
      activateView('schedule');
    });
    list.append(item);
  }
}

// --- Trips view ---

function selectTrip(trip) {
  state.tripId = trip.id;
  state.tripName = trip.name;
  localStorage.setItem('triptrack.tripId', trip.id);
  localStorage.setItem('triptrack.tripName', trip.name);
  renderTrips();
  renderSchedule();
}

function clearSelectedTrip() {
  state.tripId = null;
  state.tripName = null;
  localStorage.removeItem('triptrack.tripId');
  localStorage.removeItem('triptrack.tripName');
}

function setTripFormMode(trip) {
  const form = document.getElementById('trip-form');
  form.querySelector('input[name="id"]').value = trip ? trip.id : '';
  document.getElementById('trip-form-title').textContent = trip ? `Edit ${trip.name}` : 'New trip';
  document.getElementById('trip-form-submit').textContent = trip ? 'Save changes' : 'Add trip';
  document.getElementById('trip-form-cancel').classList.toggle('hidden', !trip);
  if (trip) {
    for (const input of form.querySelectorAll('input[name]')) {
      if (input.name !== 'id') input.value = trip[input.name] ?? '';
    }
    form.classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    form.reset();
  }
}

function setCityFormMode(city) {
  const form = document.getElementById('city-form');
  form.querySelector('input[name="id"]').value = city ? city.id : '';
  document.getElementById('city-form-title').textContent = city ? `Edit ${city.name}` : 'Add city';
  document.getElementById('city-form-submit').textContent = city ? 'Save changes' : 'Add city';
  document.getElementById('city-form-cancel').classList.toggle('hidden', !city);
  if (city) {
    for (const input of form.querySelectorAll('input[name]')) {
      if (input.name !== 'id') input.value = city[input.name] ?? '';
    }
    form.classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    form.reset();
  }
}

async function renderTrips() {
  const trips = await api('GET', '/api/trips');
  if (!state.tripId && trips.length > 0) {
    selectTrip(trips[0]);
    return;
  }
  const list = document.getElementById('trip-list');
  list.replaceChildren();
  if (trips.length === 0) {
    list.append(el('p', 'muted', 'No trips yet — add your first sourcing trip.'));
  }
  for (const trip of trips) {
    const item = el('div', 'item trip-item' + (trip.id === state.tripId ? ' selected' : ''));
    const left = el('div');
    left.append(el('div', 'title', trip.name));
    left.append(el('div', 'sub', [trip.start_date, trip.end_date].filter(Boolean).join(' → ') || 'No dates'));
    item.append(left);
    const right = el('div', 'trip-actions');
    if (trip.id === state.tripId) right.append(el('span', 'status status-CONFIRMED', 'ACTIVE'));
    const editButton = el('button', 'map-link', '✏️ Edit');
    editButton.type = 'button';
    editButton.addEventListener('click', (event) => {
      event.stopPropagation();
      setTripFormMode(trip);
    });
    const deleteButton = el('button', 'map-link danger', '🗑 Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm(`Delete trip "${trip.name}"? This does not delete its cities or visits.`)) return;
      try {
        await api('DELETE', `/api/trips/${trip.id}`);
        if (trip.id === state.tripId) clearSelectedTrip();
        await renderTrips();
        refreshSyncStatus().catch(() => {});
      } catch (error) {
        toast(error.message);
      }
    });
    right.append(editButton, deleteButton);
    item.append(right);
    item.addEventListener('click', () => selectTrip(trip));
    list.append(item);
  }

  const detail = document.getElementById('trip-detail');
  if (!state.tripId) {
    detail.classList.add('hidden');
    return;
  }
  detail.classList.remove('hidden');
  document.getElementById('trip-detail-name').textContent = `Itinerary — ${state.tripName}`;
  const cities = await api('GET', `/api/trips/${state.tripId}/cities`);
  const cityList = document.getElementById('city-list');
  cityList.replaceChildren();
  if (cities.length === 0) {
    cityList.append(el('p', 'muted', 'No cities yet — add the cities you will visit.'));
  }
  for (const city of cities) {
    const item = el('div', 'item trip-item');
    const left = el('div');
    left.append(el('div', 'title', city.name_cn ? `${city.name} · ${city.name_cn}` : city.name));
    left.append(
      el('div', 'sub', [city.arrive_date && `${city.arrive_date} → ${city.depart_date || '?'}`, city.hotel_name].filter(Boolean).join(' · ') || '—')
    );
    item.append(left);
    const right = el('div', 'trip-actions');
    const editButton = el('button', 'map-link', '✏️ Edit');
    editButton.type = 'button';
    editButton.addEventListener('click', () => setCityFormMode(city));
    const deleteButton = el('button', 'map-link danger', '🗑 Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', async () => {
      if (!confirm(`Delete city "${city.name}"? This does not delete its visits.`)) return;
      try {
        await api('DELETE', `/api/cities/${city.id}`);
        await renderTrips();
        refreshSyncStatus().catch(() => {});
      } catch (error) {
        toast(error.message);
      }
    });
    right.append(editButton, deleteButton);
    item.append(right);
    cityList.append(item);
  }
}

// --- Suppliers view ---

function supplierProfile(supplier) {
  const box = el('div', 'supplier-profile');
  const add = (label, value, href) => {
    if (!value) return;
    const row = el('div', 'profile-row');
    row.append(el('span', 'profile-label', label));
    if (href) {
      const link = el('a', null, value);
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      row.append(link);
    } else {
      row.append(el('span', 'profile-value', value));
    }
    box.append(row);
  };

  add('Contact', supplier.contact_name);
  add('Mobile', supplier.contact_mobile);
  add('WhatsApp', supplier.whatsapp);
  add('WeChat', supplier.wechat_id);
  const firstEmail = supplier.email ? supplier.email.split(/[\s/]+/)[0] : null;
  add('Email', supplier.email, firstEmail && firstEmail.includes('@') ? `mailto:${firstEmail}` : null);
  const firstSite = supplier.website ? supplier.website.split(/\s+/)[0] : null;
  add('Website', supplier.website, firstSite ? (firstSite.startsWith('http') ? firstSite : `https://${firstSite}`) : null);
  add('Region', supplier.region);
  add('Address', supplier.address_en);
  add('Address 中文', supplier.address_cn);
  add('Products', supplier.products);
  add('Specialty', supplier.specialty);
  add('Established', supplier.established);
  add('Employees', supplier.employees);
  add('Exports to', supplier.export_markets);
  add('Notes', supplier.notes);
  if (!box.children.length) {
    box.append(el('div', 'muted', 'No further details — edit or re-import to add profile data.'));
  }
  return box;
}

function mapLink(supplier) {
  // Saved share link wins; otherwise search Google Maps for the best address we have.
  const query = supplier.address_cn || supplier.address_en || supplier.name_cn || supplier.name;
  const href = supplier.map_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  const link = el('a', 'map-link', '📍 Map');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = supplier.map_url ? 'Open saved Google Maps link' : `Search Google Maps for “${query}”`;
  link.addEventListener('click', (event) => event.stopPropagation());
  return link;
}

function supplierMatchesQuery(supplier, query) {
  const haystack = [
    supplier.name,
    supplier.name_cn,
    supplier.contact_name,
    supplier.product_category,
    supplier.products,
    supplier.specialty,
    supplier.region,
    supplier.notes
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function renderSupplierList() {
  const query = state.supplierQuery.trim().toLowerCase();
  const filtered = state.suppliers.filter(
    (supplier) =>
      (!state.supplierRegion || supplier.region === state.supplierRegion) &&
      (!query || supplierMatchesQuery(supplier, query))
  );

  const count = document.getElementById('supplier-count');
  count.textContent =
    filtered.length === state.suppliers.length
      ? `Suppliers (${state.suppliers.length})`
      : `Suppliers (${filtered.length} of ${state.suppliers.length})`;

  const list = document.getElementById('supplier-list');
  list.replaceChildren();
  if (filtered.length === 0) {
    list.append(el('p', 'muted', state.suppliers.length === 0 ? 'No suppliers yet — add one or import your Excel master.' : 'No suppliers match your search.'));
  }
  for (const supplier of filtered) {
    const item = el('div', 'item supplier-item');
    const header = el('div', 'supplier-header');
    const left = el('div');
    left.append(el('div', 'title', supplier.name_cn ? `${supplier.name} · ${supplier.name_cn}` : supplier.name));
    left.append(
      el('div', 'sub', [supplier.region, supplier.product_category, supplier.contact_name, supplier.contact_mobile]
        .filter(Boolean)
        .join(' · ') || '—')
    );
    const actions = el('div', 'supplier-actions');
    const editButton = el('button', 'map-link', '✏️ Edit');
    editButton.type = 'button';
    editButton.addEventListener('click', (event) => {
      event.stopPropagation();
      setSupplierFormMode(supplier);
    });
    const deleteButton = el('button', 'map-link danger', '🗑 Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirm(`Delete supplier “${supplier.name}”?`)) return;
      try {
        await api('DELETE', `/api/suppliers/${supplier.id}`);
        await renderSuppliers();
        refreshSyncStatus().catch(() => {});
      } catch (error) {
        toast(error.message);
      }
    });
    actions.append(mapLink(supplier), editButton, deleteButton);
    header.append(left, actions);
    item.append(header);

    const profile = supplierProfile(supplier);
    profile.classList.add('hidden');
    item.append(profile);
    header.addEventListener('click', () => profile.classList.toggle('hidden'));
    list.append(item);
  }
}

function setSupplierFormMode(supplier) {
  const form = document.getElementById('supplier-form');
  form.querySelector('input[name="id"]').value = supplier ? supplier.id : '';
  document.getElementById('supplier-form-title').textContent = supplier ? `Edit ${supplier.name}` : 'New supplier';
  document.getElementById('supplier-form-submit').textContent = supplier ? 'Save changes' : 'Add supplier';
  document.getElementById('supplier-form-cancel').classList.toggle('hidden', !supplier);
  document.getElementById('supplier-coords-input').value = '';
  setCoordsStatus('supplier-coords-status', '', false);
  if (supplier) {
    for (const input of form.querySelectorAll('input[name]')) {
      if (input.name !== 'id') input.value = supplier[input.name] ?? '';
    }
    form.classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    form.reset();
  }
}

async function renderSuppliers() {
  state.suppliers = await api('GET', '/api/suppliers');

  const regionSelect = document.getElementById('supplier-region');
  const current = state.supplierRegion;
  const regions = [...new Set(state.suppliers.map((s) => s.region).filter(Boolean))].sort();
  regionSelect.replaceChildren(el('option', null, 'All regions'));
  regionSelect.firstChild.value = '';
  for (const region of regions) {
    const option = el('option', null, region);
    option.value = region;
    regionSelect.append(option);
  }
  regionSelect.value = regions.includes(current) ? current : '';
  state.supplierRegion = regionSelect.value;

  renderSupplierList();

  const select = document.querySelector('#visit-form select[name="supplier_id"]');
  select.replaceChildren();
  for (const supplier of state.suppliers) {
    const option = el('option', null, supplier.name);
    option.value = supplier.id;
    select.append(option);
  }
}

// --- Map view ---

// Icon.Default._getIconUrl always prepends imagePath in front of iconUrl/iconRetinaUrl/
// shadowUrl — setting those to full paths (instead of just imagePath) double-prepends and
// 404s. imagePath + Leaflet's own bare filenames is the correct, documented way to point
// a self-hosted Leaflet at vendored (not CDN) marker images.
L.Icon.Default.mergeOptions({
  imagePath: '/vendor/leaflet/images/'
});

let supplierMap = null;
let supplierMapMarkers = null;

// gps_lat/gps_lng (set by the coordinates helper on the form) win; records saved before that
// existed, or imported with only a map link, fall back to parsing one out of it. Works for both
// suppliers and places — both carry the same gps_lat/gps_lng/map_url columns.
function entityLocation(entity) {
  if (typeof entity.gps_lat === 'number' && typeof entity.gps_lng === 'number') {
    return { lat: entity.gps_lat, lng: entity.gps_lng };
  }
  return parseCoordinates(entity.map_url || '');
}

function supplierPopup(supplier, loc) {
  const box = el('div');
  box.append(el('b', null, supplier.name_cn ? `${supplier.name} · ${supplier.name_cn}` : supplier.name));
  const details = [supplier.region, supplier.contact_name, supplier.contact_mobile].filter(Boolean).join(' · ');
  if (details) box.append(el('div', 'muted', details));
  const linkRow = el('div');
  const link = el('a', null, 'Open in Maps →');
  link.href = supplier.map_url || `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
  link.target = '_blank';
  link.rel = 'noopener';
  linkRow.append(link);
  box.append(linkRow);
  return box;
}

function placeIcon(type) {
  const meta = PLACE_TYPES[type] || { emoji: '📍', label: 'Place' };
  return L.divIcon({
    className: 'place-div-icon',
    html: `<span class="place-marker place-marker-${type}">${meta.emoji}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -13]
  });
}

function placePopup(place, loc) {
  const meta = PLACE_TYPES[place.type] || { emoji: '📍', label: 'Place' };
  const box = el('div');
  box.append(el('b', null, `${meta.emoji} ${place.name}`));
  box.append(el('div', 'muted', meta.label));
  if (place.address) box.append(el('div', 'muted', place.address));
  const linkRow = el('div');
  const link = el('a', null, 'Open in Maps →');
  link.href = place.map_url || `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
  link.target = '_blank';
  link.rel = 'noopener';
  linkRow.append(link);
  box.append(linkRow);
  return box;
}

async function renderMap() {
  const container = document.getElementById('supplier-map');
  if (!supplierMap) {
    supplierMap = L.map(container);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(supplierMap);
    supplierMapMarkers = L.layerGroup().addTo(supplierMap);
  }

  state.places = await api('GET', '/api/places');
  renderPlaceList();

  const regionSelect = document.getElementById('map-region');
  const current = state.mapRegion;
  const regions = [...new Set(state.suppliers.map((s) => s.region).filter(Boolean))].sort();
  regionSelect.replaceChildren(el('option', null, 'All regions'));
  regionSelect.firstChild.value = '';
  for (const region of regions) {
    const option = el('option', null, region);
    option.value = region;
    regionSelect.append(option);
  }
  regionSelect.value = regions.includes(current) ? current : '';
  state.mapRegion = regionSelect.value;

  const filtered = state.suppliers.filter((s) => !state.mapRegion || s.region === state.mapRegion);

  supplierMapMarkers.clearLayers();
  const points = [];
  for (const supplier of filtered) {
    const loc = entityLocation(supplier);
    if (!loc) continue;
    points.push([loc.lat, loc.lng]);
    L.marker([loc.lat, loc.lng]).bindPopup(supplierPopup(supplier, loc)).addTo(supplierMapMarkers);
  }
  const suppliersPlotted = points.length;

  let placesPlotted = 0;
  for (const place of state.places) {
    const loc = entityLocation(place);
    if (!loc) continue;
    placesPlotted += 1;
    points.push([loc.lat, loc.lng]);
    L.marker([loc.lat, loc.lng], { icon: placeIcon(place.type) }).bindPopup(placePopup(place, loc)).addTo(supplierMapMarkers);
  }

  const missing = filtered.length - suppliersPlotted;
  const summary = document.getElementById('map-summary');
  summary.textContent = points.length === 0
    ? 'No suppliers with a location yet — open a supplier, paste GPS coordinates, and hit "Build map link".'
    : `${suppliersPlotted} of ${filtered.length} supplier${filtered.length === 1 ? '' : 's'} plotted` +
      (missing > 0 ? ` · ${missing} missing a location` : '') +
      (placesPlotted > 0 ? ` · ${placesPlotted} place${placesPlotted === 1 ? '' : 's'}` : '');

  // The container is display:none until this tab is opened, so Leaflet computed zero size
  // when the map was first created — invalidateSize() makes it re-measure now that it's visible.
  requestAnimationFrame(() => {
    supplierMap.invalidateSize();
    if (points.length > 0) {
      supplierMap.fitBounds(points, { padding: [30, 30], maxZoom: 14 });
    } else {
      supplierMap.setView([20, 0], 2);
    }
  });
}

function setPlaceFormMode(place) {
  const form = document.getElementById('place-form');
  form.querySelector('input[name="id"]').value = place ? place.id : '';
  document.getElementById('place-form-title').textContent = place ? `Edit ${place.name}` : 'New place';
  document.getElementById('place-form-submit').textContent = place ? 'Save changes' : 'Add place';
  document.getElementById('place-form-cancel').classList.toggle('hidden', !place);
  document.getElementById('place-coords-input').value = '';
  setCoordsStatus('place-coords-status', '', false);
  if (place) {
    for (const input of form.querySelectorAll('input[name], select[name]')) {
      if (input.name !== 'id') input.value = place[input.name] ?? '';
    }
    form.classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    form.reset();
  }
}

function renderPlaceList() {
  document.getElementById('place-count').textContent = `Places (${state.places.length})`;

  const list = document.getElementById('place-list');
  list.replaceChildren();
  if (state.places.length === 0) {
    list.append(el('p', 'muted', 'No places yet — add airports, stations, or hotels so they show on the map.'));
  }
  for (const place of state.places) {
    const meta = PLACE_TYPES[place.type] || { emoji: '📍', label: 'Place' };
    const item = el('div', 'item');
    const left = el('div');
    left.append(el('div', 'title', `${meta.emoji} ${place.name}`));
    left.append(el('div', 'sub', [meta.label, place.address].filter(Boolean).join(' · ')));
    item.append(left);

    const actions = el('div', 'head-actions');
    actions.append(mapLink({ ...place, address_en: place.address }));
    const editButton = el('button', 'map-link', '✏️ Edit');
    editButton.type = 'button';
    editButton.addEventListener('click', () => setPlaceFormMode(place));
    const deleteButton = el('button', 'map-link danger', '🗑 Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', async () => {
      if (!confirm(`Delete place "${place.name}"?`)) return;
      try {
        await api('DELETE', `/api/places/${place.id}`);
        await renderMap();
        refreshSyncStatus().catch(() => {});
      } catch (error) {
        toast(error.message);
      }
    });
    actions.append(editButton, deleteButton);
    item.append(actions);
    list.append(item);
  }
}

// --- Schedule view ---

function supplierName(id) {
  const supplier = state.suppliers.find((s) => s.id === id);
  return supplier ? supplier.name : 'Unknown supplier';
}

async function renderSamples(container, visitId) {
  const samples = await api('GET', `/api/visits/${visitId}/samples`);
  container.replaceChildren();
  for (const sample of samples) {
    const parts = [sample.sample_no, sample.description, sample.unit_price != null && `${sample.currency} ${sample.unit_price}`, sample.moq != null && `MOQ ${sample.moq}`]
      .filter(Boolean)
      .join(' · ');
    container.append(el('div', 'sample-row', parts || 'Sample'));
  }

  const form = el('form', 'sample-form');
  const no = el('input'); no.name = 'sample_no'; no.placeholder = 'No.';
  const desc = el('input'); desc.name = 'description'; desc.placeholder = 'Description';
  const price = el('input'); price.name = 'unit_price'; price.placeholder = 'Unit price'; price.type = 'number'; price.step = '0.01';
  const add = el('button', null, 'Add sample'); add.type = 'submit';
  form.append(no, desc, price, add);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await api('POST', '/api/samples', { visit_id: visitId, ...formValues(form) });
    await renderSamples(container, visitId);
    refreshSyncStatus().catch(() => {});
  });
  container.append(form);
}

function shiftScheduleDate(days) {
  const date = new Date(`${state.scheduleDate || todayIso()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  state.scheduleDate = date.toISOString().slice(0, 10);
  renderSchedule().catch((error) => toast(error.message));
}

async function renderSchedule() {
  const empty = document.getElementById('schedule-empty');
  const body = document.getElementById('schedule-body');
  if (!state.tripId) {
    empty.classList.remove('hidden');
    body.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  body.classList.remove('hidden');

  if (!state.scheduleDate) {
    // Default the day picker to the trip's next visit day (or its last, for past trips).
    const allVisits = await api('GET', `/api/trips/${state.tripId}/visits`);
    const today = todayIso();
    const upcoming = allVisits.find((v) => v.visit_date >= today);
    state.scheduleDate = upcoming ? upcoming.visit_date : allVisits.length > 0 ? allVisits[allVisits.length - 1].visit_date : today;
  }

  const dateInput = document.getElementById('schedule-date');
  dateInput.value = state.scheduleDate;
  document.querySelector('#visit-form input[name="visit_date"]').value = state.scheduleDate;

  const visits = await api('GET', `/api/trips/${state.tripId}/visits?date=${state.scheduleDate}`);
  document.getElementById('day-visit-count').textContent = `Visits (${visits.length})`;
  const list = document.getElementById('visit-list');
  list.replaceChildren();
  if (visits.length === 0) {
    list.append(el('p', 'muted', 'No visits planned this day.'));
  }
  for (const visit of visits) {
    const item = el('div', 'item');
    item.style.display = 'block';
    const header = el('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    const left = el('div');
    left.append(el('div', 'title', `${visit.scheduled_time || '—'} · ${supplierName(visit.supplier_id)}`));
    left.append(el('div', 'sub', visit.purpose || ''));
    header.append(left, el('span', `status status-${visit.status}`, visit.status));
    item.append(header);

    const actions = el('div', 'visit-actions');
    for (const status of ['CONFIRMED', 'DONE', 'CANCELLED']) {
      if (visit.status === status) continue;
      const button = el('button', null, status === 'CONFIRMED' ? 'Confirm' : status === 'DONE' ? 'Done' : 'Cancel');
      button.addEventListener('click', async () => {
        await api('POST', `/api/visits/${visit.id}/status`, { status });
        await renderSchedule();
        refreshSyncStatus().catch(() => {});
      });
      actions.append(button);
    }
    item.append(actions);

    const samples = el('div', 'samples');
    item.append(samples);
    renderSamples(samples, visit.id).catch(() => {});
    list.append(item);
  }
}

// --- Admin view ---

function setUserFormMode(user) {
  const form = document.getElementById('user-form');
  if (user) form.classList.remove('hidden');
  document.getElementById('user-form-title').textContent = user ? `Edit — ${user.name}` : 'New user';
  document.getElementById('user-form-submit').textContent = user ? 'Save changes' : 'Add user';
  document.getElementById('user-form-cancel').classList.toggle('hidden', !user);
  form.elements.id.value = user ? user.id : '';
  form.elements.name.value = user ? user.name : '';
  form.elements.email.value = user ? user.email : '';
  form.elements.role.value = user ? user.role : 'MEMBER';
  form.elements.active.value = user ? String(user.active) : '1';
}

async function renderUsers() {
  const users = await api('GET', '/api/users');
  const list = document.getElementById('user-list');
  list.replaceChildren();
  for (const user of users) {
    const item = el('div', 'item' + (user.active ? '' : ' inactive'));
    const left = el('div');
    left.append(el('div', 'title', user.name));
    left.append(el('div', 'sub', user.email || '—'));
    const right = el('div', 'user-actions');
    right.append(el('span', `role-badge role-${user.role}`, user.role));
    const editBtn = el('button', null, 'Edit');
    editBtn.addEventListener('click', () => setUserFormMode(user));
    const deleteBtn = el('button', 'danger', 'Delete');
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete user ${user.name}?`)) return;
      try {
        await api('DELETE', `/api/users/${user.id}`);
        await renderUsers();
        refreshSyncStatus().catch(() => {});
      } catch (error) {
        toast(error.message);
      }
    });
    right.append(editBtn, deleteBtn);
    item.append(left, right);
    list.append(item);
  }
}

async function exportDataFile() {
  const res = await fetch('/api/admin/export');
  if (!res.ok) {
    toast('Export failed');
    return;
  }
  const blob = await res.blob();
  const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'triptrack-export.json';
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importDataFile(file) {
  const resultLine = document.getElementById('import-result');
  try {
    const dump = JSON.parse(await file.text());
    const result = await api('POST', '/api/admin/import', dump);
    resultLine.textContent = `Imported ${file.name}: ${result.applied} applied, ${result.skipped} skipped (already up to date).`;
    await Promise.all([renderUsers(), renderTrips(), renderSuppliers()]);
    refreshSyncStatus().catch(() => {});
  } catch (error) {
    resultLine.textContent = `Import failed: ${error.message}`;
  }
}

// --- Supplier import (Excel/CSV) ---

async function importSupplierSheet(file) {
  const out = document.getElementById('supplier-import-result');
  out.textContent = `Importing ${file.name}…`;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const result = await api('POST', '/api/suppliers/import', { filename: file.name, data_base64: btoa(binary) });
    const parts = [`Imported ${result.imported} supplier(s)`];
    if (result.skipped_existing) parts.push(`${result.skipped_existing} skipped (already exist)`);
    if (result.skipped_invalid) parts.push(`${result.skipped_invalid} invalid`);
    out.textContent = parts.join(' · ') + (result.errors.length ? ` — ${result.errors.join('; ')}` : '');
    await renderSuppliers();
    refreshSyncStatus().catch(() => {});
  } catch (error) {
    out.textContent = `Import failed: ${error.message}`;
  }
}

// --- Navigation & wiring ---

function activateView(name) {
  const tab = document.querySelector(`.tab[data-view="${name}"]`);
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.view').forEach((view) => view.classList.add('hidden'));
  document.getElementById(`view-${name}`).classList.remove('hidden');
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'today') renderToday().catch((error) => toast(error.message));
  if (name === 'schedule') renderSchedule().catch((error) => toast(error.message));
  if (name === 'admin') renderUsers().catch((error) => toast(error.message));
  if (name === 'map') renderMap().catch((error) => toast(error.message));
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => activateView(tab.dataset.view));
});

document.querySelectorAll('.add-toggle[data-target]').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.target === 'supplier-form') setSupplierFormMode(null);
    if (button.dataset.target === 'trip-form') setTripFormMode(null);
    if (button.dataset.target === 'city-form') setCityFormMode(null);
    if (button.dataset.target === 'place-form') setPlaceFormMode(null);
    document.getElementById(button.dataset.target).classList.toggle('hidden');
  });
});

function bindForm(id, path, extra, after) {
  const form = document.getElementById(id);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('POST', path, { ...formValues(form), ...(extra ? extra() : {}) });
      form.reset();
      form.classList.add('hidden');
      await after();
      refreshSyncStatus().catch(() => {});
    } catch (error) {
      toast(error.message);
    }
  });
}

document.getElementById('schedule-date').addEventListener('change', (event) => {
  state.scheduleDate = event.currentTarget.value;
  renderSchedule().catch(() => {});
});
document.getElementById('day-prev').addEventListener('click', () => shiftScheduleDate(-1));
document.getElementById('day-next').addEventListener('click', () => shiftScheduleDate(1));
document.getElementById('today-plan-button').addEventListener('click', () => {
  state.scheduleDate = todayIso();
  activateView('schedule');
});

document.getElementById('supplier-search').addEventListener('input', (event) => {
  state.supplierQuery = event.currentTarget.value;
  renderSupplierList();
});
document.getElementById('supplier-region').addEventListener('change', (event) => {
  state.supplierRegion = event.currentTarget.value;
  renderSupplierList();
});
document.getElementById('map-region').addEventListener('change', (event) => {
  state.mapRegion = event.currentTarget.value;
  renderMap().catch((error) => toast(error.message));
});

document.getElementById('sync-button').addEventListener('click', runSyncNow);

document.getElementById('user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  const payload = { name: values.name, email: values.email, role: values.role, active: Number(values.active) };
  if (values.password) payload.password = values.password;
  try {
    if (values.id) {
      await api('PATCH', `/api/users/${values.id}`, payload);
    } else {
      await api('POST', '/api/users', payload);
    }
    setUserFormMode(null);
    form.classList.add('hidden');
    await renderUsers();
    refreshSyncStatus().catch(() => {});
  } catch (error) {
    toast(error.message);
  }
});

document.getElementById('user-form-cancel').addEventListener('click', () => {
  setUserFormMode(null);
  document.getElementById('user-form').classList.add('hidden');
});
document.getElementById('export-button').addEventListener('click', exportDataFile);
document.getElementById('import-file').addEventListener('change', (event) => {
  const file = event.currentTarget.files?.[0];
  if (file) importDataFile(file);
  event.currentTarget.value = '';
});
document.getElementById('supplier-import-file').addEventListener('change', (event) => {
  const file = event.currentTarget.files?.[0];
  if (file) importSupplierSheet(file);
  event.currentTarget.value = '';
});

// City form creates or, when an id is set via Edit, updates in place.
document.getElementById('city-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.querySelector('input[name="id"]').value;
  try {
    if (id) {
      const payload = {};
      for (const input of form.querySelectorAll('input[name]')) {
        if (input.name !== 'id') {
          payload[input.name] = input.value === '' ? null : input.name === 'sort_order' ? Number(input.value) : input.value;
        }
      }
      await api('PATCH', `/api/cities/${id}`, payload);
    } else {
      await api('POST', '/api/cities', { ...formValues(form), trip_id: state.tripId });
    }
    setCityFormMode(null);
    form.classList.add('hidden');
    await renderTrips();
    refreshSyncStatus().catch(() => {});
  } catch (error) {
    toast(error.message);
  }
});
document.getElementById('city-form-cancel').addEventListener('click', () => {
  setCityFormMode(null);
  document.getElementById('city-form').classList.add('hidden');
});

// Trip form creates or, when an id is set via Edit, updates in place.
document.getElementById('trip-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.querySelector('input[name="id"]').value;
  try {
    if (id) {
      const payload = {};
      for (const input of form.querySelectorAll('input[name]')) {
        if (input.name !== 'id') payload[input.name] = input.value || null;
      }
      await api('PATCH', `/api/trips/${id}`, payload);
      if (id === state.tripId) state.tripName = payload.name;
    } else {
      await api('POST', '/api/trips', formValues(form));
    }
    setTripFormMode(null);
    form.classList.add('hidden');
    await renderTrips();
    refreshSyncStatus().catch(() => {});
  } catch (error) {
    toast(error.message);
  }
});
document.getElementById('trip-form-cancel').addEventListener('click', () => {
  setTripFormMode(null);
  document.getElementById('trip-form').classList.add('hidden');
});
bindForm('visit-form', '/api/visits', () => ({ trip_id: state.tripId }), renderSchedule);

// Supplier form creates or, when an id is set via Edit, updates in place.
// Builds a Google Maps link from pasted coordinates, so a supplier location can be
// mapped from any GPS source (phone GPS, Apple Maps, WeChat share, Amap, Baidu) without
// needing Google Maps itself to load — useful where Google Maps is blocked (e.g. mainland
// China). Accepts "lat,lng" possibly embedded in other text (a share-sheet URL, a label),
// separated by a regular or full-width comma, or just whitespace.
function parseCoordinates(text) {
  const match = /(-?\d{1,3}\.\d{2,})[,，\s]+(-?\d{1,3}\.\d{2,})/.exec(text);
  if (match) {
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  // Some copy/paste paths turn the lat/lng comma into a period — e.g.
  // "31.1934930.119.1855390" instead of "31.1934930,119.1855390" — leaving four
  // dot-separated digit groups instead of one comma. Recover the split: the first
  // two groups are one decimal number, the last two are the other.
  const merged = /(-?\d{1,3})\.(\d{2,})\.(-?\d{1,3})\.(\d{2,})/.exec(text);
  if (merged) {
    const lat = Number(`${merged[1]}.${merged[2]}`);
    const lng = Number(`${merged[3]}.${merged[4]}`);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return null;
}

function setCoordsStatus(statusId, message, isError) {
  const status = document.getElementById(statusId);
  status.textContent = message;
  status.classList.toggle('error', Boolean(isError));
}

// Shared by the supplier form and the place form: builds a Google Maps link from pasted
// coordinates, so a location can be mapped from any GPS source (phone GPS, Apple Maps, WeChat
// share, Amap, Baidu) without needing Google Maps itself to load — useful where Google Maps is
// blocked (e.g. mainland China).
function wireCoordsHelper(formId, inputId, buttonId, statusId) {
  const apply = () => {
    const input = document.getElementById(inputId);
    const coords = parseCoordinates(input.value);
    if (!coords) {
      // Shown inline next to the button, not just via the header toast — that toast is easy to
      // miss when this button is scrolled far down a long form (which it usually is).
      setCoordsStatus(
        statusId,
        input.value.trim() ? `Could not find coordinates like "31.23, 121.47" in "${input.value.trim()}"` : 'Paste coordinates first',
        true
      );
      return;
    }
    const form = document.getElementById(formId);
    form.querySelector('input[name="map_url"]').value = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
    form.querySelector('input[name="gps_lat"]').value = coords.lat;
    form.querySelector('input[name="gps_lng"]').value = coords.lng;
    input.value = '';
    setCoordsStatus(statusId, `✓ Map link built from ${coords.lat}, ${coords.lng} — save the form to keep it`, false);
    toast('Map link built — will also show on the Map tab once saved');
  };
  document.getElementById(buttonId).addEventListener('click', apply);
  // Enter in this field should build the link, not submit the whole form.
  document.getElementById(inputId).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      apply();
    }
  });
}
wireCoordsHelper('supplier-form', 'supplier-coords-input', 'supplier-coords-apply', 'supplier-coords-status');
wireCoordsHelper('place-form', 'place-coords-input', 'place-coords-apply', 'place-coords-status');

document.getElementById('supplier-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.querySelector('input[name="id"]').value;
  try {
    if (id) {
      const payload = {};
      for (const input of form.querySelectorAll('input[name]')) {
        if (input.name === 'id') continue;
        payload[input.name] = input.value ? (NUMERIC_FORM_FIELDS.has(input.name) ? Number(input.value) : input.value) : null;
      }
      await api('PATCH', `/api/suppliers/${id}`, payload);
    } else {
      await api('POST', '/api/suppliers', formValues(form));
    }
    setSupplierFormMode(null);
    form.classList.add('hidden');
    await renderSuppliers();
    refreshSyncStatus().catch(() => {});
  } catch (error) {
    toast(error.message);
  }
});
document.getElementById('supplier-form-cancel').addEventListener('click', () => {
  setSupplierFormMode(null);
  document.getElementById('supplier-form').classList.add('hidden');
});

// Place form creates or, when an id is set via Edit, updates in place.
document.getElementById('place-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.querySelector('input[name="id"]').value;
  try {
    if (id) {
      const payload = {};
      for (const input of form.querySelectorAll('input[name], select[name]')) {
        if (input.name === 'id') continue;
        payload[input.name] = input.value ? (NUMERIC_FORM_FIELDS.has(input.name) ? Number(input.value) : input.value) : null;
      }
      await api('PATCH', `/api/places/${id}`, payload);
    } else {
      await api('POST', '/api/places', formValues(form));
    }
    setPlaceFormMode(null);
    form.classList.add('hidden');
    await renderMap();
    refreshSyncStatus().catch(() => {});
  } catch (error) {
    toast(error.message);
  }
});
document.getElementById('place-form-cancel').addEventListener('click', () => {
  setPlaceFormMode(null);
  document.getElementById('place-form').classList.add('hidden');
});

// --- Auth ---

let appStarted = false;

function showAuth(needsSetup) {
  document.querySelector('main').classList.add('hidden');
  document.querySelector('.tabs').classList.add('hidden');
  document.getElementById('logout-button').classList.add('hidden');
  document.getElementById('current-user').classList.add('hidden');
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('setup-form').classList.toggle('hidden', !needsSetup);
  document.getElementById('login-form').classList.toggle('hidden', needsSetup);
}

function startApp(user) {
  document.getElementById('auth-screen').classList.add('hidden');
  document.querySelector('main').classList.remove('hidden');
  document.querySelector('.tabs').classList.remove('hidden');
  const userLabel = document.getElementById('current-user');
  userLabel.textContent = user.name;
  userLabel.classList.remove('hidden');
  document.getElementById('logout-button').classList.remove('hidden');
  document.querySelector('.tab[data-view="admin"]').classList.toggle('hidden', user.role !== 'ADMIN');
  if (appStarted) return;
  appStarted = true;
  setInterval(() => refreshSyncStatus().catch(() => {}), 30000);
  renderSuppliers()
    .then(renderTrips)
    .then(refreshSyncStatus)
    .then(() => activateView(location.hash.slice(1) || 'today'))
    .catch((error) => toast(error.message));
}

function bindAuthForm(formId, path, errorId) {
  const form = document.getElementById(formId);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorLabel = document.getElementById(errorId);
    errorLabel.textContent = '';
    try {
      const result = await api('POST', path, formValues(form));
      form.reset();
      startApp(result.user);
    } catch (error) {
      errorLabel.textContent = error.message;
    }
  });
}
bindAuthForm('setup-form', '/api/auth/setup', 'setup-error');
bindAuthForm('login-form', '/api/auth/login', 'login-error');

document.getElementById('logout-button').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  location.reload();
});

api('GET', '/api/auth/status')
  .then((status) => (status.authenticated ? startApp(status.user) : showAuth(status.needs_setup)))
  .catch(() => showAuth(false));
