// ── STATE ──
let map, userMarker, userLat, userLng, routingControl;
let watchId = null;
let nearbyMarkers = [];
let lastKnownAddress = "Location unavailable";
let currentSOSTab = 'emergency';

let contact = JSON.parse(localStorage.getItem('roadsos_contact') || '{"name":"","number":""}');
let cachedLat = parseFloat(localStorage.getItem('roadsos_lat') || '0');
let cachedLng = parseFloat(localStorage.getItem('roadsos_lng') || '0');
updateContactDisplay();

// ── MAP INIT ──
map = L.map('map', { zoomControl: true }).setView([20.5937, 78.9629], 5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution:'© OpenStreetMap contributors', maxZoom:19
}).addTo(map);

// Icons
const makeIcon = (emoji, bg, label) => L.divIcon({
  html: `<div style="background:${bg};color:white;border-radius:8px;padding:3px 7px;font-size:11px;font-weight:700;font-family:sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.5)">${emoji} ${label}</div>`,
  className:'', iconAnchor:[40,14]
});

const userIcon = L.divIcon({
  html:`<div style="width:16px;height:16px;background:#2d8cff;border:3px solid white;border-radius:50%;box-shadow:0 0 0 6px rgba(45,140,255,0.25)"></div>`,
  className:'', iconAnchor:[8,8]
});

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
  if (!navigator.geolocation) { 
    setStatus("GPS not supported"); 
    useCachedLocation(); 
    return; }
    if (watchId) {
      navigator.geolocation.clearWatch(watchId);
    }

  watchId = navigator.geolocation.watchPosition(onLocationSuccess, onLocationError,
    { enableHighAccuracy:true, timeout:10000, maximumAge:0 });
}

function onLocationSuccess(pos) {
  userLat = pos.coords.latitude;
  userLng = pos.coords.longitude;
  localStorage.setItem('roadsos_lat', userLat);
  localStorage.setItem('roadsos_lng', userLng);
  if(!userMarker) {
     map.setView([userLat, userLng], 15);
  }
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker([userLat, userLng], { icon: userIcon })
    .addTo(map).bindPopup('<b>📍 You are here</b>').openPopup();
  reverseGeocode(userLat, userLng);
  setStatus("GPS Active");
}

function onLocationError() { setStatus("Last known location"); useCachedLocation(); }

function useCachedLocation() {
  if (cachedLat && cachedLng) {
    userLat = cachedLat; userLng = cachedLng;
    map.setView([userLat, userLng], 14);
    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.marker([userLat, userLng], { icon: userIcon })
      .addTo(map).bindPopup('<b>📍 Last known location</b>');
    lastKnownAddress = localStorage.getItem('roadsos_address') || "Last known location (offline)";
    showToast("📡 Offline — using last known location");
  }
}

function reverseGeocode(lat, lng) {
  fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`)
    .then(r=>r.json()).then(d => {
      lastKnownAddress = d.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      localStorage.setItem('roadsos_address', lastKnownAddress);
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
  fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`)
    .then(r=>r.json()).then(data => {
      if (!data.length) return showToast("❌ Destination not found");
      const dest = data[0];
      const dLat = parseFloat(dest.lat), dLng = parseFloat(dest.lon);
      clearNearbyMarkers();
      const destIcon = L.divIcon({
        html:`<div style="background:#f5a623;color:#000;border-radius:8px;padding:3px 8px;font-size:11px;font-weight:700;font-family:sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.4)">🏁 ${dest.display_name.split(',')[0]}</div>`,
        className:'', iconAnchor:[40,14]
      });
      nearbyMarkers.push(L.marker([dLat,dLng],{icon:destIcon}).addTo(map)
        .bindPopup(`<b>🏁 Destination</b><br>${dest.display_name.split(',').slice(0,3).join(', ')}`));
      if (userLat && userLng) {
        if (routingControl) map.removeControl(routingControl);
        routingControl = L.Routing.control({
          waypoints: [L.latLng(userLat,userLng), L.latLng(dLat,dLng)],
          lineOptions: { styles: [{color:'#2d8cff',opacity:0.8,weight:5}] },
          createMarker: (i,wp) => i===0 ? L.marker(wp.latLng,{icon:userIcon}) : L.marker(wp.latLng,{icon:destIcon}),
          routeWhileDragging: false, addWaypoints: false, draggableWaypoints: false, fitSelectedRoutes: true
        }).addTo(map);
      } else { map.setView([dLat,dLng],14); }
      showToast(`✅ Destination: ${dest.display_name.split(',')[0]}`);
    }).catch(()=>showToast("❌ No internet — cannot search"));
}

