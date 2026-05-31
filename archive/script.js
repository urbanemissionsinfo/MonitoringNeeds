// ── MAP INIT ──────────────────────────────────────────────────
const map = L.map('map', {
  center: [28.6448, 77.2167],
  zoom: 7,
  zoomControl: true
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
  maxZoom: 18
}).addTo(map);

// ── CONFIG ────────────────────────────────────────────────────
const POPULATION_API = 'http://localhost:5000/population';

// ── STATE ─────────────────────────────────────────────────────
let mode = null;           // 'bbox' | 'polygon'
let drawing = false;
let shapes = [];           // all drawn layers
let logCount = 0;

// bbox
let bboxStart = null;
let bboxRect = null;

// polygon
let polyPoints = [];
let polyLine = null;       // temp polyline preview
let polyMarkers = [];      // small vertex markers

// ── MODE SELECTOR ─────────────────────────────────────────────
function setMode(m) {
  cancelDrawing();
  mode = m;
  document.getElementById('btn-bbox').classList.toggle('active', m === 'bbox');
  document.getElementById('btn-poly').classList.toggle('active', m === 'polygon');
  const ind = document.getElementById('mode-indicator');
  ind.classList.add('active');
  if (m === 'bbox') {
    ind.innerHTML = '⬜ Bounding Box Mode<div class="hint">Click & drag to draw a rectangle</div>';
  } else {
    ind.innerHTML = '⬡ Polygon Mode<div class="hint">Click to add vertices · Double-click to finish</div>';
  }
  document.body.classList.add('drawing');
}

function cancelDrawing() {
  drawing = false;
  bboxStart = null;
  if (bboxRect && !shapes.includes(bboxRect)) { map.removeLayer(bboxRect); bboxRect = null; }
  polyPoints = [];
  polyMarkers.forEach(m => map.removeLayer(m));
  polyMarkers = [];
  if (polyLine) { map.removeLayer(polyLine); polyLine = null; }
  document.body.classList.remove('drawing');
}

// ── BOUNDING BOX ──────────────────────────────────────────────
map.on('mousedown', function(e) {
  if (mode !== 'bbox') return;
  drawing = true;
  bboxStart = e.latlng;
  bboxRect = L.rectangle([bboxStart, bboxStart], {
    color: '#00e5a0', weight: 2, fillColor: '#00e5a0', fillOpacity: 0.12,
    dashArray: '6 4'
  }).addTo(map);
  map.dragging.disable();
});

map.on('mousemove', function(e) {
  if (mode !== 'bbox' || !drawing || !bboxRect) return;
  bboxRect.setBounds([bboxStart, e.latlng]);
});

map.on('mouseup', function(e) {
  if (mode !== 'bbox' || !drawing) return;
  drawing = false;
  map.dragging.enable();
  bboxRect.setStyle({ dashArray: null, weight: 2 });

  const bounds = bboxRect.getBounds();
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();

  const coords = {
    type: 'BoundingBox',
    southWest: { lat: +sw.lat.toFixed(6), lng: +sw.lng.toFixed(6) },
    northEast: { lat: +ne.lat.toFixed(6), lng: +ne.lng.toFixed(6) },
    corners: [
      { lat: +sw.lat.toFixed(6), lng: +sw.lng.toFixed(6) },
      { lat: +ne.lat.toFixed(6), lng: +sw.lng.toFixed(6) },
      { lat: +ne.lat.toFixed(6), lng: +ne.lng.toFixed(6) },
      { lat: +sw.lat.toFixed(6), lng: +ne.lng.toFixed(6) }
    ]
  };

  shapes.push(bboxRect);
  bboxRect = null;
  logCoords(coords);
  console.log('[GeoSketch] Bounding Box:', coords);

  // ── POPULATION FETCH ────────────────────────────────────────
  fetchPopulation(sw, ne, logCount);
});

