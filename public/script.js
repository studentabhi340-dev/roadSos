// ── STATE ──
let map, userMarker, userLat, userLng, routingControl;
let watchId = null;
let nearbyMarkers = [];
let lastKnownAddress = "Location unavailable";
let currentSOSTab = 'emergency';
let activeFilter = null;
let lastDestination = null;

// ── CACHE (in-memory, per session) ──
const nearbyCache = {};   // key: "type_lat_lng" → { ts, elements }
const CACHE_TTL = 5 * 60 * 1000; // 5 min
let reverseGeocodeTimer = null;   // debounce reverse geocode calls

let contact = JSON.parse(localStorage.getItem('roadsos_contact') || '{"name":"","number":""}');
let cachedLat = parseFloat(localStorage.getItem('roadsos_lat') || '0');
let cachedLng = parseFloat(localStorage.getItem('roadsos_lng') || '0');
updateContactDisplay();

// ── MAP INIT ──
// Use cached coords for instant first view; fall back to India centre
const initLat = cachedLat || 20.5937;
const initLng = cachedLng || 78.9629;
const initZoom = cachedLat ? 15 : 5;
map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([initLat, initLng], initZoom);

// Use a lighter tile layer that caches better & loads faster on slow connections
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
  maxZoom: 19,
  keepBuffer: 4,          // keep more tiles in memory while panning
  updateWhenIdle: true,   // don't hammer the server while dragging
  updateWhenZooming: false
}).addTo(map);

// If we have a cached location, show it immediately — don't wait for GPS
if (cachedLat && cachedLng) {
  userMarker = L.marker([cachedLat, cachedLng], { icon: userIcon() })
    .addTo(map).bindPopup('<b>📍 Last known location</b>');
  lastKnownAddress = localStorage.getItem('roadsos_address') || `${cachedLat.toFixed(5)}, ${cachedLng.toFixed(5)}`;
  setStatus("Last known location");
}

// Icons (defined as functions to avoid hoisting issues)
function makeIcon(emoji, bg, label) {
  return L.divIcon({
    html: `<div style="background:${bg};color:white;border-radius:8px;padding:3px 7px;font-size:11px;font-weight:700;font-family:sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.5)">${emoji} ${label}</div>`,
    className: '', iconAnchor: [40, 14]
  });
}
function userIcon() {
  return L.divIcon({
    html: `<div style="width:16px;height:16px;background:#2d8cff;border:3px solid white;border-radius:50%;box-shadow:0 0 0 6px rgba(45,140,255,0.25)"></div>`,
    className: '', iconAnchor: [8, 8]
  });
}

const icons = {
  hospital:  makeIcon('🏥','#e8001c','Hospital'),
  police:    makeIcon('🚔','#2d5fe8','Police'),
  ambulance: makeIcon('🚑','#c0392b','Ambulance'),
  repair:    makeIcon('🔧','#e67e22','Repair'),
  food:      makeIcon('🛒','#27ae60','Store'),
};

// Overpass queries per type
const overpassQuery = {
  hospital:  'amenity~"hospital|clinic"',
  police:    'amenity=police',
  ambulance: 'amenity~"hospital|clinic"',
  repair:    'shop~"car_repair|tyres|car_parts|bicycle"',
  food:      'shop~"supermarket|convenience|general|grocery|food"',
};

// ── GEOLOCATION ──
function getLocation() {
  if (!navigator.geolocation) { setStatus("GPS not supported"); return; }
  if (watchId) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    onLocationSuccess,
    onLocationError,
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 30000  // accept a 30s old fix — huge speed improvement on slow connections
    }
  );
}

function onLocationSuccess(pos) {
  const newLat = pos.coords.latitude;
  const newLng = pos.coords.longitude;

  // Skip update if barely moved (< ~10 m) — avoids pointless re-renders
  if (userLat && userLng) {
    const moved = getDistanceKm(userLat, userLng, newLat, newLng);
    if (moved < 0.01) return;  // less than 10m, skip
  }

  userLat = newLat;
  userLng = newLng;
  localStorage.setItem('roadsos_lat', userLat);
  localStorage.setItem('roadsos_lng', userLng);

  if (!userMarker) map.setView([userLat, userLng], 15);
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker([userLat, userLng], { icon: userIcon() })
    .addTo(map).bindPopup('<b>📍 You are here</b>').openPopup();

  // Debounce reverse geocode: only call it if location hasn't changed for 3s
  // and only when no cached address exists for this session
  clearTimeout(reverseGeocodeTimer);
  reverseGeocodeTimer = setTimeout(() => reverseGeocode(userLat, userLng), 3000);

  setStatus("GPS Active");
}

