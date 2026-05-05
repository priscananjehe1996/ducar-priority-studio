import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Bot,
  Brain,
  CircleDollarSign,
  ClipboardCheck,
  Database,
  Eye,
  EyeOff,
  FileSpreadsheet,
  GitBranch,
  Gauge,
  Layers,
  LayoutDashboard,
  LineChart,
  MapIcon,
  Network,
  RefreshCcw,
  Route,
  ShieldAlert,
  SlidersHorizontal,
  Target,
} from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import sample from "../data/sample_assets.json";
import { prioritise, summarise } from "./prioritisation.js";
import "./styles.css";

const BASE = import.meta.env.BASE_URL || "/ducar-priority-studio/";
const currency = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/* ─── local ML fallback ─── */
function localAnalysis(records, budget, reservePercent) {
  const netBudget = budget * (1 - reservePercent / 100);
  const programme = prioritise(records, netBudget).map((item) => {
    const mlRisk = Math.min(
      0.99,
      Math.max(
        0.05,
        (Number(item.condition) * 0.22 +
          Number(item.criticality) * 0.18 +
          Number(item.climate) * 0.2 +
          Number(item.safety) * 0.18 +
          (item.maintainable === "No" ? 1.2 : 0) -
          Number(item.readiness) * 0.06) /
          5
      )
    );
    return { ...item, mlRisk, riskBand: mlRisk > 0.72 ? "High" : mlRisk > 0.55 ? "Medium" : "Low" };
  });
  const summary = summarise(programme);
  return {
    netBudget,
    programme,
    summary: {
      records: programme.length,
      selectedCost: programme.filter((p) => p.status === "Selected").reduce((a, p) => a + p.cost, 0),
      deferredCost: programme.filter((p) => p.status === "Deferred").reduce((a, p) => a + p.cost, 0),
      selected: summary.Selected || 0,
      referrals: summary.Referred || 0,
      highRisk: programme.filter((p) => p.riskBand === "High").length,
    },
    ml: { model: "Browser fallback risk model" },
    geospatial: {
      hotspots: [],
      bbox: {
        minLat: Math.min(...programme.map((p) => p.lat)),
        maxLat: Math.max(...programme.map((p) => p.lat)),
        minLon: Math.min(...programme.map((p) => p.lon)),
        maxLon: Math.max(...programme.map((p) => p.lon)),
      },
    },
  };
}

/* ─── Status colours ─── */
const STATUS_COLORS = {
  Selected: "#10b981",
  Deferred: "#f59e0b",
  Referred: "#ef4444",
};

const NAV_ITEMS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "controls", label: "Budget Inputs", icon: SlidersHorizontal },
  { id: "analytics", label: "Analytics", icon: LineChart },
  { id: "framework", label: "Framework Flow", icon: Network },
  { id: "gis", label: "GIS Surface", icon: MapIcon },
  { id: "allocation", label: "Allocation", icon: GitBranch },
  { id: "programme", label: "Programme", icon: FileSpreadsheet },
];

const FLOW_STEPS = [
  {
    title: "Register DUCAR Assets",
    tag: "Inventory",
    detail: "Roads, bridges, districts, regions, road class, surface, location, and intervention need.",
    icon: Database,
  },
  {
    title: "Validate Evidence",
    tag: "QA",
    detail: "Check condition scores, maintainability, cost reasonableness, GIS coordinates, and readiness.",
    icon: ClipboardCheck,
  },
  {
    title: "Score Priority",
    tag: "ML risk",
    detail: "Blend condition, criticality, safety, climate exposure, traffic, equity, and readiness.",
    icon: Brain,
  },
  {
    title: "Rationalise Budget",
    tag: "Fiscal gate",
    detail: "Deduct reserve, compare total demand with available funds, and flag unaffordable items.",
    icon: CircleDollarSign,
  },
  {
    title: "Allocate by Class",
    tag: "Network logic",
    detail: "Sequence candidate works by functional class, region, district, bridge need, and strategic link value.",
    icon: Route,
  },
  {
    title: "Check GIS Equity",
    tag: "Spatial balance",
    detail: "Review hotspots, underserved districts, regional spread, KCCA links, and climate-exposed corridors.",
    icon: MapIcon,
  },
  {
    title: "Approve Programme",
    tag: "Decision",
    detail: "Separate selected, deferred, and referred assets with documented assumptions and reasons.",
    icon: ShieldAlert,
  },
  {
    title: "Export Workplan",
    tag: "Outputs",
    detail: "Produce editable tables, GeoJSON, dashboards, manuals, reports, and implementation packs.",
    icon: Target,
  },
];