// ── POPULATION API CALL ───────────────────────────────────────
async function fetchPopulation(sw, ne, shapeIndex) {
  // Show a loading entry in the panel
  const loadingId = `pop-loading-${shapeIndex}`;
  appendPopulationEntry(shapeIndex, null, loadingId);

  try {
    const response = await fetch(POPULATION_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        south: sw.lat,
        west:  sw.lng,
        north: ne.lat,
        east:  ne.lng
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    updatePopulationEntry(loadingId, data, shapeIndex);
    console.log(`[GeoSketch] Population for BBOX #${shapeIndex}:`, data);

  } catch (err) {
    updatePopulationEntryError(loadingId, err.message, shapeIndex);
    console.error(`[GeoSketch] Population fetch failed for BBOX #${shapeIndex}:`, err.message);
  }
}

// Appends a loading population entry to the console
function appendPopulationEntry(index, data, id) {
  const out = document.getElementById('console-output');
  const entry = document.createElement('div');
  entry.className = 'log-entry population';
  entry.id = id;
  entry.innerHTML = `
    <div class="log-ts">${timestamp()}</div>
    <div class="log-type pop-label">👥 POPULATION #${index}</div>
    <div class="log-coords pop-value">
      <span class="pop-spinner">⏳ Querying LandScan raster…</span>
    </div>
  `;
  out.appendChild(entry);
  out.scrollTop = out.scrollHeight;
}

// Updates the loading entry with real data
function updatePopulationEntry(id, data, index) {
  const entry = document.getElementById(id);
  if (!entry) return;
  const millions = data.population_millions;
  const total    = data.population.toLocaleString('en-IN');
  const m        = data.monitors_required;

  const pollutantLabels = { spm: 'SPM', so2: 'SO₂', no2: 'NO₂', co: 'CO' };

  const monitorsHTML = Object.entries(m).map(([key, val]) =>
    `<span class="monitor-row"><span class="monitor-pollutant">${pollutantLabels[key]}</span><span class="monitor-val">${val}</span></span>`
  ).join('');

  entry.querySelector('.pop-value').innerHTML = `
    <span class="pop-big">${millions}M</span>
    <span class="pop-raw">(${total} people)</span>
    <span class="monitors-label">Min. monitors required (CPCB)</span>
    <span class="monitors-grid">${monitorsHTML}</span>
  `;
}

// Updates the loading entry with an error
function updatePopulationEntryError(id, msg, index) {
  const entry = document.getElementById(id);
  if (!entry) return;
  entry.classList.add('pop-error');
  entry.querySelector('.pop-value').innerHTML = `⚠ ${msg}`;
}

// ── POLYGON ───────────────────────────────────────────────────
map.on('click', function(e) {
  if (mode !== 'polygon') return;

  polyPoints.push(e.latlng);

  const dot = L.circleMarker(e.latlng, {
    radius: 5, color: '#ff6b35', fillColor: '#ff6b35', fillOpacity: 1, weight: 2
  }).addTo(map);
  polyMarkers.push(dot);

  if (polyLine) map.removeLayer(polyLine);
  if (polyPoints.length > 1) {
    polyLine = L.polyline(polyPoints, {
      color: '#ff6b35', weight: 2, dashArray: '6 4'
    }).addTo(map);
  }
});

map.on('dblclick', function(e) {
  if (mode !== 'polygon' || polyPoints.length < 2) return;

  polyPoints.pop();
  polyMarkers[polyMarkers.length - 1] && map.removeLayer(polyMarkers.pop());
  if (polyLine) { map.removeLayer(polyLine); polyLine = null; }
  polyMarkers.forEach(m => map.removeLayer(m));
  polyMarkers = [];

  const finalPoints = [...polyPoints];
  polyPoints = [];

  const poly = L.polygon(finalPoints, {
    color: '#ff6b35', weight: 2, fillColor: '#ff6b35', fillOpacity: 0.12
  }).addTo(map);
  shapes.push(poly);

  const coords = {
    type: 'Polygon',
    vertices: finalPoints.map((p, i) => ({
      index: i,
      lat: +p.lat.toFixed(6),
      lng: +p.lng.toFixed(6)
    })),
    count: finalPoints.length
  };

  logCoords(coords);
  console.log('[GeoSketch] Polygon:', coords);
});

map.on('dblclick', function() {
  if (mode === 'polygon') return false;
});

// ── CLEAR ─────────────────────────────────────────────────────
function clearAll() {
  cancelDrawing();
  shapes.forEach(l => map.removeLayer(l));
  shapes = [];
  logCount = 0;
  updateBadge();

  const out = document.getElementById('console-output');
  const entry = document.createElement('div');
  entry.className = 'log-entry clear';
  entry.innerHTML = `
    <div class="log-ts">${timestamp()}</div>
    <div class="log-type">✕ ALL CLEARED</div>
    <div class="log-coords">Canvas reset. Ready for new shapes.</div>
  `;
  out.innerHTML = '';
  out.appendChild(entry);

  mode = null;
  document.getElementById('btn-bbox').classList.remove('active');
  document.getElementById('btn-poly').classList.remove('active');
  const ind = document.getElementById('mode-indicator');
  ind.classList.remove('active');
  ind.innerHTML = 'No mode selected<div class="hint">Pick a tool above to start drawing</div>';
  document.body.classList.remove('drawing');

  console.clear();
  console.log('[GeoSketch] Canvas cleared');
}

// ── LOGGING ───────────────────────────────────────────────────
function timestamp() {
  const n = new Date();
  return n.toLocaleTimeString('en-IN', { hour12: false }) + '.' + String(n.getMilliseconds()).padStart(3, '0');
}

function updateBadge() {
  const badge = document.getElementById('log-count');
  badge.textContent = logCount === 1 ? '1 shape' : `${logCount} shapes`;
}

function logCoords(coords) {
  logCount++;
  updateBadge();

  const out = document.getElementById('console-output');
  const empty = out.querySelector('.empty-state');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'log-entry info';

  const label = coords.type === 'BoundingBox'
    ? `⬜ BBOX #${logCount}`
    : `⬡ POLYGON #${logCount}`;

  let display = '';
  if (coords.type === 'BoundingBox') {
    display = `SW: [${coords.southWest.lat}, ${coords.southWest.lng}]\nNE: [${coords.northEast.lat}, ${coords.northEast.lng}]`;
  } else {
    display = coords.vertices.map(v => `[${v.lat}, ${v.lng}]`).join('\n');
  }

  entry.innerHTML = `
    <div class="log-ts">${timestamp()}</div>
    <div class="log-type">${label}</div>
    <div class="log-coords">${display}</div>
  `;
  out.appendChild(entry);
  out.scrollTop = out.scrollHeight;
}