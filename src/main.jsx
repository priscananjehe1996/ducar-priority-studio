import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowLeft,
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
  ListFilter,
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
  Truck,
} from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
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
  { id: "traffic", label: "Traffic Analytics", icon: Truck },
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

const TRAFFIC_CONSIDERATIONS = [
  ["Data Type", "Inventory, condition, traffic, climate, crash, cost, speed, works, emissions, and economic parameter records."],
  ["Representative Vehicles", "Motorcycles, passenger cars, taxis, minibuses, buses, light goods, medium/heavy goods, and multi-axle trucks."],
  ["Climate Zones", "Rainfall, temperature, flood exposure, terrain, drainage sensitivity, and climate-stress screening."],
  ["Axle Loading", "Equivalent standard axle loading, overloaded freight flags, weighbridge evidence, and vehicle mass assumptions."],
  ["Road Deterioration Models", "Roughness, cracking, rutting, gravel loss, potholing, drainage distress, and bridge/culvert risk."],
  ["Work Effects Models", "Routine maintenance, grading, resealing, overlay, rehabilitation, reconstruction, and climate resilience effects."],
  ["Road User Effects Models", "Vehicle operating cost, speed, travel time, safety, reliability, emissions, and detour impacts."],
  ["Unit Costs by Surface Type", "Bituminous, gravel, earth, concrete, structures, drainage, safety furniture, and traffic management rates."],
  ["Traffic Flow Patterns", "Hourly/daily/seasonal profiles, peak spreading, market days, school traffic, freight corridors, and urban delay."],
  ["Speed Flow Types", "Free-flow, interrupted, urban arterial, rural two-lane, gravel, steep terrain, and congested approaches."],
  ["Speed Reduction Factors", "Surface, curvature, gradient, narrow carriageway, settlements, work zones, weather, and heavy vehicle share."],
  ["Traffic Growth Rates", "Base year AADT, normal growth, generated traffic, diverted traffic, freight growth, and induced demand."],
  ["Vehicle Utilization", "Annual kilometres, occupancy/load factors, operating hours, empty running, and fleet age."],
  ["Travel Time Valuation", "Passenger work/non-work time, freight inventory time, public transport occupancy, and regional income assumptions."],
  ["Unit Costs of Vehicle Resources", "Fuel, tyres, oil, maintenance parts, crew, depreciation, capital cost, insurance, and overheads."],
  ["Accident Data", "Fatal, serious, minor, damage-only crashes, risk exposure, blackspots, and safety countermeasure benefits."],
  ["Emissions", "Fuel use, CO2e, NOx, PM, speed-emission curves, roughness effects, and climate-cost screening."],
  ["Road Network Matrix", "Origin-destination, district-region links, functional class, alternative routes, bridges, and service access."],
  ["Work Standards", "Trigger thresholds, treatment rules, service levels, design lives, unit rates, and implementation constraints."],
  ["Economic Analysis Parameters", "Discount rate, analysis period, residual value, shadow pricing, VOC/time/safety benefits, and sensitivity tests."],
  ["Analysis Groups", "Region, district, functional class, surface, traffic band, climate-risk band, poverty/equity band, and agency owner."],
];

const OPEN_DATA_LOGIC = [
  "OpenStreetMap/Geofabrik highway tags feed road type, name/ref, and open mapping confidence.",
  "World Bank HDM-4 road user cost logic informs vehicle resource costs, travel time, emissions, and accident-cost placeholders.",
  "WorldClim and NASA POWER-style climate fields are reserved for rainfall, temperature, and climate-stress joins.",
  "Local UNRA/DUCAR/KCCA shapefiles remain authoritative where they conflict with generic open mapping.",
];

const DUCAR_EXEMPTION_TEXT =
  "National roads are visible as a reference layer for connectivity and double-counting checks, but DUCAR analysis, prioritisation and budget allocation focus on non-national roads unless a formal delegation exists.";

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

