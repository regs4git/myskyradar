// Configuração
const CONFIG = {
  defaultLat: 38.736946, // Lisboa
  defaultLon: -9.142685,
  apiBase: 'https://api.adsb.lol/v2', // Nova API: gratuita, sem chave, mais estável
  pollInterval: 10000, // 10 segundos (ADSB.lol é mais tolerante)
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
  planes: new Map(),
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

// NOVO: Mapa Esri Dark Gray (Gratuito, sem API Key, estilo moderno escuro)
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles © Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China, TomTom',
  maxZoom: 16
}).addTo(map);

// Ícone SVG do avião
const getPlaneIcon = (heading, type, isSelected) => {
  let className = 'plane-icon';
  if (isSelected) className += ' selected';
  else if (type === 'military') className += ' military';
  else className += ' commercial';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" class="${className}" style="transform: rotate(${heading}deg); transition: transform 1s linear;">
    <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
  </svg>`;
  
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14]
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

const getCardinal = (deg) => {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  return dirs[Math.round(deg / 45) % 8];
};

const playBlip = () => {
  if (!state.soundEnabled) return;
  try {
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
  } catch (e) { /* Ignorar erros de áudio em background */ }
};

const showStatus = (msg, type = 'info') => {
  const banner = document.getElementById('status-banner');
  banner.textContent = msg;
  banner.className = `status-banner visible ${type}`;
  setTimeout(() => banner.classList.remove('visible'), 4000);
};

const hideStatus = () => {
  document.getElementById('status-banner').classList.remove('visible');
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
        hideStatus();
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
    radius: 8, color: '#3b82f6', fillColor: '#ffffff', fillOpacity: 1, weight: 3
  }).addTo(map).bindPopup('Tu estás aqui');

  state.rangeCircle = L.circle([state.lat, state.lon], {
    radius: state.range * 1000, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.05, weight: 1, dashArray: '5, 5'
  }).addTo(map);
};

// Dados da API (AGORA COM ADSB.LOL)
const fetchData = async () => {
  try {
    // ADSB.lol permite pedir diretamente por raio (dist) e altitude máxima (alt em pés)
    // 10000 pés ≈ 3000 metros (suficiente para mostrar aviões na UI, filtramos os alertas depois)
    const url = `${CONFIG.apiBase}/lat/${state.lat}/lon/${state.lon}/dist/${state.range}/alt/10000`;
    
    const res = await fetch(url);
    if (!res.ok) throw new Error('Falha na API');
    const data = await res.json();
    
    if (!data.ac || data.ac.length === 0) {
      updateUI([]);
      return;
    }

    const now = Date.now() / 1000;
    const newPlanes = new Map();

    data.ac.forEach(ac => {
      if (!ac.lat || !ac.lon || ac.alt_baro === undefined) return;

      const dist = getDistance(state.lat, state.lon, ac.lat, ac.lon);
      if (dist > state.range * 1000) return;

      const icao24 = ac.hex;
      const callsign = ac.flight ? ac.flight.trim() : 'N/D';
      // Converter pés para metros e nós para km/h
      const altitudeM = Math.round(ac.alt_baro * 0.3048); 
      const speedKmh = ac.gs ? Math.round(ac.gs * 1.852) : 0;
      const heading = ac.track ? Math.round(ac.track) : 0;
      const seen = ac.seen || 0; // segundos desde a última receção

      // Detetar militar (pela flag da API ou prefixos comuns)
      const isMil = ac.military === true || (callsign && ['POR', 'FAB', 'ARMY', 'NAVY', 'MIL', 'RESCUE'].some(k => callsign.includes(k)));

      const prev = state.planes.get(icao24);
      const isApproaching = prev ? dist < prev.dist : false;

      const plane = {
        icao24, callsign, country: ac.r || 'Desconhecido',
        lat: ac.lat, lon: ac.lon,
        altitude: altitudeM,
        speed: speedKmh,
        heading,
        squawk: ac.squawk || 'N/D',
        dist, isApproaching, isMil, isAlert: ac.squawk === '7700' || ac.squawk === '7500' || ac.squawk === '7600',
        lastContact: now - seen
      };

      newPlanes.set(icao24, plane);

      // Notificações
      if (state.notifEnabled && !state.notifiedPlanes.has(icao24)) {
        if (dist <= CONFIG.alertRadius && plane.altitude <= CONFIG.alertAltitude) {
          state.notifiedPlanes.add(icao24);
          playBlip();
          if (Notification.permission === 'granted') {
            new Notification(`MySkyRadar: ${callsign}`, {
              body: `A ${(dist/1000).toFixed(1)} km, ${altitudeM}m. ${isApproaching ? 'A aproximar-se.' : 'A afastar-se.'}`,
              icon: 'icons/icon-192x192.png'
            });
          }
        }
      }
    });

    state.planes = newPlanes;
    state