function onLocationError() {
  setStatus("Last known location");
  if (cachedLat && cachedLng && !userLat) {
    userLat = cachedLat; userLng = cachedLng;
    map.setView([userLat, userLng], 14);
    showToast("📡 Using last known location");
  }
}

function reverseGeocode(lat, lng) {
  // Skip if we already have a fresh address (less than 2 min old)
  const lastGeoTs = parseInt(localStorage.getItem('roadsos_geo_ts') || '0');
  if (Date.now() - lastGeoTs < 2 * 60 * 1000) {
    lastKnownAddress = localStorage.getItem('roadsos_address') || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    return;
  }
  fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=14&addressdetails=0`)
    .then(r => r.json()).then(d => {
      lastKnownAddress = d.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      localStorage.setItem('roadsos_address', lastKnownAddress);
      localStorage.setItem('roadsos_geo_ts', Date.now().toString());
    }).catch(() => {
      lastKnownAddress = localStorage.getItem('roadsos_address') || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    });
}

function setStatus(t) { document.getElementById('status-text').textContent = t; }
getLocation();


// ── DESTINATION SEARCH ──
function searchDestination() {
  const query = document.getElementById('dest-input').value.trim();
  if (!query) return showToast("Please enter a destination");
  showToast("🔍 Searching…");
  // Add countrycodes bias for faster, smaller response
  fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=0`)
    .then(r => r.json()).then(data => {
      if (!data.length) return showToast("❌ Destination not found");
      const dest = data[0];
      const dLat = parseFloat(dest.lat), dLng = parseFloat(dest.lon);
      const dName = dest.display_name.split(',')[0];

      lastDestination = { lat: dLat, lng: dLng, name: dName };
      activeFilter = null;
      document.querySelectorAll('.q-btn').forEach(b => b.classList.remove('active-filter'));

      _clearMarkersAndRoute();
      _drawRoute(dLat, dLng, dName, '#2d8cff');
      showToast(`✅ Destination: ${dName}`);
    }).catch(() => showToast("❌ No internet — cannot search"));
}


// ── INTERNAL: clear markers + routing control ──
function _clearMarkersAndRoute() {
  nearbyMarkers.forEach(m => map.removeLayer(m));
  nearbyMarkers = [];
  if (routingControl) { map.removeControl(routingControl); routingControl = null; }
}

// ── INTERNAL: draw a route line + destination pin ──
function _drawRoute(dLat, dLng, dName, lineColor) {
  const destIcon = L.divIcon({
    html: `<div style="background:${lineColor === '#2d8cff' ? '#f5a623' : '#e8001c'};color:${lineColor === '#2d8cff' ? '#000' : '#fff'};border-radius:8px;padding:3px 8px;font-size:11px;font-weight:700;font-family:sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.4)">🏁 ${dName}</div>`,
    className: '', iconAnchor: [40, 14]
  });

  const destMarker = L.marker([dLat, dLng], { icon: destIcon })
    .addTo(map)
    .bindPopup(`<b>🏁 ${dName}</b>`);
  nearbyMarkers.push(destMarker);

  if (userLat && userLng) {
    routingControl = L.Routing.control({
      waypoints: [L.latLng(userLat, userLng), L.latLng(dLat, dLng)],
      lineOptions: { styles: [{ color: lineColor, opacity: 0.85, weight: 5 }] },
      createMarker: (i, wp) => {
        if (i === 0) return L.marker(wp.latLng, { icon: userIcon() });
        return null;
      },
      routeWhileDragging: false,
      addWaypoints: false,
      draggableWaypoints: false,
      fitSelectedRoutes: true
    }).addTo(map);
  } else {
    map.setView([dLat, dLng], 14);
  }
}