// ── FIND NEARBY (map buttons) ──
function findNearby(type) {
  if (!userLat) return showToast("📡 Getting your location…");
  clearNearbyMarkers();

  // Highlight active button
  document.querySelectorAll('.q-btn').forEach(b=>b.classList.remove('active-filter'));
  document.getElementById(`qb-${type}`)?.classList.add('active-filter');

  const qFilter = overpassQuery[type];
  const radius = 15000;
  const q = `[out:json][timeout:12];(node[${qFilter}](around:${radius},${userLat},${userLng});way[${qFilter}](around:${radius},${userLat},${userLng}););out center 8;`;

  showToast("🔍 Finding nearby…");
  fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`)
    .then(r=>r.json()).then(data => {
      if (!data.elements.length) return showToast(`No ${type} services found nearby`);
      data.elements.slice(0,8).forEach(el => {
        const lat = el.lat || el.center?.lat;
        const lng = el.lon || el.center?.lon;
        if (!lat) return;
        const name = el.tags?.name || type;
        const icon = icons[type] || icons.hospital;
        const dist = getDistanceKm(userLat,userLng,lat,lng);
        nearbyMarkers.push(
          L.marker([lat,lng],{icon}).addTo(map)
            .bindPopup(`<b>${name}</b><br><small>${dist} km away</small>`)
        );
      });
      showToast(`✅ Found ${Math.min(data.elements.length,8)} nearby`);
    }).catch(()=>showToast("❌ No internet"));
}

function clearNearbyMarkers() {
  nearbyMarkers.forEach(m=>map.removeLayer(m));
  nearbyMarkers=[];
}
/*
// ── SOS ──
function triggerSOS() {
  document.getElementById('sos-modal').classList.add('active');
  document.getElementById('sos-time').textContent = `Activated at ${new Date().toLocaleTimeString()}`;
  document.getElementById('sos-location').textContent =
    lastKnownAddress || `${userLat?.toFixed(5)}, ${userLng?.toFixed(5)}` || "Fetching…";

  const alertEl = document.getElementById('family-alert-text');
  if (contact.name && contact.number) {
    alertEl.innerHTML = `📲 Alerting <b>${contact.name}</b> (${contact.number}) — share your location`;
  } else {
    alertEl.innerHTML = `⚠️ No contact set — <u onclick="closeSOS();openContactModal()" style="cursor:pointer">Add one now</u>`;
  }

  // Default tab: emergency
  switchSOSTab('emergency', document.querySelector('.tab-btn'));
}
*/

function triggerSOS() {
  // Start 5-second countdown before firing
  startSOSCountdown();
}

function startSOSCountdown() {
  let countdown = 10;
  const overlay = document.createElement('div');
  overlay.id = 'sos-countdown';
  overlay.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px">
      <div style="font-size:5rem;font-weight:900;color:#e8001c;font-family:Rajdhani,sans-serif"
        id="sos-count-num">10</div>
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
    if (countdown <= 0) {
      cancelSOSCountdown();
      fireSOS();
    }
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
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
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

  list.innerHTML = `<div style="text-align:center;color:var(--muted);padding:10px;font-size:0.8rem">🔍 Finding nearest ${tab}…</div>`;

  const qFilter = overpassQuery[tab];
  const radius = tab==='food' ? 3000 : tab==='repair' ? 5000 : 5000;
  const q = `[out:json][timeout:10];(node[${qFilter}](around:${radius},${userLat},${userLng});way[${qFilter}](around:${radius},${userLat},${userLng}););out center 5;`;

  fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`)
    .then(r=>r.json())
    .then(data => {
      list.innerHTML = '';
      if (!data.elements.length) {
        list.innerHTML = `<div style="color:var(--muted);font-size:0.82rem;padding:10px;text-align:center">😔 None found within ${radius/1000} km</div>`;
        // Fallback helpline for hospital/police
        if (tab==='hospital') { addSOSItem(list,'🏥','Ambulance (Fallback)','108',null); }
        if (tab==='police')   { addSOSItem(list,'🚔','Police (Fallback)','100',null); }
        return;
      }
      data.elements.slice(0,5).forEach(el => {
        const lat = el.lat || el.center?.lat;
        const lng = el.lon || el.center?.lon;
        if (!lat) return;
        const name = el.tags?.name || (tab==='repair' ? 'Vehicle Repair Shop' : tab==='food' ? 'General Store' : tab==='police' ? 'Police Station' : 'Hospital/Clinic');
        const dist = getDistanceKm(userLat,userLng,lat,lng);
        const phone = el.tags?.phone || el.tags?.['contact:phone'] ||
          (tab==='police' ? '100' : tab==='hospital'||tab==='ambulance' ? '108' : 'N/A');
        const emoji = {hospital:'🏥',police:'🚔',ambulance:'🚑',repair:'🔧',food:'🛒'}[tab]||'📍';
        addSOSItem(list, emoji, `${name} (${dist} km)`, phone, ()=>{
          map.setView([lat,lng],16); closeSOS();
        });
      });
    })
    .catch(() => {
      list.innerHTML = '';
      list.innerHTML = `<div style="color:var(--muted);font-size:0.82rem;padding:8px;text-align:center">❌ No internet — showing emergency numbers</div>`;
      if (tab==='hospital'||tab==='ambulance') addSOSItem(list,'🏥','Ambulance','108',null);
      if (tab==='police') addSOSItem(list,'🚔','Police','100',null);
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
  if (onClick) div.addEventListener('click', e=>{ if(e.target.tagName!=='BUTTON') onClick(); });
  container.appendChild(div);
}

function callNumber(num) { if(num&&num!=='N/A') window.location.href=`tel:${num}`; else showToast("No phone number available"); }
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
  contact = {name,number};
  localStorage.setItem('roadsos_contact', JSON.stringify(contact));
  updateContactDisplay(); closeContactModal();
  showToast(`✅ Contact saved: ${name}`);
}
function updateContactDisplay() {
  document.getElementById('contact-name-display').textContent = contact.name||'Add Emergency Contact';
  document.getElementById('contact-number-display').textContent = contact.number||'Tap edit to set →';
}

// ── UTILS ──
function getDistanceKm(lat1,lng1,lat2,lng2) {
  const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLng=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return (R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))).toFixed(1);
}

function showToast(msg) {
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),3000);
}

document.getElementById('dest-input').addEventListener('keydown', e=>{ if(e.key==='Enter') searchDestination(); });
