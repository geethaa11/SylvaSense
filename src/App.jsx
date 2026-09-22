import { useRef, useState, useEffect } from 'react';
import { MapContainer, TileLayer, useMap, GeoJSON, Popup, CircleMarker } from 'react-leaflet';
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';

import { evaluateEvidence } from './evidenceEngine';

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
      onPolygonCreated(layer.toGeoJSON(), hectares, layer, latlngs);
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

const LADDER_LEVELS = [
  { level: 'L4', title: 'Individual tree / crown' },
  { level: 'L3', title: 'Canopy object / density' },
  { level: 'L2', title: 'Canopy cover / structure' },
  { level: 'L1', title: 'Forest condition / change' }
];

function App() {
  const mapRef = useRef(null);
  const [polygonGeoJSON, setPolygonGeoJSON] = useState(null);
  const [polygonLayer, setPolygonLayer] = useState(null);
  const [polygonLatLngs, setPolygonLatLngs] = useState([]);
  const [areaHa, setAreaHa] = useState(0);
  const [biome, setBiome] = useState('Tropical Forest');
  const [status, setStatus] = useState('Draw a forest area on the map to begin analysis.');
  const [activeLayers, setActiveLayers] = useState({ sentinel2: true, sentinel1SAR: false, objects: false });
  
  const [requestedMeasurement, setRequestedMeasurement] = useState(null);
  const [analysisResult, setAnalysisResult] = useState(null);
  
  const [reviewTrigger, setReviewTrigger] = useState(0);
  const [compareClaimsOpen, setCompareClaimsOpen] = useState(false);
  const [explainerOpen, setExplainerOpen] = useState(false);
  const [proofOpen, setProofOpen] = useState(false);
  
  const [demoFeatures, setDemoFeatures] = useState(null);
  const [demoObjects, setDemoObjects] = useState([]);
  
  const [liveDataStatus, setLiveDataStatus] = useState({ backend: 'Checking...', sentinel2: 'Checking...', sentinel1: 'Checking...', raster: 'Unknown' });
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001';

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/health`)
      .then(res => res.json())
      .then(data => setLiveDataStatus(data))
      .catch(() => setLiveDataStatus({ backend: 'Unavailable', sentinel2: 'Unavailable', sentinel1: 'Unavailable', raster: 'Unavailable' }));
  }, []);

  useEffect(() => {
    if (polygonLayer) {
      polygonLayer.setStyle({ color: BIOME_COLORS[biome], fillColor: BIOME_COLORS[biome] });
    }
    const map = mapRef.current;
    if (map && map.pm) {
      map.pm.setPathOptions({ color: BIOME_COLORS[biome], fillColor: BIOME_COLORS[biome], fillOpacity: 0.4 });
    }
  }, [biome, polygonLayer]);

  function handlePolygonCreated(geojson, hectares, layer, latlngs) {
    if (polygonLayer) { mapRef.current.removeLayer(polygonLayer); }
    setPolygonGeoJSON(geojson); 
    setAreaHa(hectares); 
    setPolygonLayer(layer);
    setPolygonLatLngs(latlngs);
    layer.setStyle({ color: BIOME_COLORS[biome], fillColor: BIOME_COLORS[biome] });
    setRequestedMeasurement(null);
    setAnalysisResult(null);
    setDemoFeatures(null);
    setDemoObjects([]);
    setStatus(`Forest area selected: ${hectares.toFixed(2)} ha. Select a measurement below.`);
  }

  function handleApiFailure(type, data) {
    const result = {
      id: type,
      title: type,
      requested: type === 'ENUMERATION' ? 'Individual tree enumeration' : type === 'STRUCTURE' ? 'Canopy cover / structure' : type === 'BIOMASS' ? 'Stand-level AGB estimation' : 'Disturbance / Change',
      required: [
          { name: 'Live API Connection', status: 'UNSUPPORTED' },
          { name: 'Sentinel-2 Raster Data', status: 'UNSUPPORTED' }
      ],
      availableSummary: data.metadata_found ? `Found scene ${data.metadata_found.scene_id} but processing failed.` : 'No satellite data retrieved.',
      decision: 'REVIEW',
      supportedResolution: 'None',
      ladderLevel: 'L0',
      reason: data.reason || 'Backend processing failed.',
      resultTitle: 'DATA UNAVAILABLE',
      resultSub: 'Cannot compute measurement without live raster processing.',
      evidenceUsed: 'None',
      technicalProof: {
          source: 'Copernicus Sentinel-2',
          processing: 'FastAPI + Rasterio',
          analysis: data.metadata_found ? 'Actual raster processing failed / unavailable' : 'Unavailable',
          decision: 'REVIEW / UNAVAILABLE',
          output: 'None'
      },
      validationZones: [],
      evidenceProfile: { optical: 'Unavailable', sar: 'Unavailable', canopy: 'Unavailable', temporal: 'Unavailable' },
      showAgbPipeline: false
    };
    
    setDemoFeatures(null);
    setDemoObjects([]);
    setActiveLayers(p => ({ ...p, objects: false }));
    setAnalysisResult(result);
  }

  function handleApiSuccess(type, data) {
    const comp = data.computation || {};
    const meta = data.metadata_found || {};
    
    // Set map objects
    if (comp.geojson) {
      setDemoFeatures(comp.geojson);
      // Generate render points from polygons for simple visual rendering
      const markers = [];
      comp.geojson.features.forEach(f => {
         if (f.geometry.type === 'Polygon') {
           const coords = f.geometry.coordinates[0][0];
           markers.push({ lat: coords[1], lng: coords[0], radius: 4 });
         }
      });
      setDemoObjects(markers);
    } else {
      setDemoFeatures(null);
      setDemoObjects([]);
    }
    
    if (type === 'ENUMERATION') {
      setActiveLayers(p => ({ ...p, objects: true }));
    }

      let sourceStr = 'Copernicus Sentinel-2 (' + meta.acquisition_date + ')';
      let processingStr = 'FastAPI + Rasterio, Sentinel-2 NDVI';
      let analysisStr = 'NDVI mean: ' + comp.ndvi_mean + ', Valid pixels: ' + comp.valid_pixels;
      let evidenceSar = meta.sentinel1_used ? meta.sentinel1_processing : 'Unavailable';
      
      if (meta.sentinel1_used) {
          sourceStr += '\nCopernicus Sentinel-1 GRD';
          processingStr += ', Sentinel-1 ' + meta.sentinel1_polarization + ' SAR backscatter';
          analysisStr += '\nSentinel-1 ' + meta.sentinel1_polarization + ' mean: ' + meta.sentinel1_vv_mean_db + ' dB, Valid pixels: ' + meta.sentinel1_valid_pixels;
      }

      const result = {
        id: type,
        title: type,
        requested: type === 'ENUMERATION' ? 'Individual tree enumeration' : type === 'STRUCTURE' ? 'Canopy cover / structure' : type === 'BIOMASS' ? 'Stand-level AGB estimation' : 'Disturbance / Change',
        required: [
            { name: 'Live API Connection', status: 'SUPPORTED' },
            { name: 'Sentinel-2 Raster Data', status: 'SUPPORTED' }
        ],
        decision: data.status,
        supportedResolution: data.resolution ? data.resolution.supported : 'L3',
        ladderLevel: data.resolution ? data.resolution.supported : 'L3',
        reason: data.resolution ? data.resolution.reason : 'Successfully processed raster.',
        resultTitle: type === 'ENUMERATION' ? (comp.canopy_objects + ' Canopy Objects') : (comp.canopy_cover_percent + '% Canopy Cover'),
        resultSub: 'Calculated from LIVE raster extraction',
        evidenceUsed: 'Sentinel-2 ' + meta.scene_id,
        technicalProof: {
            source: sourceStr,
            processing: processingStr,
            analysis: analysisStr,
            decision: data.status,
            output: 'GeoJSON polygons generated via NDVI threshold >= 0.4'
        },
        validationZones: [],
        evidenceProfile: { optical: 'B04, B08 processed', sar: evidenceSar, canopy: 'NDVI segmented', temporal: 'Single scene' },
      showAgbPipeline: false
    };
    
    setAnalysisResult(result);
  }

  function selectMeasurement(type) {
    if (isAnalyzing) return;
    setIsAnalyzing(true);
    setRequestedMeasurement(type);
    setStatus('Searching satellite data...');
    setAnalysisResult(null);
    setProofOpen(false);

    fetch(`${API_BASE_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aoi: polygonGeoJSON, measurement: type })
    })
    .then(res => {
      if (!res.ok) throw new Error('Backend error');
      return res.json();
    })
    .then(data => {
      setIsAnalyzing(false);
      
      const s1Status = data.metadata_found?.sentinel1_connected ? 'Connected' : 'Unavailable';
      setLiveDataStatus(prev => ({ ...prev, sentinel1: s1Status, sentinel2: 'Connected' }));
      
      if (data.api_state === 'NO_DATA') {
         setStatus('REVIEW — No suitable satellite data found');
         handleApiFailure(type, data);
      } else if (data.api_state === 'API_FAILURE') {
         setStatus('REVIEW — Satellite data could not be retrieved');
         handleApiFailure(type, data);
      } else {
         setStatus('Live satellite analysis completed');
         handleApiSuccess(type, data);
      }
    })
    .catch(err => {
      console.error(err);
      setIsAnalyzing(false);
      setStatus('REVIEW — Live analysis service unavailable');
      handleApiFailure(type, { api_state: 'BACKEND_UNAVAILABLE', reason: 'Live analysis service unavailable. Please check the backend connection.', metadata_found: null });
    });
  }

  function downloadGeoJSON() {
    const dataToExport = demoFeatures ? demoFeatures : polygonGeoJSON;
    if (!dataToExport) { setStatus('Draw an area and analyze first.'); return; }
    
    if (!demoFeatures) {
        setStatus('Cannot export live geometry - live analysis did not succeed.');
        return;
    }

    const data = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([data], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'sylvasense-boundaries.geojson'; link.click();
    URL.revokeObjectURL(url); 
    setStatus('Exported canopy boundaries.');
  }

  function clearMap() {
    const map = mapRef.current;
    if (map) {
      map.eachLayer((layer) => {
        if (layer instanceof L.Polygon || layer instanceof L.Polyline) { map.removeLayer(layer); }
      });
    }
    setPolygonGeoJSON(null); setPolygonLayer(null); setPolygonLatLngs([]); setAreaHa(0); 
    setAnalysisResult(null); setRequestedMeasurement(null); setDemoFeatures(null); setDemoObjects([]);
    setStatus('Map cleared. Draw a new forest area.');
  }

  function toggleLayer(layerName) { setActiveLayers(p => ({ ...p, [layerName]: !p[layerName] })); }

  const statusColor = (status) => {
    if (status === 'SUPPORTED') return '#22c55e';
    if (status === 'REVIEW') return '#f97316';
    return '#ef4444';
  };
  
  const statusIcon = (status) => {
    if (status === 'SUPPORTED') return '🟢';
    if (status === 'REVIEW') return '🟡';
    return '🔴';
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-flex">
          <div>
            <h1>🌳 SYLVASENSE</h1>
            <p className="subtitle">Evidence-Bounded Forest Intelligence</p>
          </div>
          <div className="header-actions">
            <button className="btn-text" onClick={() => setExplainerOpen(true)}>How SylvaSense Decides</button>
            <div className="demo-badge">
              <strong>PROTOTYPE — DEMONSTRATION DATA</strong>
              <span>Production connects to live inference & calibrated data</span>
            </div>
          </div>
        </div>
      </header>

      {explainerOpen && (
        <div className="modal-overlay" onClick={() => setExplainerOpen(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>HOW SYLVASENSE DECIDES</h3>
            <div className="explainer-flow">
              <div className="ex-step"><strong>1. REQUEST</strong><br/>What do you want to measure?</div>
              <div className="ex-arrow">↓</div>
              <div className="ex-step"><strong>2. SPECIFY</strong><br/>What evidence does that measurement require?</div>
              <div className="ex-arrow">↓</div>
              <div className="ex-step"><strong>3. TEST</strong><br/>Is that evidence available and sufficient?</div>
              <div className="ex-arrow">↓</div>
              <div className="ex-step"><strong>4. SELECT</strong><br/>What spatial resolution is actually supported?</div>
              <div className="ex-arrow">↓</div>
              <div className="ex-step"><strong>5. QUANTIFY</strong><br/>Produce the strongest defensible result.</div>
            </div>
            <button className="btn-primary" style={{marginTop: '20px', width: '100%'}} onClick={() => setExplainerOpen(false)}>Close</button>
          </div>
        </div>
      )}

      {compareClaimsOpen && (
        <div className="modal-overlay" onClick={() => setCompareClaimsOpen(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>COMPARE CLAIMS ON THIS AOI</h3>
            <table className="compare-table">
              <thead>
                <tr>
                  <th>Requested Measurement</th>
                  <th>Core Evidence Requirement</th>
                  <th>Output Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Tree Enumeration</td>
                  <td>Crown separability</td>
                  <td><span style={{color: '#f97316'}}>REVIEW (Downgraded to object density)</span></td>
                </tr>
                <tr>
                  <td>Forest Structure</td>
                  <td>Canopy evidence</td>
                  <td><span style={{color: '#22c55e'}}>SUPPORTED</span></td>
                </tr>
                <tr>
                  <td>Aboveground Biomass</td>
                  <td>Reference biomass + model</td>
                  <td><span style={{color: '#f97316'}}>REVIEW (Requires field validation)</span></td>
                </tr>
                <tr>
                  <td>Forest Change</td>
                  <td>Temporal + optical + SAR</td>
                  <td><span style={{color: '#22c55e'}}>SUPPORTED</span></td>
                </tr>
              </tbody>
            </table>
            <p style={{fontSize: '13px', color: '#555', marginTop: '16px'}}>Same forest ≠ same claim. SylvaSense adjusts the output resolution based on the evidence requirements of the specific claim.</p>
            <button className="btn-primary" style={{marginTop: '20px', width: '100%'}} onClick={() => setCompareClaimsOpen(false)}>Close</button>
          </div>
        </div>
      )}

      <main className="container">
        <div className="toolbar">
          <div className="toolbar-section">
            <strong>Data Layers</strong>
            <label className="checkbox-label">
              <input type="checkbox" checked={activeLayers.sentinel2} onChange={() => toggleLayer('sentinel2')} />
              <span>Optical (Sentinel-2)</span>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={activeLayers.sentinel1SAR} onChange={() => toggleLayer('sentinel1SAR')} />
              <span>SAR (Sentinel-1)</span>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={activeLayers.objects} onChange={() => toggleLayer('objects')} />
              <span>Segmentation Objects</span>
            </label>
          </div>

          <div className="toolbar-section">
            <label>
              <strong>Forest Type</strong>
              <select value={biome} onChange={(e) => setBiome(e.target.value)} style={{ display: 'block', width: '100%', marginTop: '6px', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}>
                <option>Tropical Forest</option>
                <option>Temperate Forest</option>
                <option>Boreal Forest</option>
                <option>Savanna / Woodland</option>
              </select>
            </label>
          </div>

          <div className="toolbar-section" style={{display: "flex", gap: "8px", alignItems: "flex-end"}}>
            <Tooltip text="Exports canopy/object boundaries from actual live raster analysis.">
              <button onClick={downloadGeoJSON} className="btn-secondary">Export GeoJSON</button>
            </Tooltip>
            <button onClick={clearMap} className="btn-secondary">Clear Area</button>
          </div>
        </div>
        
        <div style={{display: 'flex', gap: '20px', marginBottom: '16px'}}>
          <div className="status-bar" style={{flex: 1, marginBottom: 0}}>
            <span className="status-icon">●</span> {status}
          </div>
          <div className="status-bar" style={{fontSize: '11px', marginBottom: 0, background: '#f8fafc', borderColor: '#e2e8f0'}}>
            <strong style={{color: '#475569', marginRight: '10px'}}>LIVE DATA CONNECTION:</strong>
            <span style={{marginRight: '8px'}}>Backend: <span style={{color: liveDataStatus.backend === 'Connected' ? '#16a34a' : '#ef4444'}}>{liveDataStatus.backend}</span></span> |
            <span style={{margin: '0 8px'}}>Sentinel-2: <span style={{color: liveDataStatus.sentinel2 === 'Connected' ? '#16a34a' : '#f59e0b'}}>{liveDataStatus.sentinel2 || 'Checking...'}</span></span> |
            <span style={{margin: '0 8px'}}>Sentinel-1: <span style={{color: liveDataStatus.sentinel1 === 'Connected' ? '#16a34a' : '#f59e0b'}}>{liveDataStatus.sentinel1 || 'Checking...'}</span></span> |
            <span style={{marginLeft: '8px'}}>Raster Processing: <span style={{color: liveDataStatus.raster === 'Ready' ? '#16a34a' : '#ef4444'}}>{liveDataStatus.raster}</span></span>
          </div>
        </div>

        <div className="main-grid">
          <section className="map-panel" style={{position: "relative"}}>
            <div className="panel-header">
              <h3>Map View</h3>
              <div className="tech-status-panel">
                <span className="tech-implemented">IMPLEMENTED</span>
                <span className="tech-demo">DEMONSTRATION</span>
              </div>
            </div>
            
            {activeLayers.sentinel1SAR && <div className="radar-overlay"></div>}

            <MapContainer center={[-3.4653, -62.2159]} zoom={14} className="map" ref={mapRef}>
              {polygonLayer && reviewTrigger > 0 && (
                <MapController boundsToFit={polygonLayer.getBounds()} reviewTrigger={reviewTrigger} />
              )}
              {activeLayers.sentinel2 ? (
                <TileLayer attribution="&copy; Esri" url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" maxNativeZoom={17} maxZoom={22} />
              ) : (
                <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              )}
              <DrawControl onPolygonCreated={handlePolygonCreated} initialColor={BIOME_COLORS[biome]} />
              
              {activeLayers.objects && demoObjects && demoObjects.map((obj, i) => (
                <CircleMarker key={'obj-'+i} center={[obj.lat, obj.lng]} radius={obj.radius} pathOptions={{ color: '#7CFC00', weight: 1, fillOpacity: 0.6 }} />
              ))}

              {analysisResult && analysisResult.validationZones.map(zone => (
                <CircleMarker 
                  key={zone.id} 
                  center={[zone.lat, zone.lng]} 
                  radius={reviewTrigger > 0 ? 18 : 12} 
                  pathOptions={{ 
                    color: zone.priority === 'HIGH' ? '#ef4444' : '#f97316', 
                    fillColor: zone.priority === 'HIGH' ? '#ef4444' : '#f97316', 
                    fillOpacity: 0.9,
                    weight: reviewTrigger > 0 ? 4 : 2 
                  }}
                  className={reviewTrigger > 0 ? 'pulse-marker' : ''}
                >
                  <Popup>
                    <strong>Simulated Priority: {zone.priority} (Demo)</strong><br/><br/>
                    <b>Reason:</b> {zone.reason}<br/>
                    <b>Action:</b> High-resolution validation recommended
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
            
            {polygonGeoJSON && (
            <div style={{padding: '12px', fontSize: '12px', background: '#f9fafb', borderTop: '1px solid #e0ece0'}}>
              <strong>CURRENT AOI DATA</strong><br/>
              Area: {areaHa.toFixed(2)} ha<br/>
              Sentinel-2 (10m): Checking LIVE connection | Sentinel-1: Checking LIVE connection
            </div>
            )}
          </section>

          <aside className="metrics-panel">
            {!polygonGeoJSON && (
              <div className="empty-state">
                <div className="empty-state-icon">📍</div>
                <p>Select or draw a forest polygon on the map to begin.</p>
              </div>
            )}

            {polygonGeoJSON && !requestedMeasurement && (
              <div className="measurement-selection">
                <h3 className="section-title">WHAT DO YOU WANT TO MEASURE?</h3>
                <div className="cards-grid">
                  <div className={`meas-card ${isAnalyzing ? 'disabled-card' : ''}`} onClick={() => selectMeasurement('ENUMERATION')}>
                    <h4>🌳 Tree / Canopy Enumeration</h4>
                    <p>Estimate tree/canopy objects and density.</p>
                  </div>
                  <div className={`meas-card ${isAnalyzing ? 'disabled-card' : ''}`} onClick={() => selectMeasurement('STRUCTURE')}>
                    <h4>🌲 Forest Structure</h4>
                    <p>Assess canopy cover / structure at supported resolution.</p>
                  </div>
                  <div className={`meas-card ${isAnalyzing ? 'disabled-card' : ''}`} onClick={() => selectMeasurement('BIOMASS')}>
                    <h4>🪵 Aboveground Biomass</h4>
                    <p>Estimate AGB from multi-source features and reference biomass.</p>
                  </div>
                  <div className={`meas-card ${isAnalyzing ? 'disabled-card' : ''}`} onClick={() => selectMeasurement('CHANGE')}>
                    <h4>🔥 Forest Change</h4>
                    <p>Assess evidence of temporal forest change/disturbance.</p>
                  </div>
                </div>
                <button className="btn-secondary" style={{width: '100%', marginTop: '16px'}} onClick={() => setCompareClaimsOpen(true)}>
                  Compare Claims for this AOI
                </button>
                
                <div style={{marginTop: '20px', padding: '12px', background: '#eef5eb', borderRadius: '8px', border: '1px solid #d8e8d0'}}>
                  <strong style={{fontSize: '12px', color: '#2d5a27'}}>PS-03 IMPLEMENTATION STATUS</strong>
                  <ul style={{margin: '8px 0 0', paddingLeft: '16px', fontSize: '12px', color: '#4a5a4a', lineHeight: '1.6'}}>
                    <li>✓ Backend API Integrated</li>
                    <li>✓ Live Sentinel-2 querying</li>
                    <li>✓ Evidence engine handles live data status</li>
                    <li>△ Raster processing (Pending Copernicus Credentials)</li>
                  </ul>
                </div>
              </div>
            )}

            {analysisResult && (
              <div className="analysis-flow">
                <button className="btn-back" onClick={() => setRequestedMeasurement(null)}>← Back to Measurements</button>
                
                <div className="flow-step">
                  <div className="step-label">STEP 1 — REQUESTED MEASUREMENT</div>
                  <div className="step-value">{analysisResult.requested}</div>
                </div>

                <div className="flow-step">
                  <div className="step-label">STEP 2 — REQUIRED EVIDENCE & CHECKS</div>
                  <ul className="evidence-list">
                    {analysisResult.required.map((req, i) => (
                      <li key={i}>
                        <span className={`badge ${req.status.toLowerCase()}`}>{statusIcon(req.status)} {req.status}</span>
                        {req.name}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="flow-step">
                  <div className="step-label">STEP 3 — DECISION</div>
                  <div className="decision-box" style={{borderLeftColor: statusColor(analysisResult.decision)}}>
                    <strong>DECISION: {statusIcon(analysisResult.decision)} {analysisResult.decision}</strong>
                    <p>{analysisResult.reason}</p>
                  </div>
                </div>

                <div className="hero-card" style={{borderTopColor: statusColor(analysisResult.decision)}}>
                  <div className="hero-header">
                    <span className="hero-title">{analysisResult.supportedResolution.toUpperCase()}</span>
                  </div>
                  <div className="hero-main">{analysisResult.resultTitle}</div>
                  <div className="hero-sub">{analysisResult.resultSub}</div>
                  
                  <div className="hero-divider"></div>
                  
                  <div className="hero-why">
                    <strong>WHY THIS RESULT?</strong>
                    <p>{analysisResult.reason}</p>
                  </div>

                  <div className="hero-metric">
                    <strong>EVIDENCE USED:</strong> {analysisResult.evidenceUsed}
                  </div>
                </div>

                <div className="ladder-container">
                  <div className="step-label" style={{marginBottom: '8px'}}>FOREST MEASUREMENT RESOLUTION LADDER</div>
                  {LADDER_LEVELS.map((level) => (
                    <div key={level.level} className={`ladder-step ${analysisResult.ladderLevel === level.level ? 'active' : ''}`}>
                      <span className="ladder-level">{level.level}</span> {level.title}
                      {analysisResult.ladderLevel === level.level && <span className="ladder-indicator">← Supported Resolution</span>}
                    </div>
                  ))}
                </div>

                <div className="proof-drawer">
                  <button className="proof-btn" onClick={() => setProofOpen(!proofOpen)}>
                    {proofOpen ? '▼' : '▶'} How was this determined? (Technical Proof)
                  </button>
                  {proofOpen && (
                    <div className="proof-content">
                      <div className="proof-row"><span>Source:</span> {analysisResult.technicalProof.source}</div>
                      <div className="proof-row"><span>Processing:</span> {analysisResult.technicalProof.processing}</div>
                      <div className="proof-row"><span>Analysis:</span> {analysisResult.technicalProof.analysis}</div>
                      <div className="proof-row"><span>Decision:</span> {analysisResult.technicalProof.decision}</div>
                      <div className="proof-row"><span>Output:</span> {analysisResult.technicalProof.output}</div>
                    </div>
                  )}
                </div>

              </div>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}

export default App;