// ── FIND NEARBY (quick-action buttons) — with caching ──
function findNearby(type) {
  if (!userLat) return showToast("📡 Getting your location…");

  // Toggle off
  if (activeFilter === type) {
    activeFilter = null;
    document.querySelectorAll('.q-btn').forEach(b => b.classList.remove('active-filter'));
    _clearMarkersAndRoute();
    if (lastDestination) {
      _drawRoute(lastDestination.lat, lastDestination.lng, lastDestination.name, '#2d8cff');
      showToast(`↩️ Back to: ${lastDestination.name}`);
    } else {
      map.setView([userLat, userLng], 14);
      showToast("✅ Filter cleared");
    }
    return;
  }

  // Toggle on
  activeFilter = type;
  document.querySelectorAll('.q-btn').forEach(b => b.classList.remove('active-filter'));
  document.getElementById(`qb-${type}`)?.classList.add('active-filter');
  _clearMarkersAndRoute();

  // Check in-memory cache first (snapped to 0.01° grid ≈ 1 km)
  const gridLat = Math.round(userLat * 100) / 100;
  const gridLng = Math.round(userLng * 100) / 100;
  const cacheKey = `${type}_${gridLat}_${gridLng}`;
  const cached = nearbyCache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    showToast("⚡ Loaded from cache");
    _renderNearbyResults(type, cached.elements);
    return;
  }

  const qFilter = overpassQuery[type];
  // Reduced radius: 8km (was 15km) → smaller payload, faster on slow connections
  const radius = 8000;
  // Compact query: removed redundant way query for police/hospital (nodes sufficient)
  const q = `[out:json][timeout:10];(node[${qFilter}](around:${radius},${userLat},${userLng});way[${qFilter}](around:${radius},${userLat},${userLng}););out center 6;`;

  showToast("🔍 Finding nearest…");
  fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`)
    .then(r => r.json())
    .then(data => {
      if (!data.elements.length) return showToast(`No ${type} services found nearby`);
      // Store in cache
      nearbyCache[cacheKey] = { ts: Date.now(), elements: data.elements };
      _renderNearbyResults(type, data.elements);
    })
    .catch(() => {
      showToast("❌ No internet — check connection");
      // Fall back to last cached entry for this type regardless of location
      const fallback = Object.entries(nearbyCache).find(([k]) => k.startsWith(type + '_'));
      if (fallback) {
        showToast("📦 Showing cached results");
        _renderNearbyResults(type, fallback[1].elements);
      }
    });
}

function _renderNearbyResults(type, elements) {
  const sorted = elements
    .map(el => {
      const lat = el.lat || el.center?.lat;
      const lng = el.lon || el.center?.lon;
      if (!lat) return null;
      return { ...el, lat, lng, dist: parseFloat(getDistanceKm(userLat, userLng, lat, lng)) };
    })
    .filter(Boolean)
    .sort((a, b) => a.dist - b.dist);

  const icon = icons[type] || icons.hospital;
  sorted.slice(1, 8).forEach(el => {
    nearbyMarkers.push(
      L.marker([el.lat, el.lng], { icon }).addTo(map)
        .bindPopup(`<b>${el.tags?.name || type}</b><br><small>${el.dist} km away</small>`)
    );
  });

  const nearest = sorted[0];
  const name = nearest.tags?.name || type;
  _drawRoute(nearest.lat, nearest.lng, name, '#e8001c');
  showToast(`✅ Routing to nearest ${type} (${nearest.dist} km)`);
}


// ── SOS ──
function triggerSOS() { startSOSCountdown(); }

function startSOSCountdown() {
  let countdown = 5;
  const overlay = document.createElement('div');
  overlay.id = 'sos-countdown';
  overlay.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px">
      <div style="font-size:5rem;font-weight:900;color:#e8001c;font-family:Rajdhani,sans-serif"
        id="sos-count-num">5</div>
      <div style="color:#fff;font-size:1.1rem;font-family:Rajdhani,sans-serif;letter-spacing:2px">
        SOS ACTIVATING…</div>
      <button onclick="cancelSOSCountdown()"
        style="margin-top:12px;background:#1c2029;color:#eef0f4;border:1px solid rgba(255,255,255,0.1);
        padding:10px 28px;border-radius:50px;font-size:1rem;cursor:pointer;font-family:DM Sans,sans-serif">
        ✕ Cancel
      </button>
    </div>
  `;
  document.body.appendChild(overlay);

  window._sosTimer = setInterval(() => {
    countdown--;
    const el = document.getElementById('sos-count-num');
    if (el) el.textContent = countdown;
    if (countdown <= 0) { cancelSOSCountdown(); fireSOS(); }
  }, 1000);
}

