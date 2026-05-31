// ── MAP INIT ──────────────────────────────────────────────────
const map = L.map('map', { center: [22.5, 82.0], zoom: 5, zoomControl: true });

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
  maxZoom: 18
}).addTo(map);

// ── TIF PATH (relative to repo root) ─────────────────────────
const TIF_PATH = 'data/landscan-india-2024.tif';

// ── GEOTIFF STATE ─────────────────────────────────────────────
let tifImage   = null;   // GeoTIFF image object
let tifMeta    = {};     // { originX, originY, pixelW, pixelH, width, height }
let tifData    = null;   // Float32Array / Int32Array of pixel values
let tifNodata  = null;   // nodata value from metadata

// ── DRAWING STATE ─────────────────────────────────────────────
let mode = null;
let drawing = false;
let shapes = [];
let logCount = 0;
let bboxStart = null;
let bboxRect  = null;
let polyPoints  = [];
let polyLine    = null;
let polyMarkers = [];

// ── LOAD TIF ON STARTUP ───────────────────────────────────────
(async function loadTif() {
  setTifStatus('loading', 'Loading LandScan raster…');
  try {
    const resp = await fetch(TIF_PATH);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — is the file committed to your repo at ${TIF_PATH}?`);
    const arrayBuffer = await resp.arrayBuffer();

    const tif = await GeoTIFF.fromArrayBuffer(arrayBuffer);
    tifImage   = await tif.getImage();

    const bbox        = tifImage.getBoundingBox();  // [minX, minY, maxX, maxY] in CRS units
    const fileDir     = tifImage.getFileDirectory();
    tifNodata         = fileDir.GDAL_NODATA !== undefined ? parseFloat(fileDir.GDAL_NODATA) : null;

    tifMeta = {
      originX: bbox[0],
      originY: bbox[3],   // top-left lat
      pixelW:  (bbox[2] - bbox[0]) / tifImage.getWidth(),
      pixelH:  (bbox[3] - bbox[1]) / tifImage.getHeight(),
      width:   tifImage.getWidth(),
      height:  tifImage.getHeight()
    };

    // Read entire raster into memory (works fine for <100 MB)
    const rasters = await tifImage.readRasters({ interleave: false });
    tifData = rasters[0];   // band 1

    setTifStatus('ready', `✓ LandScan loaded · ${tifMeta.width}×${tifMeta.height} px`);
    console.log('[GeoSketch] TIF loaded', tifMeta);
  } catch (err) {
    setTifStatus('error', `✗ ${err.message}`);
    console.error('[GeoSketch] TIF load failed:', err);
  }
})();

function setTifStatus(state, text) {
  const bar  = document.getElementById('tif-status');
  const span = document.getElementById('tif-status-text');
  bar.className  = `tif-status ${state}`;
  span.textContent = text;
}

// ── CPCB MONITOR CALCULATION ──────────────────────────────────
function numMonitorsCpcb(pollutant, population) {
  let num = [];

  if (pollutant === 'spm') {
    num = [4];
    if (population < 100000) return num.reduce((a, b) => a + b, 0);
    if (population > 1000000)
      num.push(Math.floor(4 + 0.6 * 900000 / 100000) + 1);
    else
      num.push(Math.floor(4 + 0.6 * (population - 100000) / 100000) + 1);
    if (population > 5000000)
      num.push(Math.floor(7.5 + 0.25 * 4000000 / 100000) + 1);
    else
      num.push(Math.floor(7.5 + 0.25 * (population - 1000000) / 100000) + 1);
    if (population > 5000000)
      num.push(Math.floor(12 + 0.16 * (population - 5000000) / 100000) + 1);
  }

  if (pollutant === 'so2') {
    num = [3];
    if (population < 100000) return num.reduce((a, b) => a + b, 0);
    if (population > 1000000)
      num.push(Math.floor(2.5 + 0.5 * 900000 / 100000) + 1);
    else
      num.push(Math.floor(2.5 + 0.5 * (population - 100000) / 100000) + 1);
    if (population > 10000000)
      num.push(Math.floor(6 + 0.15 * 9000000 / 100000) + 1);
    else
      num.push(Math.floor(6 + 0.15 * (population - 1000000) / 100000) + 1);
    if (population > 10000000)
      num.push(20);
  }

  if (pollutant === 'no2') {
    num = [4];
    if (population < 100000) return num.reduce((a, b) => a + b, 0);
    if (population > 1000000)
      num.push(Math.floor(4 + 0.6 * 900000 / 100000) + 1);
    else
      num.push(Math.floor(4 + 0.6 * (population - 100000) / 100000) + 1);
    if (population > 1000000)
      num.push(10);
  }

  if (pollutant === 'co') {
    num = [1];
    if (population < 100000) return num.reduce((a, b) => a + b, 0);
    if (population > 5000000)
      num.push(Math.floor(1 + 0.15 * 4900000 / 100000) + 1);
    else
      num.push(Math.floor(1 + 0.15 * (population - 100000) / 100000) + 1);
    if (population > 5000000)
      num.push(Math.floor(6 + 0.05 * (population - 5000000) / 100000) + 1);
  }

  return num.reduce((a, b) => a + b, 0);
}

// ── POPULATION FROM BBOX ──────────────────────────────────────
function computePopulation(south, west, north, east) {
  if (!tifData) return null;

  const { originX, originY, pixelW, pixelH, width, height } = tifMeta;

  // Convert geo bbox → pixel indices (clamped to raster bounds)
  const colMin = Math.max(0,         Math.floor((west  - originX) / pixelW));
  const colMax = Math.min(width - 1, Math.ceil( (east  - originX) / pixelW));
  const rowMin = Math.max(0,         Math.floor((originY - north) / pixelH));
  const rowMax = Math.min(height - 1,Math.ceil( (originY - south) / pixelH));

  if (colMin > colMax || rowMin > rowMax) return 0;

  let total = 0;
  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) {
      const val = tifData[row * width + col];
      if (val === tifNodata) continue;
      if (val < 0) continue;
      total += val;
    }
  }
  return Math.round(total);
}

// ── MODE SELECTOR ─────────────────────────────────────────────
function setMode(m) {
  cancelDrawing();
  mode = m;
  document.getElementById('btn-bbox').classList.toggle('active', m === 'bbox');
  document.getElementById('btn-poly').classList.toggle('active', m === 'polygon');
  const ind = document.getElementById('mode-indicator');
  ind.classList.add('active');
  ind.innerHTML = m === 'bbox'
    ? '⬜ Bounding Box Mode<div class="hint">Click &amp; drag to draw a rectangle</div>'
    : '⬡ Polygon Mode<div class="hint">Click to add vertices · Double-click to finish</div>';
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
    color: '#00e5a0', weight: 2, fillColor: '#00e5a0', fillOpacity: 0.12, dashArray: '6 4'
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
  bboxRect.setStyle({ dashArray: null });

  const bounds = bboxRect.getBounds();
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();

  shapes.push(bboxRect);
  bboxRect = null;

  const coordsData = {
    type: 'BoundingBox',
    southWest: { lat: +sw.lat.toFixed(6), lng: +sw.lng.toFixed(6) },
    northEast: { lat: +ne.lat.toFixed(6), lng: +ne.lng.toFixed(6) }
  };

  logCoords(coordsData);

  // Compute population & monitors synchronously (data already in memory)
  const population = computePopulation(sw.lat, sw.lng, ne.lat, ne.lng);
  if (population !== null) {
    logPopulation(population, logCount);
  } else {
    logError('TIF not loaded yet — draw again after the raster finishes loading.', logCount);
  }
});

// ── POLYGON ───────────────────────────────────────────────────
map.on('click', function(e) {
  if (mode !== 'polygon') return;
  polyPoints.push(e.latlng);
  const dot = L.circleMarker(e.latlng, {
    radius: 5, color: '#ff6b35', fillColor: '#ff6b35', fillOpacity: 1, weight: 2
  }).addTo(map);
  polyMarkers.push(dot);
  if (polyLine) map.removeLayer(polyLine);
  if (polyPoints.length > 1)
    polyLine = L.polyline(polyPoints, { color: '#ff6b35', weight: 2, dashArray: '6 4' }).addTo(map);
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

  const coordsData = {
    type: 'Polygon',
    vertices: finalPoints.map((p, i) => ({ index: i, lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) })),
    count: finalPoints.length
  };
  logCoords(coordsData);
  // Note: polygon population would need point-in-polygon masking; bbox is fully supported
  logError('Population for polygons coming soon — use Bounding Box mode for now.', logCount);
});

// ── CLEAR ─────────────────────────────────────────────────────
function clearAll() {
  cancelDrawing();
  shapes.forEach(l => map.removeLayer(l));
  shapes = [];
  logCount = 0;
  updateBadge();

  const out = document.getElementById('console-output');
  out.innerHTML = '';
  const entry = document.createElement('div');
  entry.className = 'log-entry clear';
  entry.innerHTML = `
    <div class="log-ts">${timestamp()}</div>
    <div class="log-type">✕ ALL CLEARED</div>
    <div class="log-coords">Canvas reset. Ready for new shapes.</div>`;
  out.appendChild(entry);

  mode = null;
  ['btn-bbox','btn-poly'].forEach(id => document.getElementById(id).classList.remove('active'));
  const ind = document.getElementById('mode-indicator');
  ind.classList.remove('active');
  ind.innerHTML = 'No mode selected<div class="hint">Pick a tool above to start drawing</div>';
  document.body.classList.remove('drawing');
}

// ── LOGGING HELPERS ───────────────────────────────────────────
function timestamp() {
  const n = new Date();
  return n.toLocaleTimeString('en-IN', { hour12: false }) + '.' + String(n.getMilliseconds()).padStart(3,'0');
}

function updateBadge() {
  document.getElementById('log-count').textContent = logCount === 1 ? '1 shape' : `${logCount} shapes`;
}

function logCoords(coords) {
  logCount++;
  updateBadge();

  const out = document.getElementById('console-output');
  out.querySelector('.empty-state')?.remove();

  const label = coords.type === 'BoundingBox' ? `⬜ BBOX #${logCount}` : `⬡ POLYGON #${logCount}`;
  let display = coords.type === 'BoundingBox'
    ? `SW: [${coords.southWest.lat}, ${coords.southWest.lng}]\nNE: [${coords.northEast.lat}, ${coords.northEast.lng}]`
    : coords.vertices.map(v => `[${v.lat}, ${v.lng}]`).join('\n');

  const entry = document.createElement('div');
  entry.className = 'log-entry info';
  entry.innerHTML = `
    <div class="log-ts">${timestamp()}</div>
    <div class="log-type">${label}</div>
    <div class="log-coords">${display}</div>`;
  out.appendChild(entry);
  out.scrollTop = out.scrollHeight;
}

function logPopulation(population, index) {
  const out = document.getElementById('console-output');
  const millions = (population / 1_000_000).toFixed(4);
  const formatted = population.toLocaleString('en-IN');

  const pollutants = ['spm','so2','no2','co'];
  const labels     = { spm:'SPM', so2:'SO₂', no2:'NO₂', co:'CO' };

  const monitorsHTML = pollutants.map(p => {
    const n = numMonitorsCpcb(p, population);
    return `
      <div class="monitor-card">
        <span class="monitor-pollutant">${labels[p]}</span>
        <span class="monitor-val">${n}</span>
        <span class="monitor-unit">stations</span>
      </div>`;
  }).join('');

  const entry = document.createElement('div');
  entry.className = 'log-entry population';
  entry.innerHTML = `
    <div class="log-ts">${timestamp()}</div>
    <div class="log-type pop-label">👥 POPULATION · BBOX #${index}</div>
    <div class="log-coords">
      <span class="pop-big">${millions}M</span>
      <span class="pop-raw">${formatted} people</span>
      <span class="monitors-label">Min. monitors required · CPCB guidelines</span>
      <div class="monitors-grid">${monitorsHTML}</div>
    </div>`;
  out.appendChild(entry);
  out.scrollTop = out.scrollHeight;

  console.log(`[GeoSketch] BBOX #${index} — Population: ${formatted}`);
  pollutants.forEach(p => console.log(`  ${labels[p]}: ${numMonitorsCpcb(p, population)} stations`));
}

function logError(msg, index) {
  const out = document.getElementById('console-output');
  const entry = document.createElement('div');
  entry.className = 'log-entry pop-error';
  entry.innerHTML = `
    <div class="log-ts">${timestamp()}</div>
    <div class="log-type pop-label">⚠ NOTE · BBOX #${index}</div>
    <div class="log-coords">${msg}</div>`;
  out.appendChild(entry);
  out.scrollTop = out.scrollHeight;
}