document.addEventListener('DOMContentLoaded', () => {
  const CONFIG = {
    defaultLat: 38.736946,
    defaultLon: -9.142685,
    pollInterval: 20000, // 20 segundos (menos agressivo)
    alertRadius: 3000,
    alertAltitude: 1500,
    // MÚLTIPLOS PROXIES CORS em fallback
    proxies: [
      'https://corsproxy.io/?',
      'https://api.allorigins.win/raw?url=',
      'https://api.codetabs.com/v1/proxy?quest='
    ],
    currentProxyIndex: 0,
    retryDelay: 5000, // 5 segundos entre retries
    maxRetries: 3
  };

  const state = {
    lat: CONFIG.defaultLat,
    lon: CONFIG.defaultLon,
    range: parseInt(localStorage.getItem('msr_range')) || 7,
    soundEnabled: localStorage.getItem('msr_sound') === 'true',
    notifEnabled: localStorage.getItem('msr_notif') === 'true',
    planes: new Map(),
    selectedPlane: null,
    userMarker: null,
    rangeCircle: null,
    trailLine: null,
    notifiedPlanes: new Set(),
    consecutiveFailures: 0
  };

  const map = L.map('map', { zoomControl: false }).setView([state.lat, state.lon], 11);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19
  }).addTo(map);

  setTimeout(() => {
    const tilePane = document.querySelector('.leaflet-tile-pane');
    if (tilePane) tilePane.style.filter = 'invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%)';
  }, 200);

  const getPlaneIcon = (heading, type, isSelected) => {
    let className = 'plane-icon';
    if (isSelected) className += ' selected';
    else if (type === 'military') className += ' military';
    else className += ' commercial';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" class="${className}" style="transform: rotate(${heading}deg); transition: transform 1s linear;"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>`;
    return L.divIcon({ html: svg, className: '', iconSize: [28, 28], iconAnchor: [14, 14] });
  };

  const toRad = (deg) => deg * (Math.PI / 180);
  const getDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3;
    const φ1 = toRad(lat1), φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1), Δλ = toRad(lon2 - lon1);
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  };
  const getCardinal = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(deg / 45) % 8];

  const playBlip = () => {
    if (!state.soundEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 1200; osc.type = 'sine';
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(); osc.stop(ctx.currentTime + 0.15);
    } catch (e) {}
  };

  const showStatus = (msg, type = 'info') => {
    const banner = document.getElementById('status-banner');
    banner.textContent = msg;
    banner.className = `status-banner visible ${type}`;
    setTimeout(() => banner.classList.remove('visible'), 5000);
  };
  const hideStatus = () => document.getElementById('status-banner').classList.remove('visible');

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
          showStatus('GPS negado. A usar Lisboa.', 'error');
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
    state.userMarker = L.circleMarker([state.lat, state.lon], { radius: 8, color: '#3b82f6', fillColor: '#ffffff', fillOpacity: 1, weight: 3 }).addTo(map).bindPopup('Tu estás aqui');
    state.rangeCircle = L.circle([state.lat, state.lon], { radius: state.range * 1000, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.05, weight: 1, dashArray: '5, 5' }).addTo(map);
  };

  const zoomToRange = () => {
    const latDelta = state.range / 111;
    const lonDelta = state.range / (111 * Math.cos(toRad(state.lat)));
    const bounds = L.latLngBounds([state.lat - latDelta, state.lon - lonDelta], [state.lat + latDelta, state.lon + lonDelta]);
    map.flyToBounds(bounds, { padding: [50, 50], duration: 1, maxZoom: 15 });
  };

  const fetchData = async () => {
    const degRange = (state.range / 111) + 0.1;
    const targetUrl = `https://opensky-network.org/api/states/all?lamin=${state.lat - degRange}&lomin=${state.lon - degRange}&lamax=${state.lat + degRange}&lomax=${state.lon + degRange}`;

    // Tentar cada proxy em ordem
    for (let i = 0; i < CONFIG.proxies.length; i++) {
      const proxyIndex = (CONFIG.currentProxyIndex + i) % CONFIG.proxies.length;
      const proxy = CONFIG.proxies[proxyIndex];
      const finalUrl = proxy + encodeURIComponent(targetUrl);

      console.log(`[MySkyRadar] Tentando proxy ${proxyIndex + 1}/${CONFIG.proxies.length}`);

      try {
        const res = await fetch(finalUrl, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const data = await res.json();
        if (!data.states || data.states.length === 0) {
          updateUI([]);
          hideStatus();
          state.consecutiveFailures = 0;
          CONFIG.currentProxyIndex = proxyIndex; // Guardar qual proxy funcionou
          return;
        }

        const now = Date.now() / 1000;
        const newPlanes = new Map();

        data.states.forEach(s => {
          const icao24 = s[0];
          const callsign = s[1] ? s[1].trim() : 'N/D';
          const country = s[2] || 'Desconhecido';
          const lon = s[5];
          const lat = s[6];
          const baroAlt = s[7];
          const velocity = s[9];
          const heading = s[10];
          const squawk = s[14];
          const onGround = s[8];
          const lastContact = s[4];

          if (onGround || lat === null || lon === null) return;

          const dist = getDistance(state.lat, state.lon, lat, lon);
          if (dist > state.range * 1000) return;

          const prev = state.planes.get(icao24);
          const isApproaching = prev ? dist < prev.dist : false;
          const isMil = ['POR', 'FAB', 'ARMY', 'NAVY', 'MIL', 'RESCUE'].some(k => callsign.includes(k));

          const plane = {
            icao24, callsign, country, lat, lon,
            altitude: baroAlt !== null ? Math.round(baroAlt) : 0,
            speed: velocity !== null ? Math.round(velocity * 3.6) : 0,
            heading: heading !== null ? Math.round(heading) : 0,
            squawk: squawk || 'N/D',
            dist, isApproaching, isMil,
            isAlert: squawk === '7700' || squawk === '7500' || squawk === '7600',
            lastContact
          };

          newPlanes.set(icao24, plane);

          if (state.notifEnabled && !state.notifiedPlanes.has(icao24)) {
            if (dist <= CONFIG.alertRadius && plane.altitude <= CONFIG.alertAltitude) {
              state.notifiedPlanes.add(icao24);
              playBlip();
              if (Notification.permission === 'granted') {
                new Notification(`MySkyRadar: ${callsign}`, {
                  body: `A ${(dist/1000).toFixed(1)} km, ${plane.altitude}m.`,
                  icon: 'icons/icon-192x192.png'
                });
              }
            }
          }
        });

        state.planes = newPlanes;
        updateUI();
        hideStatus();
        state.consecutiveFailures = 0;
        CONFIG.currentProxyIndex = proxyIndex;
        console.log(`[MySkyRadar] Sucesso com proxy ${proxyIndex + 1}`);
        return; // Sucesso, sair do loop
        
      } catch (err) {
        console.warn(`[MySkyRadar] Proxy ${proxyIndex + 1} falhou:`, err.message);
        continue; // Tentar próximo proxy
      }
    }

    // Todos os proxies falharam
    state.consecutiveFailures++;
    console.error(`[MySkyRadar] Todos os proxies falharam (tentativa ${state.consecutiveFailures})`);
    
    if (state.consecutiveFailures >= 3) {
      showStatus('Problema de ligação. A tentar novamente...', 'error');
    } else {
      showStatus('Ligação lenta. A tentar novamente...', 'info');
    }
  };

  const updateUI = (planesOverride = null) => {
    const planesToRender = planesOverride !== null ? planesOverride : Array.from(state.planes.values());
    map.eachLayer(layer => { if (layer instanceof L.Marker && layer !== state.userMarker) map.removeLayer(layer); });
    if (state.trailLine) { map.removeLayer(state.trailLine); state.trailLine = null; }
    
    const sortedPlanes = [...planesToRender].sort((a, b) => a.dist - b.dist);
    sortedPlanes.forEach(p => {
      const isSelected = state.selectedPlane === p.icao24;
      const icon = getPlaneIcon(p.heading, p.isMil ? 'military' : 'commercial', isSelected);
      const marker = L.marker([p.lat, p.lon], { icon }).addTo(map);
      marker.on('click', () => selectPlane(p.icao24));
      if (isSelected) {
        const rad = toRad(p.heading);
        state.trailLine = L.polyline([[p.lat, p.lon], [p.lat + Math.cos(rad)*0.015, p.lon + Math.sin(rad)*0.015]], { color: '#eab308', weight: 3, dashArray: '4, 4' }).addTo(map);
      }
    });

    document.getElementById('plane-count').textContent = sortedPlanes.length;
    const listEl = document.getElementById('plane-list');
    listEl.innerHTML = sortedPlanes.length === 0 ? '<div style="text-align:center; color:var(--text-secondary); padding:20px;">Sem aviões no raio.</div>' : '';
    
    sortedPlanes.forEach(p => {
      const div = document.createElement('div');
      div.className = `plane-item ${state.selectedPlane === p.icao24 ? 'selected' : ''}`;
      div.innerHTML = `<div><div class="pi-callsign">${p.callsign}</div><div class="pi-company">${p.country} ${p.isMil ? '• MILITAR' : ''}</div></div><div class="pi-alt">${p.altitude} m</div><div class="pi-dist">${(p.dist/1000).toFixed(1)} km</div>`;
      div.onclick = () => selectPlane(p.icao24);
      listEl.appendChild(div);
    });

    if (state.selectedPlane) { 
      const p = state.planes.get(state.selectedPlane); 
      if (p) renderDetail(p); else closeDetail(); 
    }
  };

  const selectPlane = (icao24) => {
    state.selectedPlane = icao24;
    document.getElementById('list-view').classList.add('hidden');
    document.getElementById('detail-view').classList.remove('hidden');
    document.getElementById('bottom-sheet').classList.add('expanded');
    const p = state.planes.get(icao24);
    if (p) { map.flyTo([p.lat, p.lon], 13, { duration: 1 }); renderDetail(p); }
  };

  const closeDetail = () => {
    state.selectedPlane = null;
    document.getElementById('detail-view').classList.add('hidden');
    document.getElementById('list-view').classList.remove('hidden');
    document.getElementById('bottom-sheet').classList.remove('expanded');
    updateUI();
  };

  const renderDetail = (p) => {
    document.getElementById('d-callsign').textContent = p.callsign || 'Desconhecido';
    document.getElementById('d-company').textContent = p.country;
    const milBadge = document.getElementById('d-military');
    if (p.isMil) milBadge.classList.remove('hidden'); else milBadge.classList.add('hidden');
    
    document.getElementById('d-distance').textContent = `${(p.dist/1000).toFixed(2)} km`;
    const trendEl = document.getElementById('d-trend');
    trendEl.textContent = p.isApproaching ? 'A aproximar-se ↘' : 'A afastar-se ↗';
    trendEl.style.color = p.isApproaching ? 'var(--success)' : 'var(--text-secondary)';
    
    document.getElementById('d-altitude').textContent = `${p.altitude.toLocaleString()} m`;
    document.getElementById('d-speed').textContent = `${p.speed} km/h`;
    document.getElementById('d-heading').textContent = `${getCardinal(p.heading)} (${p.heading}°)`;
    document.getElementById('d-icao24').textContent = p.icao24.toUpperCase();
    
    const sqEl = document.getElementById('d-squawk');
    sqEl.textContent = p.squawk;
    sqEl.style.color = p.isAlert ? 'var(--military)' : 'var(--text-primary)';
    
    const age = Math.round((Date.now() / 1000) - p.lastContact);
    document.getElementById('d-age').textContent = `há ${age}s`;
    
    document.getElementById('link-fr24').href = `https://www.flightradar24.com/data/aircraft/${p.icao24}`;
    document.getElementById('link-fa').href = `https://www.flightaware.com/live/flight/${p.icao24.toUpperCase()}`;
  };

  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      state.range = parseInt(e.target.dataset.range);
      localStorage.setItem('msr_range', state.range);
      updateUserMarker();
      zoomToRange();
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
    document.getElementById('bottom-sheet').classList.toggle('expanded');
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }

  initGeo();
  fetchData();
  setInterval(fetchData, CONFIG.pollInterval);
});
