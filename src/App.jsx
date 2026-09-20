import { useRef, useState, useEffect } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
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
    <span
      className="tooltip-wrapper"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && <span className="tooltip-box">{text}</span>}
    </span>
  );
}

function DrawControl({ onPolygonCreated }) {
  const map = useMap();

  useEffect(() => {
    map.pm.addControls({
      position: "topright",
      drawCircle: false,
      drawCircleMarker: false,
      drawPolyline: false,
      drawRectangle: false,
      drawMarker: false,
      drawText: false,
    });

    map.on("pm:create", (event) => {
      const layer = event.layer;
      const geojson = layer.toGeoJSON();
      const latlngs = layer.getLatLngs()[0];
      const hectares = getPolygonAreaHectares(latlngs);

      onPolygonCreated(geojson, hectares, layer);
    });

    return () => {
      map.pm.removeControls();
      map.off("pm:create");
    };
  }, [map, onPolygonCreated]);

  return null;
}

function App() {
  const mapRef = useRef(null);

  const [polygonGeoJSON, setPolygonGeoJSON] = useState(null);
  const [polygonLayer, setPolygonLayer] = useState(null);
  const [areaHa, setAreaHa] = useState(0);
  const [biome, setBiome] = useState("Tropical Forest");
  const [results, setResults] = useState(null);
  const [status, setStatus] = useState(
    "Draw a box around a forest area using the tool on the map."
  );

  const [activeLayers, setActiveLayers] = useState({
    sentinel2: true,
    sentinel1SAR: false,
    ndvi: false,
  });

  const biomassFactors = {
    "Tropical Forest": 180,
    "Temperate Forest": 120,
    "Boreal Forest": 80,
    "Savanna / Woodland": 55,
  };

  function handlePolygonCreated(geojson, hectares, layer) {
    setPolygonGeoJSON(geojson);
    setAreaHa(hectares);
    setPolygonLayer(layer);
    setStatus(
      `Forest area selected: ${hectares.toFixed(2)} ha. Click the green button to see results.`
    );
  }

  function analyzeForest() {
    if (!polygonGeoJSON || areaHa <= 0) {
      setStatus("Please draw a box around a forest area first.");
      return;
    }

    setStatus("Working on it...");

    setTimeout(() => {
      const simulatedCurrentNDVI = 0.68;
      const simulatedPreviousNDVI = 0.74;

      const canopyFraction = Math.max(
        0,
        Math.min(1, (simulatedCurrentNDVI - 0.30) / (0.85 - 0.30))
      );

      const canopyCoverPercent = canopyFraction * 100;

      const treesPerHectare = Math.round(120 + canopyFraction * 480);
      const estimatedTrees = Math.round(areaHa * treesPerHectare);

      const biomassFactor = biomassFactors[biome];
      const agbTonnes = areaHa * canopyFraction * biomassFactor;
      const carbonTonnes = agbTonnes * 0.47;
      const co2eTonnes = carbonTonnes * 3.67;

      const previousCanopyFraction = Math.max(
        0,
        Math.min(1, (simulatedPreviousNDVI - 0.30) / (0.85 - 0.30))
      );

      const previousCanopyPercent = previousCanopyFraction * 100;
      const lossPercent = Math.max(0, previousCanopyPercent - canopyCoverPercent);

      let alert = "Forest is healthy";
      let alertLevel = "low";
      if (lossPercent > 15) {
        alert = "High risk of tree loss";
        alertLevel = "high";
      } else if (lossPercent > 5) {
        alert = "Some tree loss occured";
        alertLevel = "medium";
      }

      setResults({
        currentNDVI: simulatedCurrentNDVI,
        canopyCoverPercent,
        estimatedTrees,
        treesPerHectare,
        agbTonnes,
        carbonTonnes,
        co2eTonnes,
        lossPercent,
        alert,
        alertLevel,
      });

      setStatus("Done! Results are shown on the right.");
    }, 1200);
  }

  function downloadGeoJSON() {
    if (!polygonGeoJSON) {
      setStatus("Draw a box first before saving.");
      return;
    }

    const data = JSON.stringify(polygonGeoJSON, null, 2);
    const blob = new Blob([data], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "sylvasense-forest-boundary.geojson";
    link.click();

    URL.revokeObjectURL(url);
    setStatus("File saved.");
  }

  function clearMap() {
    const map = mapRef.current;
    if (map) {
      map.eachLayer((layer) => {
        if (layer instanceof L.Polygon || layer instanceof L.Polyline) {
          map.removeLayer(layer);
        }
      });
    }

    setPolygonGeoJSON(null);
    setPolygonLayer(null);
    setAreaHa(0);
    setResults(null);
    setStatus("Map cleared. Draw a new box.");
  }

  function toggleLayer(layerName) {
    setActiveLayers((prev) => ({
      ...prev,
      [layerName]: !prev[layerName],
    }));
  }

  return (
    <div className="app">
      <header className="header">
        <h1>🌳 SylvaSense</h1>
        <p>Forest checking tool using satellite and radar pictures</p>
      </header>

      <main className="container">
        <div className="toolbar">
          <div className="toolbar-section">
            <strong>Data Layers</strong>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={activeLayers.sentinel2}
                onChange={() => toggleLayer("sentinel2")}
              />
              <Tooltip text="satellite photos that show amount of dense trees and plants(setinel2)">
                <span className="term">Satellite Photos</span>
              </Tooltip>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={activeLayers.sentinel1SAR}
                onChange={() => toggleLayer("sentinel1SAR")}
              />
              <Tooltip text="Radar that can see through clouds used to get more data on tree density(sentinel1)">
                <span className="term">Radar View</span>
              </Tooltip>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={activeLayers.ndvi}
                onChange={() => toggleLayer("ndvi")}
              />
              <Tooltip text="to find conopy density Higher means more plants and vegetation">
                <span className="term">Canopy density value</span>
              </Tooltip>
            </label>
          </div>

          <div className="toolbar-section">
            <label>
              <strong>Forest Type</strong>
              <select
                value={biome}
                onChange={(e) => setBiome(e.target.value)}
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: "6px",
                  padding: "8px",
                }}
              >
                <option>Tropical Forest</option>
                <option>Temperate Forest</option>
                <option>taiga Forest</option>
                <option>Savanna ONANA</option>
              </select>
            </label>
          </div>

          <div className="toolbar-section">
            <button onClick={analyzeForest} className="btn-primary">
               Check Forest
            </button>
            <button onClick={downloadGeoJSON} className="btn-secondary">
               Save Area
            </button>
            <button onClick={clearMap} className="btn-secondary">
              Clear
            </button>
          </div>
        </div>

        <div className="status-bar">
          <span className="status-icon">●</span>
          {status}
        </div>

        <div className="main-grid">
          <section className="map-panel">
            <div className="panel-header">
              <h3> Map</h3>
              <div className="layer-badges">
                {activeLayers.sentinel2 && <span className="badge">Photos</span>}
                {activeLayers.sentinel1SAR && <span className="badge">Radar</span>}
                {activeLayers.ndvi && <span className="badge badge-green">Greenness</span>}
              </div>
            </div>
            <MapContainer
              center={[-3.4653, -62.2159]}
              zoom={5}
              className="map"
              ref={mapRef}
            >
              <TileLayer
                attribution="&copy; OpenStreetMap"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <DrawControl onPolygonCreated={handlePolygonCreated} />
            </MapContainer>
            <div className="map-legend">
              <div><span className="legend-color" style={{background: '#2f7d4a'}}></span>Low Density </div>
              <div><span className="legend-color" style={{background: '#7CFC00'}}></span> Moderate Density</div>
              <div><span className="legend-color" style={{background: '#f97316'}}></span> high Dense Canopy</div>
            </div>
          </section>

          <aside className="metrics-panel">
            <div className="panel-header">
              <h3>🌲 Results</h3>
            </div>

            <div className="metric-card">
              <div className="metric-label">Area Size</div>
              <div className="metric-value">{areaHa.toFixed(2)} ha</div>
            </div>

            {results && (
              <>
                <div className="metric-card highlight">
                  <div className="metric-label">Tree Cover</div>
                  <div className="metric-value">
                    {results.canopyCoverPercent.toFixed(1)}%
                  </div>
                  <div className="metric-sub">
                    Greenness: {results.currentNDVI.toFixed(3)}
                  </div>
                </div>

                <div className="metric-card">
                  <div className="metric-label">Trees Found</div>
                  <div className="metric-value">
                    {results.estimatedTrees.toLocaleString()}
                  </div>
                  <div className="metric-sub">
                    {results.treesPerHectare} per hectare
                  </div>
                </div>

                <div className="metric-card">
                  <div className="metric-label">Wood Weight</div>
                  <div className="metric-value">{results.agbTonnes.toFixed(1)} t</div>
                </div>

                <div className="metric-card">
                  <div className="metric-label">Carbon Stored</div>
                  <div className="metric-value">
                    {results.carbonTonnes.toFixed(1)} tC
                  </div>
                  <div className="metric-sub">
                    {results.co2eTonnes.toFixed(1)} tCO₂e
                  </div>
                </div>

                <div className={`alert-card alert-${results.alertLevel}`}>
                  <div className="alert-icon">
                    {results.alertLevel === "high" && "!!!"}
                    {results.alertLevel === "medium" && "!"}
                    {results.alertLevel === "low" && ";)"}
                  </div>
                  <div>
                    <div className="alert-title">{results.alert}</div>
                    <div className="alert-detail">
                      Tree loss: {results.lossPercent.toFixed(1)}%
                    </div>
                  </div>
                </div>
              </>
            )}
          </aside>
        </div>

        <div className="disclaimer-box">
          <strong>Prototype only:</strong>
          <p>
            this is only a prototype 
          </p>
        </div>
      </main>
    </div>
  );
}

export default App;