function cancelSOSCountdown() {
  clearInterval(window._sosTimer);
  const el = document.getElementById('sos-countdown');
  if (el) el.remove();
  showToast("SOS cancelled");
}

function fireSOS() {
  document.getElementById('sos-modal').classList.add('active');
  document.getElementById('sos-time').textContent = `Activated at ${new Date().toLocaleTimeString()}`;
  document.getElementById('sos-location').textContent =
    lastKnownAddress || `${userLat?.toFixed(5)}, ${userLng?.toFixed(5)}` || "Fetching…";

  const alertEl = document.getElementById('family-alert-text');
  if (contact.name && contact.number) {
    const lat = userLat?.toFixed(5) || 'unknown';
    const lng = userLng?.toFixed(5) || 'unknown';
    const mapsLink = `https://maps.google.com/?q=${lat},${lng}`;
    const address = lastKnownAddress || `${lat}, ${lng}`;
    const smsBody = `🆘 EMERGENCY! I need help immediately.\n📍 My location: ${address}\n🗺️ Map: ${mapsLink}\n— Sent via RoadSoS`;
    window.open(`sms:${contact.number}?body=${encodeURIComponent(smsBody)}`, '_self');
    alertEl.innerHTML = `✅ SMS opened for <b>${contact.name}</b> (${contact.number}) — press Send!`;
  } else {
    alertEl.innerHTML = `⚠️ No contact set — <u onclick="closeSOS();openContactModal()" style="cursor:pointer">Add one now</u>`;
    showToast("⚠️ Set an emergency contact first!");
  }
  switchSOSTab('emergency', document.querySelector('.tab-btn'));
}

function switchSOSTab(tab, btnEl) {
  currentSOSTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  loadSOSTab(tab);
}