/* ─── Metric card ─── */
function Metric({ icon: Icon, label, value, tone = "blue" }) {
  return (
    <div className={`metric ${tone}`}>
      <Icon size={22} />
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function VerticalNav({ activeSection, onNavigate }) {
  return (
    <aside className="vertical-nav" aria-label="DUCAR workspace navigation">
      <div className="nav-brand">
        <span className="brand-mark"><Bot size={19} /></span>
        <div>
          <strong>DUCAR</strong>
          <small>Priority Studio</small>
        </div>
      </div>
      <nav>
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item ${activeSection === id ? "active" : ""}`}
            onClick={() => onNavigate(id)}
            title={label}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="nav-status">
        <Gauge size={16} />
        <span>Live allocation engine</span>
      </div>
    </aside>
  );
}

function ProcessFlow({ analysis, grouped }) {
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActiveStep((step) => (step + 1) % FLOW_STEPS.length);
    }, 2200);
    return () => window.clearInterval(timer);
  }, []);

  const selectedCost = analysis.summary?.selectedCost || 0;
  const netBudget = analysis.netBudget || 0;
  const selectedCount = analysis.summary?.selected || 0;
  const leadingClass = grouped[0]?.[0] || "Awaiting allocation";

  return (
    <section className="panel wide flow-panel" id="framework">
      <div className="panel-title">
        <Network size={18} />
        <h2>Animated Framework Schematic and Tool Process Flow</h2>
      </div>

      <div className="flow-summary">
        <span><strong>Net budget</strong>UGX {currency.format(netBudget)}</span>
        <span><strong>Allocated</strong>UGX {currency.format(selectedCost)}</span>
        <span><strong>Selected works</strong>{selectedCount}</span>
        <span><strong>Leading allocation lane</strong>{leadingClass}</span>
      </div>

      <div className="flow-canvas">
        <svg className="flow-connectors" viewBox="0 0 1000 460" preserveAspectRatio="none" aria-hidden="true">
          <path className="flow-track" d="M80 95 H350 H620 H905 V310 H635 H365 H95" />
          <path className="flow-pulse" d="M80 95 H350 H620 H905 V310 H635 H365 H95" />
        </svg>
        <div className={`flow-bot stage-${activeStep}`} aria-hidden="true">
          <Bot size={24} />
          <span />
        </div>
        <div className="flow-grid">
          {FLOW_STEPS.map(({ title, tag, detail, icon: Icon }, index) => (
            <article
              key={title}
              className={`flow-node ${index === activeStep ? "active" : ""} ${index < activeStep ? "visited" : ""}`}
            >
              <div className="flow-node-head">
                <i><Icon size={18} /></i>
                <span>{String(index + 1).padStart(2, "0")}</span>
              </div>
              <strong>{title}</strong>
              <em>{tag}</em>
              <p>{detail}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Leaflet + OpenStreetMap MapPanel
   ═══════════════════════════════════════════════════════════════════ */
function MapPanel({ programme }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const layersRef = useRef({});
  const assetsLayerRef = useRef(null);

  const [showDistricts, setShowDistricts] = useState(true);
  const [showRoads, setShowRoads] = useState(true);
  const [showOsmMajor, setShowOsmMajor] = useState(true);
  const [showRoadSummary, setShowRoadSummary] = useState(true);
  const [showKCCA, setShowKCCA] = useState(true);
  const [showAssets, setShowAssets] = useState(true);
  const [loading, setLoading] = useState(true);

  // Initialise map once
  useEffect(() => {
    if (mapInstance.current) return;

    const map = L.map(mapRef.current, {
      center: [1.3, 32.5],
      zoom: 7,
      zoomControl: false,
      attributionControl: false,
    });

    // Dark tile layer
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 18,
      subdomains: "abcd",
    }).addTo(map);

    L.control.zoom({ position: "topright" }).addTo(map);
    L.control
      .attribution({ position: "bottomright", prefix: false })
      .addAttribution('&copy; <a href="https://www.openstreetmap.org/">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>')
      .addTo(map);

    mapInstance.current = map;

    // Load GeoJSON layers
    loadLayers(map);

    return () => {
      map.remove();
      mapInstance.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadLayers(map) {
    setLoading(true);
    try {
      // District boundaries
      const distRes = await fetch(`${BASE}data/districts.geojson`);
      if (distRes.ok) {
        const distData = await distRes.json();
        layersRef.current.districts = L.geoJSON(distData, {
          style: () => ({
            color: "rgba(59,130,246,0.4)",
            weight: 1,
            fillColor: "rgba(59,130,246,0.05)",
            fillOpacity: 1,
          }),
          onEachFeature: (feature, layer) => {
            const p = feature.properties;
            const name = p.district || p.admin2Name || "Unknown";
            const roads = p.road_count ?? "—";
            const km = p.total_km ? Number(p.total_km).toLocaleString() : "—";
            layer.bindTooltip(
              `<strong>${name}</strong><br/>Region: ${p.region || "—"}<br/>Roads: ${roads}<br/>Total: ${km} km`,
              { sticky: true, className: "map-tooltip" }
            );
          },
        }).addTo(map);
      }

      // District roads (dissolved)
      const roadsRes = await fetch(`${BASE}data/district_roads_dissolved.geojson`);
      if (roadsRes.ok) {
        const roadsData = await roadsRes.json();
        layersRef.current.roads = L.geoJSON(roadsData, {
          style: () => ({
            color: "rgba(245,158,11,0.35)",
            weight: 1.5,
            dashArray: "4 3",
          }),
          onEachFeature: (feature, layer) => {
            const p = feature.properties;
            layer.bindTooltip(
              `<strong>${p.DistName || "—"}</strong><br/>Class: ${p.RdClass || "—"}<br/>${(p.length_km || 0).toFixed(1)} km`,
              { sticky: true, className: "map-tooltip" }
            );
          },
        }).addTo(map);
      }

      // All-road district summary from OSM + DUCAR master build
      const summaryRes = await fetch(`${BASE}data/uganda_roads_district_summary.geojson`);
      if (summaryRes.ok) {
        const summaryData = await summaryRes.json();
        layersRef.current.roadSummary = L.geoJSON(summaryData, {
          style: (feature) => {
            const km = Number(feature.properties.total_km || 0);
            const intensity = Math.min(0.44, 0.08 + km / 90000);
            return {
              color: "rgba(52,211,153,0.5)",
              weight: 1,
              fillColor: "#34d399",
              fillOpacity: intensity,
            };
          },
          onEachFeature: (feature, layer) => {
            const p = feature.properties;
            layer.bindTooltip(
              `<strong>${p.district || "District"}</strong><br/>All road records: ${Number(p.road_records || 0).toLocaleString()}<br/>Total length: ${Number(p.total_km || 0).toLocaleString()} km<br/>OSM length: ${Number(p.osm_km || 0).toLocaleString()} km<br/>Verify: ${Number(p.verify_count || 0).toLocaleString()}`,
              { sticky: true, className: "map-tooltip" }
            );
          },
        }).addTo(map);
      }

      // OSM major/named roads
      const osmRes = await fetch(`${BASE}data/uganda_osm_major_roads_web.geojson`);
      if (osmRes.ok) {
        const osmData = await osmRes.json();
        const classColor = {
          "National Road": "#60a5fa",
          "District Road": "#fbbf24",
          "Urban Road": "#c084fc",
          "Community Access Road": "#34d399",
          "Unclassified - Verify": "#94a3b8",
        };
        layersRef.current.osmMajor = L.geoJSON(osmData, {
          style: (feature) => {
            const cls = feature.properties.ducar_class;
            return {
              color: classColor[cls] || "#94a3b8",
              weight: cls === "National Road" ? 2.2 : 1.3,
              opacity: cls === "Unclassified - Verify" ? 0.35 : 0.68,
            };
          },
          onEachFeature: (feature, layer) => {
            const p = feature.properties;
            layer.bindTooltip(
              `<strong>${p.road_name || p.road_ref || "Unnamed OSM road"}</strong><br/>OSM: ${p.osm_highway || "—"}<br/>DUCAR: ${p.ducar_class || "—"}<br/>District: ${p.district || "—"}<br/>${Number(p.length_km || 0).toFixed(2)} km<br/>Quality: ${p.data_quality_flag || "—"}`,
              { sticky: true, className: "map-tooltip" }
            );
          },
        }).addTo(map);
      }

      // KCCA roads
      const kccaRes = await fetch(`${BASE}data/kcca_roads.geojson`);
      if (kccaRes.ok) {
        const kccaData = await kccaRes.json();
        layersRef.current.kcca = L.geoJSON(kccaData, {
          style: () => ({
            color: "#a855f7",
            weight: 2.5,
            opacity: 0.8,
          }),
          onEachFeature: (feature, layer) => {
            const p = feature.properties;
            layer.bindTooltip(
              `<strong>${p.Link_Name || p.Road_No_1 || "KCCA Road"}</strong><br/>Surface: ${p.Surface__1 || "—"}<br/>${(p.Length_km_ || 0)} km`,
              { sticky: true, className: "map-tooltip" }
            );
          },
        }).addTo(map);
      }
    } catch (e) {
      console.warn("GeoJSON layer load error:", e);
    }
    setLoading(false);
  }

  // Update asset markers when programme changes
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;

    // Remove old assets
    if (assetsLayerRef.current) {
      map.removeLayer(assetsLayerRef.current);
    }

    const markers = programme.map((p) => {
      const color = STATUS_COLORS[p.status] || "#94a3b8";
      const radius = p.assetType === "Bridge" ? 8 : 6;
      const marker = L.circleMarker([p.lat, p.lon], {
        radius,
        color: "#020617",
        weight: 1.5,
        fillColor: color,
        fillOpacity: 0.9,
      });
      marker.bindPopup(
        `<div class="map-popup">
          <strong>${p.assetId}</strong> <span class="status ${p.status}">${p.status}</span>
          <table>
            <tr><td>Type</td><td>${p.assetType} / ${p.surface}</td></tr>
            <tr><td>District</td><td>${p.admin}</td></tr>
            <tr><td>Region</td><td>${p.region}</td></tr>
            <tr><td>Intervention</td><td>${p.intervention}</td></tr>
            <tr><td>Cost</td><td>UGX ${currency.format(p.cost)}</td></tr>
            <tr><td>ML Risk</td><td><span class="risk ${p.riskBand}">${Math.round((p.mlRisk || 0) * 100)}%</span></td></tr>
          </table>
        </div>`,
        { className: "dark-popup" }
      );
      return marker;
    });

    assetsLayerRef.current = L.layerGroup(markers);
    if (showAssets) assetsLayerRef.current.addTo(map);
  }, [programme, showAssets]);

  // Toggle layer visibility
  const toggleLayer = useCallback((key, visible) => {
    const map = mapInstance.current;
    if (!map) return;
    const layer = key === "assets" ? assetsLayerRef.current : layersRef.current[key];
    if (!layer) return;
    if (visible) map.addLayer(layer);
    else map.removeLayer(layer);
  }, []);

  useEffect(() => { toggleLayer("districts", showDistricts); }, [showDistricts, toggleLayer]);
  useEffect(() => { toggleLayer("roads", showRoads); }, [showRoads, toggleLayer]);
  useEffect(() => { toggleLayer("osmMajor", showOsmMajor); }, [showOsmMajor, toggleLayer]);
  useEffect(() => { toggleLayer("roadSummary", showRoadSummary); }, [showRoadSummary, toggleLayer]);
  useEffect(() => { toggleLayer("kcca", showKCCA); }, [showKCCA, toggleLayer]);
  useEffect(() => { toggleLayer("assets", showAssets); }, [showAssets, toggleLayer]);

  return (
    <section className="panel map-panel" id="gis">
      <div className="map-header">
        <div className="panel-title" style={{ borderBottom: "none", marginBottom: 0, paddingBottom: 0 }}>
          <Layers size={18} />
          <h2>Geospatial Risk Surface — OpenStreetMap</h2>
        </div>
        <div className="layer-toggles">
          <button
            className={`layer-btn ${showDistricts ? "active" : ""}`}
            onClick={() => setShowDistricts(!showDistricts)}
            title="District boundaries"
          >
            {showDistricts ? <Eye size={14} /> : <EyeOff size={14} />} Districts
          </button>
          <button
            className={`layer-btn ${showRoads ? "active" : ""}`}
            onClick={() => setShowRoads(!showRoads)}
            title="District road network"
          >
            {showRoads ? <Eye size={14} /> : <EyeOff size={14} />} Roads
          </button>
          <button
            className={`layer-btn ${showOsmMajor ? "active osm" : ""}`}
            onClick={() => setShowOsmMajor(!showOsmMajor)}
            title="OpenStreetMap major and named roads"
          >
            {showOsmMajor ? <Eye size={14} /> : <EyeOff size={14} />} OSM Roads
          </button>
          <button
            className={`layer-btn ${showRoadSummary ? "active summary" : ""}`}
            onClick={() => setShowRoadSummary(!showRoadSummary)}
            title="District-level all-road summary"
          >
            {showRoadSummary ? <Eye size={14} /> : <EyeOff size={14} />} All-road Summary
          </button>
          <button
            className={`layer-btn ${showKCCA ? "active kcca" : ""}`}
            onClick={() => setShowKCCA(!showKCCA)}
            title="KCCA urban roads"
          >
            {showKCCA ? <Eye size={14} /> : <EyeOff size={14} />} KCCA
          </button>
          <button
            className={`layer-btn ${showAssets ? "active green" : ""}`}
            onClick={() => setShowAssets(!showAssets)}
            title="DUCAR programme assets"
          >
            {showAssets ? <Eye size={14} /> : <EyeOff size={14} />} Assets
          </button>
        </div>
      </div>
      <div className="map-container" ref={mapRef}>
        {loading && (
          <div className="map-loading">
            <div className="spinner" />
            <span>Loading geospatial layers…</span>
          </div>
        )}
      </div>
      <div className="map-legend">
        <span><i className="dot selected" /> Selected</span>
        <span><i className="dot deferred" /> Deferred</span>
        <span><i className="dot referred" /> Referred</span>
        <span><i className="dot osm-dot" /> OSM major/named</span>
        <span><i className="dot summary-dot" /> All-road density</span>
        <span><i className="dot kcca-dot" /> KCCA</span>
        <span><i className="dot district-dot" /> District boundary</span>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   App
   ═══════════════════════════════════════════════════════════════════ */
function App() {
  const [records, setRecords] = useState(sample);
  const [budget, setBudget] = useState(250000000);
  const [reservePercent, setReservePercent] = useState(5);
  const [analysis, setAnalysis] = useState(() => localAnalysis(sample, 250000000, 5));
  const [apiMode, setApiMode] = useState("checking");
  const [filter, setFilter] = useState("All");
  const [activeSection, setActiveSection] = useState("overview");

  async function runAnalysis(nextRecords = records) {
    try {
      const res = await fetch("/api/analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: nextRecords, budget, reservePercent }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      setAnalysis(data);
      setApiMode("Python ML API");
    } catch {
      setAnalysis(localAnalysis(nextRecords, budget, reservePercent));
      setApiMode("Browser fallback");
    }
  }

  useEffect(() => {
    runAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budget, reservePercent]);

  useEffect(() => {
    const sections = NAV_ITEMS.map((item) => document.getElementById(item.id)).filter(Boolean);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target?.id) setActiveSection(visible.target.id);
      },
      { rootMargin: "-20% 0px -65% 0px", threshold: [0.1, 0.25, 0.5] }
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  const programme = analysis.programme || [];
  const shown = filter === "All" ? programme : programme.filter((p) => p.status === filter);
  const grouped = useMemo(() => {
    const group = {};
    for (const item of programme) {
      const key = `${item.region} / ${item.functionalClass}`;
      group[key] = (group[key] || 0) + item.cost;
    }
    return Object.entries(group).sort((a, b) => b[1] - a[1]);
  }, [programme]);

  function updateRecord(assetId, field, value) {
    const next = records.map((r) => (r.assetId === assetId ? { ...r, [field]: value } : r));
    setRecords(next);
    runAnalysis(next);
  }

  function exportGeoJson() {
    const fc = {
      type: "FeatureCollection",
      features: programme.map((p) => ({
        type: "Feature",
        properties: {
          Asset_ID: p.assetId,
          Asset_Type: p.assetType,
          Region: p.region,
          District: p.admin,
          Functional_Class: p.functionalClass,
          Status: p.status,
          Priority_Score: p.score,
          ML_Risk: p.mlRisk,
          Cost_UGX: p.cost,
        },
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(fc, null, 2)], { type: "application/geo+json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "ducar_ml_geospatial_programme.geojson";
    a.click();
  }

  function navigateToSection(id) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(id);
  }

  return (
    <div className="shell">
      <VerticalNav activeSection={activeSection} onNavigate={navigateToSection} />
      <div className="app">
        <header className="hero" id="overview">
          <div>
            <p className="eyebrow">DUCAR Priority Studio v0.5</p>
            <h1>Dynamic ML and Geospatial Budget Allocation Tool</h1>
            <p>
              React + Leaflet/OSM interface with real DUCAR district road networks, KCCA urban roads,
              ML risk scoring, geospatial clustering, and GIS-ready outputs.
            </p>
          </div>
          <div className="hero-actions">
            <span className="api-pill"><Brain size={16} /> {apiMode}</span>
            <button onClick={() => runAnalysis()}><RefreshCcw size={16} /> Re-run ML</button>
            <button className="secondary" onClick={exportGeoJson}><MapIcon size={16} /> Export GeoJSON</button>
          </div>
        </header>

        <section className="control-strip" id="controls">
          <label>
            Received Budget UGX
            <input type="number" value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
          </label>
          <label>
            Emergency Reserve %
            <input type="number" value={reservePercent} onChange={(e) => setReservePercent(Number(e.target.value))} />
          </label>
          <label>
            Programme Filter
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              {["All", "Selected", "Deferred", "Referred", "Check cost"].map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
        </section>

        <section className="metrics-grid" id="analytics">
          <Metric icon={CircleDollarSign} label="Net budget" value={`UGX ${currency.format(analysis.netBudget || 0)}`} />
          <Metric icon={Activity} label="Selected cost" value={`UGX ${currency.format(analysis.summary?.selectedCost || 0)}`} tone="green" />
          <Metric icon={ShieldAlert} label="High ML risk assets" value={analysis.summary?.highRisk || 0} tone="red" />
          <Metric icon={Layers} label="Regions / classes" value={grouped.length} tone="gold" />
        </section>

        <main className="dashboard-grid">
          <ProcessFlow analysis={analysis} grouped={grouped} />
          <MapPanel programme={programme} />

          <section className="panel" id="allocation">
            <div className="panel-title">
              <GitBranch size={18} />
              <h2>Budget Rationalisation by Region and Functional Class</h2>
            </div>
            <div className="bars">
              {grouped.map(([key, value]) => (
                <div className="bar-row" key={key}>
                  <span>{key}</span>
                  <div><i style={{ width: `${Math.min(100, (value / Math.max(...grouped.map((g) => g[1]))) * 100)}%` }} /></div>
                  <strong>{currency.format(value)}</strong>
                </div>
              ))}
            </div>
          </section>

          <section className="panel wide" id="programme">
            <div className="panel-title">
              <Route size={18} />
              <h2>Editable Programme Table</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Asset</th>
                    <th>Region / District</th>
                    <th>Functional Class</th>
                    <th>Intervention</th>
                    <th>Cost</th>
                    <th>Condition</th>
                    <th>Criticality</th>
                    <th>Climate</th>
                    <th>Safety</th>
                    <th>Traffic</th>
                    <th>Equity</th>
                    <th>Readiness</th>
                    <th>ML Risk</th>
                    <th>Status</th>
                    <th>Maintainable</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.assetId}>
                      <td>{p.rank}</td>
                      <td><strong>{p.assetId}</strong><small>{p.assetType} / {p.surface}</small></td>
                      <td>{p.region}<small>{p.admin}</small></td>
                      <td>{p.functionalClass}</td>
                      <td>{p.intervention}</td>
                      <td>UGX {currency.format(p.cost)}</td>
                      {["condition", "criticality", "climate", "safety", "traffic", "equity", "readiness"].map((field) => (
                        <td key={field}>
                          <div className="range-wrap">
                            <input
                              type="range"
                              min="1"
                              max="5"
                              value={records.find((r) => r.assetId === p.assetId)?.[field] || 1}
                              onChange={(e) => updateRecord(p.assetId, field, Number(e.target.value))}
                            />
                            <span className="range-value">{records.find((r) => r.assetId === p.assetId)?.[field] || 1}</span>
                          </div>
                        </td>
                      ))}
                      <td><span className={`risk ${p.riskBand}`}>{Math.round((p.mlRisk || 0) * 100)}%</span></td>
                      <td><span className={`status ${p.status}`}>{p.status}</span></td>
                      <td>
                        <select value={records.find((r) => r.assetId === p.assetId)?.maintainable || "Yes"} onChange={(e) => updateRecord(p.assetId, "maintainable", e.target.value)}>
                          <option>Yes</option>
                          <option>No</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
