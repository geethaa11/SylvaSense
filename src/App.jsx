import { useRef, useState, useEffect } from 'react';
import { MapContainer, TileLayer, useMap, CircleMarker, Popup } from 'react-leaflet';
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

function getPolygonAreaHectares(latlngs) {
  const earthRadius = 6378137;
  let area = 0;
  for (let i = 0; i < latlngs.length; i++) {
    const p1 = latlngs[i];
    const p2 = latlngs[(i + 1) % latlngs.length];
    const x1 = earthRadius * (p1.lng * Math.PI / 180) * Math.cos(p1.lat * Math.PI / 180);
    const y1 = earthRadius * (p1.lat * Math.PI / 180);
    const x2 = earthRadius * (p2.lng * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180);
    const y2 = earthRadius * (p2.lat * Math.PI / 180);
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2) / 10000;
}

function Tooltip({ text, children }) {
  const [visible, setVisible] = useState(false);
  return (
    <span className='tooltip-wrapper' onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
      {children}
      {visible && <span className='tooltip-box'>{text}</span>}
    </span>
  );
}

function DrawControl({ onPolygonCreated, initialColor }) {
  const map = useMap();
  useEffect(() => {
    map.pm.addControls({
      position: 'topright', drawCircle: false, drawCircleMarker: false,
      drawPolyline: false, drawRectangle: false, drawMarker: false, drawText: false,
    });
    map.pm.setPathOptions({ color: initialColor, fillColor: initialColor, fillOpacity: 0.4 });
    const handleCreate = (event) => {
      const layer = event.layer;
      const latlngs = layer.getLatLngs()[0];
      const hectares = getPolygonAreaHectares(latlngs);
      onPolygonCreated(layer.toGeoJSON(), hectares, layer);
    };
    map.on('pm:create', handleCreate);
    return () => { map.pm.removeControls(); map.off('pm:create', handleCreate); };
  }, [map, onPolygonCreated, initialColor]);
  return null;
}

function MapController({ boundsToFit, reviewTrigger }) {
  const map = useMap();
  useEffect(() => {
    if (boundsToFit && reviewTrigger > 0) {
      map.fitBounds(boundsToFit, { padding: [50, 50], animate: true, duration: 1.5 });
    }
  }, [boundsToFit, reviewTrigger, map]);
  return null;
}

const BIOME_COLORS = {
  'Tropical Forest': '#2f7d4a',
  'Temperate Forest': '#2b8a7b',
  'Boreal Forest': '#1b4f2c',
  'Savanna / Woodland': '#a38d29'
};

const BIOMASS_FACTORS = {
  'Tropical Forest': 180, 'Temperate Forest': 120,
  'Boreal Forest': 80, 'Savanna / Woodland': 55,
};

