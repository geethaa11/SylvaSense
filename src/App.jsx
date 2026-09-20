import { useRef, useState, useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  Polygon,
  Circle,
  Popup,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";
import "./App.css";

// Fix Leaflet default marker/icon paths
delete L.Icon.Default.prototype._getIconUrl;

L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
  iconUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
  shadowUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
});

function getPolygonAreaHectares(latlngs) {
  if (!latlngs || latlngs.length < 3) return 0;

  const points = latlngs.map((p) => ({
    lat: p.lat,
    lng: p.lng,
  }));

  const earthRadius = 6378137;
  let area = 0;

  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];

    const x1 =
      (p1.lng * Math.PI) / 180 *
      earthRadius *
      Math.cos((p1.lat * Math.PI) / 180);

    const y1 = (p1.lat * Math.PI) / 180 * earthRadius;

    const x2 =
      (p2.lng * Math.PI) / 180 *
      earthRadius *
      Math.cos((p2.lat * Math.PI) / 180);

    const y2 = (p2.lat * Math.PI) / 180 * earthRadius;

    area += x1 * y2 - x2 * y1;
  }

  return Math.abs(area) / 2 / 10000;
}

function DrawControl({ onPolygonCreated }) {
  const map = useMap();

  useEffect(() => {
    map.pm.addControls({
      position: "topleft",
      drawText: false,
      drawCircle: false,
      drawCircleMarker: false,
      drawPolyline: false,
      drawRectangle: false,
      drawMarker: false,
      drawPolygon: true,
      editMode: false,
      dragMode: false,
      cutPolygon: false,
      removalMode: false,
    });

    map.on("pm:create", (e) => {
      if (e.shape !== "Polygon") return;

      const layer = e.layer;
      const latlngs = layer.getLatLngs()[0];

      const area = getPolygonAreaHectares(latlngs);
      const geojson = layer.toGeoJSON();

      onPolygonCreated({
        layer,
        area,
        geojson,
        latlngs,
      });
    });

    return () => {
      map.pm.removeControls();
      map.off("pm:create");
    };
  }, [map, onPolygonCreated]);

  return null;
}

function MapEffects({ polygonLayer, validationZones }) {
  const map = useMap();

  useEffect(() => {
    if (!polygonLayer) return;

    map.fitBounds(polygonLayer.getBounds(), {
      padding: [30, 30],
      maxZoom: 12,
    });
  }, [polygonLayer, map]);

  return (
    <>
      {validationZones.map((zone) => (
        <Circle
          key={zone.id}
          center={zone.position}
          radius={zone.radius}
          pathOptions={{
            color: "#d97706",
            fillColor: "#f59e0b",
            fillOpacity: 0.28,
            weight: 2,
          }}
        >
          <Popup>
            <strong>Adaptive Validation Zone</strong>
            <br />
            Priority: {zone.priority}
            <br />
            Reason: {zone.reason}
          </Popup>
        </Circle>
      ))}
    </>
  );
}