function SignalTile({ label, value, sublabel, tone = "blue" }) {
  return (
    <article className={`signal-tile ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{sublabel}</em>
    </article>
  );
}

function ProgrammeDonut({ programme }) {
  const counts = ["Selected", "Deferred", "Referred"].map((status) => ({
    status,
    value: programme.filter((p) => p.status === status).length,
    color: STATUS_COLORS[status],
  }));
  const total = Math.max(1, counts.reduce((sum, item) => sum + item.value, 0));
  let offset = 25;
  return (
    <section className="viz-card">
      <div className="viz-title">
        <h3>Programme decision split</h3>
        <span>{total} assets</span>
      </div>
      <div className="donut-wrap">
        <svg viewBox="0 0 120 120" role="img" aria-label="Programme status split">
          <circle cx="60" cy="60" r="42" className="donut-bg" />
          {counts.map((item) => {
            const length = (item.value / total) * 264;
            const segment = (
              <circle
                key={item.status}
                cx="60"
                cy="60"
                r="42"
                className="donut-segment"
                style={{ stroke: item.color, strokeDasharray: `${length} ${264 - length}`, strokeDashoffset: -offset }}
              />
            );
            offset += length;
            return segment;
          })}
          <text x="60" y="56" textAnchor="middle" className="donut-number">{counts[0].value}</text>
          <text x="60" y="73" textAnchor="middle" className="donut-label">selected</text>
        </svg>
        <div className="donut-legend">
          {counts.map((item) => (
            <span key={item.status}><i style={{ background: item.color }} />{item.status}: {item.value}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function AllocationBarChart({ grouped }) {
  const top = grouped.slice(0, 7);
  const max = Math.max(1, ...top.map((item) => item[1]));
  return (
    <section className="viz-card wide-viz">
      <div className="viz-title">
        <h3>Allocation lanes</h3>
        <span>Top region / class groupings</span>
      </div>
      <div className="mini-bars">
        {top.map(([label, value], index) => (
          <div className="mini-bar" key={label}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{label}</strong>
            <div><i style={{ width: `${(value / max) * 100}%` }} /></div>
            <em>UGX {currency.format(value)}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

function RiskHeatmap({ programme }) {
  const regions = [...new Set(programme.map((p) => p.region))].slice(0, 6);
  const classes = [...new Set(programme.map((p) => p.functionalClass))].slice(0, 5);
  return (
    <section className="viz-card wide-viz">
      <div className="viz-title">
        <h3>Risk intensity matrix</h3>
        <span>Region x functional class</span>
      </div>
      <div className="heatmap-grid" style={{ gridTemplateColumns: `110px repeat(${classes.length}, minmax(76px, 1fr))` }}>
        <b />
        {classes.map((item) => <b key={item}>{item}</b>)}
        {regions.map((region) => (
          <React.Fragment key={region}>
            <b>{region}</b>
            {classes.map((cls) => {
              const items = programme.filter((p) => p.region === region && p.functionalClass === cls);
              const avg = items.length ? items.reduce((sum, p) => sum + (p.mlRisk || 0), 0) / items.length : 0;
              return (
                <span
                  key={`${region}-${cls}`}
                  style={{ "--risk": avg }}
                  title={`${region} / ${cls}: ${Math.round(avg * 100)}% risk`}
                >
                  {items.length ? `${Math.round(avg * 100)}%` : "—"}
                </span>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function InfographicPanel({ analysis, grouped, programme }) {
  const selected = analysis.summary?.selected || 0;
  const highRisk = analysis.summary?.highRisk || 0;
  const netBudget = analysis.netBudget || 0;
  const selectedCost = analysis.summary?.selectedCost || 0;
  const absorption = netBudget ? Math.round((selectedCost / netBudget) * 100) : 0;
  const leadingLane = grouped[0]?.[0] || "Awaiting allocation";
  return (
    <section className="infographic-panel">
      <div className="traffic-hero-card">
        <p className="eyebrow">Allocation index</p>
        <strong>{absorption}%</strong>
        <span>of net budget committed to selected works</span>
        <div className="index-scale">
          <i style={{ left: `${Math.min(96, Math.max(4, absorption))}%` }} />
        </div>
      </div>
      <div className="signal-grid">
        <SignalTile label="Selected works" value={selected} sublabel="funded in current scenario" tone="green" />
        <SignalTile label="High risk" value={highRisk} sublabel="assets requiring attention" tone="red" />
        <SignalTile label="Leading lane" value={leadingLane.split("/")[0].trim()} sublabel={leadingLane.split("/")[1]?.trim() || "network class"} tone="cyan" />
      </div>
      <ProgrammeDonut programme={programme} />
    </section>
  );
}

function TrafficAnalyticsPanel({ programme, grouped }) {
  const trafficIndex = Math.round(
    Math.min(100, 18 + programme.reduce((sum, p) => sum + Number(p.traffic || 0) + Number(p.safety || 0), 0) * 2.4)
  );
  const climateIndex = Math.round(
    Math.min(100, 12 + programme.reduce((sum, p) => sum + Number(p.climate || 0), 0) * 4.6)
  );
  return (
    <div className="traffic-page-grid">
      <section className="traffic-command-card">
        <p className="eyebrow">Traffic and economic engine</p>
        <strong>{trafficIndex}</strong>
        <span>DUCAR non-national network pressure score from traffic, safety, surface and risk inputs</span>
        <div className="index-scale"><i style={{ left: `${trafficIndex}%` }} /></div>
        <p className="exemption-text">{DUCAR_EXEMPTION_TEXT}</p>
      </section>
      <section className="signal-grid">
        <SignalTile label="Climate stress" value={`${climateIndex}%`} sublabel="screening placeholder" tone="cyan" />
        <SignalTile label="Analysis groups" value={grouped.length} sublabel="region/class budget groups" tone="green" />
        <SignalTile label="Open data logic" value={OPEN_DATA_LOGIC.length} sublabel="linked evidence streams" tone="red" />
      </section>
      <section className="viz-card traffic-model-card">
        <div className="viz-title">
          <h3>Required analytical considerations</h3>
          <span>HDM-style parameter library</span>
        </div>
        <div className="consideration-grid">
          {TRAFFIC_CONSIDERATIONS.map(([label, detail]) => (
            <article key={label}>
              <strong>{label}</strong>
              <p>{detail}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="viz-card">
        <div className="viz-title">
          <h3>Open-source data thinking</h3>
          <span>provenance-first</span>
        </div>
        <div className="open-data-list">
          {OPEN_DATA_LOGIC.map((item) => <p key={item}>{item}</p>)}
        </div>
      </section>
    </div>
  );
}

function MapScene3D({ programme }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const [roads, setRoads] = useState(null);
  const [roadSystemFilter, setRoadSystemFilter] = useState("All");
  const [roadClassFilter, setRoadClassFilter] = useState("All");
  const [surfaceFilter, setSurfaceFilter] = useState("All");
  const [roadSort, setRoadSort] = useState("length_km");
  const [showSummary, setShowSummary] = useState(true);
  const [showAssets, setShowAssets] = useState(true);

  const roadOptions = useMemo(() => {
    const features = roads?.features || [];
    const values = (field) => ["All", ...[...new Set(features.map((f) => f.properties?.[field]).filter(Boolean))].sort()];
    return { systems: values("road_system"), classes: values("road_class"), surfaces: values("surface") };
  }, [roads]);

  const filteredRoads = useMemo(() => {
    const features = roads?.features || [];
    return features
      .filter((f) => roadSystemFilter === "All" || f.properties?.road_system === roadSystemFilter)
      .filter((f) => roadClassFilter === "All" || f.properties?.road_class === roadClassFilter)
      .filter((f) => surfaceFilter === "All" || f.properties?.surface === surfaceFilter)
      .sort((a, b) => {
        const av = a.properties?.[roadSort];
        const bv = b.properties?.[roadSort];
        return typeof av === "number" && typeof bv === "number" ? bv - av : String(av || "").localeCompare(String(bv || ""));
      });
  }, [roads, roadSystemFilter, roadClassFilter, surfaceFilter, roadSort]);

  const programmeGeoJson = useMemo(() => ({
    type: "FeatureCollection",
    features: programme.map((p) => ({
      type: "Feature",
      properties: { status: p.status, label: p.assetId, risk: p.riskBand },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    })),
  }), [programme]);

  useEffect(() => {
    if (mapInstance.current) return;
    const map = new maplibregl.Map({
      container: mapRef.current,
      center: [32.5, 1.3],
      zoom: 6.9,
      pitch: 62,
      bearing: -20,
      antialias: true,
      style: {
        version: 8,
        sources: {
          carto: {
            type: "raster",
            tiles: ["https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap © CARTO",
          },
        },
        layers: [{ id: "carto", type: "raster", source: "carto" }],
      },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    mapInstance.current = map;
    map.on("load", async () => {
      const [roadData, summaryData] = await Promise.all([
        fetch(`${BASE}data/uganda_unified_roads_web.geojson`).then((r) => r.json()),
        fetch(`${BASE}data/uganda_roads_district_summary.geojson`).then((r) => r.json()),
      ]);
      setRoads(roadData);
      map.addSource("roads", { type: "geojson", data: roadData });
      map.addSource("summary", { type: "geojson", data: summaryData });
      map.addSource("assets", { type: "geojson", data: programmeGeoJson });
      map.addLayer({
        id: "summary-fill",
        type: "fill",
        source: "summary",
        paint: {
          "fill-color": ["interpolate", ["linear"], ["to-number", ["get", "total_km"]], 0, "#ecfeff", 600, "#a7f3d0", 2500, "#22c55e"],
          "fill-opacity": 0.28,
        },
      });
      const roadLayers = [
        ["roads-ducar", "DUCAR", "#f59e0b", 5.8, null],
        ["roads-national", "National", "#64748b", 5.2, [2, 1.2]],
        ["roads-open", "Open mapping", "#059669", 3.4, null],
        ["roads-urban", "Urban", "#9333ea", 4.6, null],
      ];
      for (const [id, system, color, width, dash] of roadLayers) {
        map.addLayer({
          id: `${id}-halo`,
          type: "line",
          source: "roads",
          filter: ["==", ["get", "road_system"], system],
          paint: { "line-color": "#ffffff", "line-width": width + 4, "line-opacity": 0.94, "line-blur": 0.6 },
        });
        map.addLayer({
          id,
          type: "line",
          source: "roads",
          filter: ["==", ["get", "road_system"], system],
          paint: { "line-color": color, "line-width": width, "line-opacity": system === "National" ? 0.58 : 0.96, ...(dash ? { "line-dasharray": dash } : {}) },
        });
      }
      map.addLayer({
        id: "assets",
        type: "circle",
        source: "assets",
        paint: {
          "circle-radius": ["case", ["==", ["get", "status"], "Selected"], 8, 6],
          "circle-color": ["match", ["get", "status"], "Selected", "#10b981", "Deferred", "#f59e0b", "Referred", "#ef4444", "#2563eb"],
          "circle-stroke-color": "#102033",
          "circle-stroke-width": 2,
        },
      });
      map.on("mousemove", "roads-ducar", (e) => showRoadPopup(map, e));
      map.on("mousemove", "roads-national", (e) => showRoadPopup(map, e));
      map.on("mousemove", "roads-open", (e) => showRoadPopup(map, e));
      map.on("mousemove", "roads-urban", (e) => showRoadPopup(map, e));
    });
    return () => { map.remove(); mapInstance.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function showRoadPopup(map, e) {
    map.getCanvas().style.cursor = "pointer";
    const p = e.features?.[0]?.properties || {};
    new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: 12 })
      .setLngLat(e.lngLat)
      .setHTML(`<strong>${p.road_name || "Road"}</strong><br/>${p.road_system} / ${p.road_class}<br/>${p.surface} • ${Number(p.length_km || 0).toLocaleString()} km<br/><b>${p.ducar_analysis_scope || ""}</b>`)
      .addTo(map);
  }

  useEffect(() => {
    const map = mapInstance.current;
    if (!map?.isStyleLoaded() || !map.getSource("roads")) return;
    map.getSource("roads").setData({ type: "FeatureCollection", features: filteredRoads });
  }, [filteredRoads]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map?.isStyleLoaded()) return;
    if (map.getLayer("summary-fill")) map.setLayoutProperty("summary-fill", "visibility", showSummary ? "visible" : "none");
  }, [showSummary]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map?.isStyleLoaded()) return;
    if (map.getSource("assets")) map.getSource("assets").setData(programmeGeoJson);
    if (map.getLayer("assets")) map.setLayoutProperty("assets", "visibility", showAssets ? "visible" : "none");
  }, [programmeGeoJson, showAssets]);

  return (
    <section className="panel map-panel map3d-panel" id="gis">
      <div className="map-header">
        <div className="panel-title" style={{ borderBottom: "none", marginBottom: 0, paddingBottom: 0 }}>
          <Layers size={18} />
          <h2>3D Uganda Road Intelligence Scene</h2>
        </div>
        <div className="layer-toggles">
          <button className="layer-btn active unified">3D Roads</button>
          <button className={`layer-btn ${showSummary ? "active summary" : ""}`} onClick={() => setShowSummary(!showSummary)}>{showSummary ? <Eye size={14} /> : <EyeOff size={14} />} Density</button>
          <button className={`layer-btn ${showAssets ? "active green" : ""}`} onClick={() => setShowAssets(!showAssets)}>{showAssets ? <Eye size={14} /> : <EyeOff size={14} />} Assets</button>
        </div>
      </div>
      <div className="road-filter-bar">
        <p className="scope-note">{DUCAR_EXEMPTION_TEXT}</p>
        <label><ListFilter size={16} /> System<select value={roadSystemFilter} onChange={(e) => setRoadSystemFilter(e.target.value)}>{roadOptions.systems.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Class<select value={roadClassFilter} onChange={(e) => setRoadClassFilter(e.target.value)}>{roadOptions.classes.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Surface<select value={surfaceFilter} onChange={(e) => setSurfaceFilter(e.target.value)}>{roadOptions.surfaces.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Sort<select value={roadSort} onChange={(e) => setRoadSort(e.target.value)}>{["length_km", "road_name", "road_class", "region", "district", "quality_flag"].map((x) => <option key={x}>{x}</option>)}</select></label>
        <strong>{filteredRoads.length.toLocaleString()} roads</strong>
      </div>
      <div className="maplibre-container" ref={mapRef} />
      <div className="map-legend logical-legend">
        <span><i className="line-swatch ducar-line" /> DUCAR roads</span>
        <span><i className="line-swatch national-line" /> National reference only</span>
        <span><i className="line-swatch open-line" /> Open mapping candidates</span>
        <span><i className="line-swatch urban-line" /> Urban/KCCA</span>
        <span><i className="dot summary-dot" /> Road density surface</span>
        <span><i className="dot selected" /> Selected asset</span>
      </div>
    </section>
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
          <a
            key={id}
            href={`#${id}`}
            className={`nav-item ${activeSection === id ? "active" : ""}`}
            onClick={() => onNavigate(id)}
            title={label}
          >
            <Icon size={18} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="nav-status">
        <Gauge size={16} />
        <span>Live allocation engine</span>
      </div>
    </aside>
  );
}

function PageChrome({ page, onBack, children }) {
  const Icon = page.icon;
  const isHome = page.id === "overview";
  return (
    <section className={`page page-${page.id}`} id={page.id}>
      <div className="page-topbar">
        {!isHome && (
          <a className="back-link" href="#overview" onClick={onBack}>
            <ArrowLeft size={18} />
            <span>Back</span>
          </a>
        )}
        <div className="page-heading">
          <Icon size={24} />
          <div>
            <p className="eyebrow">{page.label}</p>
            <h1>{page.title}</h1>
          </div>
        </div>
      </div>
      {children}
    </section>
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
  const unifiedRoadLayerRef = useRef(null);

  const [showDistricts, setShowDistricts] = useState(true);
  const [showRoads, setShowRoads] = useState(false);
  const [showUnifiedRoads, setShowUnifiedRoads] = useState(true);
  const [showNational, setShowNational] = useState(false);
  const [showOsmMajor, setShowOsmMajor] = useState(false);
  const [showRoadSummary, setShowRoadSummary] = useState(true);
  const [showKCCA, setShowKCCA] = useState(false);
  const [showAssets, setShowAssets] = useState(true);
  const [loading, setLoading] = useState(true);
  const [roadData, setRoadData] = useState(null);
  const [roadSystemFilter, setRoadSystemFilter] = useState("All");
  const [roadClassFilter, setRoadClassFilter] = useState("All");
  const [surfaceFilter, setSurfaceFilter] = useState("All");
  const [roadSort, setRoadSort] = useState("length_km");

  // Initialise map once
  useEffect(() => {
    if (mapInstance.current) return;

    const map = L.map(mapRef.current, {
      center: [1.3, 32.5],
      zoom: 7,
      zoomControl: false,
      attributionControl: false,
    });

    // Light OSM-derived tile layer
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
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
        if (!showRoads) map.removeLayer(layersRef.current.roads);
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
        if (!showNational) map.removeLayer(layersRef.current.national);
      }

      // National road network FY25/26
      const nationalRes = await fetch(`${BASE}data/uganda_national_roads_fy25_26.geojson`);
      if (nationalRes.ok) {
        const nationalData = await nationalRes.json();
        const nationalColor = {
          "Main National Road": "#38bdf8",
          "Class A National Road": "#60a5fa",
          "Class B National Road": "#818cf8",
          "Class C National Road": "#a78bfa",
        };
        layersRef.current.national = L.geoJSON(nationalData, {
          style: (feature) => {
            const cls = feature.properties.road_class;
            const sealed = feature.properties.surface === "Bituminous";
            return {
              color: nationalColor[cls] || "#93c5fd",
              weight: cls === "Main National Road" ? 3.2 : cls === "Class A National Road" ? 2.6 : 2,
              opacity: 0.86,
              dashArray: sealed ? null : "6 4",
            };
          },
          onEachFeature: (feature, layer) => {
            const p = feature.properties;
            layer.bindTooltip(
              `<strong>${p.road_no || "National road"}: ${p.road_name || "Unnamed link"}</strong><br/>Class: ${p.road_class || "—"}<br/>Surface: ${p.surface || "—"}<br/>Region: ${p.maintenance_region || "—"} / ${p.maintenance_district || "—"}<br/>Length: ${Number(p.length_km || 0).toLocaleString()} km<br/>NDP IV: ${p.ndpiv_priority || "—"}`,
              { sticky: true, className: "map-tooltip" }
            );
          },
        }).addTo(map);
        if (!showOsmMajor) map.removeLayer(layersRef.current.osmMajor);
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
        if (!showKCCA) map.removeLayer(layersRef.current.kcca);
      }
      const unifiedRes = await fetch(`${BASE}data/uganda_unified_roads_web.geojson`);
      if (unifiedRes.ok) setRoadData(await unifiedRes.json());

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

  const roadOptions = useMemo(() => {
    const features = roadData?.features || [];
    const values = (field) => ["All", ...[...new Set(features.map((f) => f.properties?.[field]).filter(Boolean))].sort()];
    return { systems: values("road_system"), classes: values("road_class"), surfaces: values("surface") };
  }, [roadData]);

  const filteredRoads = useMemo(() => {
    const features = roadData?.features || [];
    return features
      .filter((f) => roadSystemFilter === "All" || f.properties?.road_system === roadSystemFilter)
      .filter((f) => roadClassFilter === "All" || f.properties?.road_class === roadClassFilter)
      .filter((f) => surfaceFilter === "All" || f.properties?.surface === surfaceFilter)
      .sort((a, b) => {
        const av = a.properties?.[roadSort];
        const bv = b.properties?.[roadSort];
        return typeof av === "number" && typeof bv === "number" ? bv - av : String(av || "").localeCompare(String(bv || ""));
      });
  }, [roadData, roadSystemFilter, roadClassFilter, surfaceFilter, roadSort]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !roadData) return;
    if (unifiedRoadLayerRef.current) map.removeLayer(unifiedRoadLayerRef.current);
    const colors = { DUCAR: "#f59e0b", National: "#64748b", "Open mapping": "#059669", Urban: "#9333ea" };
    unifiedRoadLayerRef.current = L.geoJSON({ type: "FeatureCollection", features: filteredRoads }, {
      style: (feature) => ({
        color: colors[feature.properties.road_system] || "#64748b",
        weight: feature.properties.road_system === "National" ? 2.7 : 1.6,
        opacity: feature.properties.ducar_analysis_scope?.startsWith("Reference") ? 0.34 : feature.properties.quality_flag === "OK" ? 0.84 : 0.48,
        dashArray: feature.properties.ducar_analysis_scope?.startsWith("Reference") ? "8 6" : feature.properties.quality_flag === "OK" ? null : "5 4",
      }),
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        layer.bindTooltip(
          `<strong>${p.road_name || "Road"}</strong><br/>System: ${p.road_system}<br/>Class: ${p.road_class}<br/>Surface: ${p.surface}<br/>Region/District: ${p.region} / ${p.district}<br/>Length: ${Number(p.length_km || 0).toLocaleString()} km<br/>Scope: ${p.ducar_analysis_scope}<br/>Clause: ${p.exemption_clause}<br/>Quality: ${p.quality_flag}`,
          { sticky: true, className: "map-tooltip" }
        );
      },
    });
    if (showUnifiedRoads) unifiedRoadLayerRef.current.addTo(map);
  }, [roadData, filteredRoads, showUnifiedRoads]);

  // Toggle layer visibility
  const toggleLayer = useCallback((key, visible) => {
    const map = mapInstance.current;
    if (!map) return;
    const layer = key === "assets" ? assetsLayerRef.current : key === "unifiedRoads" ? unifiedRoadLayerRef.current : layersRef.current[key];
    if (!layer) return;
    if (visible) map.addLayer(layer);
    else map.removeLayer(layer);
  }, []);

  useEffect(() => { toggleLayer("districts", showDistricts); }, [showDistricts, toggleLayer]);
  useEffect(() => { toggleLayer("unifiedRoads", showUnifiedRoads); }, [showUnifiedRoads, toggleLayer]);
  useEffect(() => { toggleLayer("roads", showRoads); }, [showRoads, toggleLayer]);
  useEffect(() => { toggleLayer("national", showNational); }, [showNational, toggleLayer]);
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
            className={`layer-btn ${showUnifiedRoads ? "active unified" : ""}`}
            onClick={() => setShowUnifiedRoads(!showUnifiedRoads)}
            title="Merged growing road intelligence layer"
          >
            {showUnifiedRoads ? <Eye size={14} /> : <EyeOff size={14} />} Unified Roads
          </button>
          <button
            className={`layer-btn ${showDistricts ? "active" : ""}`}
            onClick={() => setShowDistricts(!showDistricts)}
            title="District boundaries"
          >
            {showDistricts ? <Eye size={14} /> : <EyeOff size={14} />} Districts
          </button>
          <button
            className={`layer-btn legacy-road-toggle ${showRoads ? "active" : ""}`}
            onClick={() => setShowRoads(!showRoads)}
            title="District road network"
          >
            {showRoads ? <Eye size={14} /> : <EyeOff size={14} />} Roads
          </button>
          <button
            className={`layer-btn legacy-road-toggle ${showNational ? "active national" : ""}`}
            onClick={() => setShowNational(!showNational)}
            title="National road network FY25/26"
          >
            {showNational ? <Eye size={14} /> : <EyeOff size={14} />} National
          </button>
          <button
            className={`layer-btn legacy-road-toggle ${showOsmMajor ? "active osm" : ""}`}
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
            className={`layer-btn legacy-road-toggle ${showKCCA ? "active kcca" : ""}`}
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
      <div className="road-filter-bar">
        <p className="scope-note">{DUCAR_EXEMPTION_TEXT}</p>
        <label><ListFilter size={16} /> System<select value={roadSystemFilter} onChange={(e) => setRoadSystemFilter(e.target.value)}>{roadOptions.systems.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Class<select value={roadClassFilter} onChange={(e) => setRoadClassFilter(e.target.value)}>{roadOptions.classes.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Surface<select value={surfaceFilter} onChange={(e) => setSurfaceFilter(e.target.value)}>{roadOptions.surfaces.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Sort<select value={roadSort} onChange={(e) => setRoadSort(e.target.value)}>{["length_km", "road_name", "road_class", "region", "district", "quality_flag"].map((x) => <option key={x}>{x}</option>)}</select></label>
        <strong>{filteredRoads.length.toLocaleString()} roads</strong>
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
        <span><i className="dot ducar-dot" /> DUCAR</span>
        <span><i className="dot selected" /> Selected</span>
        <span><i className="dot deferred" /> Deferred</span>
        <span><i className="dot referred" /> Referred</span>
        <span><i className="dot national-dot" /> National reference only</span>
        <span><i className="dot osm-dot" /> OSM major/named</span>
        <span><i className="dot summary-dot" /> All-road density</span>
        <span><i className="dot kcca-dot" /> KCCA</span>
        <span><i className="dot district-dot" /> District boundary</span>
        <span><i className="dash-sample" /> Excluded/reference or validation needed</span>
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
  const [programmeSortField, setProgrammeSortField] = useState("rank");
  const [programmeSortDirection, setProgrammeSortDirection] = useState("asc");
  const [activeSection, setActiveSection] = useState(() => window.location.hash.replace("#", "") || "overview");

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
    function syncPage() {
      const next = window.location.hash.replace("#", "") || "overview";
      setActiveSection(NAV_ITEMS.some((item) => item.id === next) ? next : "overview");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    window.addEventListener("hashchange", syncPage);
    syncPage();
    return () => window.removeEventListener("hashchange", syncPage);
  }, []);

  const programme = analysis.programme || [];
  const programmeAttributes = Object.keys(programme[0] || {});
  const shown = (filter === "All" ? programme : programme.filter((p) => p.status === filter)).toSorted((a, b) => {
    const av = a[programmeSortField];
    const bv = b[programmeSortField];
    const result = typeof av === "number" && typeof bv === "number" ? av - bv : String(av || "").localeCompare(String(bv || ""));
    return programmeSortDirection === "asc" ? result : -result;
  });
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
    setActiveSection(id);
    if (window.location.hash !== `#${id}`) window.location.hash = id;
  }

  const activePage = NAV_ITEMS.find((item) => item.id === activeSection) || NAV_ITEMS[0];
  const pageMeta = {
    overview: { ...activePage, title: "Dynamic ML and Geospatial Budget Allocation Tool" },
    controls: { ...activePage, title: "Budget Inputs and Scenario Controls" },
    analytics: { ...activePage, title: "Live Allocation Analytics" },
    traffic: { ...activePage, title: "Traffic, Economic and Deterioration Analytics" },
    framework: { ...activePage, title: "Animated Framework and Tool Process Flow" },
    gis: { ...activePage, title: "GIS Surface with National Reference Exemption" },
    allocation: { ...activePage, title: "Budget Rationalisation by Region and Functional Class" },
    programme: { ...activePage, title: "Editable Prioritised Programme Table" },
  }[activePage.id];

  const overviewCards = NAV_ITEMS.filter((item) => item.id !== "overview");

  return (
    <div className="shell">
      <VerticalNav activeSection={activeSection} onNavigate={navigateToSection} />
      <div className="app">
        <PageChrome page={pageMeta} onBack={() => navigateToSection("overview")}>
          {activeSection === "overview" && (
            <>
              <header className="hero">
                <div>
                  <p className="eyebrow">DUCAR Priority Studio v0.6</p>
                  <h1>Bright, page-based allocation studio for DUCAR decisions</h1>
                  <p>
                    Hyperlinked pages for budget inputs, analytics, GIS layers, framework flow, allocation,
                    and editable programme outputs.
                  </p>
                </div>
                <div className="hero-actions">
                  <span className="api-pill"><Brain size={16} /> {apiMode}</span>
                  <button onClick={() => runAnalysis()}><RefreshCcw size={16} /> Re-run ML</button>
                  <button className="secondary" onClick={exportGeoJson}><MapIcon size={16} /> Export GeoJSON</button>
                </div>
              </header>
              <section className="metrics-grid">
                <Metric icon={CircleDollarSign} label="Net budget" value={`UGX ${currency.format(analysis.netBudget || 0)}`} />
                <Metric icon={Activity} label="Selected cost" value={`UGX ${currency.format(analysis.summary?.selectedCost || 0)}`} tone="green" />
                <Metric icon={ShieldAlert} label="High ML risk assets" value={analysis.summary?.highRisk || 0} tone="red" />
                <Metric icon={Layers} label="Regions / classes" value={grouped.length} tone="gold" />
              </section>
              <InfographicPanel analysis={analysis} grouped={grouped} programme={programme} />
              <section className="page-card-grid">
                {overviewCards.map(({ id, label, icon: Icon }) => (
                  <a className="page-card" href={`#${id}`} key={id} onClick={() => navigateToSection(id)}>
                    <Icon size={28} />
                    <strong>{label}</strong>
                    <span>Open page</span>
                  </a>
                ))}
              </section>
            </>
          )}

          {activeSection === "controls" && (
            <section className="control-strip">
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
          )}

          {activeSection === "analytics" && (
            <>
              <section className="metrics-grid">
                <Metric icon={CircleDollarSign} label="Net budget" value={`UGX ${currency.format(analysis.netBudget || 0)}`} />
                <Metric icon={Activity} label="Selected cost" value={`UGX ${currency.format(analysis.summary?.selectedCost || 0)}`} tone="green" />
                <Metric icon={ShieldAlert} label="High ML risk assets" value={analysis.summary?.highRisk || 0} tone="red" />
                <Metric icon={Layers} label="Regions / classes" value={grouped.length} tone="gold" />
              </section>
              <div className="analytics-viz-grid">
                <AllocationBarChart grouped={grouped} />
                <RiskHeatmap programme={programme} />
                <ProgrammeDonut programme={programme} />
              </div>
            </>
          )}

          {activeSection === "framework" && <ProcessFlow analysis={analysis} grouped={grouped} />}
          {activeSection === "traffic" && <TrafficAnalyticsPanel programme={programme} grouped={grouped} />}
          {activeSection === "gis" && <MapScene3D programme={programme} />}

          {activeSection === "allocation" && (
            <section className="panel">
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
          )}

          {activeSection === "programme" && (
            <section className="panel wide">
              <div className="panel-title">
                <Route size={18} />
                <h2>Editable Programme Table</h2>
              </div>
              <div className="table-toolbar">
                <label>Sort attribute<select value={programmeSortField} onChange={(e) => setProgrammeSortField(e.target.value)}>{programmeAttributes.map((x) => <option key={x}>{x}</option>)}</select></label>
                <label>Direction<select value={programmeSortDirection} onChange={(e) => setProgrammeSortDirection(e.target.value)}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
                <strong>{shown.length} displayed records</strong>
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
          )}
        </PageChrome>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