function App() {
  const mapRef = useRef(null);
  const [polygonGeoJSON, setPolygonGeoJSON] = useState(null);
  const [polygonLayer, setPolygonLayer] = useState(null);
  const [areaHa, setAreaHa] = useState(0);
  const [biome, setBiome] = useState('Tropical Forest');
  const [results, setResults] = useState(null);
  const [validationZones, setValidationZones] = useState([]);
  const [status, setStatus] = useState('Draw a forest area on the map to begin analysis.');
  const [activeLayers, setActiveLayers] = useState({ sentinel2: true, sentinel1SAR: false, ndvi: false });
  const [reviewTrigger, setReviewTrigger] = useState(0);

  useEffect(() => {
    if (polygonLayer) {
      polygonLayer.setStyle({ color: BIOME_COLORS[biome], fillColor: BIOME_COLORS[biome] });
    }
    const map = mapRef.current;
    if (map && map.pm) {
      map.pm.setPathOptions({ color: BIOME_COLORS[biome], fillColor: BIOME_COLORS[biome], fillOpacity: 0.4 });
    }
  }, [biome, polygonLayer]);

  function handlePolygonCreated(geojson, hectares, layer) {
    if (polygonLayer) { mapRef.current.removeLayer(polygonLayer); }
    setPolygonGeoJSON(geojson); setAreaHa(hectares); setPolygonLayer(layer);
    layer.setStyle({ color: BIOME_COLORS[biome], fillColor: BIOME_COLORS[biome] });
    setValidationZones([]); setResults(null); setReviewTrigger(0);
    setStatus(`Forest area selected: ${hectares.toFixed(2)} ha. Click Analyze Forest.`);
  }

  function analyzeForest() {
    if (!polygonGeoJSON || areaHa <= 0) {
      setStatus('Please draw a forest polygon first.'); return;
    }
    setStatus('Analyzing forest indicators...');
    
    setTimeout(() => {
      const simulatedCurrentNDVI = 0.68;
      const canopyFraction = Math.max(0, Math.min(1, (simulatedCurrentNDVI - 0.30) / (0.85 - 0.30)));
      const canopyCoverPercent = canopyFraction * 100;
      
      const treesPerHectare = Math.round(120 + canopyFraction * 480);
      const estimatedTrees = Math.round(areaHa * treesPerHectare);
      const uncertainty = Math.round(estimatedTrees * 0.20); 
      
      const biomassFactor = BIOMASS_FACTORS[biome];
      const agbDensity = canopyFraction * biomassFactor;
      const agbDensityUncertainty = agbDensity * 0.15;
      const agbTonnes = areaHa * agbDensity;
      const carbonTonnes = agbTonnes * 0.47;
      const co2eTonnes = carbonTonnes * 3.67;
      
      const lossPercent = 6; 
      let alertStatus = 'REVIEW';
      
      const bounds = polygonLayer.getBounds();
      const n = bounds.getNorth();
      const s = bounds.getSouth();
      const e = bounds.getEast();
      const w = bounds.getWest();
      const latDiff = n - s;
      const lngDiff = e - w;
      
      const latlngs = polygonLayer.getLatLngs()[0];
      function isPointInPolygon(lat, lng) {
        let inside = false;
        for (let i = 0, j = latlngs.length - 1; i < latlngs.length; j = i++) {
          const xi = latlngs[i].lat, yi = latlngs[i].lng;
          const xj = latlngs[j].lat, yj = latlngs[j].lng;
          const intersect = ((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi);
          if (intersect) inside = !inside;
        }
        return inside;
      }

      const candidates = [];
      const steps = 12;
      for (let i = 1; i < steps; i++) {
        for (let j = 1; j < steps; j++) {
          const lat = s + (latDiff * i) / steps;
          const lng = w + (lngDiff * j) / steps;
          if (isPointInPolygon(lat, lng)) {
            candidates.push({ lat, lng });
          }
        }
      }

      const selected = [];
      if (candidates.length > 0) selected.push(candidates[Math.floor(candidates.length * 0.1)]);
      if (candidates.length > 1) selected.push(candidates[Math.floor(candidates.length * 0.5)]);
      if (candidates.length > 2) selected.push(candidates[Math.floor(candidates.length * 0.9)]);

      const zoneConfigs = [
        { priority: 'HIGH PRIORITY', color: '#ef4444', radius: 12, reason: 'High uncertainty + fingerprint deviation' },
        { priority: 'REVIEW', color: '#f97316', radius: 8, reason: 'Moderate deviation' },
        { priority: 'STABLE', color: '#22c55e', radius: 8, reason: 'Stable forest' }
      ];

      const newZones = selected.map((pt, idx) => {
        const config = zoneConfigs[idx % zoneConfigs.length];
        return {
          id: idx + 1,
          lat: pt.lat,
          lng: pt.lng,
          priority: config.priority,
          color: config.color,
          radius: config.radius,
          reason: config.reason
        };
      });

      setValidationZones(newZones);
      setResults({
        currentNDVI: simulatedCurrentNDVI,
        canopyCoverPercent,
        estimatedTrees, uncertainty, treesPerHectare,
        agbDensity, agbDensityUncertainty, agbTonnes, carbonTonnes, co2eTonnes,
        lossPercent, alertStatus,
        evidenceConfidence: 87,
        fingerprintDeviation: 18,
      });
      setStatus('Analysis complete. Review the evidence and priority zones.');
    }, 1200);
  }

  function handleReviewPriorityZones() {
    setReviewTrigger(prev => prev + 1);
    setStatus('Priority validation zones highlighted on the map.');
  }

  function downloadGeoJSON() {
    if (!polygonGeoJSON) { setStatus('Draw a box first before saving.'); return; }
    const data = JSON.stringify(polygonGeoJSON, null, 2);
    const blob = new Blob([data], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'sylvasense-forest-boundary.geojson'; link.click();
    URL.revokeObjectURL(url); setStatus('File saved.');
  }

  function clearMap() {
    const map = mapRef.current;
    if (map) {
      map.eachLayer((layer) => {
        if (layer instanceof L.Polygon || layer instanceof L.Polyline) { map.removeLayer(layer); }
      });
    }
    setPolygonGeoJSON(null); setPolygonLayer(null); setAreaHa(0); setResults(null); setValidationZones([]); setReviewTrigger(0);
    setStatus('Map cleared. Draw a new forest area.');
  }

  function toggleLayer(layerName) { setActiveLayers(p => ({ ...p, [layerName]: !p[layerName] })); }

  return (
    <div className="app">
      <header className="header">
        <h1>🌳 SYLVASENSE</h1>
        <p>Forest Intelligence & Evidence Monitoring | Earth Observation • Computer Vision • Climate Tech</p>
      </header>

      <main className="container">
        <div className="toolbar">
          <div className="toolbar-section">
            <strong>Data Layers</strong>
            <label className="checkbox-label">
              <input type="checkbox" checked={activeLayers.sentinel2} onChange={() => toggleLayer('sentinel2')} />
              <Tooltip text="Sentinel-2 Optical Satellite Photos"><span className="term">Satellite Photos</span></Tooltip>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={activeLayers.sentinel1SAR} onChange={() => toggleLayer('sentinel1SAR')} />
              <Tooltip text="Sentinel-1 SAR Radar View Overlay (Prototype)"><span className="term">Radar View</span></Tooltip>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={activeLayers.ndvi} onChange={() => toggleLayer('ndvi')} />
              <Tooltip text="Canopy density visualization (Prototype)"><span className="term">Canopy Density</span></Tooltip>
            </label>
          </div>

          <div className="toolbar-section">
            <label>
              <strong>Forest Type</strong>
              <select value={biome} onChange={(e) => setBiome(e.target.value)} style={{ display: 'block', width: '100%', marginTop: '6px', padding: '8px' }}>
                <option>Tropical Forest</option>
                <option>Temperate Forest</option>
                <option>Boreal Forest</option>
                <option>Savanna / Woodland</option>
              </select>
            </label>
          </div>

          <div className="toolbar-section" style={{display: "flex", gap: "8px", alignItems: "flex-end"}}>
            <button onClick={analyzeForest} className="btn-primary">Analyze Forest</button>
            <button onClick={downloadGeoJSON} className="btn-secondary">Save GeoJSON</button>
            <button onClick={clearMap} className="btn-secondary">Clear</button>
          </div>
        </div>

        <div className="status-bar">
          <span className="status-icon">●</span> {status}
        </div>

        <div className="main-grid">
          <section className="map-panel" style={{position: "relative"}}>
            <div className="panel-header">
              <h3>Map</h3>
            </div>
            
            {activeLayers.sentinel1SAR && <div className="radar-overlay"></div>}
            {activeLayers.ndvi && <div className="canopy-overlay"></div>}

            <MapContainer center={[-3.4653, -62.2159]} zoom={5} className="map" ref={mapRef}>
              {polygonLayer && reviewTrigger > 0 && (
                <MapController boundsToFit={polygonLayer.getBounds()} reviewTrigger={reviewTrigger} />
              )}
              {activeLayers.sentinel2 ? (
                <TileLayer attribution="&copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EAP, and the GIS User Community" url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" />
              ) : (
                <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              )}
              <DrawControl onPolygonCreated={handlePolygonCreated} initialColor={BIOME_COLORS[biome]} />
              
              {validationZones.map(zone => (
                <CircleMarker 
                  key={zone.id} 
                  center={[zone.lat, zone.lng]} 
                  radius={reviewTrigger > 0 ? zone.radius * 1.5 : zone.radius} 
                  pathOptions={{ 
                    color: zone.color, 
                    fillColor: zone.color, 
                    fillOpacity: 0.9,
                    weight: reviewTrigger > 0 && zone.priority === 'HIGH PRIORITY' ? 4 : 2 
                  }}
                  className={reviewTrigger > 0 ? 'pulse-marker' : ''}
                >
                  <Popup>
                    <strong>Validation Priority</strong><br/>
                    <span style={{color: zone.color, fontWeight: 'bold'}}>{zone.priority}</span><br/><br/>
                    <b>Reason:</b> {zone.reason}<br/>
                    <b>Recommended Action:</b><br/>High-resolution validation
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
            
            <div className="map-legend">
              <div><strong>FOREST DENSITY:</strong></div>
              <div><span className="legend-color" style={{background: '#2f7d4a'}}></span>Low</div>
              <div><span className="legend-color" style={{background: '#7CFC00'}}></span>Moderate</div>
              <div><span className="legend-color" style={{background: '#f97316'}}></span>High</div>
              <div style={{marginLeft: "16px"}}><strong>VALIDATION PRIORITY:</strong></div>
              <div><span className="legend-color" style={{background: '#22c55e', borderRadius: '50%'}}></span>Stable</div>
              <div><span className="legend-color" style={{background: '#f97316', borderRadius: '50%'}}></span>Review</div>
              <div><span className="legend-color" style={{background: '#ef4444', borderRadius: '50%'}}></span>High Priority</div>
            </div>
          </section>

          <aside className="metrics-panel">
            <div className="panel-header">
              <h3>FOREST ANALYSIS</h3>
            </div>
            
            {!results && (
              <div className="empty-state">
                <div className="empty-state-icon">🌲</div>
                <p>Draw a forest polygon and click<br/><b>"Analyze Forest"</b> to generate:</p>
                <ul className="empty-state-list">
                  <li>Canopy assessment</li>
                  <li>Tree population estimate</li>
                  <li>Biomass estimate</li>
                  <li>Forest fingerprint</li>
                  <li>Evidence confidence</li>
                  <li>Adaptive validation</li>
                </ul>
              </div>
            )}

            {results && (
              <>
                <div className="metric-card">
                  <div className="metric-label">Area</div>
                  <div className="metric-value">{areaHa.toFixed(2)} ha</div>
                </div>

                <div className="metric-card highlight">
                  <div className="metric-label">Estimated Tree Population</div>
                  <div className="metric-value">{results.estimatedTrees.toLocaleString()} ± {results.uncertainty.toLocaleString()}</div>
                  <div className="metric-sub">stems (Demo estimate)</div>
                  <div className="metric-sub">Tree Density: {results.treesPerHectare} stems/ha</div>
                </div>

                <div className="metric-card">
                  <div className="metric-label">Canopy Cover</div>
                  <div className="metric-value">{results.canopyCoverPercent.toFixed(1)}%</div>
                  <div className="metric-sub">Current NDVI: {results.currentNDVI.toFixed(3)} (Demo estimate)</div>
                </div>

                <div className="metric-card">
                  <div className="metric-label">ABOVEGROUND BIOMASS</div>
                  <div className="metric-value">{results.agbDensity.toFixed(1)} ± {results.agbDensityUncertainty.toFixed(1)} Mg/ha</div>
                  <div className="metric-sub">Total Biomass: {results.agbTonnes.toFixed(1)} t</div>
                  <div className="metric-sub">Reference: ESA CCI Biomass / GEDI where suitable coverage exists</div>
                  <div className="metric-sub" style={{marginTop: '4px'}}><strong>Carbon Stock:</strong> {results.carbonTonnes.toFixed(1)} tC</div>
                  <div className="metric-sub"><strong>CO₂ Equivalent:</strong> {results.co2eTonnes.toFixed(1)} tCO₂e</div>
                </div>

                <div className="metric-card" style={{background: "#f9f9f9", border: "1px solid #ccc"}}>
                  <div className="metric-label">FOREST FINGERPRINT</div>
                  <div className="metric-sub" style={{fontStyle: 'italic', marginBottom: '8px'}}>Compared with the forest's historical baseline</div>
                  <div className="metric-sub">Spectral Profile: Stable ✓</div>
                  <div className="metric-sub">SAR Profile: Stable ✓</div>
                  <div className="metric-sub">Canopy Structure: Stable ✓</div>
                  <div className="metric-sub">Temporal Behaviour: Slight Deviation ⚠</div>
                  <div className="metric-sub" style={{marginTop: '4px'}}><strong>Overall Fingerprint Deviation:</strong> {results.fingerprintDeviation}%</div>
                </div>

                <div className="metric-card" style={{background: "#f9f9f9", border: "1px solid #ccc"}}>
                  <div className="metric-label">EVIDENCE FUSION</div>
                  <div className="metric-sub">Optical Signal: ✓</div>
                  <div className="metric-sub">SAR Signal: ✓</div>
                  <div className="metric-sub">Temporal Persistence: ✓</div>
                  <div className="metric-sub">Fingerprint Deviation: ⚠</div>
                  <div className="metric-sub" style={{marginTop: '4px'}}>
                    <strong>Evidence Confidence:</strong> <span style={{fontSize: '16px', fontWeight: 'bold'}}>{results.evidenceConfidence}%</span>
                  </div>
                  <div className="metric-sub" style={{marginTop: '6px', display: 'flex', alignItems: 'center', gap: '8px'}}>
                    <strong>Status:</strong> 
                    <span className={`status-badge status-${results.alertStatus.toLowerCase()}`}>{results.alertStatus}</span>
                  </div>
                </div>
                
                <div className="metric-card" style={{background: "#fff3e0", border: "1px solid #ffb74d"}}>
                  <div className="metric-label">ADAPTIVE VALIDATION</div>
                  <div className="metric-sub" style={{fontStyle: 'italic', marginBottom: '8px'}}>High-resolution validation is prioritized only where uncertainty or anomaly signals are strongest.</div>
                  <div className="metric-sub"><strong>3 zones require review</strong></div>
                  <ul style={{fontSize: "12px", margin: "4px 0", paddingLeft: "16px"}}>
                    <li>Zone A (High uncertainty) → Priority: <span style={{color: '#ef4444', fontWeight: 'bold'}}>HIGH</span></li>
                    <li>Zone B (Fingerprint deviation) → Priority: <span style={{color: '#f97316', fontWeight: 'bold'}}>REVIEW</span></li>
                    <li>Zone C (Stable forest) → No additional validation required</li>
                  </ul>
                  <button className="btn-secondary" style={{marginTop: "12px", width: "100%", fontSize: "13px", padding: "8px", fontWeight: "bold"}} onClick={handleReviewPriorityZones}>
                    Review Priority Zones
                  </button>
                </div>
              </>
            )}
          </aside>
        </div>
        
        <div className="workflow-panel">
          <h4>HOW SYLVASENSE REACHED THIS RESULT (Intended workflow)</h4>
          <p>SELECT FOREST → ANALYZE → CANOPY → TREE POPULATION → BIOMASS → CHANGE DETECTION → EVIDENCE FUSION → ADAPTIVE VALIDATION</p>
        </div>

        <div className="disclaimer-box">
          <strong>Prototype Notice:</strong>
          <p>Analysis values shown in this prototype are demonstrative. Production deployment would connect real satellite imagery, calibrated forest inventories and validated high-resolution reference data.</p>
        </div>
      </main>
    </div>
  );
}

export default App;