function App() {
  const mapRef = useRef(null);

  const [polygonGeoJSON, setPolygonGeoJSON] = useState(null);
  const [polygonLayer, setPolygonLayer] = useState(null);
  const [areaHa, setAreaHa] = useState(0);

  const [biome, setBiome] = useState("Tropical Forest");

  const [results, setResults] = useState(null);

  const [status, setStatus] = useState(
    "Draw a forest polygon on the map to begin analysis."
  );

  const [activeLayers, setActiveLayers] = useState({
    sentinel2: true,
    sentinel1SAR: false,
    ndvi: false,
  });

  const [validationZones, setValidationZones] = useState([]);

  const biomassFactors = {
    "Tropical Forest": 180,
    "Temperate Forest": 120,
    "Boreal Forest": 80,
    "Savanna / Woodland": 55,
  };

  const forestProfiles = {
    "Tropical Forest": {
      baseline: "Dense evergreen canopy",
      spectral: "High vegetation response",
      sar: "Moderate–high structural response",
      canopy: "High",
    },
    "Temperate Forest": {
      baseline: "Seasonal mixed canopy",
      spectral: "Moderate seasonal response",
      sar: "Moderate structural response",
      canopy: "Moderate–high",
    },
    "Boreal Forest": {
      baseline: "Needleleaf-dominant canopy",
      spectral: "Moderate vegetation response",
      sar: "Moderate structural response",
      canopy: "Moderate",
    },
    "Savanna / Woodland": {
      baseline: "Open woodland structure",
      spectral: "Seasonal vegetation response",
      sar: "Lower structural response",
      canopy: "Low–moderate",
    },
  };

  const handlePolygonCreated = ({
    layer,
    area,
    geojson,
    latlngs,
  }) => {
    setPolygonLayer(layer);
    setPolygonGeoJSON(geojson);
    setAreaHa(area);

    setResults(null);
    setValidationZones([]);

    setStatus(
      `Polygon selected: ${area.toFixed(2)} hectares. Ready for analysis.`
    );

    // Keep a visible reference to the selected polygon
    layer.setStyle({
      color: "#2d5a27",
      weight: 3,
      fillColor: "#6aaa45",
      fillOpacity: 0.22,
    });

    // Create a small visual layer effect inside the selected region
    if (latlngs && latlngs.length >= 3) {
      const center = latlngs.reduce(
        (acc, point) => ({
          lat: acc.lat + point.lat / latlngs.length,
          lng: acc.lng + point.lng / latlngs.length,
        }),
        { lat: 0, lng: 0 }
      );

      setValidationZones([
        {
          id: "preview",
          position: [center.lat, center.lng],
          radius: Math.max(150, Math.min(700, area * 12)),
          priority: "Pending",
          reason: "Awaiting forest analysis",
        },
      ]);
    }
  };

  const analyzeForest = () => {
    if (!polygonGeoJSON || areaHa <= 0) {
      setStatus("Please draw a forest polygon first.");
      return;
    }

    setStatus("Analysing multi-sensor forest evidence...");
    setResults(null);

    setTimeout(() => {
      // Prototype values.
      // These represent a simulated MVP workflow, not live satellite inference.
      const simulatedCurrentNDVI = 0.68;
      const simulatedPreviousNDVI = 0.74;

      const canopyFraction = Math.min(
        0.92,
        Math.max(0.35, 0.55 + areaHa / 1000)
      );

      const canopyCoverPercent = canopyFraction * 100;

      const treesPerHectare = Math.round(
        120 + canopyFraction * 480
      );

      const estimatedTrees = Math.round(
        areaHa * treesPerHectare
      );

      const uncertainty = Math.max(
        500,
        Math.round(estimatedTrees * 0.18)
      );

      const biomassFactor = biomassFactors[biome];

      const agbTonnes =
        areaHa * canopyFraction * biomassFactor;

      const agbPerHa =
        areaHa > 0 ? agbTonnes / areaHa : 0;

      const carbonTonnes = agbTonnes * 0.47;
      const co2eTonnes = carbonTonnes * 3.67;

      const lossPercent = Math.max(
        0,
        ((simulatedPreviousNDVI - simulatedCurrentNDVI) /
          simulatedPreviousNDVI) *
          100
      );

      let alert = "NORMAL";
      let alertLevel = "low";

      if (lossPercent > 15) {
        alert = "ALERT";
        alertLevel = "high";
      } else if (lossPercent > 5) {
        alert = "REVIEW";
        alertLevel = "medium";
      }

      // Simulated Forest Fingerprint deviation
      const fingerprintDeviation =
        lossPercent > 8
          ? "High deviation"
          : lossPercent > 4
          ? "Moderate deviation"
          : "Within baseline";

      // Adaptive validation prioritises uncertain/anomalous zones
      const validationPriority =
        alertLevel === "high"
          ? "High"
          : alertLevel === "medium"
          ? "Medium"
          : "Low";

      setResults({
        canopyCoverPercent,
        currentNDVI: simulatedCurrentNDVI,
        previousNDVI: simulatedPreviousNDVI,
        estimatedTrees,
        uncertainty,
        treesPerHectare,
        agbTonnes,
        agbPerHa,
        carbonTonnes,
        co2eTonnes,
        lossPercent,
        alert,
        alertLevel,
        fingerprintDeviation,
        validationPriority,
        evidence: {
          optical: true,
          sar: activeLayers.sentinel1SAR,
          temporal: true,
          fingerprint: true,
        },
      });

      // Put validation zone near the centre of the selected polygon
      if (polygonLayer) {
        const center = polygonLayer.getBounds().getCenter();

        setValidationZones([
          {
            id: "validation-1",
            position: [center.lat, center.lng],
            radius: Math.max(
              180,
              Math.min(850, areaHa * 15)
            ),
            priority: validationPriority,
            reason:
              alertLevel === "low"
                ? "Low uncertainty / stable baseline"
                : "Deviation requires targeted high-resolution validation",
          },
        ]);
      }

      setStatus(
        "Analysis complete. Evidence summary is shown below."
      );
    }, 1200);
  };

  const clearMap = () => {
    if (polygonLayer && mapRef.current) {
      mapRef.current.removeLayer(polygonLayer);
    }

    setPolygonGeoJSON(null);
    setPolygonLayer(null);
    setAreaHa(0);
    setResults(null);
    setValidationZones([]);

    setStatus(
      "Draw a forest polygon on the map to begin analysis."
    );
  };

  const downloadGeoJSON = () => {
    if (!polygonGeoJSON) return;

    const blob = new Blob(
      [JSON.stringify(polygonGeoJSON, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "sylvasense-forest-polygon.geojson";
    link.click();

    URL.revokeObjectURL(url);
  };

  const toggleLayer = (layer) => {
    setActiveLayers((previous) => ({
      ...previous,
      [layer]: !previous[layer],
    }));
  };

  const profile = forestProfiles[biome];

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>SYLVASENSE</h1>
          <p>
            Evidence-Backed Forest Intelligence
          </p>
        </div>

        <div className="header-badge">
          ORION-PS-03
        </div>
      </header>

      <main className="main-content">
        <section className="toolbar">
          <div className="control-group">
            <label>Forest Type</label>

            <select
              value={biome}
              onChange={(e) => {
                setBiome(e.target.value);
                setResults(null);
                setStatus(
                  `${e.target.value} selected. Draw a polygon or analyse an existing one.`
                );
              }}
            >
              <option>Tropical Forest</option>
              <option>Temperate Forest</option>
              <option>Boreal Forest</option>
              <option>Savanna / Woodland</option>
            </select>
          </div>

          <div className="control-group">
            <label>Data Layers</label>

            <div className="layer-buttons">
              <button
                className={
                  activeLayers.sentinel2
                    ? "layer-btn active"
                    : "layer-btn"
                }
                onClick={() => toggleLayer("sentinel2")}
              >
                🛰️ Optical
              </button>

              <button
                className={
                  activeLayers.sentinel1SAR
                    ? "layer-btn active"
                    : "layer-btn"
                }
                onClick={() => toggleLayer("sentinel1SAR")}
              >
                📡 SAR
              </button>

              <button
                className={
                  activeLayers.ndvi
                    ? "layer-btn active"
                    : "layer-btn"
                }
                onClick={() => toggleLayer("ndvi")}
              >
                🌿 NDVI
              </button>
            </div>
          </div>

          <div className="toolbar-actions">
            <button
              className="btn-primary"
              onClick={analyzeForest}
            >
              Analyse Forest
            </button>

            <button
              className="btn-secondary"
              onClick={clearMap}
            >
              Clear
            </button>
          </div>
        </section>

        <div className="status-bar">
          <span className="status-dot"></span>
          {status}
        </div>

        <section className="workspace">
          <div className="map-panel">
            <div className="panel-header">
              <div>
                <h2>Forest Analysis Map</h2>
                <p>
                  Select a polygon to analyse forest conditions
                </p>
              </div>

              {areaHa > 0 && (
                <span className="area-badge">
                  {areaHa.toFixed(2)} ha
                </span>
              )}
            </div>

            <div className="map-container">
              <MapContainer
                center={[-3.4653, -62.2159]}
                zoom={5}
                style={{ height: "100%", width: "100%" }}
                ref={mapRef}
              >
                <TileLayer
                  attribution='&copy; OpenStreetMap contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />

                <DrawControl
                  onPolygonCreated={handlePolygonCreated}
                />

                <MapEffects
                  polygonLayer={polygonLayer}
                  validationZones={validationZones}
                />

                {polygonLayer && (
                  <Polygon
                    positions={polygonLayer.getLatLngs()[0]}
                    pathOptions={{
                      color:
                        biome === "Tropical Forest"
                          ? "#15803d"
                          : biome === "Temperate Forest"
                          ? "#2563eb"
                          : biome === "Boreal Forest"
                          ? "#0891b2"
                          : "#ca8a04",
                      fillColor:
                        biome === "Tropical Forest"
                          ? "#22c55e"
                          : biome === "Temperate Forest"
                          ? "#60a5fa"
                          : biome === "Boreal Forest"
                          ? "#67e8f9"
                          : "#facc15",
                      fillOpacity: 0.25,
                      weight: 3,
                    }}
                  />
                )}
              </MapContainer>

              <div className="map-legend">
                <strong>Map Legend</strong>

                <div>
                  <span className="legend-dot normal"></span>
                  Selected Forest
                </div>

                <div>
                  <span className="legend-dot validation"></span>
                  Validation Priority Zone
                </div>
              </div>
            </div>

            <div className="map-footer">
              <span>
                🌲 Profile: <strong>{biome}</strong>
              </span>

              <span>
                Baseline: <strong>{profile.baseline}</strong>
              </span>

              {polygonGeoJSON && (
                <button
                  className="download-btn"
                  onClick={downloadGeoJSON}
                >
                  ↓ Export GeoJSON
                </button>
              )}
            </div>
          </div>

          <aside className="results-panel">
            <div className="panel-header">
              <div>
                <h2>Forest Intelligence</h2>
                <p>Evidence-backed prototype outputs</p>
              </div>
            </div>

            {!results ? (
              <div className="empty-state">
                <div className="empty-icon">🌳</div>

                <h3>Ready for Analysis</h3>

                <p>
                  Draw a forest polygon on the map and
                  click <strong>Analyse Forest</strong>.
                </p>
              </div>
            ) : (
              <>
                <div className="metrics-grid">
                  <div className="metric-card">
                    <span>Area</span>
                    <strong>
                      {areaHa.toFixed(1)} ha
                    </strong>
                  </div>

                  <div className="metric-card">
                    <span>Canopy Cover</span>
                    <strong>
                      {results.canopyCoverPercent.toFixed(1)}%
                    </strong>
                  </div>

                  <div className="metric-card">
                    <span>Tree Population</span>
                    <strong>
                      {results.estimatedTrees.toLocaleString()}
                    </strong>

                    <small>
                      ±{" "}
                      {results.uncertainty.toLocaleString()} stems
                    </small>
                  </div>

                  <div className="metric-card">
                    <span>AGB</span>
                    <strong>
                      {results.agbPerHa.toFixed(1)}
                    </strong>

                    <small>Mg/ha</small>
                  </div>
                </div>

                <div className="fingerprint-card">
                  <div className="section-title">
                    🌲 Forest Fingerprint
                  </div>

                  <div className="fingerprint-grid">
                    <div>
                      <span>Spectral</span>
                      <strong>{profile.spectral}</strong>
                    </div>

                    <div>
                      <span>SAR</span>
                      <strong>{profile.sar}</strong>
                    </div>

                    <div>
                      <span>Canopy</span>
                      <strong>{profile.canopy}</strong>
                    </div>

                    <div>
                      <span>Deviation</span>
                      <strong>
                        {results.fingerprintDeviation}
                      </strong>
                    </div>
                  </div>
                </div>

                <div className="evidence-card">
                  <div className="section-title">
                    📊 Evidence Fusion
                  </div>

                  <div className="evidence-list">
                    <div>
                      Optical
                      <span>
                        {results.evidence.optical ? "✓" : "—"}
                      </span>
                    </div>

                    <div>
                      SAR
                      <span>
                        {results.evidence.sar ? "✓" : "—"}
                      </span>
                    </div>

                    <div>
                      Temporal
                      <span>
                        {results.evidence.temporal ? "✓" : "—"}
                      </span>
                    </div>

                    <div>
                      Fingerprint
                      <span>
                        {results.evidence.fingerprint ? "✓" : "—"}
                      </span>
                    </div>
                  </div>
                </div>

                <div
                  className={`alert-card ${results.alertLevel}`}
                >
                  <div>
                    <span>Forest Status</span>
                    <strong>{results.alert}</strong>
                  </div>

                  <div>
                    <span>Canopy Change</span>
                    <strong>
                      {results.lossPercent.toFixed(1)}%
                    </strong>
                  </div>
                </div>

                <div className="validation-card">
                  <div>
                    <span>🔍 Adaptive Validation</span>
                    <strong>
                      {results.validationPriority} Priority
                    </strong>
                  </div>

                  <p>
                    Zones showing higher deviation or
                    uncertainty are prioritised for
                    high-resolution validation.
                  </p>
                </div>

                <div className="prototype-note">
                  Prototype output: satellite inference,
                  validation and uncertainty values are
                  simulated for the current MVP.
                </div>
              </>
            )}
          </aside>
        </section>
      </main>
    </div>
  );
}

export default App;

