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

// ── DOM ELEMENTS FOR MOBILE BUTTON ────────────────────────────
const finishPolyBtn = document.getElementById('btn-finish-poly');

if (finishPolyBtn) {
  finishPolyBtn.addEventListener('click', function(e) {
    L.DomEvent.stopPropagation(e); // Stop Leaflet from registering a map click behind button
    finishPolygon();
  });
}

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


// ── POPULATION FROM POLYGON (point-in-polygon raster mask) ───
function pointInPolygon(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// Computes population for an array of coordinate rings [[lng, lat], ...]
function computePopulationFromRing(ring) {
  if (!tifData) return null;
  const { originX, originY, pixelW, pixelH, width, height } = tifMeta;
  const lngs = ring.map(c => c[0]);
  const lats  = ring.map(c => c[1]);
  const west  = Math.min(...lngs), east  = Math.max(...lngs);
  const south = Math.min(...lats), north = Math.max(...lats);
  const colMin = Math.max(0,          Math.floor((west  - originX) / pixelW));
  const colMax = Math.min(width - 1,  Math.ceil( (east  - originX) / pixelW));
  const rowMin = Math.max(0,          Math.floor((originY - north) / pixelH));
  const rowMax = Math.min(height - 1, Math.ceil( (originY - south) / pixelH));
  if (colMin > colMax || rowMin > rowMax) return 0;
  let total = 0;
  for (let row = rowMin; row <= rowMax; row++) {
    const pixLat = originY - (row + 0.5) * pixelH;
    for (let col = colMin; col <= colMax; col++) {
      const pixLng = originX + (col + 0.5) * pixelW;
      if (!pointInPolygon(pixLng, pixLat, ring)) continue;
      const val = tifData[row * width + col];
      if (val === tifNodata || val < 0) continue;
      total += val;
    }
  }
  return Math.round(total);
}

function computePopulationFromGeoJSON(geojson) {
  if (!tifData) return null;
  let total = 0;
  function processGeometry(geom) {
    if (!geom) return;
    if (geom.type === 'Polygon') {
      total += computePopulationFromRing(geom.coordinates[0]);
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach(poly => { total += computePopulationFromRing(poly[0]); });
    } else if (geom.type === 'GeometryCollection') {
      geom.geometries.forEach(processGeometry);
    }
  }
  if (geojson.type === 'FeatureCollection') {
    geojson.features.forEach(f => processGeometry(f.geometry));
  } else if (geojson.type === 'Feature') {
    processGeometry(geojson.geometry);
  } else {
    processGeometry(geojson);
  }
  return total;
}

// ── FILE UPLOAD HANDLER (GeoJSON + KML) ──────────────────────
function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  const reader = new FileReader();
  reader.onload = function(e) {
    const text = e.target.result;
    const name = file.name;
    let geojson = null;
    try {
      if (name.toLowerCase().endsWith('.kml')) {
        const parser = new DOMParser();
        const kmlDom = parser.parseFromString(text, 'text/xml');
        geojson = toGeoJSON.kml(kmlDom);
      } else {
        geojson = JSON.parse(text);
      }
    } catch (err) {
      logError(`Could not parse "${name}": ${err.message}`, logCount + 1);
      return;
    }
    const hasFeatures = geojson && (
      (geojson.features && geojson.features.length > 0) ||
      geojson.type === 'Polygon' || geojson.type === 'MultiPolygon' || geojson.type === 'Feature'
    );
    if (!hasFeatures) {
      logError(`No valid geometry found in "${name}".`, logCount + 1);
      return;
    }
    const layer = L.geoJSON(geojson, {
      style: { color: '#164D12', weight: 2, fillColor: '#164D12', fillOpacity: 0.10 }
    }).addTo(map);
    map.fitBounds(layer.getBounds(), { padding: [30, 30] });
    shapes.push(layer);
    const bounds = layer.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    logCount++;
    updateBadge();
    document.getElementById('console-output').querySelector('.empty-state')?.remove();
    const featureCount = geojson.features ? geojson.features.length : 1;
    const entry = document.createElement('div');
    entry.className = 'log-entry info';
    entry.innerHTML = `
      <div class="log-ts">${timestamp()}</div>
      <div class="log-type">\u{1F4C1} FILE \u00B7 ${name}</div>
      <div class="log-coords">${featureCount} feature${featureCount !== 1 ? 's' : ''}\nSW: [${sw.lat.toFixed(4)}, ${sw.lng.toFixed(4)}]\nNE: [${ne.lat.toFixed(4)}, ${ne.lng.toFixed(4)}]</div>`;
    const out = document.getElementById('console-output');
    out.appendChild(entry);
    out.scrollTop = out.scrollHeight;
    const population = computePopulationFromGeoJSON(geojson);
    if (population !== null) {
      logPopulation(population, logCount, name);
    } else {
      logError('TIF not loaded yet — try again after the raster finishes loading.', logCount);
    }
  };
  reader.readAsText(file);
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
    : '⬡ Polygon Mode<div class="hint">Tap locations to add corners · Use the button below to finish</div>';
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
  
  if (finishPolyBtn) finishPolyBtn.style.display = 'none'; // Hide mobile finish button
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

  const population = computePopulation(sw.lat, sw.lng, ne.lat, ne.lng);
  if (population !== null) {
    logPopulation(population, logCount);
  } else {
    logError('TIF not loaded yet — draw again after the raster finishes loading.', logCount);
  }
});

