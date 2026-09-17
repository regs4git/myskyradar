// Configuração
const CONFIG = {
  defaultLat: 38.736946, // Lisboa
  defaultLon: -9.142685,
  apiBase: 'https://opensky-network.org/api/states/all',
  pollInterval: 15000, // 15s para respeitar limite de 100req/10min da OpenSky sem auth
  alertRadius: 3000, // 3 km
  alertAltitude: 1500, // 1500 metros
};

// Estado da aplicação
const state = {
  lat: CONFIG.defaultLat,
  lon: CONFIG.defaultLon,
  range: parseInt(localStorage.getItem('msr_range')) || 5,
  soundEnabled: localStorage.getItem('msr_sound') === 'true',
  notifEnabled: localStorage.getItem('msr_notif') === 'true',
  planes: new Map(), // ICAO24 -> dados
  selectedPlane: null,
  userMarker: null,
  rangeCircle: null,
  trailLine: null,
  notifiedPlanes: new Set(),
  lastUpdate: 0
};

// Inicialização do Mapa
const map = L.map('map', { zoomControl: false }).setView([state.lat, state.lon], 11);
L.control.zoom({ position: 'bottomright' }).addTo(map);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
  subdomains: 'abcd',
  maxZoom: 19
}).addTo(map);

// Ícone SVG do avião
const getPlaneIcon = (heading, type, isSelected, isSquawkAlert) => {
  let className = 'plane-icon';
  if (isSquawkAlert) className += ' squawk-alert';
  else if (isSelected) className += ' selected';
  else if (type === 'military') className += ' military';
  else className += ' commercial';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" class="${className}" style="transform: rotate(${heading}deg);">
    <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
  </svg>`;
  
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
};

// Utilitários
const toRad = (deg) => deg * (Math.PI / 180);
const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1), Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

const getBearing = (lat1, lon1, lat2, lon2) => {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.cos(φ2) - Math.sin(φ1)*Math.sin(φ2)*Math.cos(Δλ); // Correção para bearing
  // Fórmula correta de bearing:
  const Y = Math.sin(Δλ) * Math.cos(φ2);
  const X = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let brng = Math.atan2(Y, X) * (180 / Math.PI);
  return (brng + 360) % 360;
};

const getCardinal = (deg) => {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  return dirs[Math.round(deg / 45) % 8];
};

const isMilitary = (callsign, country) => {
  if (!callsign) return false;
  const milKeywords = ['POR', 'FAB', 'ARMY', 'NAVY', 'MIL', 'RESCUE', 'FORCE'];
  return milKeywords.some(k => callsign.toUpperCase().includes(k)) || country === 'Portugal';
};

const playBlip = () => {
  if (!state.soundEnabled) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = 1200;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.1, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  osc.start();
  osc.stop(ctx.currentTime + 0.15);
};

const showStatus = (msg, type = 'info') => {
  const banner = document.getElementById('status-banner');
  banner.textContent = msg;
  banner.className = `status-banner visible ${type}`;
  setTimeout(() => banner.classList.remove('visible'), 4000);
};

// Geolocalização
const initGeo = () => {
  if (navigator.geolocation) {
    showStatus('A obter localização...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.lat = pos.coords.latitude;
        state.lon = pos.coords.longitude;
        map.setView([state.lat, state.lon], 12);
        showStatus('Localização obtida com sucesso', 'success');
        updateUserMarker();
        fetchData();
      },
      (err) => {
        showStatus('GPS negado. A usar Lisboa como padrão.', 'error');
        updateUserMarker();
        fetchData();
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  } else {
    showStatus('Geolocalização não suportada.', 'error');
    updateUserMarker();
    fetchData();
  }
};

const updateUserMarker = () => {
  if (state.userMarker) map.removeLayer(state.userMarker);
  if (state.rangeCircle) map.removeLayer(state.rangeCircle);

  state.userMarker = L.circleMarker([state.lat, state.lon], {
    radius: 6, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 1, weight: 2
  }).addTo(map).bindPopup('Tu estás aqui');

  state.rangeCircle = L.circle([state.lat, state.lon], {
    radius: state.range * 1000, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.05, weight: 1, dashArray: '5, 5'
  }).addTo(map);
};

// Dados da API
const fetchData = async () => {
  try {
    // OpenSky permite bbox para otimizar: west, south, east, north
    const degRange = state.range / 111; // aprox graus
    const bbox = `${state.lon - degRange},${state.lat - degRange},${state.lon + degRange},${state.lat + degRange}`;
    const url = `${CONFIG.apiBase}?lamin=${state.lat - degRange}&lomin=${state.lon - degRange}&lamax=${state.lat + degRange}&lomax=${state.lon + degRange}`;
    
    const res = await fetch(url);
    if (!res.ok) throw new Error('Falha na API');
    const data = await res.json();
    
    if (!data.states) {
      updateUI([]);
      return;
    }

    const now = Date.now() / 1000;
    const newPlanes = new Map();

    data.states.forEach(stateData => {
      const icao24 = stateData[0];
      const callsign = stateData[1]?.trim() || 'N/D';
      const country = stateData[2];
      const lon = stateData[5];
      const lat = stateData[6];
      const baroAlt = stateData[7];
      const velocity = stateData[9];
      const heading = stateData[10];
      const squawk = stateData[14];
      const onGround = stateData[8];
      const lastContact = stateData[4];

      if (onGround || lat === null || lon === null) return; // Só em voo

      const dist = getDistance(state.lat, state.lon, lat, lon);
      if (dist > state.range * 1000) return;

      const prev = state.planes.get(icao24);
      const isApproaching = prev ? dist < prev.dist : false;
      const isMil = isMilitary(callsign, country);
      const isAlert = squawk === '7700' || squawk === '7500' || squawk === '7600';

      const plane = {
        icao24, callsign, country, lat, lon, 
        altitude: baroAlt !== null ? Math.round(baroAlt) : 0,
        speed: velocity !== null ? Math.round(velocity * 3.6) : 0, // m/s to km/h
        heading: heading !== null ? Math.round(heading) : 0,
        squawk, dist, isApproaching, isMil, isAlert, lastContact
      };

      newPlanes.set(icao24, plane);

      // Notificações
      if (state.notifEnabled && !state.notifiedPlanes.has(icao24)) {
        if (dist <= CONFIG.alertRadius && plane.altitude <= CONFIG.alertAltitude) {
          state.notifiedPlanes.add(icao24);
          playBlip();
          if (Notification.permission === 'granted') {
            new Notification(`MySkyRadar: ${callsign}`, {
              body: `A ${Math.round(dist/1000*10)/10} km, ${plane.altitude}m. ${isApproaching ? 'A aproximar-se.' : 'A afastar-se.'}`,
              icon: 'icons/icon-192x192.png'
            });
          }
        }
      }
    });

    state.planes = newPlanes;
    state.lastUpdate = now;
    updateUI();
  } catch (err) {
    console.error(err);
    showStatus('Erro ao obter dados dos aviões. Tentar novamente em breve.', 'error');
  }
};

// Atualização da UI
const updateUI = () => {
  // Atualizar marcadores no mapa
  map.eachLayer(layer => {
    if (layer instanceof L.Marker && layer !== state.userMarker) {
      map.removeLayer(layer);
    }
  });

  if (state.trailLine) {
    map.removeLayer(state.trailLine);
    state.trailLine = null;
  }

  const sortedPlanes = Array.from(state.planes.values()).sort((a, b) => a.dist - b.dist);
  
  sortedPlanes.forEach(p => {
    const isSelected = state.selectedPlane === p.icao24;
    const icon = getPlaneIcon(p.heading, p.isMil ? 'military' : 'commercial', isSelected, p.isAlert);
    
    const marker = L.marker([p.lat, p.lon], { icon }).addTo(map);
    marker.on('click', () => selectPlane(p.icao24));

    if (isSelected) {
      // Linha de trajetória
      const rad = toRad(p.heading);
      const trailLat = p.lat + (Math.cos(rad) * 0.01); // aprox 1km à frente
      const trailLon = p.lon + (Math.sin(rad) * 0.01);
      state.trailLine = L.polyline([[p.lat, p.lon], [trailLat, trailLon]], {
        color: '#eab308', weight: 2, dashArray: '4, 4'
      }).addTo(map);
    }
  });

  // Atualizar lista
  document.getElementById('plane-count').textContent = sortedPlanes.length;
  const listEl = document.getElementById('plane-list');
  listEl.innerHTML = '';

  if (sortedPlanes.length === 0) {
    listEl.innerHTML = '<div style="text-align:center; color:var(--text-secondary); padding:20px;">Sem aviões no raio selecionado.</div>';
  }

  sortedPlanes.forEach(p => {
    const div = document.createElement('div');
    div.className = `plane-item ${state.selectedPlane === p.icao24 ? 'selected' : ''}`;
    div.innerHTML = `
      <div>
        <div class="pi-callsign">${p.callsign}</div>
        <div class="pi-company">${p.country} ${p.isMil ? '• MILITAR' : ''}</div>
      </div>
      <div class="pi-alt">${p.altitude} m</div>
      <div class="pi-dist">${(p.dist/1000).toFixed(1)} km</div>
    `;
    div.onclick = () => selectPlane(p.icao24);
    listEl.appendChild(div);
  });

  // Se houver um selecionado, atualizar o painel de detalhe
  if (state.selectedPlane) {
    const p = state.planes.get(state.selectedPlane);
    if (p) renderDetail(p);
    else closeDetail();
  }
};

const selectPlane = (icao24) => {
  state.selectedPlane = icao24;
  document.getElementById('list-view').classList.add('hidden');
  document.getElementById('detail-view').classList.remove('hidden');
  document.getElementById('bottom-sheet').classList.add('expanded');
  
  const p = state.planes.get(icao24);
  if (p) {
    map.flyTo([p.lat, p.lon], 13, { duration: 1 });
    renderDetail(p);
  }
};

const closeDetail = () => {
  state.selectedPlane = null;
  document.getElementById('detail-view').classList.add('hidden');
  document.getElementById('list-view').classList.remove('hidden');
  document.getElementById('bottom-sheet').classList.remove('expanded');
  updateUI(); // redesenha sem a linha de trajetória
};

const renderDetail = (p) => {
  document.getElementById('d-callsign').textContent = p.callsign || 'Desconhecido';
  document.getElementById('d-company').textContent = p.country;
  
  const milBadge = document.getElementById('d-military');
  if (p.isMil) milBadge.classList.remove('hidden');
  else milBadge.classList.add('hidden');

  document.getElementById('d-distance').textContent = `${(p.dist/1000).toFixed(2)} km`;
  
  const trendEl = document.getElementById('d-trend');
  trendEl.textContent = p.isApproaching ? 'A aproximar-se ↓' : 'A afastar-se ↑';
  trendEl.style.color = p.isApproaching ? 'var(--success)' : 'var(--text-secondary)';

  document.getElementById('d-altitude').textContent = `${p.altitude.toLocaleString()} m`;
  document.getElementById('d-speed').textContent = `${p.speed} km/h`;
  document.getElementById('d-heading').textContent = `${getCardinal(p.heading)} (${p.heading}°)`;
  document.getElementById('d-icao24').textContent = p.icao24.toUpperCase();
  
  const sqEl = document.getElementById('d-squawk');
  sqEl.textContent = p.squawk || 'N/D';
  sqEl.style.color = p.isAlert ? 'var(--military)' : 'var(--text-primary)';

  const age = Math.round((Date.now()/1000) - p.lastContact);
  document.getElementById('d-age').textContent = `há ${age}s`;

  document.getElementById('link-fr24').href = `https://www.flightradar24.com/data/aircraft/${p.icao24}`;
  document.getElementById('link-fa').href = `https://www.flightaware.com/live/flight/${p.icao24.toUpperCase()}`;
};

// Event Listeners
document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    state.range = parseInt(e.target.dataset.range);
    localStorage.setItem('msr_range', state.range);
    updateUserMarker();
    fetchData();
  });
});

document.getElementById('sound-toggle').checked = state.soundEnabled;
document.getElementById('sound-toggle').addEventListener('change', (e) => {
  state.soundEnabled = e.target.checked;
  localStorage.setItem('msr_sound', state.soundEnabled);
});

document.getElementById('notif-toggle').checked = state.notifEnabled;
document.getElementById('notif-toggle').addEventListener('change', async (e) => {
  state.notifEnabled = e.target.checked;
  localStorage.setItem('msr_notif', state.notifEnabled);
  if (state.notifEnabled && Notification.permission !== 'granted') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      showStatus('Permissão de notificações negada.', 'error');
      state.notifEnabled = false;
      e.target.checked = false;
    }
  }
});

document.getElementById('back-to-list').addEventListener('click', closeDetail);

document.getElementById('sheet-handle').addEventListener('click', () => {
  const sheet = document.getElementById('bottom-sheet');
  sheet.classList.toggle('expanded');
});

// Inicialização
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(console.error);
}

initGeo();
setInterval(fetchData, CONFIG.pollInterval);
