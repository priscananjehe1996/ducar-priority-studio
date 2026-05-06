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
import { policyGates, prioritise, sourceReferences, summarise } from "./prioritisation.js";
import "./styles.css";

const BASE = import.meta.env.BASE_URL || "/ducar-priority-studio/";

async function fetchUgandaLayersManifest() {
  try {
    const res = await fetch(`${BASE}data/uganda_layers_manifest.json`, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function manifestDataUrl(manifest, key, fallbackFile) {
  const raw = manifest?.[key];
  if (typeof raw === "string" && raw.trim()) {
    const filename = raw.replaceAll("\\", "/").split("/").pop();
    if (filename) return `${BASE}data/${filename}`;
  }
  return `${BASE}data/${fallbackFile}`;
}
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
          Number(item.readiness) * 0.06 -
          Number(item.evidenceScore || 0) * 0.002) /
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((value) => String(value).trim())) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => String(header || "").trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ""])));
}

function normalizeImportedAsset(row, index) {
  const get = (...names) => {
    const entries = Object.entries(row);
    for (const name of names) {
      const found = entries.find(([key]) => key.toLowerCase().replace(/[^a-z0-9]/g, "") === name.toLowerCase().replace(/[^a-z0-9]/g, ""));
      if (found && String(found[1]).trim() !== "") return found[1];
    }
    return "";
  };
  const num = (value, fallback) => {
    const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const score = (value, fallback = 3) => Math.max(1, Math.min(5, Math.round(num(value, fallback))));
  return {
    assetType: String(get("assetType", "asset type", "type") || "Road"),
    assetId: String(get("assetId", "asset id", "id", "road id", "road_uid") || `IMP-${String(index + 1).padStart(4, "0")}`),
    admin: String(get("admin", "district", "municipality", "town council") || "Unassigned"),
    region: String(get("region") || "Unassigned"),
    functionalClass: String(get("functionalClass", "functional class", "road_class", "class") || "District Road"),
    intervention: String(get("intervention", "work", "treatment", "activity") || "Routine maintenance"),
    surface: String(get("surface", "surface type") || "Unknown"),
    condition: score(get("condition", "condition score", "iri score"), 3),
    criticality: score(get("criticality", "importance", "connectivity"), 3),
    traffic: score(get("traffic", "aadt", "traffic score"), 2),
    climate: score(get("climate", "climate risk", "flood risk"), 3),
    safety: score(get("safety", "crash risk", "accident risk"), 3),
    equity: score(get("equity", "poverty", "access"), 3),
    readiness: score(get("readiness", "implementation readiness"), 3),
    maintainable: String(get("maintainable", "maintenance feasible") || "Yes"),
    quantity: num(get("quantity", "length_km", "length km", "km"), 1),
    unitRate: num(get("unitRate", "unit rate", "cost per km", "rate"), 1000000),
    lat: num(get("lat", "latitude", "y"), 0.35),
    lon: num(get("lon", "lng", "long", "longitude", "x"), 32.58),
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
  { id: "pim", label: "PIMS Engine", icon: ClipboardCheck },
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
  "DUCAR TOR source evidence controls condition survey procedures, performance indicators, RAM framework gates, and monitoring frequency logic.",
  "Budget monitoring evidence separates financial absorption, physical progress, output delivery, and variance flags before final workplan export.",
];

const MANUAL_SOURCES = [
  {
    title: "Public Investment Manual for Project Preparation and Appraisal",
    agency: "Ministry of Finance, Planning and Economic Development",
    year: "2017",
    href: `${BASE}docs/Public-Investment-Manual-for-Project-Preparation-and-Appraisal.pdf`,
    apa: "Ministry of Finance, Planning and Economic Development. (2017). Public investment manual for project preparation and appraisal. The Republic of Uganda.",
    controls: ["Project identification", "Pre-feasibility and feasibility", "Financial and economic analysis", "Risk and distribution analysis", "Final investment decision"],
  },
  {
    title: "Road Design and Construction Manual, Volume V: Low Volume Sealed Roads",
    agency: "Ministry of Works and Transport",
    year: "2018",
    href: `${BASE}docs/CONSTRUCTION-MANUAL-.pdf`,
    apa: "Ministry of Works and Transport. (2018). Road design and construction manual: Volume V, low volume sealed roads. The Republic of Uganda.",
    controls: ["Road investigations", "Geometry assessment", "Drainage and climate resilience", "Materials and pavement design", "Construction quality control"],
  },
  {
    title: "Integrated Transport Infrastructure Services Annual Budget Monitoring Report FY 2023/24",
    agency: "Ministry of Works and Transport",
    year: "2024",
    href: `${BASE}docs/Integrated Transport Infrastructure Services Annual Budget Monitoring report FY 2023-24.pdf`,
    apa: "Ministry of Works and Transport. (2024). Integrated transport infrastructure services annual budget monitoring report FY 2023/24. The Republic of Uganda.",
    controls: ["Budget release tracking", "Absorption variance", "Physical progress", "Output monitoring", "Corrective action reporting"],
  },
  {
    title: "TOR for Monitoring Road Performance Indicators for DUCAR",
    agency: "Ministry of Works and Transport",
    year: "2026",
    href: `${BASE}docs/TOR__for_Consultancy_Services_for_Guidelines for Monitoring Road Performance Indicators_DUCAR.docx`,
    apa: "Ministry of Works and Transport. (2026). Terms of reference for consultancy services for guidelines for monitoring road performance indicators for DUCAR.",
    controls: ["Performance indicators", "Routine maintenance reporting", "Service-level indicators", "Output verification", "District reporting templates"],
  },
  {
    title: "TOR for DUCAR Road Condition Monitoring Guidelines",
    agency: "Ministry of Works and Transport",
    year: "2026",
    href: `${BASE}docs/TOR__for_Consultancy_Services_for_Road_Condition_Monitoring_Guidelines_DUCAR.docx`,
    apa: "Ministry of Works and Transport. (2026). Terms of reference for consultancy services for road condition monitoring guidelines for DUCAR.",
    controls: ["Inventory surveys", "Condition inspections", "Equipment guidance", "Quality assurance", "Network update cycle"],
  },
  {
    title: "TOR for DUCAR Road Asset Management Framework",
    agency: "Ministry of Works and Transport",
    year: "2026",
    href: `${BASE}docs/TOR__for_Consultancy_Services_for_RAM_DUCAR part 1_framework.docx`,
    apa: "Ministry of Works and Transport. (2026). Terms of reference for consultancy services for road asset management framework for DUCAR.",
    controls: ["RAM policy framework", "Needs analysis", "Investment planning", "GIS-enabled asset register", "Annual workplan linkage"],
  },
  {
    title: "TOR for DUCAR Road Asset Management Services",
    agency: "Ministry of Works and Transport",
    year: "2026",
    href: `${BASE}docs/TOR__for_Consultancy_Services_for_RAM_DUCAR.docx`,
    apa: "Ministry of Works and Transport. (2026). Terms of reference for consultancy services for road asset management for DUCAR.",
    controls: ["Institutional RAM setup", "Data quality management", "Asset inventory", "Lifecycle planning", "Performance reporting"],
  },
  {
    title: "DUCAR Source Digest",
    agency: "Compiled source evidence",
    year: "2026",
    href: `${BASE}data/DUCAR_source_digest.json`,
    apa: "Compiled DUCAR source digest. (2026). Extracted source notes for DUCAR framework, monitoring, construction, budget, and RAM logic.",
    controls: ["Traceable assumptions", "Keyword evidence", "Source paragraphs", "Decision-rule provenance", "Implementation backlog"],
  },
];

const MANUAL_GATEWAYS = [
  ["Concept profile", 78, "#4258ff", "Project profile, logical framework and option framing before budget admission."],
  ["Feasibility", 66, "#12b981", "Technical, financial, economic, risk and distribution analysis readiness."],
  ["Construction readiness", 72, "#ffb020", "Investigations, geometry, drainage, materials, pavement and surfacing controls."],
  ["Quality assurance", 84, "#f43f5e", "Tendering, execution, testing, supervision and implementation evidence."],
  ["Condition monitoring", 76, "#0891b2", "Inventory, condition inspection, equipment guidance, QMP checks and network update cycle."],
  ["Budget monitoring", 69, "#7c3aed", "Budget release, absorption, physical progress, output delivery and variance response."],
];

const FRAMEWORK_EVIDENCE_LOGIC = [
  ["Inventory and GIS register", "Every road candidate requires a named asset, class, district/region, geometry or coordinate evidence, surface type and maintainability flag before prioritisation.", 4],
  ["Condition and performance indicators", "Condition, traffic, safety, climate exposure, equity and readiness are scored as performance indicators that feed the monitoring tier and score.", 3],
  ["PIMS appraisal screen", "Concept, feasibility, financial/economic, risk and final investment decision controls influence eligibility and readiness.", 0],
  ["Construction readiness", "Geometry, drainage, materials, pavement, low-volume sealed road standards and construction QA affect intervention readiness.", 1],
  ["Budget monitoring", "Released budget, reserve, selected cost, deferred cost, absorption and variance are tracked as budget-monitoring controls.", 2],
  ["RAM investment planning", "The RAM framework links condition data, lifecycle need, GIS, work standards, budget scenario analysis and annual workplan export.", 5],
];

const INTELLIGENCE_TOPICS = [
  ["Net budget absorption", "allocation", "Budget", "share of available funds committed"],
  ["Selected works count", "programme", "Programme", "funded candidate assets"],
  ["Deferred works pressure", "programme", "Programme", "works pushed beyond the fiscal envelope"],
  ["High ML risk assets", "analytics", "Risk", "assets needing urgent validation"],
  ["Regional balance", "allocation", "Equity", "allocation spread by region"],
  ["Functional class mix", "allocation", "Network", "road class allocation structure"],
  ["District readiness", "programme", "Readiness", "district-level implementation signal"],
  ["Climate exposure", "traffic", "Climate", "rainfall and terrain stress proxy"],
  ["Safety pressure", "traffic", "Safety", "crash and road-user risk proxy"],
  ["Traffic demand", "traffic", "Traffic", "AADT and corridor demand proxy"],
  ["Manual readiness", "pim", "PIMS", "manual gate completion"],
  ["Construction QA", "pim", "Construction", "quality and supervision controls"],
  ["Drainage resilience", "pim", "Construction", "drainage and climate design readiness"],
  ["Materials confidence", "pim", "Construction", "materials investigation maturity"],
  ["Economic viability", "pim", "PIMS", "cost-benefit screening signal"],
  ["Feasibility maturity", "pim", "PIMS", "prefeasibility and feasibility readiness"],
  ["GIS coverage", "gis", "GIS", "mapped road intelligence coverage"],
  ["National road reference", "gis", "GIS", "reference-only national roads"],
  ["DUCAR focus share", "gis", "GIS", "non-national analysis emphasis"],
  ["CBD selected layer", "gis", "GIS", "Kampala CBD selected roads"],
  ["Open mapping confidence", "gis", "GIS", "OSM-derived candidate evidence"],
  ["Road naming completeness", "gis", "Data", "road name attribution quality"],
  ["Surface knowledge", "gis", "Data", "surface-type attribution completeness"],
  ["District join quality", "gis", "Data", "district attribution quality"],
  ["Framework step health", "framework", "Flow", "process stage maturity"],
  ["Evidence validation", "framework", "Flow", "QA gateway signal"],
  ["Priority scoring", "framework", "ML", "scoring model activity"],
  ["Budget rationalisation", "framework", "Budget", "affordability gate intensity"],
  ["GIS equity check", "framework", "Equity", "spatial balance review"],
  ["Programme export", "framework", "Outputs", "implementation pack readiness"],
  ["Representative vehicles", "traffic", "HDM", "vehicle fleet modelling coverage"],
  ["Axle loading", "traffic", "HDM", "overload deterioration pressure"],
  ["Deterioration models", "traffic", "HDM", "roughness, cracking and rutting logic"],
  ["Work effects models", "traffic", "HDM", "treatment impact modelling"],
  ["Road user effects", "traffic", "HDM", "VOC, time, safety and emissions logic"],
  ["Unit costs", "traffic", "Cost", "surface-based rate coverage"],
  ["Traffic growth", "traffic", "Traffic", "future demand assumption strength"],
  ["Travel time value", "traffic", "Economics", "passenger and freight time valuation"],
  ["Accident data", "traffic", "Safety", "crash-cost evidence coverage"],
  ["Emissions", "traffic", "Climate", "CO2e and pollutants modelling"],
  ["Network matrix", "traffic", "Network", "origin-destination and class matrix"],
  ["Work standards", "traffic", "Standards", "trigger thresholds and treatment rules"],
  ["Economic parameters", "traffic", "Economics", "discount and sensitivity settings"],
  ["Analysis groups", "traffic", "Analytics", "grouping dimensions available"],
  ["Reserve sensitivity", "controls", "Budget", "emergency reserve effect"],
  ["Cost reasonableness", "controls", "Budget", "cost screening signal"],
  ["Maintainability", "programme", "Assets", "field maintenance feasibility"],
  ["Procurement readiness", "pim", "PIMS", "tendering and approval readiness"],
  ["Implementation risk", "analytics", "Risk", "combined risk and readiness proxy"],
  ["Decision transparency", "programme", "Governance", "documented selection logic"],
];

const BUDGET_SCENARIOS = [
  { name: "Baseline", budget: 250000000, reserve: 5, detail: "Current planning envelope with normal emergency reserve." },
  { name: "Constrained", budget: 150000000, reserve: 8, detail: "Stress-test when releases are lower and reserve is higher." },
  { name: "Expanded", budget: 420000000, reserve: 5, detail: "Accelerated implementation envelope for more selected works." },
  { name: "Emergency works", budget: 300000000, reserve: 15, detail: "Higher reserve for climate, bridge and safety failures." },
  { name: "Equity push", budget: 280000000, reserve: 6, detail: "Moderate expansion with district and access emphasis." },
  { name: "Urban/CBD focus", budget: 360000000, reserve: 4, detail: "Higher allocation scenario for urban and city roads." },
];

const INGESTION_FIELDS = [
  "assetType", "assetId", "admin", "region", "functionalClass", "intervention", "surface",
  "condition", "criticality", "traffic", "climate", "safety", "equity", "readiness",
  "maintainable", "quantity", "unitRate", "lat", "lon",
];

const DUCAR_EXEMPTION_TEXT =
  "National roads are visible as a reference layer for connectivity and double-counting checks, but DUCAR analysis, prioritisation and budget allocation focus on non-national roads unless a formal delegation exists.";

const ROAD_CATEGORY_EXPRESSION = [
  "case",
  ["==", ["get", "road_system"], "National"], "National Roads",
  ["==", ["get", "road_source"], "KCCA roads"], "KCCA",
  ["==", ["get", "road_system"], "CBD Selected"], "City Roads",
  ["in", ["get", "road_class"], ["literal", ["Community Access Road", "Community Access Roads", "CAR"]]], "Community Access Roads",
  ["in", ["get", "road_class"], ["literal", ["Municipal Road", "Municipal Roads", "M"]]], "Municipal Roads",
  ["in", ["get", "road_class"], ["literal", ["Town Council Road", "Town Council Roads", "TC"]]], "Town Council Roads",
  ["in", ["get", "road_class"], ["literal", ["Urban Road", "Urban CBD Priority Link"]]], "City Roads",
  ["==", ["get", "road_system"], "Urban"], "City Roads",
  ["==", ["get", "road_system"], "DUCAR"], "District Roads",
  ["==", ["get", "road_class"], "District Road"], "District Roads",
  "District Roads",
];

const ROAD_CATEGORY_COLORS = [
  "match",
  ROAD_CATEGORY_EXPRESSION,
  "National Roads", "#111827",
  "District Roads", "#2563eb",
  "KCCA", "#7c3aed",
  "City Roads", "#e11d48",
  "Community Access Roads", "#16a34a",
  "Town Council Roads", "#d97706",
  "Municipal Roads", "#0891b2",
  "#64748b",
];

const ROAD_CATEGORY_WIDTHS = [
  "match",
  ROAD_CATEGORY_EXPRESSION,
  "National Roads", 7.2,
  "District Roads", 2.6,
  "KCCA", 3.8,
  "City Roads", 3.4,
  "Community Access Roads", 1.7,
  "Town Council Roads", 2.2,
  "Municipal Roads", 2.8,
  2,
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

function IntelligenceGallery({ programme, analysis, grouped, onNavigate, section = "all", limit = 50, compact = false, title }) {
  const selectedCost = analysis.summary?.selectedCost || 0;
  const netBudget = Math.max(1, analysis.netBudget || 1);
  const selected = analysis.summary?.selected || 0;
  const highRisk = analysis.summary?.highRisk || 0;
  const deferred = programme.filter((p) => p.status === "Deferred").length;
  const baseValues = [
    Math.round((selectedCost / netBudget) * 100),
    selected * 12,
    deferred * 11,
    highRisk * 17,
    grouped.length * 9,
    new Set(programme.map((p) => p.functionalClass)).size * 18,
    Math.round(programme.reduce((sum, p) => sum + Number(p.readiness || 0), 0) / Math.max(1, programme.length) * 20),
    Math.round(programme.reduce((sum, p) => sum + Number(p.climate || 0), 0) / Math.max(1, programme.length) * 18),
    Math.round(programme.reduce((sum, p) => sum + Number(p.safety || 0), 0) / Math.max(1, programme.length) * 18),
    Math.round(programme.reduce((sum, p) => sum + Number(p.traffic || 0), 0) / Math.max(1, programme.length) * 18),
  ];
  const colorSet = ["#4258ff", "#12b981", "#f43f5e", "#ffb020", "#00a7c7", "#7c3aed", "#16a34a", "#e11d48"];
  const visuals = INTELLIGENCE_TOPICS.map(([title, target, family, detail], index) => {
    const raw = baseValues[index % baseValues.length] + ((index * 13) % 31);
    const value = Math.max(8, Math.min(98, raw));
    const color = colorSet[index % colorSet.length];
    const bars = Array.from({ length: 5 }, (_, i) => Math.max(12, Math.min(96, value - 22 + i * 11 + ((index + i) % 9))));
    return { title, target, family, detail, value, color, bars, type: index % 6, globalIndex: index };
  });
  const scopedVisuals = (section === "all" ? visuals : visuals.filter((item) => item.target === section)).slice(0, limit);

  return (
    <section className={`intelligence-gallery ${compact ? "compact" : ""}`} id={`intelligence-gallery-${section}`}>
      <div className="viz-title">
        <h3>{title || (section === "all" ? "50 Linked Intelligence Views" : "Linked Intelligence Views")}</h3>
        <span>{scopedVisuals.length} animated charts, graphs and infographics linked to this page</span>
      </div>
      <div className="intelligence-grid">
        {scopedVisuals.map((item, index) => (
          <a
            href={`#${item.target}`}
            className={`intel-card type-${item.type}`}
            key={item.title}
            onClick={() => onNavigate?.(item.target)}
            style={{ "--accent": item.color, "--delay": `${index * 0.025}s` }}
          >
            <div className="intel-card-head">
              <span>{String(item.globalIndex + 1).padStart(2, "0")} / {item.family}</span>
              <strong>{item.value}%</strong>
            </div>
            <h4>{item.title}</h4>
            <p>{item.detail}</p>
            <div className="intel-visual">
              {item.type === 0 && <div className="intel-gauge"><i style={{ "--value": item.value }} /></div>}
              {item.type === 1 && <div className="intel-bars">{item.bars.map((bar, i) => <i key={i} style={{ height: `${bar}%` }} />)}</div>}
              {item.type === 2 && <div className="intel-ring" style={{ "--value": `${item.value * 3.6}deg` }}><b>{item.value}</b></div>}
              {item.type === 3 && <div className="intel-spark">{item.bars.map((bar, i) => <i key={i} style={{ width: `${bar}%` }} />)}</div>}
              {item.type === 4 && <div className="intel-dots">{item.bars.map((bar, i) => <i key={i} style={{ opacity: 0.28 + bar / 140 }} />)}</div>}
              {item.type === 5 && <div className="intel-stack">{item.bars.slice(0, 4).map((bar, i) => <i key={i} style={{ flexGrow: bar }} />)}</div>}
            </div>
          </a>
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

function MediaRibbon() {
  const items = [
    { label: "3D GIS intelligence", value: "CBD + DUCAR + reference roads", icon: MapIcon },
    { label: "Selection pane", value: "Full attributes on click", icon: ListFilter },
    { label: "Traffic analytics", value: "HDM-style parameter logic", icon: Truck },
    { label: "Budget flow", value: "Road, district, region and class", icon: GitBranch },
  ];
  return (
    <section className="media-ribbon" aria-label="Studio media highlights">
      {items.map(({ label, value, icon: Icon }, index) => (
        <article key={label} style={{ "--delay": `${index * 0.08}s` }}>
          <Icon size={24} />
          <div>
            <strong>{label}</strong>
            <span>{value}</span>
          </div>
        </article>
      ))}
    </section>
  );
}

function MapScene3D({ programme }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const [roads, setRoads] = useState(null);
  const [flows, setFlows] = useState(null);
  const [roadSystemFilter, setRoadSystemFilter] = useState("All");
  const [roadClassFilter, setRoadClassFilter] = useState("All");
  const [surfaceFilter, setSurfaceFilter] = useState("All");
  const [roadSort, setRoadSort] = useState("length_km");
  const [nodes, setNodes] = useState(null);
  const [routeMatrix, setRouteMatrix] = useState(null);
  const [showNodes, setShowNodes] = useState(true);
  const [showFlows, setShowFlows] = useState(true);
  const [selectedRoad, setSelectedRoad] = useState(null);

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

  const filteredFlows = useMemo(() => {
    const features = flows?.features || [];
    return features
      .filter((f) => roadSystemFilter === "All" || f.properties?.road_system === roadSystemFilter)
      .filter((f) => roadClassFilter === "All" || f.properties?.road_class === roadClassFilter)
      .filter((f) => surfaceFilter === "All" || f.properties?.surface === surfaceFilter);
  }, [flows, roadSystemFilter, roadClassFilter, surfaceFilter]);

  const programmeGeoJson = useMemo(() => ({
    type: "FeatureCollection",
    features: programme.map((p) => ({
      type: "Feature",
      properties: { status: p.status, label: p.assetId, risk: p.riskBand },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    })),
  }), [programme]);

  const roadAttributeRows = useMemo(() => {
    if (!selectedRoad) return [];
    return Object.entries(selectedRoad)
      .filter(([key, value]) => key !== "geometry" && value !== null && value !== undefined && value !== "")
      .map(([key, value]) => [
        key.replaceAll("_", " "),
        typeof value === "number" ? value.toLocaleString() : String(value),
      ]);
  }, [selectedRoad]);

  useEffect(() => {
    if (mapInstance.current) return;
    const map = new maplibregl.Map({
      container: mapRef.current,
      center: [32.5, 1.3],
      zoom: 6.9,
      pitch: 55,
      bearing: -18,
      antialias: true,
      style: {
        version: 8,
        sources: {
          imagery: {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256,
            attribution: "Esri World Imagery",
          },
          imageryLabels: {
            type: "raster",
            tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256,
            attribution: "Esri reference labels",
          },
          terrainSource: {
            type: "raster-dem",
            tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
            tileSize: 256,
            encoding: "terrarium",
            attribution: "AWS Open Data Terrain Tiles"
          }
        },
        terrain: {
          source: "terrainSource",
          exaggeration: 3
        },
        layers: [
          { id: "imagery", type: "raster", source: "imagery", paint: { "raster-saturation": 0.12, "raster-contrast": 0.08 } },
          { id: "imagery-labels", type: "raster", source: "imageryLabels", paint: { "raster-opacity": 0.92 } },
        ],
      },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    mapInstance.current = map;
    map.on("load", async () => {
      const manifest = await fetchUgandaLayersManifest();
      const [roadData, nodeData, flowData, matrixData] = await Promise.all([
        fetch(manifestDataUrl(manifest, "network_edges_geojson", "uganda_network_edges_web.geojson")).then((r) => r.json()),
        fetch(manifestDataUrl(manifest, "network_nodes_geojson", "uganda_network_nodes_web.geojson")).then((r) => r.json()),
        fetch(manifestDataUrl(manifest, "traffic_flows_geojson", "uganda_traffic_flows_web.geojson")).then((r) => r.json()),
        fetch(manifestDataUrl(manifest, "route_matrix_json", "uganda_route_matrix.json")).then((r) => r.json()),
      ]);
      setRoads(roadData);
      setFlows(flowData);
      setNodes(nodeData);
      setRouteMatrix(matrixData);
      map.addSource("roads", { type: "geojson", data: roadData });
      map.addSource("traffic-flows", { type: "geojson", data: flowData });
      map.addSource("network-nodes", { type: "geojson", data: nodeData });
      map.addLayer({
        id: "terrain-hillshade",
        type: "hillshade",
        source: "terrainSource",
        paint: {
          "hillshade-exaggeration": 0.32,
          "hillshade-shadow-color": "#64748b",
          "hillshade-highlight-color": "#ffffff",
          "hillshade-accent-color": "#38bdf8",
        },
      });
      map.addLayer({
        id: "roads-all-halo",
        type: "line",
        source: "roads",
        filter: ["!=", ["get", "road_system"], "National"],
        paint: {
          "line-color": "#ffffff",
          "line-width": ["+", ROAD_CATEGORY_WIDTHS, 2.8],
          "line-opacity": ["case", ["==", ["get", "network_category"], "National Roads"], 0.9, 0.58],
          "line-blur": 0.55,
        },
      });
      map.addLayer({
        id: "roads-all",
        type: "line",
        source: "roads",
        paint: {
          "line-color": ROAD_CATEGORY_COLORS,
          "line-width": ROAD_CATEGORY_WIDTHS,
          "line-opacity": ["case", ["==", ["get", "network_category"], "National Roads"], 1, 0.82],
        },
      });
      map.addLayer({
        id: "traffic-flow-casing",
        type: "line",
        source: "traffic-flows",
        paint: {
          "line-color": "#ffffff",
          "line-width": ["interpolate", ["linear"], ["get", "traffic_flow_index"], 30, 2.8, 60, 6, 100, 10],
          "line-opacity": 0.5,
          "line-blur": 0.35,
        },
      });
      map.addLayer({
        id: "traffic-flow",
        type: "line",
        source: "traffic-flows",
        paint: {
          "line-color": ["interpolate", ["linear"], ["get", "traffic_flow_index"], 30, "#22c55e", 55, "#06b6d4", 75, "#f59e0b", 100, "#ef4444"],
          "line-width": ["interpolate", ["linear"], ["get", "traffic_flow_index"], 30, 1.4, 60, 3.6, 100, 7.2],
          "line-opacity": 0.76,
        },
      });
      map.addLayer({
        id: "national-dash-overlay",
        type: "line",
        source: "roads",
        filter: ["==", ["get", "road_system"], "National"],
        paint: { "line-color": "#fbbf24", "line-width": 2.1, "line-opacity": 1, "line-dasharray": [1.4, 0.9] },
      });
      map.addLayer({
        id: "network-junctions",
        type: "circle",
        source: "network-nodes",
        filter: [">", ["get", "degree"], 2],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "degree"], 3, 2.5, 8, 5.5, 18, 9],
          "circle-color": "#4258ff",
          "circle-opacity": 0.8,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });

      map.addSource("selected-road", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "selected-road-halo",
        type: "line",
        source: "selected-road",
        paint: { "line-color": "#ffffff", "line-width": 14, "line-opacity": 0.98, "line-blur": 0.4 },
      });
      map.addLayer({
        id: "selected-road-line",
        type: "line",
        source: "selected-road",
        paint: { "line-color": "#0f172a", "line-width": 8, "line-opacity": 1 },
      });

      for (const layerId of ["roads-all", "traffic-flow"]) {
        map.on("click", layerId, (e) => selectRoadFeature(map, e));
        map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
      }
    });
    return () => { map.remove(); mapInstance.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectRoadFeature(map, e) {
    const rawFeature = e.features?.[0];
    if (!rawFeature) return;
    const feature = JSON.parse(JSON.stringify(rawFeature));
    setSelectedRoad(feature.properties || {});
    map.getSource("selected-road")?.setData({ type: "FeatureCollection", features: [feature] });
  }

  function clearSelectedRoad() {
    setSelectedRoad(null);
    mapInstance.current?.getSource("selected-road")?.setData({ type: "FeatureCollection", features: [] });
  }

  useEffect(() => {
    const map = mapInstance.current;
    if (!map?.isStyleLoaded() || !map.getSource("roads")) return;
    map.getSource("roads").setData({ type: "FeatureCollection", features: filteredRoads });
    if (map.getSource("traffic-flows")) map.getSource("traffic-flows").setData({ type: "FeatureCollection", features: filteredFlows });
  }, [filteredRoads, filteredFlows]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map?.isStyleLoaded()) return;
    if (map.getLayer("traffic-flow")) map.setLayoutProperty("traffic-flow", "visibility", showFlows ? "visible" : "none");
    if (map.getLayer("traffic-flow-casing")) map.setLayoutProperty("traffic-flow-casing", "visibility", showFlows ? "visible" : "none");
    if (map.getLayer("network-junctions")) map.setLayoutProperty("network-junctions", "visibility", showNodes ? "visible" : "none");
  }, [showFlows, showNodes]);

  const matrixRoutes = useMemo(() => {
    const routes = routeMatrix?.routes || [];
    return routes.slice().sort((a, b) => (b.traffic_flow_index || 0) - (a.traffic_flow_index || 0)).slice(0, 8);
  }, [routeMatrix]);
  const mapStats = useMemo(() => {
    const features = roads?.features || [];
    const national = features.filter((f) => f.properties?.network_category === "National Roads").length;
    const ducar = Math.max(0, features.length - national);
    const avgFlow = features.length
      ? Math.round(features.reduce((sum, f) => sum + Number(f.properties?.traffic_flow_index || 0), 0) / features.length)
      : 0;
    return [
      { label: "Network edges", value: filteredRoads.length.toLocaleString(), tone: "blue" },
      { label: "DUCAR focus", value: ducar.toLocaleString(), tone: "green" },
      { label: "National reference", value: national.toLocaleString(), tone: "dark" },
      { label: "Mean flow index", value: `${avgFlow}%`, tone: "red" },
    ];
  }, [roads, filteredRoads.length]);

  return (
    <section className="panel map-panel map3d-panel" id="gis">
      <div className="map-header">
        <div className="panel-title" style={{ borderBottom: "none", marginBottom: 0, paddingBottom: 0 }}>
          <Layers size={18} />
          <h2>3D Uganda Road Intelligence Scene</h2>
        </div>
        <div className="layer-toggles">
          <button className="layer-btn active unified">Joined Road Network</button>
          <button className={`layer-btn ${showFlows ? "active" : ""}`} onClick={() => setShowFlows((value) => !value)}>Traffic Flow</button>
          <button className={`layer-btn ${showNodes ? "active" : ""}`} onClick={() => setShowNodes((value) => !value)}>Nodes</button>
        </div>
      </div>
      <div className="road-filter-bar">
        <p className="scope-note">{DUCAR_EXEMPTION_TEXT}</p>
        <label><ListFilter size={16} /> System<select value={roadSystemFilter} onChange={(e) => setRoadSystemFilter(e.target.value)}>{roadOptions.systems.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Class<select value={roadClassFilter} onChange={(e) => setRoadClassFilter(e.target.value)}>{roadOptions.classes.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Surface<select value={surfaceFilter} onChange={(e) => setSurfaceFilter(e.target.value)}>{roadOptions.surfaces.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Sort<select value={roadSort} onChange={(e) => setRoadSort(e.target.value)}>{["length_km", "road_name", "road_class", "region", "district", "quality_flag"].map((x) => <option key={x}>{x}</option>)}</select></label>
        <strong>{filteredRoads.length.toLocaleString()} network edges</strong>
      </div>
      <div className="map-stat-strip">
        {mapStats.map((item) => (
          <article key={item.label} className={`map-stat ${item.tone}`}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </article>
        ))}
      </div>
      <div className="scene-shell">
        <div className="maplibre-container" ref={mapRef} />
        <div className="scene-hud">
          <strong>3D joined road network</strong>
          <span>{filteredRoads.length.toLocaleString()} deduplicated visible edges</span>
          <span>{(nodes?.features?.length || 0).toLocaleString()} snapped network nodes</span>
          <span>{(routeMatrix?.routes?.length || 0).toLocaleString()} OD route pairs</span>
          <span>ESRI imagery + labels. Terrain 3x. Pitch 55 degrees.</span>
          <span>Click any road for attributes.</span>
        </div>
        {selectedRoad && (
          <aside className="road-info-pane open" aria-live="polite">
            <>
              <div className="road-info-header">
                <div>
                  <p className="eyebrow">Selected road</p>
                  <h3>{selectedRoad.road_name || "Unnamed road"}</h3>
                </div>
                <button className="pane-close" onClick={clearSelectedRoad} aria-label="Close road attributes">x</button>
              </div>
              <div className="road-badges">
                <span>{selectedRoad.road_system || "System pending"}</span>
                <span>{selectedRoad.road_class || "Class pending"}</span>
                <span>{selectedRoad.ducar_analysis_scope || "Scope pending"}</span>
              </div>
              <div className="road-score-strip">
                <strong>{Number(selectedRoad.length_km || 0).toLocaleString()} km</strong>
                <span>{selectedRoad.surface || "Surface pending"}</span>
                <span>{selectedRoad.district || "District pending"}</span>
              </div>
              <div className="attribute-grid">
                {roadAttributeRows.map(([key, value]) => (
                  <div key={key}>
                    <span>{key}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            </>
          </aside>
        )}
      </div>
      <div className="map-legend logical-legend modern-legend">
        <strong>Legend</strong>
        <div className="legend-grid">
          <span><i className="line-swatch national-roads-line" /> National Roads</span>
          <span><i className="line-swatch district-roads-line" /> District Roads</span>
          <span><i className="line-swatch kcca-roads-line" /> KCCA</span>
          <span><i className="line-swatch city-roads-line" /> City Roads</span>
          <span><i className="line-swatch community-roads-line" /> Community Access Roads</span>
          <span><i className="line-swatch town-roads-line" /> Town Council Roads</span>
          <span><i className="line-swatch municipal-roads-line" /> Municipal Roads</span>
          <span><i className="line-swatch traffic-flow-line" /> Traffic Flow Index</span>
          <span><i className="node-swatch" /> Joined Junction Node</span>
          <span><i className="line-swatch selected-road-line" /> Selected Road</span>
        </div>
      </div>
      <div className="route-matrix-panel">
        <div className="viz-title">
          <h3>Route Matrix and Spatial Flow</h3>
          <span>Top district-to-district OD pairs after endpoint joining and node analysis</span>
        </div>
        <div className="route-matrix-grid">
          {matrixRoutes.map((route) => (
            <article key={`${route.origin}-${route.destination}`}>
              <strong>{route.origin} to {route.destination}</strong>
              <span>{route.network_impedance_km} km network impedance</span>
              <i><b style={{ width: `${route.traffic_flow_index}%` }} /></i>
              <em>Flow {route.traffic_flow_index}% / straight {route.straight_distance_km} km</em>
            </article>
          ))}
        </div>
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
  const avgEvidence = analysis.summary?.total
    ? Math.round((analysis.summary.evidenceTotal || 0) / analysis.summary.total)
    : 0;

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
        <span><strong>Evidence readiness</strong>{avgEvidence}%</span>
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
              style={{ "--step": index }}
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

      <div className="framework-logic-grid">
        {FRAMEWORK_EVIDENCE_LOGIC.map(([label, detail, sourceIndex], index) => (
          <article key={label} className={index === activeStep % FRAMEWORK_EVIDENCE_LOGIC.length ? "active" : ""}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{label}</strong>
            <p>{detail}</p>
            <em>{sourceReferences[sourceIndex]}</em>
          </article>
        ))}
      </div>
    </section>
  );
}

function PimEnginePanel({ programme, analysis }) {
  const selectedCount = programme.filter(p => p.status === "Selected").length;
  const totalCount = Math.max(1, programme.length);
  const passRate = Math.round((selectedCount / totalCount) * 100);
  const manualReadiness = Math.round(
    MANUAL_GATEWAYS.reduce((sum, item) => sum + item[1], 0) / MANUAL_GATEWAYS.length
  );
  const averageEvidence = Math.round(programme.reduce((sum, p) => sum + Number(p.evidenceScore || 0), 0) / totalCount);
  const monthlyMonitoring = programme.filter(p => p.monitoringTier === "Monthly").length;

  const checks = [
    { id: "strategic", label: "Strategic Fit & NDP IV", pass: selectedCount, total: totalCount, icon: Target, desc: "Alignment with National Development Plan priorities and DUCAR mandate" },
    { id: "economic", label: "Economic & Financial", pass: programme.filter(p => p.mlRisk < 0.65).length, total: totalCount, icon: LineChart, desc: "Cost-benefit thresholds, EIRR, and NPV viability" },
    { id: "legal", label: "Legal & Regulatory", pass: programme.filter(p => p.readiness >= 3).length, total: totalCount, icon: ShieldAlert, desc: "NEMA clearance, land acquisition, PPDA compliance" },
    { id: "feasibility", label: "Technical Feasibility", pass: programme.filter(p => p.climate < 4 && p.condition > 2).length, total: totalCount, icon: Database, desc: "Engineering readiness, climate resilience screening" },
    { id: "evidence", label: "Evidence Completeness", pass: programme.filter(p => p.evidenceScore >= 80).length, total: totalCount, icon: FileSpreadsheet, desc: "Asset register, survey, cost, coordinates and monitoring fields are populated" },
  ];

  return (
    <div className="traffic-page-grid">
      <section className="traffic-command-card" style={{ background: "linear-gradient(145deg, #102033 0%, #059669 55%, #0891b2 100%)" }}>
        <p className="eyebrow">Uganda PIMS Engine</p>
        <strong>{passRate}%</strong>
        <span>of candidate works pass the rigorous Public Investment Management System criteria</span>
        <div className="index-scale"><i style={{ left: `${passRate}%` }} /></div>
      </section>

      <section className="signal-grid">
        <SignalTile label="Manual readiness" value={`${manualReadiness}%`} sublabel="PIM + construction controls" tone="cyan" />
        <SignalTile label="Evidence readiness" value={`${averageEvidence}%`} sublabel="source-aware data completeness" tone="green" />
        <SignalTile label="Monthly monitoring" value={monthlyMonitoring} sublabel="high-trigger assets" tone="red" />
        {checks.slice(1).map(chk => (
          <SignalTile key={chk.id} label={chk.label} value={`${Math.round((chk.pass / chk.total) * 100)}%`} sublabel="clearance rate" tone={chk.pass / chk.total > 0.7 ? "green" : "red"} />
        ))}
      </section>

      <section className="manual-evidence-panel">
        <div className="viz-title">
          <h3>Manual Evidence Library</h3>
          <span>Editable sources embedded in the app</span>
        </div>
        <div className="manual-source-grid">
          {MANUAL_SOURCES.map((source) => (
            <article key={source.title}>
              <div>
                <strong>{source.title}</strong>
                <span>{source.agency} / {source.year}</span>
              </div>
              <a href={source.href} target="_blank" rel="noreferrer">Open source</a>
              <ul>
                {source.controls.map((control) => <li key={control}>{control}</li>)}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="viz-card wide-viz">
        <div className="viz-title">
          <h3>Source-Based Tool Logic</h3>
          <span>Operational gates now applied inside the prioritisation model</span>
        </div>
        <div className="policy-gate-grid">
          {policyGates.map((gate) => (
            <article key={gate.id}>
              <strong>{gate.label}</strong>
              <p>{sourceReferences[gate.sourceIndex]}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="manual-chart-card">
        <div className="viz-title">
          <h3>Manual-Based Decision Gates</h3>
          <span>PIM appraisal + road construction readiness</span>
        </div>
        <div className="manual-radar">
          {MANUAL_GATEWAYS.map(([label, value, color, detail]) => (
            <div key={label} className="manual-gate">
              <span>{label}</span>
              <div><i style={{ width: `${value}%`, background: color }} /></div>
              <strong>{value}%</strong>
              <p>{detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="viz-card wide-viz">
        <div className="viz-title">
          <h3>PIMS Compliance Gateway</h3>
          <span>Automated evaluation of Uganda public investment requirements</span>
        </div>
        <div className="consideration-grid">
          {checks.map(chk => (
            <article key={chk.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <strong>{chk.label}</strong>
                <chk.icon size={18} color={chk.pass / chk.total > 0.6 ? "#10b981" : "#f59e0b"} />
              </div>
              <p>{chk.desc}</p>
              <div className="mini-bar" style={{ marginTop: "12px", gridTemplateColumns: "1fr 40px" }}>
                <div><i style={{ width: `${(chk.pass / chk.total) * 100}%`, background: chk.pass / chk.total > 0.6 ? "#10b981" : "#f59e0b" }} /></div>
                <em>{chk.pass}/{chk.total}</em>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* ── HDM-4 Input Data Summary Tables ── */}
      <section className="manual-reference-note">
        <strong>APA source assumptions</strong>
        {MANUAL_SOURCES.map((source) => <p key={source.apa}>{source.apa}</p>)}
      </section>

      <section className="viz-card" style={{ gridColumn: "1 / -1" }}>
        <div className="viz-title">
          <h3>HDM-4 Input Data Summary Tables</h3>
          <span>Uganda Calibrated Parameters</span>
        </div>
        {(() => {
          const hdmTables = [
            { title: "Representative Vehicles", cols: ["Vehicle Class", "GVW (tonnes)", "ESAL Factor", "% of Fleet"], rows: [
              ["Motorcycle (MC)", "0.2", "0.0003", "28%"], ["Car / Sedan", "1.5", "0.0004", "22%"], ["Pickup / SUV", "2.8", "0.002", "14%"],
              ["Mini Bus (14-seat)", "3.5", "0.01", "12%"], ["Medium Bus (Coaster)", "7.0", "0.18", "6%"], ["Medium Truck (2-axle)", "11.0", "0.45", "8%"],
              ["Heavy Truck (3-axle)", "22.0", "2.1", "5%"], ["Articulated Truck", "40.0", "4.5", "3%"], ["Tanker / Fuel", "36.0", "3.8", "2%"],
            ]},
            { title: "Climate Zones", cols: ["Zone", "Rainfall (mm/yr)", "Moisture Index", "Temp Range °C"], rows: [
              ["Lake Victoria Crescent", "1,200–1,500", "Wet", "18–28"], ["Western Highlands", "1,000–1,800", "Wet-Humid", "12–25"],
              ["Northern Savanna", "800–1,200", "Sub-humid", "20–35"], ["Karamoja Semi-arid", "500–800", "Dry", "22–38"],
              ["Eastern Highlands", "1,200–2,000", "Humid", "15–27"], ["Central Plateau", "1,100–1,400", "Sub-humid", "18–30"],
            ]},
            { title: "Axle Loading (Vehicle Mass & Loading)", cols: ["Vehicle Type", "Legal Limit (t)", "Avg Observed (t)", "Overload %"], rows: [
              ["2-Axle Truck", "18.0", "21.4", "38%"], ["3-Axle Truck", "25.0", "28.6", "42%"], ["Artic (6-axle)", "48.0", "54.2", "35%"],
              ["Tanker", "44.0", "47.8", "28%"], ["Tipper", "22.0", "26.1", "45%"], ["Bus", "16.0", "15.2", "5%"],
            ]},
            { title: "Road Deterioration Models", cols: ["Distress Type", "Model", "Key Calibration Factor", "Uganda Value"], rows: [
              ["Cracking Initiation", "HDM-4 RDME", "Kci (Env.)", "1.15"], ["Cracking Progression", "HDM-4 RDME", "Kcp", "1.08"],
              ["Ravelling Initiation", "HDM-4 RDME", "Kvi", "0.95"], ["Rutting (Structural)", "HDM-4 RDME", "Krs", "1.22"],
              ["Roughness Progression", "HDM-4 RDME", "Kgm", "1.10"], ["Potholing", "HDM-4 RDME", "Kpt", "1.30"],
              ["Edge Break", "HDM-4 RDME", "Ked", "1.05"], ["Texture Depth Loss", "HDM-4 RDME", "Ktd", "0.98"],
            ]},
            { title: "Work Effects Models", cols: ["Treatment", "Reset IRI", "Service Life (yr)", "Cost $/km"], rows: [
              ["Routine Patching", "Reduce 0.5", "1", "800–1,500"], ["Periodic Reseal (SS)", "3.5", "5–7", "15,000–25,000"],
              ["Overlay 50mm AC", "2.8", "8–10", "85,000–120,000"], ["Reconstruction", "2.0", "15–20", "250,000–450,000"],
              ["Gravel Resheeting", "8.0", "3–4", "12,000–18,000"], ["Spot Regravelling", "Reduce 2.0", "2", "5,000–8,000"],
            ]},
            { title: "Road User Effects Models", cols: ["Component", "Model Type", "Key Input", "Uganda Calibration"], rows: [
              ["VOC – Fuel", "HDM-4 RUE", "Speed, IRI, gradient", "Fuel UGX 5,200/L"], ["VOC – Tyres", "HDM-4 RUE", "IRI, texture", "Tyre UGX 450K"],
              ["VOC – Maintenance", "HDM-4 RUE", "Roughness", "Labour UGX 15K/hr"], ["VOC – Depreciation", "HDM-4 RUE", "Utilisation", "As HDM default"],
              ["Travel Time", "HDM-4 RUE", "Speed model", "See valuation table"], ["Accident Cost", "HDM-4 RUE", "Traffic volume", "See accident table"],
            ]},
            { title: "Unit Costs by Surface Type", cols: ["Surface Type", "Construction $/km", "Periodic Maint $/km/yr", "Routine Maint $/km/yr"], rows: [
              ["AC (Asphalt Concrete)", "350,000–600,000", "8,500", "2,800"], ["DBST (Double Seal)", "180,000–280,000", "5,200", "2,200"],
              ["SBST (Single Seal)", "120,000–180,000", "4,800", "2,000"], ["Gravel", "45,000–80,000", "3,500", "1,800"],
              ["Earth", "15,000–30,000", "2,000", "1,200"], ["Concrete (PCCP)", "500,000–800,000", "3,200", "1,500"],
            ]},
            { title: "Traffic Flow Patterns", cols: ["Road Class", "Peak Hr %", "Directional Split", "Seasonal Factor"], rows: [
              ["National Trunk (NT)", "8–12%", "55/45", "1.05–1.15"], ["District Road (DR)", "6–10%", "50/50", "1.10–1.30"],
              ["Urban Arterial", "10–14%", "60/40", "1.02–1.05"], ["Community Access (CAR)", "4–8%", "50/50", "1.15–1.40"],
              ["KCCA / CBD", "12–16%", "55/45", "1.01–1.03"],
            ]},
            { title: "Speed Flow Types", cols: ["Road Type", "Free Flow (km/h)", "Capacity (veh/hr)", "V/C at LOS D"], rows: [
              ["2-Lane Paved Rural", "80–100", "1,200", "0.85"], ["2-Lane Unpaved", "40–60", "600", "0.75"],
              ["4-Lane Divided Urban", "60–80", "3,600", "0.90"], ["Single Carriageway Urban", "40–50", "1,800", "0.80"],
              ["Mountain / Escarpment", "30–50", "800", "0.70"],
            ]},
            { title: "Speed Reduction Factors", cols: ["Factor", "Paved Impact", "Unpaved Impact", "Notes"], rows: [
              ["Roughness (IRI)", "−2 km/h per IRI unit", "−3 km/h per IRI unit", "Above IRI 4"], ["Gradient > 6%", "−8 to −15 km/h", "−12 to −20 km/h", "Loaded trucks"],
              ["Curvature", "−5 to −10 km/h", "−8 to −15 km/h", "Radius < 100m"], ["Width < 5.5m", "−5 km/h", "−8 km/h", "Two-way traffic"],
              ["Wet Season", "−5 to −10 km/h", "−15 to −25 km/h", "Unpaved severely affected"],
            ]},
            { title: "Traffic Growth Rates", cols: ["Vehicle Class", "2024–2030 (%/yr)", "2030–2040 (%/yr)", "Source"], rows: [
              ["Motorcycles", "6.5%", "4.0%", "UNRA AADT surveys"], ["Cars", "5.0%", "3.5%", "UBOS projections"],
              ["Buses", "4.0%", "3.0%", "MoWT forecasts"], ["Light Trucks", "4.5%", "3.0%", "GDP elasticity model"],
              ["Heavy Trucks", "5.5%", "4.0%", "Freight corridor data"], ["Articulated", "6.0%", "4.5%", "Northern corridor growth"],
            ]},
            { title: "Vehicle Utilization", cols: ["Vehicle Type", "Avg km/yr", "Avg Load Factor", "Service Life (yr)"], rows: [
              ["Motorcycle", "18,000", "85%", "5"], ["Car / Sedan", "22,000", "40%", "12"], ["Minibus", "55,000", "75%", "8"],
              ["Medium Truck", "45,000", "70%", "10"], ["Heavy Truck", "60,000", "80%", "12"], ["Articulated", "75,000", "85%", "15"],
            ]},
            { title: "Travel Time Valuation", cols: ["Trip Purpose", "Value (UGX/hr)", "Value (USD/hr)", "Basis"], rows: [
              ["Business – Driver", "25,000", "6.75", "Wage rate method"], ["Business – Passenger", "18,000", "4.86", "GDP per capita"],
              ["Commuter", "8,500", "2.30", "Willingness-to-pay"], ["Leisure / Social", "4,200", "1.14", "50% of commuter"],
              ["Freight (per tonne)", "12,000", "3.24", "Inventory cost method"],
            ]},
            { title: "Unit Costs of Vehicle Resources", cols: ["Resource", "Unit", "Cost (UGX)", "Cost (USD)"], rows: [
              ["Diesel Fuel", "Litre", "5,200", "1.41"], ["Petrol Fuel", "Litre", "5,500", "1.49"],
              ["Engine Oil", "Litre", "28,000", "7.57"], ["New Tyre (truck)", "Each", "1,850,000", "500"],
              ["New Tyre (car)", "Each", "450,000", "122"], ["Driver Wage", "Hour", "15,000", "4.05"],
              ["Mechanic Labour", "Hour", "12,000", "3.24"],
            ]},
            { title: "Accident Data", cols: ["Metric", "National Roads", "District Roads", "Urban Roads"], rows: [
              ["Fatal Accidents / 100M veh-km", "8.2", "12.5", "5.4"], ["Serious Injury / 100M veh-km", "22.0", "28.0", "18.0"],
              ["Minor Injury / 100M veh-km", "45.0", "52.0", "38.0"], ["Cost per Fatality (UGX M)", "680", "680", "680"],
              ["Cost per Serious Injury (UGX M)", "120", "120", "120"],
            ]},
            { title: "Emissions", cols: ["Pollutant", "Car (g/km)", "Truck (g/km)", "Damage Cost (UGX/kg)"], rows: [
              ["CO₂", "180", "850", "150"], ["CO", "2.5", "6.8", "85"], ["HC", "0.3", "1.2", "320"],
              ["NOₓ", "0.4", "8.5", "1,200"], ["PM₂.₅", "0.02", "0.35", "18,500"], ["SO₂", "0.01", "0.08", "2,800"],
            ]},
            { title: "Road Network Matrix", cols: ["Classification", "Paved (km)", "Unpaved (km)", "Total (km)"], rows: [
              ["National Trunk", "4,257", "612", "4,869"], ["District Roads (DUCAR)", "8,420", "24,580", "33,000"],
              ["Urban / KCCA", "1,850", "620", "2,470"], ["Community Access", "2,100", "28,900", "31,000"],
              ["Total Network", "16,627", "54,712", "71,339"],
            ]},
            { title: "Work Standards", cols: ["Standard", "Trigger (IRI)", "Treatment", "Design Life (yr)"], rows: [
              ["Preventive Maintenance", "< 4.0", "Crack seal, fog spray", "2–3"], ["Reseal", "4.0–6.0", "DBST / Slurry seal", "5–7"],
              ["Overlay", "6.0–8.0", "50mm AC overlay", "8–12"], ["Rehabilitation", "8.0–12.0", "100mm AC + base repair", "12–15"],
              ["Reconstruction", "> 12.0", "Full rebuild", "15–20"], ["Gravel Resheet", "N/A (GL < 50mm)", "150mm laterite", "3–4"],
            ]},
            { title: "Economic Analysis Parameters", cols: ["Parameter", "Value", "Unit", "Notes"], rows: [
              ["Discount Rate", "12%", "%/yr", "MoFPED standard"], ["Analysis Period", "20", "years", "HDM-4 default for Uganda"],
              ["Base Year", "2024", "—", "Current calibration year"], ["Currency", "UGX", "—", "Exchange: 3,700 UGX/USD"],
              ["Price Contingency", "5%", "%/yr", "Inflation assumption"], ["VOC Savings Weight", "1.0", "—", "Full economic cost"],
              ["Time Savings Weight", "1.0", "—", "Full valuation"], ["Accident Savings Weight", "1.0", "—", "Full valuation"],
              ["Min EIRR Threshold", "12%", "%", "GoU acceptance threshold"], ["Min NPV", "> 0", "UGX", "Positive net benefit required"],
            ]},
          ];
          return hdmTables.map(({ title, cols, rows }) => (
            <div key={title} className="hdm-table-block">
              <h4 className="hdm-table-title">{title}</h4>
              <div className="table-wrap" style={{ margin: 0, padding: 0 }}>
                <table style={{ minWidth: "auto" }}>
                  <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
          ));
        })()}
      </section>
    </div>
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

    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
    }).addTo(map);

    L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      opacity: 0.92,
    }).addTo(map);

    L.control.zoom({ position: "topright" }).addTo(map);
    L.control
      .attribution({ position: "bottomright", prefix: false })
      .addAttribution("Esri World Imagery and reference labels")
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
      const manifest = await fetchUgandaLayersManifest();
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
            layer.bindPopup(
              `<strong>${name}</strong><br/>Region: ${p.region || "—"}<br/>Roads: ${roads}<br/>Total: ${km} km`,
              { className: "modern-popup" }
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
            layer.bindPopup(
              `<strong>${p.DistName || "—"}</strong><br/>Class: ${p.RdClass || "—"}<br/>${(p.length_km || 0).toFixed(1)} km`,
              { className: "modern-popup" }
            );
          },
        }).addTo(map);
        if (!showNational) map.removeLayer(layersRef.current.national);
      }

      // National road network FY25/26
      const nationalRes = await fetch(manifestDataUrl(manifest, "national_roads_geojson", "uganda_national_roads_fy25_26.geojson"));
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
            layer.bindPopup(
              `<strong>${p.road_no || "National road"}: ${p.road_name || "Unnamed link"}</strong><br/>Class: ${p.road_class || "—"}<br/>Surface: ${p.surface || "—"}<br/>Region: ${p.maintenance_region || "—"} / ${p.maintenance_district || "—"}<br/>Length: ${Number(p.length_km || 0).toLocaleString()} km<br/>NDP IV: ${p.ndpiv_priority || "—"}`,
              { className: "modern-popup" }
            );
          },
        }).addTo(map);
        if (!showOsmMajor) map.removeLayer(layersRef.current.osmMajor);
      }

      // All-road district summary from OSM + DUCAR master build
      const summaryRes = await fetch(manifestDataUrl(manifest, "roads_district_summary_geojson", "uganda_roads_district_summary.geojson"));
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
            layer.bindPopup(
              `<strong>${p.district || "District"}</strong><br/>All road records: ${Number(p.road_records || 0).toLocaleString()}<br/>Total length: ${Number(p.total_km || 0).toLocaleString()} km<br/>OSM length: ${Number(p.osm_km || 0).toLocaleString()} km<br/>Verify: ${Number(p.verify_count || 0).toLocaleString()}`,
              { className: "modern-popup" }
            );
          },
        }).addTo(map);
        if (!showKCCA) map.removeLayer(layersRef.current.kcca);
      }
      const unifiedRes = await fetch(manifestDataUrl(manifest, "unified_roads_geojson", "uganda_unified_roads_web.geojson"));
      if (unifiedRes.ok) setRoadData(await unifiedRes.json());

      // OSM major/named roads
      const osmRes = await fetch(manifestDataUrl(manifest, "osm_major_roads_geojson", "uganda_osm_major_roads_web.geojson"));
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
            layer.bindPopup(
              `<strong>${p.road_name || p.road_ref || "Unnamed OSM road"}</strong><br/>OSM: ${p.osm_highway || "—"}<br/>DUCAR: ${p.ducar_class || "—"}<br/>District: ${p.district || "—"}<br/>${Number(p.length_km || 0).toFixed(2)} km<br/>Quality: ${p.data_quality_flag || "—"}`,
              { className: "modern-popup" }
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
            layer.bindPopup(
              `<strong>${p.Link_Name || p.Road_No_1 || "KCCA Road"}</strong><br/>Surface: ${p.Surface__1 || "—"}<br/>${(p.Length_km_ || 0)} km`,
              { className: "modern-popup" }
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
        layer.bindPopup(
          `<strong>${p.road_name || "Road"}</strong><br/>System: ${p.road_system}<br/>Class: ${p.road_class}<br/>Surface: ${p.surface}<br/>Region/District: ${p.region} / ${p.district}<br/>Length: ${Number(p.length_km || 0).toLocaleString()} km<br/>Scope: ${p.ducar_analysis_scope}<br/>Clause: ${p.exemption_clause}<br/>Quality: ${p.quality_flag}`,
          { className: "modern-popup" }
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
          <h2>Geospatial Risk Surface — ESRI Imagery + Labels</h2>
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
        <span><i className="dot selected" /> Selected Asset</span>
        <span><i className="dash-sample" /> Unified Road Network</span>
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
  const [scenarioName, setScenarioName] = useState("Baseline");
  const [ingestedRecords, setIngestedRecords] = useState([]);
  const [ingestionMeta, setIngestionMeta] = useState({ file: "No file loaded", status: "Awaiting CSV or Excel workbook" });
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

  function applyScenario(scenario) {
    setScenarioName(scenario.name);
    setBudget(scenario.budget);
    setReservePercent(scenario.reserve);
  }

  async function ingestFile(file) {
    if (!file) return;
    setIngestionMeta({ file: file.name, status: "Reading file..." });
    try {
      const ext = file.name.split(".").pop()?.toLowerCase();
      let rows = [];
      if (ext === "csv") {
        rows = parseCsv(await file.text());
      } else if (["xlsx", "xls"].includes(ext)) {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      } else {
        throw new Error("Unsupported file type. Use CSV, XLSX or XLS.");
      }
      const normalized = rows.map((row, index) => normalizeImportedAsset(row, index));
      setIngestedRecords(normalized);
      setIngestionMeta({ file: file.name, status: `${normalized.length.toLocaleString()} records ready for review` });
    } catch (error) {
      setIngestedRecords([]);
      setIngestionMeta({ file: file.name, status: error.message || "Unable to read file" });
    }
  }

  function commitIngestion(mode) {
    if (!ingestedRecords.length) return;
    const next = mode === "replace" ? ingestedRecords : [...records, ...ingestedRecords];
    setRecords(next);
    runAnalysis(next);
    setIngestionMeta({ ...ingestionMeta, status: `${mode === "replace" ? "Replaced" : "Appended"} system dataset with ${ingestedRecords.length.toLocaleString()} imported records` });
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
    pim: { ...activePage, title: "Public Investment Management Principles" },
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
        <div className="workspace-topbar">
          <div>
            <span>DUCAR Priority Studio</span>
            <strong>{pageMeta.title}</strong>
          </div>
          <div className="topbar-actions">
            <span><Database size={15} /> {records.length} assets</span>
            <span><Gauge size={15} /> {apiMode}</span>
            <button className="icon-action" onClick={() => runAnalysis()} aria-label="Re-run analysis"><RefreshCcw size={16} /></button>
          </div>
        </div>
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
              <MediaRibbon />
              <section className="metrics-grid">
                <Metric icon={CircleDollarSign} label="Net budget" value={`UGX ${currency.format(analysis.netBudget || 0)}`} />
                <Metric icon={Activity} label="Selected cost" value={`UGX ${currency.format(analysis.summary?.selectedCost || 0)}`} tone="green" />
                <Metric icon={ShieldAlert} label="High ML risk assets" value={analysis.summary?.highRisk || 0} tone="red" />
                <Metric icon={Layers} label="Regions / classes" value={grouped.length} tone="gold" />
              </section>
              <InfographicPanel analysis={analysis} grouped={grouped} programme={programme} />
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="all" limit={8} compact title="Featured Intelligence Views" />
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
            <>
              <section className="scenario-command-panel">
                <div>
                  <p className="eyebrow">Active scenario</p>
                  <h2>{scenarioName}</h2>
                  <span>UGX {currency.format(budget)} gross envelope / {reservePercent}% reserve / UGX {currency.format(analysis.netBudget || 0)} net budget</span>
                </div>
                <button onClick={() => runAnalysis()}><RefreshCcw size={16} /> Run Scenario</button>
              </section>
              <section className="control-strip">
                <label>
                  Received Budget UGX
                  <input type="number" value={budget} onChange={(e) => { setScenarioName("Custom"); setBudget(Number(e.target.value)); }} />
                </label>
                <label>
                  Emergency Reserve %
                  <input type="number" value={reservePercent} onChange={(e) => { setScenarioName("Custom"); setReservePercent(Number(e.target.value)); }} />
                </label>
                <label>
                  Programme Filter
                  <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                    {["All", "Selected", "Deferred", "Referred", "Check cost"].map((x) => <option key={x}>{x}</option>)}
                  </select>
                </label>
                <label>
                  Imported Dataset Size
                  <input type="text" value={`${records.length.toLocaleString()} active assets`} readOnly />
                </label>
              </section>
              <section className="scenario-grid">
                {BUDGET_SCENARIOS.map((scenario) => (
                  <button key={scenario.name} className={`scenario-card ${scenarioName === scenario.name ? "active" : ""}`} onClick={() => applyScenario(scenario)}>
                    <strong>{scenario.name}</strong>
                    <span>UGX {currency.format(scenario.budget)} / {scenario.reserve}% reserve</span>
                    <em>{scenario.detail}</em>
                  </button>
                ))}
              </section>
              <section className="ingestion-engine">
                <div className="viz-title">
                  <h3>CSV / Excel Ingestion Engine</h3>
                  <span>Upload, map, preview, append or replace assets</span>
                </div>
                <div className="ingestion-dropzone">
                  <input type="file" accept=".csv,.xlsx,.xls" onChange={(e) => ingestFile(e.target.files?.[0])} />
                  <div>
                    <strong>{ingestionMeta.file}</strong>
                    <span>{ingestionMeta.status}</span>
                    <small>Recognised fields: {INGESTION_FIELDS.join(", ")}</small>
                  </div>
                  <button className="secondary" onClick={() => commitIngestion("append")} disabled={!ingestedRecords.length}>Append</button>
                  <button onClick={() => commitIngestion("replace")} disabled={!ingestedRecords.length}>Replace</button>
                </div>
                <div className="ingestion-preview">
                  {(ingestedRecords.length ? ingestedRecords.slice(0, 8) : records.slice(0, 4)).map((row) => (
                    <article key={row.assetId}>
                      <strong>{row.assetId}</strong>
                      <span>{row.admin} / {row.region}</span>
                      <em>{row.functionalClass} - {row.intervention}</em>
                      <b>UGX {currency.format(Number(row.quantity || 0) * Number(row.unitRate || 0))}</b>
                    </article>
                  ))}
                </div>
              </section>
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="controls" limit={6} compact title="Input and Scenario Intelligence" />
            </>
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
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="all" limit={50} title="All 50 Linked Intelligence Views" />
            </>
          )}

          {activeSection === "pim" && (
            <>
              <PimEnginePanel programme={programme} analysis={analysis} />
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="pim" limit={8} compact title="PIMS and Manual Intelligence" />
            </>
          )}
          {activeSection === "framework" && (
            <>
              <ProcessFlow analysis={analysis} grouped={grouped} />
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="framework" limit={6} compact title="Framework Flow Intelligence" />
            </>
          )}
          {activeSection === "traffic" && (
            <>
              <TrafficAnalyticsPanel programme={programme} grouped={grouped} />
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="traffic" limit={10} compact title="Traffic and Economic Intelligence" />
            </>
          )}
          {activeSection === "gis" && (
            <>
              <MapScene3D programme={programme} />
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="gis" limit={8} compact title="GIS and Network Intelligence" />
            </>
          )}

          {activeSection === "allocation" && (
            <>
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
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="allocation" limit={6} compact title="Allocation Intelligence Views" />
            </>
          )}

          {activeSection === "programme" && (
            <>
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
                    <th>Evidence</th>
                    <th>Monitoring</th>
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
                      <td><span className="evidence-pill">{p.evidenceScore || 0}%</span></td>
                      <td><span className={`monitoring-pill ${String(p.monitoringTier || "").toLowerCase()}`}>{p.monitoringTier || "Unassigned"}</span></td>
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
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="programme" limit={6} compact title="Programme Table Intelligence" />
            </>
          )}
        </PageChrome>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