function loadSOSTab(tab) {
  const list = document.getElementById('nearby-list');

  if (tab === 'emergency') {
    list.innerHTML = '';
    addSOSItem(list,'🚨','National Emergency','112',null);
    addSOSItem(list,'🏥','Ambulance (National)','108',null);
    addSOSItem(list,'🚔','Police','100',null);
    addSOSItem(list,'🔥','Fire Brigade','101',null);
    addSOSItem(list,'👩','Women Helpline','1091',null);
    return;
  }

  if (!userLat) {
    list.innerHTML = `<div style="color:var(--muted);font-size:0.82rem;padding:10px;text-align:center">📡 Location unavailable</div>`;
    return;
  }

  // Use cached nearby results if available
  const gridLat = Math.round(userLat * 100) / 100;
  const gridLng = Math.round(userLng * 100) / 100;
  const cacheKey = `${tab}_${gridLat}_${gridLng}`;
  const cached = nearbyCache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    list.innerHTML = '';
    _buildSOSList(list, tab, cached.elements);
    return;
  }

  list.innerHTML = `<div style="text-align:center;color:var(--muted);padding:10px;font-size:0.8rem">🔍 Finding nearest ${tab}…</div>`;

  const qFilter = overpassQuery[tab];
  const radius = tab === 'food' ? 3000 : 5000;
  const q = `[out:json][timeout:10];(node[${qFilter}](around:${radius},${userLat},${userLng});way[${qFilter}](around:${radius},${userLat},${userLng}););out center 5;`;

  fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`)
    .then(r => r.json())
    .then(data => {
      list.innerHTML = '';
      // Cache the result
      nearbyCache[cacheKey] = { ts: Date.now(), elements: data.elements };
      if (!data.elements.length) {
        list.innerHTML = `<div style="color:var(--muted);font-size:0.82rem;padding:10px;text-align:center">😔 None found within ${radius/1000} km</div>`;
        if (tab==='hospital') addSOSItem(list,'🏥','Ambulance (Fallback)','108',null);
        if (tab==='police')   addSOSItem(list,'🚔','Police (Fallback)','100',null);
        return;
      }
      _buildSOSList(list, tab, data.elements);
    })
    .catch(() => {
      list.innerHTML = '';
      // Try stale cache on error
      const fallback = Object.entries(nearbyCache).find(([k]) => k.startsWith(tab + '_'));
      if (fallback) {
        list.innerHTML = `<div style="color:var(--amber);font-size:0.75rem;padding:6px;text-align:center">📦 Offline — showing cached results</div>`;
        _buildSOSList(list, tab, fallback[1].elements);
        return;
      }
      list.innerHTML = `<div style="color:var(--muted);font-size:0.82rem;padding:8px;text-align:center">❌ No internet — showing emergency numbers</div>`;
      if (tab==='hospital'||tab==='ambulance') addSOSItem(list,'🏥','Ambulance','108',null);
      if (tab==='police') addSOSItem(list,'🚔','Police','100',null);
    });
}

function _buildSOSList(list, tab, elements) {
  elements.slice(0, 5).forEach(el => {
    const lat = el.lat || el.center?.lat;
    const lng = el.lon || el.center?.lon;
    if (!lat) return;
    const name = el.tags?.name || (tab==='repair' ? 'Vehicle Repair Shop' : tab==='food' ? 'General Store' : tab==='police' ? 'Police Station' : 'Hospital/Clinic');
    const dist = getDistanceKm(userLat, userLng, lat, lng);
    const phone = el.tags?.phone || el.tags?.['contact:phone'] ||
      (tab==='police' ? '100' : tab==='hospital'||tab==='ambulance' ? '108' : 'N/A');
    const emoji = {hospital:'🏥',police:'🚔',ambulance:'🚑',repair:'🔧',food:'🛒'}[tab]||'📍';
    addSOSItem(list, emoji, `${name} (${dist} km)`, phone, () => {
      map.setView([lat, lng], 16); closeSOS();
    });
  });
}

function addSOSItem(container, icon, name, phone, onClick) {
  const div = document.createElement('div');
  div.className = 'nearby-item';
  div.innerHTML = `
    <div class="nearby-left">
      <span class="nearby-icon">${icon}</span>
      <div style="min-width:0">
        <div class="nearby-name">${name}</div>
        <div class="nearby-dist">${phone}</div>
      </div>
    </div>
    <button class="btn-call" onclick="callNumber('${phone}')">📞 Call</button>
  `;
  if (onClick) div.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') onClick(); });
  container.appendChild(div);
}

function callNumber(num) { if(num && num!=='N/A') window.location.href=`tel:${num}`; else showToast("No phone number available"); }
function closeSOS() { document.getElementById('sos-modal').classList.remove('active'); }

// ── CONTACT ──
function openContactModal() {
  document.getElementById('c-name').value = contact.name||'';
  document.getElementById('c-number').value = contact.number||'';
  document.getElementById('contact-modal').classList.add('active');
}
function closeContactModal() { document.getElementById('contact-modal').classList.remove('active'); }
function saveContact() {
  const name = document.getElementById('c-name').value.trim();
  const number = document.getElementById('c-number').value.trim();
  if (!name||!number) return showToast("Please fill both fields");
  contact = {name, number};
  localStorage.setItem('roadsos_contact', JSON.stringify(contact));
  updateContactDisplay(); closeContactModal();
  showToast(`✅ Contact saved: ${name}`);
}
function updateContactDisplay() {
  document.getElementById('contact-name-display').textContent = contact.name||'Add Emergency Contact';
  document.getElementById('contact-number-display').textContent = contact.number||'Tap edit to set →';
}

// ── UTILS ──
function getDistanceKm(lat1, lng1, lat2, lng2) {
  const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLng=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return (R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))).toFixed(1);
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

document.getElementById('dest-input').addEventListener('keydown', e => { if(e.key==='Enter') searchDestination(); });