// ── POLYGON DRAWING ───────────────────────────────────────────
map.on('click', function(e) {
  if (mode !== 'polygon') return;
  
  polyPoints.push(e.latlng);
  
  // Create an explicit touch-friendly node visual marker
  const dot = L.circleMarker(e.latlng, {
    radius: 6, color: '#ff6b35', fillColor: '#ff6b35', fillOpacity: 1, weight: 2
  }).addTo(map);
  polyMarkers.push(dot);
  
  if (polyLine) map.removeLayer(polyLine);
  if (polyPoints.length > 1) {
    polyLine = L.polyline(polyPoints, { color: '#ff6b35', weight: 2, dashArray: '6 4' }).addTo(map);
  }

  // Show floating finish action once a valid shape can form (minimum 3 points)
  if (polyPoints.length >= 3 && finishPolyBtn) {
    finishPolyBtn.style.display = 'block';
  }
});

// ── FINISH POLYGON CALCULATIONS ──────────────────────────────
function finishPolygon() {
  if (polyPoints.length < 3) return;

  if (finishPolyBtn) finishPolyBtn.style.display = 'none'; // Clear out the button overlay
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
  
  // Convert Leaflet LatLng array to GeoJSON ring [lng, lat]
  const ring = finalPoints.map(p => [p.lng, p.lat]);
  ring.push(ring[0]); // close ring loop
  
  const polyGeojson = { type: 'Polygon', coordinates: [ring] };
  const population = computePopulationFromGeoJSON(polyGeojson);
  
  if (population !== null) {
    logPopulation(population, logCount, 'Drawn Polygon');
  } else {
    logError('TIF not loaded yet — draw again after the raster finishes loading.', logCount);
  }
}

// ── CLEAR ALL ─────────────────────────────────────────────────
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

function logPopulation(population, index, label) {
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
    <div class="log-type pop-label">👥 POPULATION · ${label || ('BBOX #' + index)}</div>
    <div class="log-coords">
      <span class="pop-big">${millions}M</span>
      <span class="pop-raw">${formatted} people</span>
      <span class="monitors-label">Min. monitors required · CPCB guidelines</span>
      <div class="monitors-grid">${monitorsHTML}</div>
    </div>`;
  out.appendChild(entry);
  out.scrollTop = out.scrollHeight;

  console.log(`[GeoSketch] #${index} (${label || 'BBOX'}) — Population: ${formatted}`);
  pollutants.forEach(p => console.log(`  ${labels[p]}: ${numMonitorsCpcb(p, population)} stations`));
}

function logError(msg, index) {
  const out = document.getElementById('console-output');
  const entry = document.createElement('div');
  entry.className = 'log-entry pop-error';
  entry.innerHTML = `
    <div class="log-ts">${timestamp()}</div>
    <div class="log-type pop-label">⚠ NOTE · #${index}</div>
    <div class="log-coords">${msg}</div>`;
  out.appendChild(entry);
  out.scrollTop = out.scrollHeight;
}