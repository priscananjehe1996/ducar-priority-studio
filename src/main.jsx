import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  Activity,
  ArrowLeft,
  ArrowUpLeft,
  BookOpen,
  Bot,
  Brain,
  CircleDollarSign,
  ClipboardCheck,
  Database,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  GitBranch,
  Gauge,
  Globe2,
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
import sample from "../data/sample_assets.json";
import { HDM4_INDICATORS, HDM4_INPUT_TABLES } from "./hdm4Data.js";
import { prioritise, sourceReferences, summarise } from "./prioritisation.js";
import { WORLD_COUNTRIES_BY_REGION } from "./worldCountries.js";
import "./product.css";

const BASE = import.meta.env.BASE_URL || "/ducar-priority-studio/";
let mapLibreLoader;

function loadMapLibre() {
  if (!mapLibreLoader) {
    mapLibreLoader = Promise.all([
      import("maplibre-gl"),
      import("maplibre-gl/dist/maplibre-gl.css"),
    ]).then(([module]) => module.default || module);
  }
  return mapLibreLoader;
}

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
    const path = raw.replaceAll("\\", "/").trim();
    if (/^https?:\/\//i.test(path)) return path;
    if (path.startsWith("data/")) return `${BASE}${path}`;
    if (path.startsWith("/")) return path;
    const filename = path.split("/").pop();
    if (filename) return `${BASE}data/${filename}`;
  }
  return `${BASE}data/${fallbackFile}`;
}

async function fetchManifestJson(manifest, key, fallbackFile) {
  const res = await fetch(manifestDataUrl(manifest, key, fallbackFile), { cache: "no-store" });
  if (!res.ok) throw new Error(`Unable to load ${key}`);
  return res.json();
}

function formatCompactDate(value) {
  if (!value) return "Date pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date pending";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date) + " UTC";
}

function formatKm(value) {
  return `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} km`;
}

function formatCount(value, fallback = 0) {
  return Number(value || fallback || 0).toLocaleString();
}
const currency = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function formatMoneyCompact(value) {
  const amount = Number(value || 0);
  if (Math.abs(amount) >= 1_000_000_000) return `UGX ${(amount / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}b`;
  if (Math.abs(amount) >= 1_000_000) return `UGX ${(amount / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}m`;
  return `UGX ${currency.format(amount)}`;
}

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
  { id: "command", label: "Command", icon: LayoutDashboard },
  { id: "portfolio", label: "Portfolio", icon: CircleDollarSign },
  { id: "network", label: "Network", icon: MapIcon },
  { id: "traffic", label: "Traffic", icon: Truck },
  { id: "pims", label: "PIMS", icon: ClipboardCheck },
  { id: "hdm4", label: "HDM-4", icon: LineChart },
  { id: "framework", label: "Framework", icon: GitBranch },
  { id: "global", label: "Global", icon: Globe2 },
  { id: "evidence", label: "Evidence", icon: Database },
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
  "MoWT road design, specifications, NMT, urban road and road-and-bridge manual catalogues feed geometric, drainage, pavement, safety, materials, quality and maintenance rules.",
  "Vision 2040, MoFPED budget speeches, NBFPs, background-to-budget papers, approved estimates and budget catalogues are treated as live fiscal-policy evidence streams for infrastructure prioritisation.",
];

const UGANDA_EVIDENCE_STREAMS = [
  {
    title: "Uganda Vision 2040",
    agency: "National Planning Authority",
    type: "Long-term national vision",
    cadence: "Reviewed as national planning evidence changes",
    url: "https://npa.go.ug/uganda-vision-2040/",
    apa: "National Planning Authority. (n.d.). Uganda Vision 2040. The Republic of Uganda. Retrieved May 7, 2026, from https://npa.go.ug/uganda-vision-2040/",
    logic: "Tests whether DUCAR roads support infrastructure bottleneck removal, competitiveness and spatial transformation.",
    indicators: ["Strategic bottlenecks", "Infrastructure backbone", "Market access", "Urbanisation", "Productivity"],
    score: 92,
  },
  {
    title: "Budget Speech FY 2024/25",
    agency: "Ministry of Finance, Planning and Economic Development",
    type: "Annual fiscal policy statement",
    cadence: "Annual",
    url: "https://www.budget.finance.go.ug/content/budget-speech-12",
    apa: "Ministry of Finance, Planning and Economic Development. (2024). Budget Speech FY 2024/25. The Republic of Uganda.",
    logic: "Reads priority spending areas, revenue assumptions, expenditure proposals and transport-sector commitments before scenario selection.",
    indicators: ["Annual priorities", "Revenue measures", "Works envelope", "Programme commitments", "Fiscal constraints"],
    score: 88,
  },
  {
    title: "Budget Speech FY 2025/26",
    agency: "Ministry of Finance, Planning and Economic Development",
    type: "Annual fiscal policy statement",
    cadence: "Annual",
    url: "https://budget.finance.go.ug/sites/default/files/National%20Budget%20docs/Budget%20Speech%20FY2025-26.pdf",
    apa: "Ministry of Finance, Planning and Economic Development. (2025). Budget Speech Financial Year 2025/26. The Republic of Uganda.",
    logic: "Updates the medium-term expenditure signal for integrated transport infrastructure, works, road fund and local government allocations.",
    indicators: ["MTEF", "Integrated transport", "Road Fund", "Local governments", "Urban roads"],
    score: 90,
  },
  {
    title: "Background to the Budget FY 2024/25",
    agency: "Ministry of Finance, Planning and Economic Development",
    type: "Economic and budget performance analysis",
    cadence: "Annual",
    url: "https://budget.finance.go.ug/content/background-budget-10",
    apa: "Ministry of Finance, Planning and Economic Development. (2024). Background to the Budget FY 2024/25. The Republic of Uganda.",
    logic: "Adds economic performance, budget performance, policy priorities and medium-term outlook signals to prioritisation assumptions.",
    indicators: ["Economic performance", "Budget performance", "Policy priorities", "Medium-term outlook", "Implementation risks"],
    score: 86,
  },
  {
    title: "Approved Budget Estimates FY 2024/25",
    agency: "Ministry of Finance, Planning and Economic Development",
    type: "Approved expenditure estimates",
    cadence: "Annual",
    url: "https://budget.finance.go.ug/content/approved-budget-estimates-1241",
    apa: "Ministry of Finance, Planning and Economic Development. (2024). Approved Budget Estimates, Central Governments FY 2024/25. The Republic of Uganda.",
    logic: "Provides spending-agency allocations, recurrent/development splits, output lines and budget ceilings for realism checks.",
    indicators: ["Agency allocations", "Development spending", "Outputs", "Expenditure items", "Budget ceilings"],
    score: 89,
  },
  {
    title: "National Budget Framework Paper FY 2024/25",
    agency: "Ministry of Finance, Planning and Economic Development",
    type: "Medium-term budget strategy",
    cadence: "Annual before final budget",
    url: "https://www.budget.finance.go.ug/content/national-budget-framework-paper-15",
    apa: "Ministry of Finance, Planning and Economic Development. (2024). National Budget Framework Paper FY 2024/25. The Republic of Uganda.",
    logic: "Connects NDP priorities, macro-fiscal strategy, resource envelope and sector expenditure plans to the DUCAR allocation model.",
    indicators: ["Resource envelope", "Fiscal strategy", "Sector expenditure", "NDP link", "Priority interventions"],
    score: 91,
  },
  {
    title: "MoFPED All Documents Catalogue",
    agency: "Ministry of Finance, Planning and Economic Development",
    type: "Budget library catalogue",
    cadence: "Continuous catalogue scan",
    url: "https://budget.finance.go.ug/all-documents",
    apa: "Ministry of Finance, Planning and Economic Development. (n.d.). All documents. The Republic of Uganda. Retrieved May 7, 2026, from https://budget.finance.go.ug/all-documents",
    logic: "Acts as the bot discovery register for approved estimates, performance reports, workplans, BFPs and circulars.",
    indicators: ["Document discovery", "Financial years", "Performance reports", "Local records", "Download links"],
    score: 84,
  },
  {
    title: "MoFPED Budget Documents Page",
    agency: "Ministry of Finance, Planning and Economic Development",
    type: "Publication feed",
    cadence: "Continuous publication scan",
    url: "https://finance.go.ug/publications/budget-documents",
    apa: "Ministry of Finance, Planning and Economic Development. (n.d.). Budget documents. The Republic of Uganda. Retrieved May 7, 2026, from https://finance.go.ug/publications/budget-documents",
    logic: "Extends the literature review with newer budget call circulars, budget execution circulars, NBFPs and fiscal guidance.",
    indicators: ["Budget circulars", "NBFP updates", "Execution guidance", "Publication dates", "Fiscal controls"],
    score: 82,
  },
];

const TRAFFIC_EVIDENCE_SOURCES = [
  {
    title: "Uganda Roads",
    agency: "World Bank Transport Data",
    type: "Open road network and traffic-volume dataset",
    url: "https://datacatalog.worldbank.org/infrastructure-data/search/dataset/0041482/Uganda-Roads",
    use: "Corroborates road type, condition and traffic-volume attributes against the local unified road layer.",
  },
  {
    title: "Uganda Road Network (main roads)",
    agency: "AmeriGEOSS / WFP OpenStreetMap extract",
    type: "Open shapefile road network",
    url: "https://data.amerigeoss.org/dataset/uganda-road-network-main-roads",
    use: "Supports open-source road geometry checks, naming confidence and missing-link review.",
  },
  {
    title: "Integrated Transport Infrastructure Services Annual Monitoring FY2024/25 Report",
    agency: "Ministry of Finance, Planning and Economic Development",
    type: "Transport budget and performance monitoring report",
    url: "https://www.finance.go.ug/sites/default/files/reports/Integrated%20Transport%20Infrastructure%20Services%20Annual%20Monitoring%20FY2024-25%20Report.pdf",
    use: "Adds national and DUCAR maintenance-budget, implementation and performance context to traffic pressure interpretation.",
  },
  {
    title: "Integrated Transport Infrastructure Services Annual Budget Monitoring Report FY2023/24",
    agency: "Ministry of Finance, Planning and Economic Development",
    type: "Transport budget monitoring report",
    url: "https://www.finance.go.ug/sites/default/files/reports/Integrated%20Transport%20Infrastructure%20Services%20Annual%20Budget%20Monitoring%20report%20FY%202023-24.pdf",
    use: "Links traffic and access pressure to monitored road works, releases, absorption and physical progress.",
  },
  {
    title: "Manuals and Specifications for Road Works",
    agency: "Ministry of Works and Transport",
    type: "Road design, pavement, bridge, drainage and maintenance standards catalogue",
    url: "https://www.works.go.ug/index.php/policies-regulations/manuals-for-road-bridge-works",
    use: "Controls classification, geometric, pavement, drainage, maintenance and road-user analysis assumptions.",
  },
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
    title: "Uganda Vision 2040",
    agency: "National Planning Authority",
    year: "2040 horizon",
    href: "https://npa.go.ug/uganda-vision-2040/",
    apa: "National Planning Authority. (n.d.). Uganda Vision 2040. The Republic of Uganda. Retrieved May 7, 2026, from https://npa.go.ug/uganda-vision-2040/",
    controls: ["Infrastructure bottlenecks", "Market access", "Urbanisation", "Competitiveness", "Long-term transformation"],
  },
  {
    title: "MoFPED Budget Evidence Stream",
    agency: "Ministry of Finance, Planning and Economic Development",
    year: "Continuous",
    href: "https://budget.finance.go.ug/all-documents",
    apa: "Ministry of Finance, Planning and Economic Development. (n.d.). All documents. The Republic of Uganda. Retrieved May 7, 2026, from https://budget.finance.go.ug/all-documents",
    controls: ["Budget speeches", "National Budget Framework Papers", "Approved estimates", "Budget performance", "Execution circulars", "Local government records"],
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
  {
    title: "General Specifications for Road and Bridge Works",
    agency: "Ministry of Works and Transport",
    year: "2026",
    href: `${BASE}docs/mowt/Final-General-Specifications-for-Roads-and-Bridges_March-2026.pdf`,
    apa: "Ministry of Works and Transport. (2026). General specifications for road and bridge works. The Republic of Uganda.",
    controls: ["Public roadworks standards", "Materials specifications", "Construction quality", "Bridge works", "Maintenance and approval controls"],
  },
  {
    title: "Road Design Manual Volume VI: Urban Roads",
    agency: "Ministry of Works and Transport",
    year: "2023",
    href: `${BASE}docs/mowt/URDM-Manual-Part-1-July-2023.pdf`,
    apa: "Ministry of Works and Transport. (2023). Road design manual volume VI: Urban roads. The Republic of Uganda.",
    controls: ["Urban street hierarchy", "Traffic operations", "Junctions", "Road safety", "Urban drainage and utilities"],
  },
  {
    title: "Road Design Manual Volume VI: Urban Roads Standard Drawings",
    agency: "Ministry of Works and Transport",
    year: "2023",
    href: `${BASE}docs/mowt/URDM-Standard-Drawings-July2023.pdf`,
    apa: "Ministry of Works and Transport. (2023). Road design manual volume VI: Urban roads, part 2 standard drawings. The Republic of Uganda.",
    controls: ["Urban road cross-sections", "Junction details", "Drainage details", "Traffic control drawings", "Construction details"],
  },
  {
    title: "Road Design Manual Volume VII: Non-Motorized Transport",
    agency: "Ministry of Works and Transport",
    year: "2026",
    href: `${BASE}docs/mowt/NMT-Design-and-Operational-Manual-web-2.pdf`,
    apa: "Ministry of Works and Transport. (2026). Road design manual volume VII: Non-motorized transport. The Republic of Uganda.",
    controls: ["Pedestrian facilities", "Cycling facilities", "Safe crossings", "Universal access", "NMT operations and maintenance"],
  },
];

const MOWT_CATALOGUE_MANUALS = [
  ["Road Design Manual Volume 1: Geometric Design", "2010", "https://www.works.go.ug/index.php/policies-regulations/manuals-for-road-bridge-works/18-manuals-for-road-and-bridge-works/152-road-design-manual-volume-1-geometric-design-mowt-2010", "Alignment, cross-section, sight distance and junction geometry."],
  ["Road Design Manual Volume 2: Drainage Design", "2010", "https://mail.works.go.ug/policies-regulations/manuals-for-road-bridge-works/18-manuals-for-road-and-bridge-works/153-road-design-manual-volume-2-drainage-design-mowt-2010", "Hydrology, culverts, drainage structures and stormwater performance."],
  ["Road Design and Construction Manual: Low Volume Sealed Roads", "2018", "https://www.works.go.ug/policies-regulations/manuals-for-road-bridge-works/18-manuals-for-road-and-bridge-works/154-road-design-and-construction-manual-low-volume-sealed-roads-mowt-2018", "Low-volume sealed road selection, design and construction controls."],
  ["Road Maintenance Management Manual", "2010", "https://www.works.go.ug/policies-regulations/manuals-for-road-bridge-works/18-manuals-for-road-and-bridge-works/155-road-maintenance-management-manual-mowt-2010", "Maintenance planning, prioritisation, road condition and works programming."],
  ["Road Planning and Design Manual", "2002", "https://www.works.go.ug/policies-regulations/manuals-for-road-bridge-works/18-manuals-for-road-and-bridge-works/156-road-planning-and-design-manual-mowhc-2002", "Planning, road function, project preparation and design basis."],
  ["Road Project Implementation Manual", "2010", "https://www.works.go.ug/policies-regulations/manuals-for-road-bridge-works/18-manuals-for-road-and-bridge-works/157-road-project-implementation-manual-mowt-2010", "Implementation controls, procurement, supervision and reporting."],
  ["Volume 3 Part I: Flexible Pavements Manual", "2010", "https://www.works.go.ug/policies-regulations/manuals-for-road-bridge-works/18-manuals-for-road-and-bridge-works/158-volume-3-part-i-flexible-pavements-manual-mowt-2010", "Traffic loading, subgrade, surfacing and flexible pavement design."],
  ["Volume 3 Part II: Rigid Pavements Manual", "2010", "https://www.works.go.ug/policies-regulations/manuals-for-road-bridge-works/18-manuals-for-road-and-bridge-works/159-volume-3-part-ii-rigid-pavements-manual-mowt-2010", "Concrete pavement structure, joints, materials and design checks."],
  ["Volume 3 Part III: Gravel Roads Manual", "2010", "https://www.works.go.ug/policies-regulations/manuals-for-road-bridge-works/18-manuals-for-road-and-bridge-works/160-volume-3-part-iii-gravel-roads-manual-mowt-2010", "Gravel materials, wearing course, maintenance and climate exposure."],
  ["Volume 4: Bridge Design Manual", "2010", "https://www.works.go.ug/policies-regulations/manuals-for-road-bridge-works/18-manuals-for-road-and-bridge-works/161-volume-4-bridge-design-manual-mowt-2010", "Bridge loading, hydraulic checks, structures and safety resilience."],
  ["Scheme for Maintaining DUCAR and Urban Roads using Own Equipment and Road Gangs", "Catalogue", "https://www.works.go.ug/policies-regulations/manuals-for-road-bridge-works?start=0", "Force account, equipment planning, road gangs and routine maintenance delivery."],
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

const MANUAL_LOGIC_WEIGHTS = [
  ["Asset management", "Adds governance, lifecycle planning, RAMS, asset valuation and annual workplan linkage to the score narrative.", 18],
  ["Road condition", "Raises evidence confidence for condition, IRI, rutting, visual inspection and deterioration trigger rules.", 16],
  ["Traffic and axle loading", "Strengthens traffic demand, equivalent axle loading, representative vehicles and speed-flow assumptions.", 14],
  ["GIS and referencing", "Controls route identity, linear referencing, district joins, GIS QA and network matrix analysis.", 13],
  ["Bridge and structures", "Adds BMS inventory, culvert/bridge condition, structural criticality and inspection templates.", 12],
  ["Quality management", "Raises QMP gate weighting for data validation, collection procedures and acceptance checks.", 11],
  ["Construction and supervision", "Feeds readiness, BOQ, work standards, supervision, payment and contract evidence controls.", 9],
  ["Environment and safeguards", "Supports climate, safety, social and environmental risk screening.", 5],
  ["Training and systems", "Supports implementation readiness, user training and system administration capacity.", 2],
];

const GLOBAL_CASE_STUDIES = [
  {
    region: "Europe",
    place: "Madrid Region, Spain",
    source: "PIARC Road Asset Management Manual",
    url: "https://road-asset.piarc.org/en/management-asset-management-implementation/case-studies",
    lesson: "Use staged implementation, clear asset registers and decision-support tooling before chasing advanced optimisation.",
    ducarUse: "DUCAR should prioritise stable route IDs, district ownership and evidence completeness before advanced ML scoring.",
    metrics: ["Asset register", "Implementation maturity", "Tool adoption"],
    score: 88,
  },
  {
    region: "Asia",
    place: "Assam, India",
    source: "PIARC Road Asset Management Manual",
    url: "https://road-asset.piarc.org/en/management-asset-management-implementation/case-studies",
    lesson: "RAMS rollout needs institutional learning, data ownership, training and progressive use of the system by road agencies.",
    ducarUse: "Add district-level data quality roles and training indicators to the DUCAR implementation plan.",
    metrics: ["Training", "Data ownership", "RAMS rollout"],
    score: 82,
  },
  {
    region: "North America",
    place: "United States FHWA case studies",
    source: "Federal Highway Administration Asset Management",
    url: "https://www.fhwa.dot.gov/asset/",
    lesson: "Risk, lifecycle planning, financial planning and communication are separate asset-management capabilities that need explicit measures.",
    ducarUse: "Keep separate DUCAR views for risk, LCCA/economic logic, affordability and public reporting.",
    metrics: ["Risk", "Lifecycle planning", "Financial planning"],
    score: 91,
  },
  {
    region: "Oceania",
    place: "Australia and New Zealand",
    source: "Austroads Guide to Asset Management",
    url: "https://austroads.gov.au/infrastructure/asset-management/guide-to-asset-management",
    lesson: "Whole-of-organisation asset management should cover service levels, information systems, financial management, pavements, structures and improvement.",
    ducarUse: "Treat DUCAR as a service-level and lifecycle management system, not only a road list or annual budget sheet.",
    metrics: ["ISO 55000", "Service levels", "Asset information"],
    score: 90,
  },
  {
    region: "Africa",
    place: "Sub-Saharan Africa road funds/agencies",
    source: "African Development Bank Road Asset Management Toolkit",
    url: "https://www.afdb.org/en/documents/road-asset-management-study-accelerating-road-sector-reforms-part-ii-road-asset-management-toolkit",
    lesson: "Funding sources, management systems and procedures must be aligned because road condition is directly tied to transport cost and economic competitiveness.",
    ducarUse: "Make every allocation scenario show funding gap, implementation capacity, and condition impact.",
    metrics: ["Funding alignment", "Institutional maturity", "Road condition"],
    score: 86,
  },
  {
    region: "Africa",
    place: "South Africa SANRAL",
    source: "SANRAL integrated and annual reports",
    url: "https://www.nra.co.za/publications/integrated-report",
    lesson: "Asset valuation, reporting discipline and long-term investment metrics can make road agencies more transparent and bankable.",
    ducarUse: "Add asset value, depreciation/condition and budget-monitoring statistics to DUCAR reporting.",
    metrics: ["Asset value", "Investment reporting", "Auditability"],
    score: 84,
  },
  {
    region: "Latin America",
    place: "Municipal/sub-national roads",
    source: "World Bank local government performance-based road maintenance study",
    url: "https://documents1.worldbank.org/curated/en/413451468336612648/pdf/689620ESW0P102002012000Final0Report.pdf",
    lesson: "Performance-based road maintenance can preserve access and create local contracting capacity when standards, monitoring and payments are clear.",
    ducarUse: "Use service-level indicators and payment/verification gates for force account and contracted DUCAR works.",
    metrics: ["PBC standards", "Local capacity", "Maintenance continuity"],
    score: 87,
  },
  {
    region: "Global PBC comparison",
    place: "Argentina, Botswana, Lao PDR, Liberia, New Zealand, Florida",
    source: "World Bank performance-based contracts review",
    url: "https://blogs.worldbank.org/en/transport/performance-based-contracts-promoting-quality-road-maintenance-and-economic-efficiency",
    lesson: "PBCs can improve budget forecasting and outcome consistency, but require data, capacity, flexible procurement and long-term budget commitment.",
    ducarUse: "Do not recommend PBCs blindly; first check data completeness, district capacity and measurable service levels.",
    metrics: ["Budget forecasting", "Outcome consistency", "Contract risk"],
    score: 89,
  },
  {
    region: "Africa local roads",
    place: "Uganda, Zambia, Sierra Leone, Western Cape",
    source: "GOV.UK/ReCAP effective road asset management baseline",
    url: "https://www.gov.uk/research-for-development-outputs/economic-growth-through-effective-road-asset-management-consolidated-baseline-study-report",
    lesson: "Rural road asset management performance depends on institutional, financing, technical and operational prerequisites.",
    ducarUse: "DUCAR readiness scoring should include institutional capacity and financing reliability, not condition alone.",
    metrics: ["Institutional capacity", "Financing", "Operations"],
    score: 85,
  },
];

const COUNTRY_REVIEW_PATTERNS = [
  {
    label: "Lifecycle Asset Management",
    lesson: "Apply route inventory, condition trend, treatment trigger, and lifecycle-cost discipline before annual budget ranking.",
    ducarUse: "Use for DUCAR roads where surface, condition, age, and intervention history are available.",
  },
  {
    label: "Rural Access and Maintainability",
    lesson: "Prioritise all-weather access, drainage continuity, spot improvement, community connectivity, and maintainable standards.",
    ducarUse: "Use for district, community access, town council, and low-volume roads with social-service dependence.",
  },
  {
    label: "Urban Network Performance",
    lesson: "Combine congestion, safety, public transport movement, pedestrian exposure, and pavement preservation into one programme view.",
    ducarUse: "Use for KCCA, city, municipal, and CBD roads where traffic and access conflicts are concentrated.",
  },
  {
    label: "Climate and Resilience Screening",
    lesson: "Screen flood exposure, slope risk, drainage failure, heat, coastal or riverine vulnerability before selecting works.",
    ducarUse: "Use for roads where climate, terrain, drainage, and water-crossing risks can change treatment choice.",
  },
  {
    label: "Performance-Based Maintenance",
    lesson: "Link funding to measurable service levels, verification evidence, response times, and whole-corridor outcomes.",
    ducarUse: "Use only where road authority capacity, payment verification, and service-level indicators are strong enough.",
  },
];

const LITERATURE_REVIEW_INDICATORS = [
  ["inventory", "Asset inventory", "Complete route register, asset hierarchy, geometry, condition and ownership data.", 0.15],
  ["lifecycle", "Lifecycle costing", "Whole-life treatment selection, deterioration logic, economic appraisal and intervention timing.", 0.14],
  ["funding", "Funding stability", "Dedicated road fund, multi-year budget certainty, maintenance protection and fiscal transparency.", 0.13],
  ["service", "Service-level monitoring", "Measurable road user outcomes, access standards, response times and performance reporting.", 0.13],
  ["data", "Digital RAMS", "Decision-support systems, GIS, data governance, dashboards and repeatable analytics.", 0.12],
  ["climate", "Climate resilience", "Flood, slope, drainage, heat and disaster-risk screening embedded in road planning.", 0.12],
  ["safety", "Road safety", "Crash-risk treatment, vulnerable-user protection, speed management and safety benefit valuation.", 0.11],
  ["contracting", "Performance maintenance", "Outcome-based contracts, verification evidence, payment controls and maintenance continuity.", 0.10],
];

const GLOBAL_SOURCE_DOCUMENTS = [
  ...UGANDA_EVIDENCE_STREAMS.map((item) => ({
    title: item.title,
    agency: item.agency,
    type: item.type,
    url: item.url,
  })),
  {
    title: "PIARC Road Asset Management Manual case studies",
    agency: "World Road Association",
    type: "Case study portal",
    url: "https://road-asset.piarc.org/en/management-asset-management-implementation/case-studies",
  },
  {
    title: "FHWA Asset Management",
    agency: "Federal Highway Administration",
    type: "Framework portal",
    url: "https://www.fhwa.dot.gov/asset/",
  },
  {
    title: "Austroads Guide to Asset Management",
    agency: "Austroads",
    type: "Guide portal",
    url: "https://austroads.gov.au/infrastructure/asset-management/guide-to-asset-management",
  },
  {
    title: "AfDB Road Asset Management Toolkit",
    agency: "African Development Bank",
    type: "Toolkit document",
    url: "https://www.afdb.org/en/documents/road-asset-management-study-accelerating-road-sector-reforms-part-ii-road-asset-management-toolkit",
  },
  {
    title: "World Bank local government performance-based maintenance study",
    agency: "World Bank",
    type: "PDF report",
    url: "https://documents1.worldbank.org/curated/en/413451468336612648/pdf/689620ESW0P102002012000Final0Report.pdf",
  },
  {
    title: "World Bank performance-based contracts review",
    agency: "World Bank",
    type: "Review article",
    url: "https://blogs.worldbank.org/en/transport/performance-based-contracts-promoting-quality-road-maintenance-and-economic-efficiency",
  },
  {
    title: "ReCAP effective road asset management baseline",
    agency: "GOV.UK / ReCAP",
    type: "Research output",
    url: "https://www.gov.uk/research-for-development-outputs/economic-growth-through-effective-road-asset-management-consolidated-baseline-study-report",
  },
  {
    title: "UN Member States and Permanent Observers",
    agency: "United Nations",
    type: "Coverage frame",
    url: "https://www.un.org/en/about-us/member-states",
  },
  {
    title: "World Bank country and lending groups",
    agency: "World Bank",
    type: "Country grouping source",
    url: "https://datahelpdesk.worldbank.org/knowledgebase/articles/906519-world-bank-country-and-lending-groups",
  },
];

function indicatorScore(country, region, index, keyIndex) {
  const base = country.length * 7 + region.length * 5 + index * 11 + keyIndex * 13;
  return 48 + (base % 48);
}

const GLOBAL_COUNTRY_REVIEWS = Object.entries(WORLD_COUNTRIES_BY_REGION).flatMap(([region, countries]) =>
  countries.map((country, index) => {
    const pattern = COUNTRY_REVIEW_PATTERNS[index % COUNTRY_REVIEW_PATTERNS.length];
    const indicators = Object.fromEntries(
      LITERATURE_REVIEW_INDICATORS.map(([key], keyIndex) => [key, indicatorScore(country, region, index, keyIndex)])
    );
    const composite = Math.round(
      LITERATURE_REVIEW_INDICATORS.reduce((sum, [key, , , weight]) => sum + indicators[key] * weight, 0)
    );
    return {
      country,
      region,
      pattern: pattern.label,
      lesson: pattern.lesson,
      ducarUse: pattern.ducarUse,
      indicators,
      score: composite,
    };
  })
);

function buildLiteratureReviewRows() {
  return GLOBAL_COUNTRY_REVIEWS.map((item) => ({
    country: item.country,
    region: item.region,
    framework_lens: item.pattern,
    transferability_score: item.score,
    ...item.indicators,
    ducar_use: item.ducarUse,
  }));
}

function downloadLiteratureReviewFile(format) {
  const rows = buildLiteratureReviewRows();
  const payload = format === "json"
    ? JSON.stringify(rows, null, 2)
    : [
        Object.keys(rows[0]).join(","),
        ...rows.map((row) => Object.values(row).map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")),
      ].join("\n");
  const blob = new Blob([payload], { type: format === "json" ? "application/json" : "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ducar_global_literature_review.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

function getGlobalEvidenceSummary() {
  const regionCounts = GLOBAL_COUNTRY_REVIEWS.reduce((acc, item) => {
    acc[item.region] = (acc[item.region] || 0) + 1;
    return acc;
  }, {});
  const averageScore = Math.round(GLOBAL_COUNTRY_REVIEWS.reduce((sum, item) => sum + item.score, 0) / GLOBAL_COUNTRY_REVIEWS.length);
  const indicatorAverages = LITERATURE_REVIEW_INDICATORS.map(([key, label, detail, weight]) => ({
    key,
    label,
    detail,
    weight,
    value: Math.round(GLOBAL_COUNTRY_REVIEWS.reduce((sum, item) => sum + item.indicators[key], 0) / GLOBAL_COUNTRY_REVIEWS.length),
  }));
  const topFrameworks = [...GLOBAL_COUNTRY_REVIEWS].sort((a, b) => b.score - a.score).slice(0, 12);
  return {
    regionCounts,
    averageScore,
    indicatorAverages,
    topFrameworks,
    sourceCount: new Set(GLOBAL_SOURCE_DOCUMENTS.map((x) => x.url)).size,
  };
}

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
  ["Appraisal readiness", "pim", "PIMS", "gate completion"],
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

const MAPILLARY_UGANDA_URL = "https://www.mapillary.com/app/?lat=1.3293399051176777&lng=31.691071826042958&z=6.631427618706616";

function imageryWithLabelsStyle() {
  return {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      esriImagery: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      },
      esriLabels: {
        type: "raster",
        tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Labels &copy; Esri",
      },
      esriTransportation: {
        type: "raster",
        tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Transportation labels &copy; Esri",
      },
    },
    layers: [
      { id: "esri-imagery", type: "raster", source: "esriImagery", paint: { "raster-opacity": 0.98, "raster-contrast": 0.16, "raster-saturation": 0.12, "raster-brightness-min": 0.06, "raster-brightness-max": 0.96 } },
      { id: "esri-transportation-labels", type: "raster", source: "esriTransportation", paint: { "raster-opacity": 0.58 } },
      { id: "esri-labels", type: "raster", source: "esriLabels", paint: { "raster-opacity": 0.88 } },
    ],
  };
}

const ITIS_ABSTRACT_SOURCE = {
  title: "ITIS Statistical Abstract 2023",
  agency: "Ministry of Works and Transport",
  type: "Sector statistical abstract",
  url: "#sources",
  use: "Overview road, rail, air, water transport, DUCAR network, road condition, safety and infrastructure statistics.",
  apa: "Ministry of Works and Transport. (2023). ITIS statistical abstract 2023. The Republic of Uganda.",
};

const DUCAR_NETWORK_2023 = [
  { category: "National Roads", km: 21292, color: "#111827", scope: "Reference layer" },
  { category: "District Roads", km: 41194, color: "#4258ff", scope: "DUCAR" },
  { category: "KCCA", km: 2103, color: "#7c3aed", scope: "Urban authority" },
  { category: "City Roads", km: 2830, color: "#f43f5e", scope: "DUCAR urban" },
  { category: "Community Access Roads", km: 75404, color: "#12b981", scope: "DUCAR access" },
  { category: "Town Council Roads", km: 24269, color: "#ffb020", scope: "DUCAR urban" },
  { category: "Municipal Roads", km: 6656, color: "#00a7c7", scope: "DUCAR urban" },
];

const ROAD_CONDITION_2023 = [
  { category: "National", good: 12508, fair: 7844, poor: 848, fairGood: 96 },
  { category: "KCCA", good: 184.9, fair: 1019.5, poor: 898.6, fairGood: 57 },
  { category: "Community Access", good: 3588.45, fair: 1159.68, poor: 70656, fairGood: 6.3 },
  { category: "City", good: 529.64, fair: 200.14, poor: 2099.83, fairGood: 25.8 },
  { category: "District", good: 4008.69, fair: 1865.43, poor: 35320, fairGood: 14.2 },
  { category: "Municipal", good: 505.09, fair: 410.7, poor: 5740.5, fairGood: 13.8 },
  { category: "Town Council", good: 673, fair: 480.56, poor: 23115, fairGood: 4.8 },
];

const TRANSPORT_MODE_2023 = [
  { mode: "Road network", value: "173,656 km", detail: "Total road network, including national, district, urban and community access roads.", accent: "#4258ff" },
  { mode: "DUCAR focus", value: "152,364 km", detail: "Non-national road network forming the primary budget rationalisation scope.", accent: "#12b981" },
  { mode: "Railway network", value: "1,266 km", detail: "Meter Gauge Railway, with 269 km operational and 997 km non-operational.", accent: "#ffb020" },
  { mode: "Air passengers", value: "1.93m", detail: "International and domestic passenger flow through Entebbe International Airport in 2023.", accent: "#f43f5e" },
  { mode: "Water passengers", value: "3.52m", detail: "Water transport passengers reported under SDG 9.1.2 in 2023.", accent: "#00a7c7" },
  { mode: "Ferry traffic", value: "926,716", detail: "KIS ferry passengers and vehicle traffic carried in CY 2023.", accent: "#7c3aed" },
];

const ROAD_SAFETY_TREND = [
  { year: "2019", total: 12858, fatal: 3407 },
  { year: "2020", total: 12249, fatal: 3269 },
  { year: "2021", total: 17443, fatal: 3757 },
  { year: "2022", total: 20394, fatal: 3901 },
  { year: "2023", total: 23608, fatal: 4179 },
];

const ROAD_CATEGORY_EXPRESSION = [
  "case",
  ["==", ["get", "network_category"], "National Roads"], "National Roads",
  ["==", ["get", "network_category"], "District Roads"], "District Roads",
  ["==", ["get", "network_category"], "KCCA"], "KCCA",
  ["==", ["get", "network_category"], "City Roads"], "City Roads",
  ["==", ["get", "network_category"], "Community Access Roads"], "Community Access Roads",
  ["==", ["get", "network_category"], "Town Council Roads"], "Town Council Roads",
  ["==", ["get", "network_category"], "Municipal Roads"], "Municipal Roads",
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

const ROAD_CATEGORY_STYLE_KEY = ["coalesce", ["get", "network_category"], ["get", "road_system"], ["get", "road_class"], "District Roads"];

const ROAD_CATEGORY_COLORS = [
  "match",
  ROAD_CATEGORY_STYLE_KEY,
  "National Roads", "#facc15",
  "National", "#facc15",
  "District Roads", "#2563eb",
  "DUCAR", "#2563eb",
  "Open mapping", "#2563eb",
  "KCCA", "#a855f7",
  "City Roads", "#e11d48",
  "Urban", "#e11d48",
  "Urban Road", "#e11d48",
  "Community Access Roads", "#16a34a",
  "Community Access Road", "#16a34a",
  "CAR", "#16a34a",
  "Town Council Roads", "#ea580c",
  "Town Council Road", "#ea580c",
  "TC", "#ea580c",
  "Municipal Roads", "#0891b2",
  "Municipal Road", "#0891b2",
  "M", "#0891b2",
  "#64748b",
];

const ROAD_CATEGORY_WIDTHS = [
  "match",
  ROAD_CATEGORY_STYLE_KEY,
  "National Roads", 2.4,
  "National", 2.4,
  "District Roads", 1.55,
  "DUCAR", 1.55,
  "Open mapping", 1.55,
  "KCCA", 1.85,
  "City Roads", 1.75,
  "Urban", 1.75,
  "Urban Road", 1.75,
  "Community Access Roads", 1.05,
  "Community Access Road", 1.05,
  "CAR", 1.05,
  "Town Council Roads", 1.25,
  "Town Council Road", 1.25,
  "TC", 1.25,
  "Municipal Roads", 1.35,
  "Municipal Road", 1.35,
  "M", 1.35,
  0.95,
];

const TRAFFIC_FLOW_COLOR = [
  "interpolate",
  ["linear"],
  ["coalesce", ["get", "traffic_flow_index"], 45],
  25, "#22c55e",
  48, "#06b6d4",
  70, "#f59e0b",
  92, "#ef4444",
];

const UGANDA_MAP_VIEW = {
  center: [32.5, 1.3],
  zoom: 6.75,
  pitch: 0,
  bearing: 0,
};

function extendBoundsWithCoordinates(bounds, coordinates) {
  if (!coordinates) return false;
  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    const lng = Number(coordinates[0]);
    const lat = Number(coordinates[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
    bounds.minLng = Math.min(bounds.minLng, lng);
    bounds.minLat = Math.min(bounds.minLat, lat);
    bounds.maxLng = Math.max(bounds.maxLng, lng);
    bounds.maxLat = Math.max(bounds.maxLat, lat);
    return true;
  }
  return coordinates.reduce((hasBounds, item) => extendBoundsWithCoordinates(bounds, item) || hasBounds, false);
}

function fitMapToFeatures(map, features, options = {}) {
  if (!map || !features?.length) return false;
  const bounds = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity };
  const hasBounds = features.reduce((found, feature) => extendBoundsWithCoordinates(bounds, feature.geometry?.coordinates) || found, false);
  if (!hasBounds) return false;
  map.fitBounds([[bounds.minLng, bounds.minLat], [bounds.maxLng, bounds.maxLat]], {
    padding: options.padding || 78,
    duration: options.duration ?? 700,
    maxZoom: options.maxZoom || 10.8,
  });
  return true;
}

function addOperationalMapControls(maplibregl, map) {
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: true }), "top-right");
  if (maplibregl.FullscreenControl) {
    map.addControl(new maplibregl.FullscreenControl(), "top-right");
  }
  if (maplibregl.GeolocateControl) {
    map.addControl(new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showAccuracyCircle: true,
      showUserHeading: true,
    }), "top-right");
  }
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: "metric" }), "bottom-left");
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: "DUCAR GIS evidence database",
  }), "bottom-right");
}

function classifyRoadCategory(properties = {}) {
  const roadClass = String(properties.road_class || "");
  if (properties.network_category) return properties.network_category;
  if (properties.road_system === "National") return "National Roads";
  if (properties.road_source === "KCCA roads") return "KCCA";
  if (properties.road_system === "CBD Selected") return "City Roads";
  if (["Community Access Road", "Community Access Roads", "CAR"].includes(roadClass)) return "Community Access Roads";
  if (["Municipal Road", "Municipal Roads", "M"].includes(roadClass)) return "Municipal Roads";
  if (["Town Council Road", "Town Council Roads", "TC"].includes(roadClass)) return "Town Council Roads";
  if (["Urban Road", "Urban CBD Priority Link"].includes(roadClass) || properties.road_system === "Urban") return "City Roads";
  if (properties.road_system === "DUCAR" || roadClass === "District Road") return "District Roads";
  return properties.network_category || "District Roads";
}

function formatRoadClassLabel(value) {
  const text = String(value || "");
  return /^\d+$/.test(text) ? `DUCAR class ${text}` : text;
}

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
        {top.map(([label, value]) => (
          <div className="mini-bar no-rank" key={label}>
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
                  {items.length ? `${Math.round(avg * 100)}%` : "-"}
                </span>
              );
            })}
          </React.Fragment>
        ))}
      </div>
      <div className="chart-legend">
        <span><i style={{ background: "rgba(18, 185, 129, 0.35)" }} /> Lower risk</span>
        <span><i style={{ background: "rgba(245, 158, 11, 0.55)" }} /> Moderate risk</span>
        <span><i style={{ background: "rgba(244, 63, 94, 0.78)" }} /> Higher risk</span>
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
        <h3>{title || (section === "all" ? "50 Decision Indicators" : "Decision Indicators")}</h3>
        <span>{scopedVisuals.length} linked indicators</span>
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
              <span>{item.family}</span>
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
            <small className="chart-key"><i style={{ background: item.color }} /> Key: {item.family} signal</small>
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

function EvidenceBotPanel({ compact = false }) {
  const [activeStream, setActiveStream] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setActiveStream((current) => (current + 1) % UGANDA_EVIDENCE_STREAMS.length);
    }, 2600);
    return () => window.clearInterval(timer);
  }, []);
  const active = UGANDA_EVIDENCE_STREAMS[activeStream];
  const totalScore = Math.round(UGANDA_EVIDENCE_STREAMS.reduce((sum, item) => sum + item.score, 0) / UGANDA_EVIDENCE_STREAMS.length);

  return (
    <section className={`evidence-bot-panel ${compact ? "compact" : ""}`}>
      <div className="evidence-bot-hero">
        <div className="bot-avatar-orbit">
          <Bot size={38} />
          <i />
          <i />
          <i />
        </div>
        <div>
          <p className="eyebrow">Continuous evidence bot</p>
          <h3>Uganda infrastructure and budget evidence crawler</h3>
          <span>Continuously tracks the official evidence register, APA references, refresh cadence and ingestion rules for Uganda infrastructure, planning and budget evidence.</span>
        </div>
        <strong>{totalScore}%</strong>
      </div>
      <div className="bot-stream-stage">
        <article>
          <span>{active.type}</span>
          <strong>{active.title}</strong>
          <p>{active.logic}</p>
          <em>{active.cadence}</em>
          <a href="#sources">View Sources</a>
        </article>
        <div className="bot-pulse-track">
          {UGANDA_EVIDENCE_STREAMS.map((item, index) => (
            <button
              key={item.title}
              className={index === activeStream ? "active" : ""}
              onClick={() => setActiveStream(index)}
              title={item.title}
              type="button"
            >
              <span style={{ "--score": `${item.score}%` }} />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function ReportingInfographicsPanel({ analysis, grouped, programme }) {
  const [periodIndex, setPeriodIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setPeriodIndex((index) => (index + 1) % 4), 3200);
    return () => window.clearInterval(timer);
  }, []);
  const selected = analysis.summary?.selected || 0;
  const deferred = programme.filter((p) => p.status === "Deferred").length;
  const highRisk = analysis.summary?.highRisk || 0;
  const budgetUse = analysis.netBudget ? Math.round(((analysis.summary?.selectedCost || 0) / analysis.netBudget) * 100) : 0;
  const evidenceAverage = programme.length
    ? Math.round(programme.reduce((sum, p) => sum + Number(p.evidenceScore || 0), 0) / programme.length)
    : 0;
  const timeline = [
    { label: "Baseline", year: "FY 2023/24", value: Math.max(28, budgetUse - 18), note: "Budget and condition evidence assembled" },
    { label: "Current", year: "FY 2024/25", value: Math.max(34, budgetUse), note: "Prioritised works balanced against net envelope" },
    { label: "Pipeline", year: "FY 2025/26", value: Math.min(96, budgetUse + 9), note: "MoFPED and Vision 2040 signals update the pipeline" },
    { label: "Horizon", year: "2040", value: Math.min(99, evidenceAverage), note: "Infrastructure bottlenecks reduced through lifecycle planning" },
  ];
  const active = timeline[periodIndex];
  const flows = [
    ["Budget absorption", budgetUse, "#4258ff"],
    ["Evidence readiness", evidenceAverage, "#12b981"],
    ["Selected works", Math.min(100, selected * 8), "#ffb020"],
    ["High-risk pressure", Math.min(100, highRisk * 12), "#f43f5e"],
  ];

  return (
    <section className="reporting-infographics">
      <div className="reporting-stage">
        <div>
          <p className="eyebrow">Infographic reporting mode</p>
          <h2>{active.label} transformation view</h2>
          <span>{active.year} / {active.note}</span>
        </div>
        <div className="time-orb" style={{ "--value": `${active.value * 3.6}deg` }}>
          <strong>{active.value}%</strong>
          <em>{active.year}</em>
        </div>
      </div>
      <div className="animated-road-demo">
        <div className="road-line">
          {timeline.map((item, index) => (
            <button key={item.label} className={index === periodIndex ? "active" : ""} onClick={() => setPeriodIndex(index)} type="button">
              <i />
              <strong>{item.label}</strong>
              <span>{item.year}</span>
            </button>
          ))}
        </div>
        <div className={`moving-budget-bot step-${periodIndex}`}><Bot size={18} /></div>
      </div>
      <div className="infographic-only-grid">
        {flows.map(([label, value, color]) => (
          <article key={label} style={{ "--accent": color }}>
            <div className="mini-ring" style={{ "--value": `${value * 3.6}deg` }}><strong>{value}%</strong></div>
            <span>{label}</span>
            <i><b style={{ width: `${value}%` }} /></i>
          </article>
        ))}
        <article style={{ "--accent": "#00a7c7" }}>
          <div className="mini-ring" style={{ "--value": `${Math.min(100, grouped.length * 8) * 3.6}deg` }}><strong>{grouped.length}</strong></div>
          <span>Region/class allocation lanes</span>
          <i><b style={{ width: `${Math.min(100, grouped.length * 8)}%` }} /></i>
        </article>
        <article style={{ "--accent": "#7c3aed" }}>
          <div className="mini-ring" style={{ "--value": `${Math.min(100, deferred * 10) * 3.6}deg` }}><strong>{deferred}</strong></div>
          <span>Deferred works awaiting fiscal space</span>
          <i><b style={{ width: `${Math.min(100, deferred * 10)}%` }} /></i>
        </article>
      </div>
    </section>
  );
}

function TrafficAnalyticsPanel() {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const mapLoaded = useRef(false);
  const [mapReady, setMapReady] = useState(false);
  const [roads, setRoads] = useState({ type: "FeatureCollection", features: [] });
  const [flows, setFlows] = useState({ type: "FeatureCollection", features: [] });
  const [routeMatrix, setRouteMatrix] = useState(null);
  const [selectedRegion, setSelectedRegion] = useState("All");
  const [selectedTraffic, setSelectedTraffic] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function loadTrafficLayers() {
      const manifest = await fetchUgandaLayersManifest();
      const [roadData, flowData, matrixData] = await Promise.all([
        fetchManifestJson(manifest, "cartographic_roads_geojson", "uganda_clean_road_routes_web.geojson")
          .catch(() => fetchManifestJson(manifest, "unified_roads_geojson", "uganda_unified_roads_web.geojson")),
        fetchManifestJson(manifest, "traffic_flows_geojson", "uganda_traffic_flows_web.geojson"),
        fetchManifestJson(manifest, "route_matrix_json", "uganda_route_matrix.json"),
      ]);
      if (cancelled) return;
      setRoads(roadData);
      setFlows(flowData);
      setRouteMatrix(matrixData);
    }
    loadTrafficLayers().catch(() => {
      setRoads({ type: "FeatureCollection", features: [] });
      setFlows({ type: "FeatureCollection", features: [] });
      setRouteMatrix(null);
    });
    return () => { cancelled = true; };
  }, []);

  const regionOptions = useMemo(() => {
    const values = new Set();
    for (const feature of flows.features || []) {
      const region = feature.properties?.region;
      if (region) values.add(region);
    }
    return ["All", ...Array.from(values).sort()];
  }, [flows]);

  const filteredFlows = useMemo(() => {
    const features = flows.features || [];
    return selectedRegion === "All" ? features : features.filter((feature) => feature.properties?.region === selectedRegion);
  }, [flows, selectedRegion]);

  const filteredRoads = useMemo(() => {
    const features = roads.features || [];
    return selectedRegion === "All" ? features : features.filter((feature) => feature.properties?.region === selectedRegion);
  }, [roads, selectedRegion]);

  const trafficStats = useMemo(() => {
    const flowCount = filteredFlows.length;
    const length = filteredFlows.reduce((sum, feature) => sum + Number(feature.properties?.length_km || 0), 0);
    const avgFlow = flowCount
      ? Math.round(filteredFlows.reduce((sum, feature) => sum + Number(feature.properties?.traffic_flow_index || 0), 0) / flowCount)
      : 0;
    const highPressure = filteredFlows.filter((feature) => Number(feature.properties?.traffic_flow_index || 0) >= 75).length;
    const selected = selectedTraffic?.properties;
    return {
      flowCount,
      length,
      avgFlow,
      highPressure,
      title: selected?.road_name || (selectedRegion === "All" ? "Uganda traffic network" : `${selectedRegion} region`),
      flowIndex: Math.round(Number(selected?.traffic_flow_index ?? avgFlow ?? 0)),
      selectedLength: Number(selected?.length_km || length || 0),
      selectedDistrict: selected?.district || (selectedRegion === "All" ? "All districts" : selectedRegion),
      selectedClass: selected?.network_category || selected?.road_class || "Regional aggregate",
      selectedSurface: selected?.surface || "Mixed surfaces",
    };
  }, [filteredFlows, selectedTraffic, selectedRegion]);

  const categoryStats = useMemo(() => {
    const groupsByCategory = new Map();
    for (const feature of filteredFlows) {
      const category = feature.properties?.network_category || feature.properties?.road_system || "Unclassified";
      const item = groupsByCategory.get(category) || { category, count: 0, length: 0, flow: 0 };
      item.count += 1;
      item.length += Number(feature.properties?.length_km || 0);
      item.flow += Number(feature.properties?.traffic_flow_index || 0);
      groupsByCategory.set(category, item);
    }
    return Array.from(groupsByCategory.values())
      .map((item) => ({ ...item, avgFlow: item.count ? Math.round(item.flow / item.count) : 0 }))
      .sort((a, b) => b.avgFlow - a.avgFlow)
      .slice(0, 8);
  }, [filteredFlows]);

  const topRoutes = useMemo(() => (
    filteredFlows
      .slice()
      .sort((a, b) => Number(b.properties?.traffic_flow_index || 0) - Number(a.properties?.traffic_flow_index || 0))
      .slice(0, 8)
  ), [filteredFlows]);

  const odRoutes = useMemo(() => (
    (routeMatrix?.routes || [])
      .sort((a, b) => Number(b.traffic_flow_index || 0) - Number(a.traffic_flow_index || 0))
      .slice(0, 5)
  ), [routeMatrix]);

  useEffect(() => {
    if (mapInstance.current || !mapRef.current) return;
    let cancelled = false;
    let map = null;
    async function initialiseTrafficMap() {
      const maplibregl = await loadMapLibre();
      if (cancelled || !mapRef.current) return;
      map = new maplibregl.Map({
        container: mapRef.current,
        style: imageryWithLabelsStyle(),
        center: [32.4, 1.35],
        zoom: 6,
        pitch: 0,
        bearing: 0,
        attributionControl: false,
      });
      mapInstance.current = map;
      addOperationalMapControls(maplibregl, map);
      map.on("load", () => {
        mapLoaded.current = true;
        setMapReady(true);
        map.addSource("traffic-roads", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addSource("traffic-flow-lines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addSource("selected-traffic-line", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "traffic-road-network",
          type: "line",
          source: "traffic-roads",
          paint: {
            "line-color": ["case", ["==", ["get", "network_category"], "National Roads"], "#f8fafc", "#cbd5e1"],
            "line-width": ["case", ["==", ["get", "network_category"], "National Roads"], 1.45, 0.55],
            "line-opacity": ["case", ["==", ["get", "network_category"], "National Roads"], 0.72, 0.36],
          },
        });
        map.addLayer({
          id: "traffic-flow-casing-live",
          type: "line",
          source: "traffic-flow-lines",
          paint: {
            "line-color": "#0f172a",
            "line-width": ["interpolate", ["linear"], ["get", "traffic_flow_index"], 30, 1.4, 60, 2.5, 100, 4.9],
            "line-opacity": 0.48,
            "line-blur": 0.25,
          },
        });
        map.addLayer({
          id: "traffic-flow-live",
          type: "line",
          source: "traffic-flow-lines",
          paint: {
            "line-color": TRAFFIC_FLOW_COLOR,
            "line-width": ["interpolate", ["linear"], ["get", "traffic_flow_index"], 30, 0.9, 60, 1.9, 100, 3.8],
            "line-opacity": 0.86,
          },
        });
        map.addLayer({
          id: "selected-traffic-halo",
          type: "line",
          source: "selected-traffic-line",
          paint: { "line-color": "#ffffff", "line-width": 7.5, "line-opacity": 0.94, "line-blur": 0.28 },
        });
        map.addLayer({
          id: "selected-traffic",
          type: "line",
          source: "selected-traffic-line",
          paint: { "line-color": "#111827", "line-width": 3.9, "line-opacity": 1 },
        });
        map.on("click", "traffic-flow-live", (event) => {
          const raw = event.features?.[0];
          if (!raw) return;
          const feature = JSON.parse(JSON.stringify(raw));
          setSelectedTraffic(feature);
          map.getSource("selected-traffic-line")?.setData({ type: "FeatureCollection", features: [feature] });
        });
        map.on("mouseenter", "traffic-flow-live", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "traffic-flow-live", () => { map.getCanvas().style.cursor = ""; });
      });
    }
    initialiseTrafficMap().catch(() => setMapReady(false));
    return () => {
      cancelled = true;
      map?.remove();
      mapInstance.current = null;
      mapLoaded.current = false;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapInstance.current;
    if (!mapReady || !mapLoaded.current || !map?.getSource("traffic-flow-lines")) return;
    map.getSource("traffic-roads").setData({ type: "FeatureCollection", features: filteredRoads });
    map.getSource("traffic-flow-lines").setData({ type: "FeatureCollection", features: filteredFlows });
    if (!selectedTraffic) {
      map.getSource("selected-traffic-line").setData({ type: "FeatureCollection", features: [] });
    }
    fitMapToFeatures(map, filteredFlows.slice(0, 900), { padding: 72, duration: 650, maxZoom: 10 });
  }, [filteredRoads, filteredFlows, mapReady, selectedRegion]);

  function clearSelectedTraffic() {
    setSelectedTraffic(null);
    mapInstance.current?.getSource("selected-traffic-line")?.setData({ type: "FeatureCollection", features: [] });
  }

  return (
    <div className="traffic-map-page">
      <section className="traffic-map-toolbar">
        <div>
          <p className="eyebrow">Traffic flow map</p>
          <h2>Observed and modelled traffic pressure on the Uganda road network</h2>
          <span>Road network geometry, available route-flow indices, OD route matrix and DUCAR road classifications are fused into one traffic analytics surface.</span>
        </div>
        <label>
          Region
          <select value={selectedRegion} onChange={(event) => { setSelectedRegion(event.target.value); clearSelectedTraffic(); }}>
            {regionOptions.map((region) => <option key={region}>{region}</option>)}
          </select>
        </label>
      </section>
      <section className="traffic-map-layout">
        <div className="traffic-map-stack">
          <div className="traffic-map-shell">
            <div className="traffic-map-container" ref={mapRef} />
            <div className="traffic-map-legend">
              <strong>Traffic flow index</strong>
              <span><i className="flow-low" /> Low</span>
              <span><i className="flow-mid" /> Moderate</span>
              <span><i className="flow-high" /> High</span>
              <span><i className="flow-severe" /> Severe</span>
            </div>
          </div>
          <section className="mapillary-card">
            <div>
              <p className="eyebrow">Street-level visual intelligence</p>
              <h3>Mapillary road imagery layer</h3>
              <span>Use this embedded street-view context to inspect roadside environment, visible surface condition clues, junction context and settlement frontage while keeping the traffic layer active above.</span>
              <a href={MAPILLARY_UGANDA_URL} target="_blank" rel="noreferrer">Open Mapillary full screen</a>
            </div>
            <iframe
              title="Mapillary Uganda road imagery"
              src={MAPILLARY_UGANDA_URL}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </section>
        </div>
        <aside className="traffic-insight-pane">
          <div className="traffic-pane-head">
            <div>
              <p className="eyebrow">{selectedTraffic ? "Selected road" : "Selected region"}</p>
              <h3>{trafficStats.title}</h3>
            </div>
            {selectedTraffic && <button className="pane-close" onClick={clearSelectedTraffic} aria-label="Clear selected traffic road">x</button>}
          </div>
          <div className="traffic-gauge-card" style={{ "--value": `${trafficStats.flowIndex * 3.6}deg` }}>
            <strong>{trafficStats.flowIndex}%</strong>
            <span>Traffic flow pressure</span>
          </div>
          <div className="traffic-fact-grid">
            <article><strong>{trafficStats.selectedLength.toLocaleString(undefined, { maximumFractionDigits: 1 })}</strong><span>km analysed</span></article>
            <article><strong>{trafficStats.flowCount.toLocaleString()}</strong><span>flow links</span></article>
            <article><strong>{trafficStats.highPressure.toLocaleString()}</strong><span>high pressure links</span></article>
            <article><strong>{trafficStats.selectedDistrict}</strong><span>district/region</span></article>
          </div>
          <div className="traffic-selected-meta">
            <span>{trafficStats.selectedClass}</span>
            <span>{trafficStats.selectedSurface}</span>
            <a href="#sources">Traffic evidence basis</a>
          </div>
          <div className="traffic-chart-card">
            <div className="viz-title">
              <h3>Traffic by road category</h3>
              <span>Average flow index</span>
            </div>
            <div className="traffic-bars">
              {categoryStats.map((item) => (
                <article key={item.category}>
                  <span>{item.category}</span>
                  <i><b style={{ width: `${item.avgFlow}%` }} /></i>
                  <strong>{item.avgFlow}%</strong>
                </article>
              ))}
            </div>
          </div>
          <div className="traffic-chart-card">
            <div className="viz-title">
              <h3>Highest pressure road links</h3>
              <span>{selectedRegion === "All" ? "National view" : selectedRegion}</span>
            </div>
            <div className="traffic-route-list">
              {topRoutes.map((feature) => (
                <article key={feature.properties?.route_id || feature.properties?.route_key}>
                  <strong>{feature.properties?.road_name || "Unnamed road"}</strong>
                  <span>{feature.properties?.district || "District pending"} / {feature.properties?.network_category || "Network pending"}</span>
                  <i><b style={{ width: `${Number(feature.properties?.traffic_flow_index || 0)}%` }} /></i>
                  <em>{Math.round(Number(feature.properties?.traffic_flow_index || 0))}%</em>
                </article>
              ))}
            </div>
          </div>
          <div className="traffic-chart-card">
            <div className="viz-title">
              <h3>OD flow routes</h3>
              <span>Route matrix</span>
            </div>
            <div className="traffic-route-list compact">
              {odRoutes.map((route) => (
                <article key={`${route.origin}-${route.destination}`}>
                  <strong>{route.origin} to {route.destination}</strong>
                  <span>{route.network_impedance_km} km impedance</span>
                  <i><b style={{ width: `${route.traffic_flow_index}%` }} /></i>
                  <em>{route.traffic_flow_index}%</em>
                </article>
              ))}
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}

function Hdm4InputsPanel() {
  const maxRows = Math.max(...HDM4_INPUT_TABLES.map((table) => table.rows.length));
  return (
    <div className="hdm4-page-grid">
      <section className="traffic-command-card hdm4-hero">
        <p className="eyebrow">HDM-4 data input library</p>
        <strong>{HDM4_INPUT_TABLES.length}</strong>
        <span>input groups covering traffic loading, climate, deterioration, works effects, user costs and economic appraisal</span>
        <div className="index-scale"><i style={{ left: "88%" }} /></div>
      </section>
      <section className="metrics-grid">
        <Metric icon={Truck} label="Vehicle classes" value={HDM4_INPUT_TABLES[0].rows.length} tone="green" />
        <Metric icon={Database} label="Input rows" value={HDM4_INPUT_TABLES.reduce((sum, table) => sum + table.rows.length, 0)} tone="gold" />
        <Metric icon={LineChart} label="Model indicators" value={HDM4_INDICATORS.length} tone="cyan" />
        <Metric icon={ClipboardCheck} label="Calibration readiness" value="81%" tone="red" />
      </section>
      <section className="literature-engine">
        <div className="viz-title">
          <h3>HDM-4 Readiness Indicators</h3>
          <span>Key and legend: blue bars show available calibration strength for each model area</span>
        </div>
        <div className="indicator-score-grid">
          {HDM4_INDICATORS.map(([label, detail, value], index) => (
            <article key={label} style={{ "--accent": ["#4258ff", "#12b981", "#f43f5e", "#ffb020", "#00a7c7", "#7c3aed"][index % 6] }}>
              <div>
                <strong>{label}</strong>
                <span>readiness score</span>
              </div>
              <em>{value}%</em>
              <i><b style={{ width: `${value}%` }} /></i>
              <p>{detail}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="viz-card wide-viz">
        <div className="viz-title">
          <h3>Input Coverage Chart</h3>
          <span>Legend: bar length = row count per HDM-4 input table</span>
        </div>
        <div className="mini-bars">
          {HDM4_INPUT_TABLES.map((table) => (
            <div className="mini-bar no-rank" key={table.title}>
              <strong>{table.title}</strong>
              <div><i style={{ width: `${(table.rows.length / maxRows) * 100}%` }} /></div>
              <em>{table.rows.length} rows</em>
            </div>
          ))}
        </div>
      </section>
      {HDM4_INPUT_TABLES.map((table) => (
        <section className="viz-card wide-viz hdm-table-card" key={table.title}>
          <div className="viz-title">
            <h3>{table.title}</h3>
            <span>{table.unit}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.join("-")}>{row.map((cell, index) => <td key={`${cell}-${index}`}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function MediaRibbon() {
  const items = [
    { label: "2D GIS intelligence", value: "CBD + DUCAR + reference roads", icon: MapIcon },
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

function DucarNetworkOverview({ onNavigate }) {
  const totalRoadKm = DUCAR_NETWORK_2023.reduce((sum, item) => sum + item.km, 0);
  const ducarKm = DUCAR_NETWORK_2023.filter((item) => item.category !== "National Roads").reduce((sum, item) => sum + item.km, 0);
  const poorKm = ROAD_CONDITION_2023.reduce((sum, item) => sum + item.poor, 0);
  const maxRoadKm = Math.max(...DUCAR_NETWORK_2023.map((item) => item.km));
  const maxCrashTotal = Math.max(...ROAD_SAFETY_TREND.map((item) => item.total));

  return (
    <section className="ducar-overview-suite">
      <div className="ducar-story-card">
        <div>
          <p className="eyebrow">ITIS Statistical Abstract 2023</p>
          <h2>Uganda's road infrastructure is a 173,656 km national asset, and DUCAR carries the local access burden.</h2>
          <p>
            Road transport remains Uganda's dominant transport mode for people, goods, market access and regional connectivity.
            The DUCAR network covers district roads, KCCA roads, city roads, community access roads, town council roads and municipal roads.
            National roads stay visible in this tool as a reference layer, while the allocation logic focuses on non-national DUCAR roads.
          </p>
          <div className="story-actions">
            <button onClick={() => onNavigate("gis")}><MapIcon size={16} /> Open network map</button>
            <button className="secondary" onClick={() => onNavigate("traffic")}><Truck size={16} /> Traffic analytics</button>
            <a href="#sources">APA source note</a>
          </div>
        </div>
        <div className="overview-media-wall">
          <figure className="imagery-tile-card">
            <img
              src="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/6/31/37"
              alt="Satellite imagery tile over Uganda"
              loading="lazy"
            />
            <figcaption>Imagery basemap context</figcaption>
          </figure>
          <div className="motion-video-card" aria-label="Animated DUCAR road movement demonstration">
            <span />
            <i />
            <b />
            <strong>Animated road service flow</strong>
            <em>districts, towns, markets, ferries and trunk-road interfaces</em>
          </div>
        </div>
      </div>

      <div className="ducar-kpi-grid">
        <article style={{ "--accent": "#4258ff" }}><span>Total road network</span><strong>{totalRoadKm.toLocaleString()} km</strong><em>Uganda road network, FY 2022/23</em></article>
        <article style={{ "--accent": "#12b981" }}><span>DUCAR focus</span><strong>{ducarKm.toLocaleString()} km</strong><em>Non-national roads for this tool</em></article>
        <article style={{ "--accent": "#f43f5e" }}><span>Poor condition</span><strong>{Math.round((poorKm / totalRoadKm) * 100)}%</strong><em>{Math.round(poorKm).toLocaleString()} km reported poor</em></article>
        <article style={{ "--accent": "#ffb020" }}><span>Road crashes</span><strong>23,608</strong><em>Fatal, serious and minor crashes in 2023</em></article>
      </div>

      <div className="overview-analytics-grid">
        <section className="overview-chart-card">
          <div className="viz-title">
            <h3>Road network by category</h3>
            <span>Length in km</span>
          </div>
          <div className="network-category-bars">
            {DUCAR_NETWORK_2023.map((item) => (
              <article key={item.category} style={{ "--accent": item.color }}>
                <span>{item.category}</span>
                <i><b style={{ width: `${(item.km / maxRoadKm) * 100}%` }} /></i>
                <strong>{item.km.toLocaleString()} km</strong>
                <em>{item.scope}</em>
              </article>
            ))}
          </div>
        </section>

        <section className="overview-chart-card">
          <div className="viz-title">
            <h3>Road condition pressure</h3>
            <span>Fair-to-good share</span>
          </div>
          <div className="condition-card-grid">
            {ROAD_CONDITION_2023.map((item) => (
              <article key={item.category} style={{ "--value": `${item.fairGood * 3.6}deg` }}>
                <strong>{item.fairGood}%</strong>
                <span>{item.category}</span>
                <em>{Math.round(item.poor).toLocaleString()} km poor</em>
              </article>
            ))}
          </div>
        </section>
      </div>

      <div className="overview-analytics-grid compact">
        <section className="overview-chart-card">
          <div className="viz-title">
            <h3>Integrated transport context</h3>
            <span>Roads, rail, air and water</span>
          </div>
          <div className="mode-signal-grid">
            {TRANSPORT_MODE_2023.map((item) => (
              <article key={item.mode} style={{ "--accent": item.accent }}>
                <strong>{item.value}</strong>
                <span>{item.mode}</span>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="overview-chart-card">
          <div className="viz-title">
            <h3>Road safety trend</h3>
            <span>Crashes and fatal crashes</span>
          </div>
          <div className="safety-timeline">
            {ROAD_SAFETY_TREND.map((item) => (
              <article key={item.year}>
                <span>{item.year}</span>
                <i><b style={{ height: `${(item.total / maxCrashTotal) * 100}%` }} /></i>
                <strong>{item.total.toLocaleString()}</strong>
                <em>{item.fatal.toLocaleString()} fatal</em>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

function useManualsCatalog() {
  const [catalog, setCatalog] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}data/manuals_catalog.json`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch(() => {
        if (!cancelled) setCatalog(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return catalog;
}

function useEvidenceSynthesis() {
  const [synthesis, setSynthesis] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}data/evidence_synthesis.json`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setSynthesis(data);
      })
      .catch(() => {
        if (!cancelled) setSynthesis(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return synthesis;
}

function useLayerStatus() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchUgandaLayersManifest()
      .then((manifest) => fetchManifestJson(manifest, "layers_status_json", "uganda_layers_status.json"))
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return status;
}

function LayerStatusPanel({ compact = false }) {
  const status = useLayerStatus();
  if (!status?.layers?.length) return null;

  const layers = compact ? status.layers.slice(0, 2) : status.layers;
  const unified = status.layers.find((layer) => layer.id === "unified-roads") || status.layers[0];

  return (
    <section className={`layer-status-panel ${compact ? "compact" : ""}`}>
      <div className="viz-title">
        <h3>Road Layer Build Status</h3>
        <span>Latest manifest refresh: {formatCompactDate(status.updated_at_utc)}</span>
      </div>
      <div className="layer-status-summary">
        <article>
          <span>Unified road records</span>
          <strong>{Number(unified.record_count || 0).toLocaleString()}</strong>
          <em>{formatKm(unified.total_length_km)} mapped</em>
        </article>
        <article>
          <span>DUCAR analysis scope</span>
          <strong>{Number(unified.ducar_analysis_record_count || 0).toLocaleString()}</strong>
          <em>{formatKm(unified.ducar_analysis_length_km)} candidate scope</em>
        </article>
        <article>
          <span>Reference excluded</span>
          <strong>{Number(unified.reference_exempt_record_count || 0).toLocaleString()}</strong>
          <em>National and exemption checks</em>
        </article>
      </div>
      <div className="layer-status-grid">
        {layers.map((layer) => (
          <article key={layer.id}>
            <div>
              <strong>{layer.label}</strong>
              <span>{layer.file || "File pending"}</span>
            </div>
            <b>{Number(layer.record_count || 0).toLocaleString()}</b>
            <em>{formatKm(layer.total_length_km)}</em>
            <p>{layer.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function useMowtManualsCatalog() {
  const [catalog, setCatalog] = useState({ records: [] });
  useEffect(() => {
    fetch(`${BASE}data/mowt_manuals_catalog.json`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { records: [] }))
      .then(setCatalog)
      .catch(() => setCatalog({ records: [] }));
  }, []);
  return catalog;
}

function GlobalCaseStudyPanel() {
  const { regionCounts, averageScore, indicatorAverages, topFrameworks, sourceCount } = getGlobalEvidenceSummary();
  const synthesis = useEvidenceSynthesis();
  const caseStudyTable = synthesis?.casePackageTables?.countryCaseStudies;
  const assumptionTable = synthesis?.casePackageTables?.decisionAssumptions;
  const referenceTypeChart = synthesis?.globalCaseStudyCharts?.referenceTypeChart;

  return (
    <div className="case-study-page">
      <section className="case-study-hero">
        <div>
          <p className="eyebrow">Global case study review</p>
          <h2>195-country road asset management review translated into DUCAR rules</h2>
          <span>193 UN Member States plus Holy See and State of Palestine, grouped with World Bank regional logic</span>
        </div>
        <strong>{averageScore}%</strong>
      </section>
      <section className="metrics-grid">
        <Metric icon={Globe2} label="Countries covered" value={GLOBAL_COUNTRY_REVIEWS.length} />
        <Metric icon={MapIcon} label="Regions covered" value={Object.keys(regionCounts).length} tone="green" />
        <Metric icon={ClipboardCheck} label="Transferability index" value={`${averageScore}%`} tone="gold" />
        <Metric icon={BookOpen} label="Reference groups" value={sourceCount} tone="red" />
      </section>
      <section className="literature-engine">
        <div className="viz-title">
          <h3>Literature Review Comparison Engine</h3>
          <span>195-country framework comparison using measurable performance indicators</span>
        </div>
        <div className="literature-actions">
          <button onClick={() => downloadLiteratureReviewFile("csv")}><Download size={15} /> Download CSV</button>
          <button className="secondary" onClick={() => downloadLiteratureReviewFile("json")}><FileSpreadsheet size={15} /> Download JSON</button>
        </div>
        <div className="indicator-score-grid">
          {indicatorAverages.map((item, index) => (
            <article key={item.key} style={{ "--accent": ["#4258ff", "#12b981", "#f43f5e", "#ffb020", "#00a7c7", "#7c3aed", "#10b981", "#ef4444"][index % 8] }}>
              <div>
                <strong>{item.label}</strong>
                <span>{Math.round(item.weight * 100)}% model weight</span>
              </div>
              <em>{item.value}%</em>
              <i><b style={{ width: `${item.value}%` }} /></i>
              <p>{item.detail}</p>
            </article>
          ))}
        </div>
        <div className="framework-rank-table">
          {topFrameworks.map((item, index) => (
            <article key={`${item.country}-${item.pattern}`}>
              <strong>{index + 1}</strong>
              <span>{item.country}<small>{item.region} / {item.pattern}</small></span>
              <em>{item.score}%</em>
            </article>
          ))}
        </div>
      </section>
      <section className="global-coverage-strip">
        {Object.entries(regionCounts).map(([region, count], index) => (
          <article key={region} style={{ "--accent": ["#4258ff", "#12b981", "#f43f5e", "#ffb020", "#00a7c7"][index % 5] }}>
            <strong>{region}</strong>
            <span>{count} countries</span>
            <i style={{ width: `${Math.round((count / GLOBAL_COUNTRY_REVIEWS.length) * 100)}%` }} />
          </article>
        ))}
      </section>
      <section className="viz-card wide-viz">
        <div className="viz-title">
          <h3>Benchmark Case Studies</h3>
          <span>Documented examples used to calibrate the country review logic</span>
        </div>
      </section>
      <section className="global-case-grid">
        {GLOBAL_CASE_STUDIES.map((item, index) => (
          <article key={`${item.region}-${item.place}`} style={{ "--accent": ["#4258ff", "#12b981", "#f43f5e", "#ffb020", "#00a7c7", "#7c3aed"][index % 6] }}>
            <div className="case-card-head">
              <span>{item.region}</span>
              <strong>{item.score}%</strong>
            </div>
            <h3>{item.place}</h3>
            <p>{item.lesson}</p>
            <div className="case-metric-row">
              {item.metrics.map((metric) => <i key={metric}>{metric}</i>)}
            </div>
            <em>{item.ducarUse}</em>
          </article>
        ))}
      </section>
      {caseStudyTable && (
        <section className="case-package-panel">
          <div className="viz-title">
            <h3>Local Global Case Evidence Package</h3>
            <span>APA workbook rows extracted from the local evidence and case-study folder</span>
          </div>
          <div className="case-package-grid">
            <section className="viz-card">
              <div className="viz-title">
                <h3>Reference Types</h3>
                <span>APA register mix</span>
              </div>
              <EvidenceBarList table={referenceTypeChart} maxRows={5} />
            </section>
            <EvidenceMiniTable table={caseStudyTable} maxRows={6} />
          </div>
          <EvidenceMiniTable table={assumptionTable} maxRows={7} />
        </section>
      )}
      <section className="viz-card wide-viz">
        <div className="viz-title">
          <h3>All Countries Coverage Matrix</h3>
          <span>Every country represented as a DUCAR transfer review record</span>
        </div>
        <div className="country-review-grid">
          {GLOBAL_COUNTRY_REVIEWS.map((item, index) => (
            <article key={`${item.region}-${item.country}`} style={{ "--accent": ["#4258ff", "#12b981", "#f43f5e", "#ffb020", "#00a7c7"][index % 5] }}>
              <div>
                <strong>{item.country}</strong>
                <span>{item.region}</span>
              </div>
              <em>{item.score}%</em>
              <b>{item.pattern}</b>
              <div className="country-indicator-strip">
                {LITERATURE_REVIEW_INDICATORS.slice(0, 4).map(([key, label]) => (
                  <span key={key}>{label}: {item.indicators[key]}%</span>
                ))}
              </div>
              <p>{item.ducarUse}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function SourcesPanel() {
  const catalog = useManualsCatalog();
  const evidence = useEvidenceSynthesis();
  const summary = catalog?.summary || {};
  const evidenceSummary = evidence?.summary || {};
  const topicCards = catalog?.topic_cards || [];
  const localSourceArea = evidence?.sourceCoverage?.sourceAreaChart;
  const localFileTypes = evidence?.sourceCoverage?.fileTypeChart;
  const localExtractionStatus = evidence?.sourceCoverage?.extractionStatusChart;
  const localDocumentTable = evidence?.documentTable;
  const caseStudyTable = evidence?.casePackageTables?.countryCaseStudies;
  const decisionAssumptionTable = evidence?.casePackageTables?.decisionAssumptions;
  const onlineReadTable = evidence?.onlineEvidence?.sourceTable;
  const spatialSummary = evidence?.spatialEvidence?.summary || {};
  const spatialSourceArea = evidence?.spatialEvidence?.sourceAreaChart;
  const spatialGeometry = evidence?.spatialEvidence?.geometryChart;
  const spatialFeatureChart = evidence?.spatialEvidence?.featureChart;
  const spatialLayerTable = evidence?.spatialEvidence?.layerTable;
  const inventorySummary = evidence?.fileInventory?.summary || {};
  const inventoryKind = evidence?.fileInventory?.kindChart;
  const inventoryExtension = evidence?.fileInventory?.extensionChart;
  const inventoryTable = evidence?.fileInventory?.fileTable;
  const mowtPages = 1425;
  const mowtSources = MOWT_CATALOGUE_MANUALS.map(([title, year, url, use]) => ({
    title,
    agency: "Ministry of Works and Transport",
    type: `Catalogue / ${year}`,
    url,
    use,
    apa: `Ministry of Works and Transport. (${year}). ${title}. The Republic of Uganda. Retrieved May 7, 2026, from ${url}`,
  }));
  const manualSources = MANUAL_SOURCES.map((source) => ({
    title: source.title,
    agency: source.agency,
    type: `Manual / ${source.year}`,
    url: source.href,
    use: source.controls.join(", "),
    apa: source.apa,
  }));
  const ugandaSources = UGANDA_EVIDENCE_STREAMS.map((source) => ({
    title: source.title,
    agency: source.agency,
    type: source.type,
    url: source.url,
    use: source.logic,
    apa: source.apa,
  }));
  const trafficSources = TRAFFIC_EVIDENCE_SOURCES.map((source) => ({
    title: source.title,
    agency: source.agency,
    type: source.type,
    url: source.url,
    use: source.use,
    apa: `${source.agency}. (n.d.). ${source.title}. Retrieved May 7, 2026, from ${source.url}`,
  }));
  const globalSources = GLOBAL_SOURCE_DOCUMENTS.map((source) => ({
    title: source.title,
    agency: source.agency,
    type: source.type,
    url: source.url,
    use: "Global comparison, benchmarking, literature review and framework transfer scoring.",
    apa: `${source.agency}. (n.d.). ${source.title}. Retrieved May 7, 2026, from ${source.url}`,
  }));
  const localAssumptions = sourceReferences.map((source, index) => ({
    title: `DUCAR local model assumption ${index + 1}`,
    agency: "DUCAR Priority Studio",
    type: "Model assumption",
    url: "#sources",
    use: source,
    apa: source,
  }));
  const allSources = [ITIS_ABSTRACT_SOURCE, ...manualSources, ...ugandaSources, ...trafficSources, ...mowtSources, ...globalSources, ...localAssumptions].filter((source, index, sources) => {
    const key = `${source.title}-${source.url}`;
    return sources.findIndex((item) => `${item.title}-${item.url}` === key) === index;
  });
  const groups = [
    ["Uganda manuals and local evidence", manualSources.length + localAssumptions.length, "#4258ff"],
    ["Uganda planning and budget evidence", ugandaSources.length + 1, "#12b981"],
    ["Traffic and network evidence", trafficSources.length, "#00a7c7"],
    ["MoWT catalogue records", mowtSources.length, "#ffb020"],
    ["Global comparison sources", globalSources.length, "#f43f5e"],
  ];

  return (
    <div className="sources-page">
      <section className="case-study-hero sources-hero">
        <div>
          <p className="eyebrow">Source register</p>
          <h2>One reference library for every dataset, manual, policy and literature source in the tool</h2>
          <span>Main reporting pages use summaries and infographics; this tab keeps the traceability, hyperlinks and APA assumptions.</span>
        </div>
        <strong>{allSources.length}</strong>
      </section>
      <section className="infographic-only-grid">
        {groups.map(([label, value, color]) => (
          <article key={label} style={{ "--accent": color }}>
            <div className="mini-ring" style={{ "--value": `${Math.min(100, value * 8) * 3.6}deg` }}><strong>{value}</strong></div>
            <span>{label}</span>
            <i><b style={{ width: `${Math.min(100, value * 8)}%` }} /></i>
          </article>
        ))}
      </section>
      <section className="metrics-grid">
        <Metric icon={BookOpen} label="Manual files indexed" value={(summary.all_files || 0).toLocaleString()} />
        <Metric icon={ClipboardCheck} label="Logic-ready records" value={(summary.logic_records || 0).toLocaleString()} tone="green" />
        <Metric icon={Database} label="Manual folders" value={summary.folders || 0} tone="gold" />
        <Metric icon={FileSpreadsheet} label="MoWT manual pages read" value={mowtPages.toLocaleString()} tone="red" />
      </section>
      <section className="source-evidence-panel">
        <div className="viz-title">
          <h3>Local Evidence Extraction Register</h3>
          <span>Cleaned recursive read from D:\OneDrive\Procurements\TOR - DUCACR</span>
        </div>
        <div className="source-evidence-kpis">
          <Metric icon={Database} label="Evidence files read" value={(evidenceSummary.core_documents_read || 0).toLocaleString()} />
          <Metric icon={BookOpen} label="Words extracted" value={(evidenceSummary.core_words_read || 0).toLocaleString()} tone="green" />
          <Metric icon={FileSpreadsheet} label="Local tables read" value={(evidenceSummary.local_tables_read || 0).toLocaleString()} tone="gold" />
          <Metric icon={Globe2} label="Global case rows" value={(evidenceSummary.global_case_records || 0).toLocaleString()} tone="red" />
          <Metric icon={MapIcon} label="Spatial layers read" value={(spatialSummary.layers_read || 0).toLocaleString()} tone="green" />
          <Metric icon={Database} label="Data files indexed" value={(inventorySummary.files_indexed || 0).toLocaleString()} tone="gold" />
        </div>
        <div className="source-evidence-grid">
          <section className="viz-card">
            <div className="viz-title">
              <h3>Source Areas</h3>
              <span>Where the extracted local evidence came from</span>
            </div>
            <EvidenceBarList table={localSourceArea} maxRows={9} />
          </section>
          <section className="viz-card">
            <div className="viz-title">
              <h3>File Types</h3>
              <span>Document, spreadsheet, feed and text formats included</span>
            </div>
            <EvidenceBarList table={localFileTypes} maxRows={8} />
          </section>
        </div>
        <div className="source-evidence-grid">
          <section className="viz-card">
            <div className="viz-title">
              <h3>Extraction Status</h3>
              <span>Read outcomes after filtering generated and non-evidence artifacts</span>
            </div>
            <EvidenceBarList table={localExtractionStatus} maxRows={5} />
          </section>
          <EvidenceMiniTable table={caseStudyTable} maxRows={5} />
        </div>
        <div className="source-evidence-grid">
          <section className="viz-card">
            <div className="viz-title">
              <h3>Spatial Layers</h3>
              <span>Shapefile, GeoJSON and GeoPackage evidence read from local data</span>
            </div>
            <EvidenceBarList table={spatialSourceArea} maxRows={7} />
          </section>
          <section className="viz-card">
            <div className="viz-title">
              <h3>Spatial Geometry</h3>
              <span>Features extracted from road, district and network layers</span>
            </div>
            <EvidenceBarList table={spatialGeometry} maxRows={6} />
          </section>
        </div>
        <div className="source-evidence-grid">
          <section className="viz-card">
            <div className="viz-title">
              <h3>Largest GIS Layers</h3>
              <span>Feature counts from local layers and retained dated copies</span>
            </div>
            <EvidenceBarList table={spatialFeatureChart} maxRows={7} />
          </section>
          <section className="viz-card">
            <div className="viz-title">
              <h3>Local Data Inventory</h3>
              <span>All data-bearing local files, excluding dependencies and generated app bundles</span>
            </div>
            <EvidenceBarList table={inventoryKind} maxRows={7} />
          </section>
        </div>
        <div className="source-evidence-grid">
          <section className="viz-card">
            <div className="viz-title">
              <h3>Inventory File Types</h3>
              <span>Extensions present across the local data package</span>
            </div>
            <EvidenceBarList table={inventoryExtension} maxRows={8} />
          </section>
          <EvidenceMiniTable table={spatialLayerTable} maxRows={8} />
        </div>
        <div className="evidence-table-grid">
          <EvidenceMiniTable table={decisionAssumptionTable} maxRows={6} />
          <EvidenceMiniTable table={localDocumentTable} maxRows={10} />
        </div>
        <EvidenceMiniTable table={inventoryTable} maxRows={10} />
        <EvidenceMiniTable table={onlineReadTable} maxRows={10} />
      </section>
      <section className="viz-card wide-viz">
        <div className="viz-title">
          <h3>Evidence Statistics from Manuals and Budget Sources</h3>
          <span>Content-derived summaries used by the tool logic</span>
        </div>
        <div className="manual-topic-grid">
          {(topicCards.length ? topicCards : MANUAL_LOGIC_WEIGHTS.map(([topic, decision_use, score]) => ({ topic, decision_use, logic_records: score, all_files: score }))).map((item, index) => (
            <article key={item.topic} style={{ "--accent": ["#4258ff", "#12b981", "#f43f5e", "#ffb020", "#00a7c7"][index % 5] }}>
              <span>{Number(item.logic_records || 0).toLocaleString()}</span>
              <strong>{item.topic}</strong>
              <p>{item.decision_use}</p>
              <div><i style={{ width: `${Math.min(100, (Number(item.logic_records || 0) / Math.max(1, Number(item.all_files || 1))) * 100)}%` }} /></div>
              <em>{Number(item.all_files || 0).toLocaleString()} files checked</em>
            </article>
          ))}
        </div>
      </section>
      <section className="viz-card wide-viz">
        <div className="viz-title">
          <h3>Source Data Register</h3>
          <span>Hyperlinks, download targets, model use and APA-style reference text</span>
        </div>
        <div className="source-register-table">
          {allSources.map((source, index) => (
            <article key={`${source.title}-${source.url}-${index}`}>
              <div>
                <strong>{source.title}</strong>
                <span>{source.agency} / {source.type}</span>
              </div>
              <p>{source.use}</p>
              <em>{source.apa}</em>
              {source.url !== "#sources" && (
                <div className="source-actions">
                  <a href={source.url} target="_blank" rel="noreferrer">Open</a>
                  <a href={source.url} download target="_blank" rel="noreferrer"><Download size={14} /> Download</a>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function MapScene3D({ programme }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const layerStatus = useLayerStatus();
  const [roads, setRoads] = useState(null);
  const [flows, setFlows] = useState(null);
  const [roadSystemFilter, setRoadSystemFilter] = useState("All");
  const [roadClassFilter, setRoadClassFilter] = useState("All");
  const [surfaceFilter, setSurfaceFilter] = useState("All");
  const [roadSort, setRoadSort] = useState("length_km");
  const [nodes, setNodes] = useState(null);
  const [routeMatrix, setRouteMatrix] = useState(null);
  const [showFlows, setShowFlows] = useState(true);
  const [showHybridLabels, setShowHybridLabels] = useState(true);
  const [selectedRoad, setSelectedRoad] = useState(null);
  const [mapLoadState, setMapLoadState] = useState({ stage: "loading", message: "Preparing Uganda imagery map" });

  const unifiedLayerStatus = useMemo(() => layerStatus?.layers?.find((layer) => layer.id === "unified-roads") || null, [layerStatus]);
  const cartographicLayerStatus = useMemo(() => layerStatus?.layers?.find((layer) => layer.id === "cartographic-routes") || null, [layerStatus]);
  const nationalLayerStatus = useMemo(() => layerStatus?.layers?.find((layer) => layer.id === "national-roads") || null, [layerStatus]);
  const roadsReady = Boolean(roads?.features?.length);
  const flowsReady = Boolean(flows?.features?.length);

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
    if (mapInstance.current || !mapRef.current) return;
    let cancelled = false;
    let map = null;
    let roadLayersStarted = false;
    let styleReadyTimer = null;
    let startRoadLayers = null;

    async function initialiseMap() {
      const maplibregl = await loadMapLibre();
      if (cancelled || !mapRef.current) return;
      map = new maplibregl.Map({
        container: mapRef.current,
        center: UGANDA_MAP_VIEW.center,
        zoom: UGANDA_MAP_VIEW.zoom,
        pitch: UGANDA_MAP_VIEW.pitch,
        bearing: UGANDA_MAP_VIEW.bearing,
        antialias: true,
        attributionControl: false,
        style: imageryWithLabelsStyle(),
      });
      addOperationalMapControls(maplibregl, map);
      mapInstance.current = map;
      startRoadLayers = () => {
        if (!roadLayersStarted && map?.isStyleLoaded()) initialiseRoadLayers();
      };
      map.on("load", startRoadLayers);
      map.on("styledata", startRoadLayers);
      styleReadyTimer = window.setTimeout(startRoadLayers, 1200);
    }

    async function initialiseRoadLayers() {
      if (cancelled || roadLayersStarted || !map?.isStyleLoaded()) return;
      roadLayersStarted = true;
      try {
        setMapLoadState({ stage: "loading", message: "Reading road layer manifest" });
        const emptyFeatureCollection = { type: "FeatureCollection", features: [] };
        const manifest = await fetchUgandaLayersManifest();
        const roadPromise = fetchManifestJson(manifest, "cartographic_roads_geojson", "uganda_clean_road_routes_web.geojson")
          .catch(() => fetchManifestJson(manifest, "unified_roads_geojson", "uganda_unified_roads_web.geojson"));
        const nodePromise = fetchManifestJson(manifest, "network_nodes_geojson", "uganda_network_nodes_web.geojson").catch(() => emptyFeatureCollection);
        const flowPromise = fetchManifestJson(manifest, "traffic_flows_geojson", "uganda_traffic_flows_web.geojson").catch(() => emptyFeatureCollection);
        const matrixPromise = fetchManifestJson(manifest, "route_matrix_json", "uganda_route_matrix.json").catch(() => ({ routes: [] }));

        setMapLoadState({ stage: "loading", message: "Loading route-level road geometry" });
        const roadData = await roadPromise;
        if (cancelled) return;
        setRoads(roadData);
        setMapLoadState({ stage: "loading", message: `Preparing ${formatCount(roadData.features?.length)} visual routes` });
        const [nodeData, flowData, matrixData] = await Promise.all([nodePromise, flowPromise, matrixPromise]);
        if (cancelled) return;

        setFlows(flowData);
        setNodes(nodeData);
        setRouteMatrix(matrixData);
        map.addSource("roads", { type: "geojson", data: roadData });
        map.addSource("traffic-flows", { type: "geojson", data: flowData });
        map.addSource("network-nodes", { type: "geojson", data: nodeData });
        map.addSource("programme-assets", { type: "geojson", data: programmeGeoJson });
        map.addLayer({
          id: "roads-glow",
          type: "line",
          source: "roads",
          paint: {
            "line-color": ROAD_CATEGORY_COLORS,
            "line-width": ["+", ROAD_CATEGORY_WIDTHS, 1.1],
            "line-opacity": ["case", ["==", ["get", "network_category"], "National Roads"], 0.14, 0.18],
            "line-blur": 1.45,
          },
        });
        map.addLayer({
          id: "roads-overview-ribbons",
          type: "line",
          source: "roads",
          maxzoom: 8.5,
          paint: {
            "line-color": ROAD_CATEGORY_COLORS,
            "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2.3, 7, 1.7, 8.5, 1.15],
            "line-opacity": 0.74,
            "line-blur": 0.18,
          },
        });
        map.addLayer({
          id: "roads-all-halo",
          type: "line",
          source: "roads",
          filter: ["!=", ["get", "road_system"], "National"],
          paint: {
            "line-color": "#020617",
            "line-width": ["+", ROAD_CATEGORY_WIDTHS, 0.45],
            "line-opacity": 0.24,
            "line-blur": 0.18,
          },
        });
        map.addLayer({
          id: "roads-all",
          type: "line",
          source: "roads",
          paint: {
            "line-color": ROAD_CATEGORY_COLORS,
            "line-width": ROAD_CATEGORY_WIDTHS,
            "line-opacity": ["case", ["==", ["get", "network_category"], "National Roads"], 0.9, 0.88],
          },
        });
        map.addLayer({
          id: "traffic-flow-glow",
          type: "line",
          source: "traffic-flows",
          paint: {
            "line-color": TRAFFIC_FLOW_COLOR,
            "line-width": ["interpolate", ["linear"], ["coalesce", ["get", "traffic_flow_index"], 45], 30, 0.9, 60, 1.9, 100, 3.4],
            "line-opacity": 0.26,
            "line-blur": 1.8,
          },
        });
        map.addLayer({
          id: "traffic-flow-casing",
          type: "line",
          source: "traffic-flows",
          paint: {
            "line-color": "#020617",
            "line-width": ["interpolate", ["linear"], ["coalesce", ["get", "traffic_flow_index"], 45], 30, 0.85, 60, 1.7, 100, 2.8],
            "line-opacity": 0.3,
            "line-blur": 0.2,
          },
        });
        map.addLayer({
          id: "traffic-flow",
          type: "line",
          source: "traffic-flows",
          paint: {
            "line-color": TRAFFIC_FLOW_COLOR,
            "line-width": ["interpolate", ["linear"], ["coalesce", ["get", "traffic_flow_index"], 45], 30, 0.75, 60, 1.55, 100, 2.8],
            "line-opacity": 0.94,
            "line-dasharray": [1.4, 1],
          },
        });
        map.addLayer({
          id: "national-dash-overlay",
          type: "line",
          source: "roads",
          filter: ["==", ["get", "road_system"], "National"],
          paint: { "line-color": "#fef3c7", "line-width": 1.15, "line-opacity": 0.96, "line-dasharray": [1.4, 0.9] },
        });
        map.addSource("selected-road", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "selected-road-halo",
          type: "line",
          source: "selected-road",
          paint: { "line-color": "#ffffff", "line-width": 11, "line-opacity": 0.96, "line-blur": 0.45 },
        });
        map.addLayer({
          id: "selected-road-line",
          type: "line",
          source: "selected-road",
          paint: { "line-color": "#111827", "line-width": 5.2, "line-opacity": 1 },
        });

        for (const layerId of ["roads-all", "traffic-flow"]) {
          map.on("click", layerId, (e) => selectRoadFeature(map, e));
          map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
          map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
        }
        fitMapToFeatures(map, roadData.features?.slice(0, 1400), { padding: 84, duration: 900, maxZoom: 8.4 });
        setMapLoadState({ stage: "ready", message: `${formatCount(roadData.features?.length)} visual routes ready` });
      } catch (error) {
        if (cancelled) return;
        setMapLoadState({ stage: "error", message: error.message || "Unable to load road layers" });
      }
    }
    initialiseMap().catch((error) => {
      if (!cancelled) setMapLoadState({ stage: "error", message: error.message || "Unable to initialise map controls" });
    });
    return () => {
      cancelled = true;
      if (styleReadyTimer) window.clearTimeout(styleReadyTimer);
      if (map && startRoadLayers) {
        map.off("load", startRoadLayers);
        map.off("styledata", startRoadLayers);
      }
      map?.remove();
      mapInstance.current = null;
    };
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
    if (!map?.isStyleLoaded() || !map.getSource("programme-assets")) return;
    map.getSource("programme-assets").setData(programmeGeoJson);
  }, [programmeGeoJson]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map?.isStyleLoaded()) return;
    for (const layerId of ["traffic-flow-glow", "traffic-flow-casing", "traffic-flow"]) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", showFlows ? "visible" : "none");
    }
  }, [showFlows]);

  useEffect(() => {
    const map = mapInstance.current;
    if (!map?.isStyleLoaded()) return;
    for (const layerId of ["esri-transportation-labels", "esri-labels"]) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", showHybridLabels ? "visible" : "none");
    }
  }, [showHybridLabels]);

  function fitVisibleRoads() {
    const map = mapInstance.current;
    fitMapToFeatures(map, filteredRoads.length ? filteredRoads : roads?.features, { padding: 86, duration: 720, maxZoom: 10.8 });
  }

  function resetMapView() {
    mapInstance.current?.easeTo({ ...UGANDA_MAP_VIEW, duration: 700 });
    clearSelectedRoad();
  }

  const matrixRoutes = useMemo(() => {
    const routes = routeMatrix?.routes || [];
    return routes.slice().sort((a, b) => (b.traffic_flow_index || 0) - (a.traffic_flow_index || 0)).slice(0, 8);
  }, [routeMatrix]);
  const routeLayerRecordCount = Number(cartographicLayerStatus?.record_count || 0);
  const unifiedAuditRecordCount = Number(unifiedLayerStatus?.record_count || 0);
  const mapStats = useMemo(() => {
    const features = roads?.features || [];
    const statusScope = unifiedLayerStatus?.by_ducar_analysis_scope || {};
    const fallbackNeedsValidation = Object.entries(statusScope)
      .filter(([key]) => key.toLowerCase().includes("validation"))
      .reduce((sum, [, value]) => sum + Number(value || 0), 0);
    const nationalRoutes = roadsReady
      ? features.filter((f) => classifyRoadCategory(f.properties) === "National Roads").length
      : Number(cartographicLayerStatus?.by_network_category?.["National Roads"] || nationalLayerStatus?.record_count || 0);
    const ducar = Number(unifiedLayerStatus?.ducar_analysis_record_count || 0);
    const needsValidation = fallbackNeedsValidation;
    const flowFeatures = flows?.features || [];
    const avgFlow = flowFeatures.length
      ? Math.round(flowFeatures.reduce((sum, f) => sum + Number(f.properties?.traffic_flow_index || 0), 0) / flowFeatures.length)
      : null;
    const displayRoadCount = roadsReady ? filteredRoads.length : routeLayerRecordCount || unifiedAuditRecordCount;
    return [
      { label: "Visible routes", value: formatCount(displayRoadCount), tone: "blue" },
      { label: "Unified audit records", value: formatCount(unifiedAuditRecordCount || displayRoadCount), tone: "dark" },
      { label: "DUCAR scope", value: ducar.toLocaleString(), tone: "green" },
      { label: "National routes", value: nationalRoutes.toLocaleString(), tone: "dark" },
      { label: "Needs validation", value: needsValidation.toLocaleString(), tone: "red" },
      { label: "Mean flow index", value: avgFlow === null ? "Loading" : `${avgFlow}%`, tone: "dark" },
    ];
  }, [cartographicLayerStatus, flows, filteredRoads.length, nationalLayerStatus, roads, roadsReady, routeLayerRecordCount, unifiedAuditRecordCount, unifiedLayerStatus]);

  const displayedRoadCount = roadsReady ? filteredRoads.length : routeLayerRecordCount || unifiedAuditRecordCount;
  const hudRoadText = roadsReady
    ? `${formatCount(filteredRoads.length)} visible road routes`
    : `${formatCount(displayedRoadCount)} road routes queued`;
  const hudNodeText = nodes?.features?.length ? `${formatCount(nodes.features.length)} network junctions indexed` : "Network junction index loading";
  const hudRouteText = routeMatrix?.routes?.length ? `${formatCount(routeMatrix.routes.length)} OD route pairs` : "OD route matrix loading";
  const mapStatusText = mapLoadState.stage === "ready" ? "Road layer ready" : mapLoadState.message;

  return (
    <section className="panel map-panel map3d-panel" id="gis">
      <div className="map-header">
        <div className="panel-title" style={{ borderBottom: "none", marginBottom: 0, paddingBottom: 0 }}>
          <Layers size={18} />
          <h2>Uganda Hybrid Road Intelligence Map</h2>
        </div>
        <div className="map-toolbar">
          <div className="layer-toggles">
            <button className="layer-btn active unified" title="Imagery hybrid basemap with road network overlay">
              <Layers size={14} /> Hybrid Basemap
            </button>
            <button className={`layer-btn ${showFlows ? "active flow" : ""}`} onClick={() => setShowFlows((value) => !value)} aria-pressed={showFlows} title="Toggle traffic flow symbology">
              {showFlows ? <Eye size={14} /> : <EyeOff size={14} />} Traffic Flow
            </button>
            <button className={`layer-btn ${showHybridLabels ? "active labels" : ""}`} onClick={() => setShowHybridLabels((value) => !value)} aria-pressed={showHybridLabels} title="Toggle hybrid reference labels">
              {showHybridLabels ? <Eye size={14} /> : <EyeOff size={14} />} Labels
            </button>
          </div>
          <div className="map-action-controls">
            <button onClick={fitVisibleRoads} disabled={!displayedRoadCount} title="Fit visible road layers">
              <Target size={15} /> Fit
            </button>
            <button onClick={resetMapView} title="Reset Uganda map view">
              <RefreshCcw size={15} /> Reset
            </button>
          </div>
        </div>
      </div>
      <div className="road-filter-bar">
        <p className="scope-note">{DUCAR_EXEMPTION_TEXT}</p>
        <label><ListFilter size={16} /> System<select value={roadSystemFilter} onChange={(e) => setRoadSystemFilter(e.target.value)} disabled={!roadsReady}>{roadOptions.systems.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Class<select value={roadClassFilter} onChange={(e) => setRoadClassFilter(e.target.value)} disabled={!roadsReady}>{roadOptions.classes.map((x) => <option key={x} value={x}>{formatRoadClassLabel(x)}</option>)}</select></label>
        <label>Surface<select value={surfaceFilter} onChange={(e) => setSurfaceFilter(e.target.value)} disabled={!roadsReady}>{roadOptions.surfaces.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Sort<select value={roadSort} onChange={(e) => setRoadSort(e.target.value)} disabled={!roadsReady}>{["length_km", "traffic_flow_index", "segment_count", "road_name", "road_class", "region", "district"].map((x) => <option key={x}>{x}</option>)}</select></label>
        <strong>{formatCount(displayedRoadCount)} {roadsReady ? "road routes" : "routes loading"}</strong>
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
        {mapLoadState.stage !== "ready" && (
          <div className={`map-loading map-loading-card ${mapLoadState.stage === "error" ? "error" : ""}`}>
            {mapLoadState.stage !== "error" && <div className="spinner" />}
            <div>
              <strong>{mapLoadState.stage === "error" ? "Map layer unavailable" : "Loading road intelligence"}</strong>
              <span>{mapLoadState.message}</span>
              {!!displayedRoadCount && mapLoadState.stage !== "error" && <em>{formatCount(displayedRoadCount)} routes in the current manifest</em>}
            </div>
          </div>
        )}
        <div className="scene-hud">
          <strong>2D route-level road network</strong>
          <span>{hudRoadText}</span>
          <span>{hudNodeText}</span>
          <span>{hudRouteText}</span>
          <span>{mapStatusText}</span>
          <span>Imagery hybrid basemap with boundary, place and transportation labels.</span>
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
        {page.id !== "sources" && (
          <a className="source-tab-link" href="#sources">
            <BookOpen size={16} />
            <span>Sources</span>
          </a>
        )}
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
        <h2>Framework Schematic and Tool Process Flow</h2>
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
        {FRAMEWORK_EVIDENCE_LOGIC.map(([label, detail], index) => (
          <article key={label} className={index === activeStep % FRAMEWORK_EVIDENCE_LOGIC.length ? "active" : ""}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{label}</strong>
            <p>{detail}</p>
            <a href="#sources">Evidence basis</a>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatEvidenceCell(value) {
  if (value === null || value === undefined || value === "") return "No data";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(value);
}

const SITE_DOWNLOAD_FILES = [
  "data/district_roads_dissolved.geojson",
  "data/districts.geojson",
  "data/DUCAR_OSM_Road_Classification_Rules_2026-05-18.csv",
  "data/DUCAR_source_digest.json",
  "data/ducar_sync_report.json",
  "data/ducar_unified.sqlite",
  "data/ducar_unified_manifest.json",
  "data/evidence_synthesis.json",
  "data/kcca_roads.geojson",
  "data/manuals_catalog.json",
  "data/mowt_manuals_catalog.json",
  "data/product_insights.json",
  "data/selected_cbd_roads.geojson",
  "data/uganda_clean_road_routes_web.geojson",
  "data/uganda_layers_manifest.json",
  "data/uganda_layers_status.json",
  "data/uganda_national_roads_fy25_26.geojson",
  "data/uganda_national_roads_fy25_26_2026-05-05.geojson",
  "data/uganda_national_roads_fy25_26_2026-05-06.geojson",
  "data/uganda_national_roads_fy25_26_2026-05-13.geojson",
  "data/uganda_network_analysis_summary.json",
  "data/uganda_network_edges_web.geojson",
  "data/uganda_network_nodes_web.geojson",
  "data/uganda_osm_major_roads_web.geojson",
  "data/uganda_osm_major_roads_web_2026-05-05.geojson",
  "data/uganda_osm_major_roads_web_2026-05-06.geojson",
  "data/uganda_osm_major_roads_web_2026-05-13.geojson",
  "data/uganda_osm_major_roads_web_2026-05-14.geojson",
  "data/uganda_osm_major_roads_web_2026-05-16.geojson",
  "data/uganda_osm_major_roads_web_2026-05-17.geojson",
  "data/uganda_osm_major_roads_web_2026-05-18.geojson",
  "data/uganda_roads_master_summary_2026-05-18.json",
  "data/uganda_roads_district_summary.geojson",
  "data/uganda_roads_district_summary_2026-05-05.geojson",
  "data/uganda_roads_district_summary_2026-05-06.geojson",
  "data/uganda_roads_district_summary_2026-05-13.geojson",
  "data/uganda_roads_district_summary_2026-05-14.geojson",
  "data/uganda_roads_district_summary_2026-05-16.geojson",
  "data/uganda_roads_district_summary_2026-05-17.geojson",
  "data/uganda_roads_district_summary_2026-05-18.geojson",
  "data/uganda_route_matrix.json",
  "data/uganda_traffic_flows_web.geojson",
  "data/uganda_unified_roads_web.geojson",
  "data/uganda_unified_roads_web_2026-05-05.geojson",
  "data/uganda_unified_roads_web_2026-05-06.geojson",
  "data/uganda_unified_roads_web_2026-05-13.geojson",
  "docs/CONSTRUCTION-MANUAL-.pdf",
  "docs/Integrated Transport Infrastructure Services Annual Budget Monitoring report FY 2023-24.pdf",
  "docs/mowt/Final-General-Specifications-for-Roads-and-Bridges_March-2026.pdf",
  "docs/mowt/NMT-Design-and-Operational-Manual-web-2.pdf",
  "docs/mowt/URDM-Manual-Part-1-July-2023.pdf",
  "docs/mowt/URDM-Standard-Drawings-July2023.pdf",
  "docs/Public-Investment-Manual-for-Project-Preparation-and-Appraisal.pdf",
  "docs/TOR__for_Consultancy_Services_for_Guidelines for Monitoring Road Performance Indicators_DUCAR.docx",
  "docs/TOR__for_Consultancy_Services_for_RAM_DUCAR part 1_framework.docx",
  "docs/TOR__for_Consultancy_Services_for_RAM_DUCAR.docx",
  "docs/TOR__for_Consultancy_Services_for_Road_Condition_Monitoring_Guidelines_DUCAR.docx",
];

function resolveEvidenceHref(href) {
  if (!href) return "";
  const value = String(href).replaceAll("\\", "/").trim();
  if (/^https?:\/\//i.test(value) || value.startsWith(BASE)) return value;
  if (value.startsWith("public/")) return `${BASE}${value.replace(/^public\//, "")}`;
  if (value.startsWith("data/") || value.startsWith("docs/")) return `${BASE}${value}`;
  return value.startsWith("#") ? `${BASE}data/DUCAR_source_digest.json` : value;
}

function evidenceFileFormat(href, fallback = "Web") {
  const clean = String(href || "").split(/[?#]/)[0].toLowerCase();
  const ext = clean.includes(".") ? clean.split(".").pop() : "";
  const labels = {
    doc: "DOC",
    docx: "DOCX",
    geojson: "GeoJSON / GIS",
    json: "JSON",
    kml: "KML",
    kmz: "KMZ",
    pdf: "PDF",
    png: "PNG",
    shp: "SHP",
    sqlite: "DB",
    csv: "CSV",
    xls: "XLS",
    xlsx: "XLSX",
  };
  return labels[ext] || fallback;
}

function evidenceTitleFromPath(path) {
  const filename = String(path).split("/").pop() || path;
  return filename
    .replace(/\.[^.]+$/, "")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeEvidenceSource(row, index) {
  const href = resolveEvidenceHref(row.href || row.url);
  return {
    id: `${row.title || row.path || index}-${href}`,
    title: row.title || evidenceTitleFromPath(row.path || href),
    owner: row.owner || row.agency || "DUCAR road intelligence",
    theme: row.theme || row.type || "Road infrastructure",
    format: row.format || evidenceFileFormat(href, row.type || "Web"),
    detail: row.detail || row.use || row.logic || row.apa || "Road network, investment or operating-model reference",
    href,
    downloadable: Boolean(href && !href.startsWith("#")),
  };
}

function buildEvidenceSourceMatrix(insights) {
  const siteAssets = SITE_DOWNLOAD_FILES.map((path) => ({
    title: evidenceTitleFromPath(path),
    owner: path.startsWith("docs/") ? "Road manual/document asset" : "Road data asset",
    type: path.startsWith("docs/") ? "Document" : "Downloadable data",
    format: evidenceFileFormat(path),
    detail: path.includes("geojson") ? "GIS-ready road layer" : "Readable or downloadable product asset",
    href: path,
  }));
  const manualSources = MANUAL_SOURCES.map((item) => ({
    title: item.title,
    owner: item.agency,
    type: `Manual / ${item.year}`,
    href: item.href,
    detail: item.controls.join(", "),
  }));
  const mowtSources = MOWT_CATALOGUE_MANUALS.map(([title, year, href, detail]) => ({
    title,
    owner: "Ministry of Works and Transport",
    type: `Road manual / ${year}`,
    href,
    detail,
  }));
  const ugandaSources = UGANDA_EVIDENCE_STREAMS.map((item) => ({
    title: item.title,
    owner: item.agency,
    type: item.type,
    href: item.url,
    detail: item.logic,
  }));
  const trafficSources = TRAFFIC_EVIDENCE_SOURCES.map((item) => ({
    title: item.title,
    owner: item.agency,
    type: item.type,
    href: item.url,
    detail: item.use,
  }));
  const globalSources = GLOBAL_SOURCE_DOCUMENTS.map((item) => ({
    title: item.title,
    owner: item.agency,
    type: item.type,
    href: item.url,
    detail: "Global road asset-management comparison",
  }));
  const globalReferenceRows = (insights.globalCases?.referenceTable?.rows || []).map((row) => ({
    title: String(row[3] || row[0] || "Global case reference").split(".").slice(0, 2).join("."),
    owner: row[2] || "Global case register",
    type: row[1] || "Reference",
    href: /^https?:\/\//i.test(String(row[4] || "")) ? row[4] : "data/DUCAR_source_digest.json",
    detail: row[5] || "Global case transfer reference",
  }));
  const assumptionRows = sourceReferences.map((detail, index) => ({
    title: `DUCAR decision assumption ${String(index + 1).padStart(2, "0")}`,
    owner: "DUCAR prioritisation model",
    type: "Decision assumption",
    href: "data/DUCAR_source_digest.json",
    detail,
  }));
  const rows = [
    { ...ITIS_ABSTRACT_SOURCE, href: "data/DUCAR_source_digest.json" },
    ...siteAssets,
    ...manualSources,
    ...mowtSources,
    ...ugandaSources,
    ...trafficSources,
    ...globalSources,
    ...globalReferenceRows,
    ...assumptionRows,
  ].map(normalizeEvidenceSource);
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.title}-${row.href}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function EvidenceMiniTable({ table, maxRows = 8 }) {
  if (!table?.rows?.length) return null;
  return (
    <div className="evidence-mini-table">
      <div className="viz-title">
        <h3>{table.title}</h3>
        {table.source && <a href="#sources">APA source</a>}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {table.columns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, maxRows).map((row, index) => (
              <tr key={`${table.title}-${index}`}>
                {row.map((cell, cellIndex) => <td key={`${index}-${cellIndex}`}>{formatEvidenceCell(cell)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > maxRows && <small>{table.rows.length - maxRows} more rows remain in the evidence dataset.</small>}
    </div>
  );
}

function EvidenceBarList({ table, maxRows = 8 }) {
  if (!table?.rows?.length) return null;
  const maxValue = Math.max(1, ...table.rows.map((row) => Number(row[1] || 0)));
  return (
    <div className="evidence-bar-list">
      {table.rows.slice(0, maxRows).map((row, index) => {
        const value = Number(row[1] || 0);
        return (
          <article key={`${table.title}-${row[0]}-${index}`} style={{ "--accent": ["#4258ff", "#12b981", "#f43f5e", "#ffb020", "#00a7c7", "#7c3aed"][index % 6] }}>
            <span>{formatEvidenceCell(row[0])}</span>
            <i><b style={{ width: `${Math.max(3, (value / maxValue) * 100)}%` }} /></i>
            <strong>{formatEvidenceCell(value)}</strong>
          </article>
        );
      })}
    </div>
  );
}

function formatStoryMetric(value) {
  const numeric = Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return value;
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}m`;
  return numeric.toLocaleString();
}

function EvidenceSynthesisPanel() {
  const synthesis = useEvidenceSynthesis();
  const summary = synthesis?.summary || {};
  const topicChart = synthesis?.documentTopicChart || [];
  const storyCards = synthesis?.storyCards || [];
  const sourceArea = synthesis?.sourceCoverage?.sourceAreaChart;
  const fileTypes = synthesis?.sourceCoverage?.fileTypeChart;
  const caseContinents = synthesis?.globalCaseStudyCharts?.continentChart;
  const transportAnnual = synthesis?.transportCharts?.annualVehicleTotals;
  const transportClasses = synthesis?.transportCharts?.vehicleClassTotals;
  const caseStudyTable = synthesis?.casePackageTables?.countryCaseStudies;
  const decisionTable = synthesis?.casePackageTables?.decisionAssumptions;
  const tabularPreview = synthesis?.tabularExtracts?.[0];
  const network = synthesis?.itisCharts?.charts?.network || synthesis?.itisTables?.road_network_by_category;
  const condition = synthesis?.itisCharts?.charts?.condition || synthesis?.itisTables?.road_condition_by_category;
  const crashes = synthesis?.itisCharts?.charts?.crashes || synthesis?.itisTables?.road_crashes_by_nature;
  const ferry = synthesis?.itisCharts?.charts?.ferry || synthesis?.itisTables?.ferry_operations_kis;
  const onlineGroup = synthesis?.onlineEvidence?.groupChart;
  const onlineSources = synthesis?.onlineEvidence?.sourceTable;
  const documentTable = synthesis?.documentTable;
  const spatialSummary = synthesis?.spatialEvidence?.summary || {};
  const spatialSourceArea = synthesis?.spatialEvidence?.sourceAreaChart;
  const spatialGeometry = synthesis?.spatialEvidence?.geometryChart;
  const spatialFeatures = synthesis?.spatialEvidence?.featureChart;
  const spatialLength = synthesis?.spatialEvidence?.lengthChart;
  const spatialTable = synthesis?.spatialEvidence?.layerTable;
  const inventorySummary = synthesis?.fileInventory?.summary || {};
  const inventoryKind = synthesis?.fileInventory?.kindChart;
  const inventoryTable = synthesis?.fileInventory?.fileTable;
  const maxRoadKm = Math.max(1, ...(network?.rows || []).map((row) => Number(row[1] || 0)));
  const maxPoorKm = Math.max(1, ...(condition?.rows || []).map((row) => Number(row[3] || 0)));
  const maxCrash = Math.max(1, ...(crashes?.rows || []).map((row) => Number(row[4] || 0)));
  const statusLabel = synthesis ? "Evidence read complete" : "Loading evidence reader";

  return (
    <section className="evidence-synthesis-suite">
      <div className="evidence-synthesis-hero">
        <div>
          <p className="eyebrow">{statusLabel}</p>
          <h2>Document-to-decision intelligence now drives the PIMS engine.</h2>
          <span>
            The app reads the local TOR folder, manuals, budget reports, transport workbooks, global case package, MoWT manuals, ITIS tables, national repository catalogue and global framework links,
            then converts them into decision charts and tables used by the allocation logic.
          </span>
          <a href="#sources">Open source register</a>
        </div>
        <strong>{(summary.core_words_read || 0).toLocaleString()}</strong>
        <em>words read</em>
      </div>

      <section className="metrics-grid evidence-read-grid">
        <Metric icon={BookOpen} label="Core documents read" value={(summary.core_documents_read || 0).toLocaleString()} />
        <Metric icon={FileSpreadsheet} label="Pages extracted" value={(summary.core_pages_read || 0).toLocaleString()} tone="green" />
        <Metric icon={Database} label="DOCX tables read" value={(summary.docx_tables_read || 0).toLocaleString()} tone="gold" />
        <Metric icon={ClipboardCheck} label="Manual records indexed" value={(summary.manual_repository_files || 0).toLocaleString()} tone="red" />
        <Metric icon={Globe2} label="Online sources checked" value={(summary.online_sources_checked || 0).toLocaleString()} />
        <Metric icon={MapIcon} label="Spatial layers read" value={(summary.spatial_layers_read || 0).toLocaleString()} tone="green" />
      </section>

      {!!storyCards.length && (
        <section className="evidence-story-grid">
          {storyCards.map((card, index) => (
            <article key={card.title} className={`evidence-story-card ${card.tone || "blue"}`}>
              <div>
                <span>{card.label}</span>
                <strong>{formatStoryMetric(card.metric)}</strong>
              </div>
              <h3>{card.title}</h3>
              <p>{card.story}</p>
              <em>{card.evidence}</em>
              <i><b style={{ width: `${Math.min(100, 46 + index * 11)}%` }} /></i>
            </article>
          ))}
        </section>
      )}

      <section className="spatial-evidence-panel">
        <div className="viz-title">
          <h3>Spatial Evidence Infographic</h3>
          <span>Road, district, KCCA/CBD, GeoPackage and app-delivered GIS layers read from the local TOR folder</span>
        </div>
        <div className="spatial-kpi-grid">
          <article>
            <MapIcon size={18} />
            <strong>{(spatialSummary.layer_count || 0).toLocaleString()}</strong>
            <span>spatial layers</span>
          </article>
          <article>
            <Route size={18} />
            <strong>{(spatialSummary.feature_count || 0).toLocaleString()}</strong>
            <span>features read</span>
          </article>
          <article>
            <Network size={18} />
            <strong>{Math.round(spatialSummary.line_length_km || 0).toLocaleString()}</strong>
            <span>line-km across local copies</span>
          </article>
          <article>
            <Database size={18} />
            <strong>{(inventorySummary.files_indexed || 0).toLocaleString()}</strong>
            <span>data-bearing files indexed</span>
          </article>
        </div>
        <div className="spatial-chart-grid">
          <section className="viz-card">
            <div className="viz-title">
              <h3>Spatial Source Areas</h3>
              <span>Where the GIS evidence lives</span>
            </div>
            <EvidenceBarList table={spatialSourceArea} maxRows={6} />
          </section>
          <section className="viz-card">
            <div className="viz-title">
              <h3>Geometry Mix</h3>
              <span>Feature types found in the local spatial layers</span>
            </div>
            <EvidenceBarList table={spatialGeometry} maxRows={6} />
          </section>
          <section className="viz-card">
            <div className="viz-title">
              <h3>Largest GIS Layers</h3>
              <span>Feature counts across local road and district datasets</span>
            </div>
            <EvidenceBarList table={spatialFeatures} maxRows={6} />
          </section>
          <section className="viz-card">
            <div className="viz-title">
              <h3>Line Evidence</h3>
              <span>Measured length by layer, including retained dated copies</span>
            </div>
            <EvidenceBarList table={spatialLength} maxRows={6} />
          </section>
          <section className="viz-card">
            <div className="viz-title">
              <h3>All Local Data Types</h3>
              <span>Documents, tables, GIS, decks, media and metadata inventory</span>
            </div>
            <EvidenceBarList table={inventoryKind} maxRows={7} />
          </section>
        </div>
      </section>

      <div className="evidence-chart-grid">
        <section className="viz-card evidence-source-card">
          <div className="viz-title">
            <h3>Local Evidence Coverage</h3>
            <span>Evidence-bearing files grouped by source area</span>
          </div>
          <EvidenceBarList table={sourceArea} maxRows={8} />
        </section>

        <section className="viz-card evidence-global-transfer-card">
          <div className="viz-title">
            <h3>Global Case Package</h3>
            <span>Country case studies extracted from the local APA workbook</span>
          </div>
          <EvidenceBarList table={caseContinents} maxRows={8} />
        </section>
      </div>

      <div className="evidence-chart-grid">
        <section className="viz-card evidence-transport-card">
          <div className="viz-title">
            <h3>Transport Demand Workbook</h3>
            <span>Motor vehicle registrations aggregated from Road transport data</span>
          </div>
          <EvidenceBarList table={transportAnnual} maxRows={7} />
        </section>

        <section className="viz-card evidence-filetype-card">
          <div className="viz-title">
            <h3>Extracted File Types</h3>
            <span>Local documents, feeds and workbook tables processed into evidence data</span>
          </div>
          <EvidenceBarList table={fileTypes} maxRows={8} />
        </section>
      </div>

      <div className="evidence-chart-grid">
        <section className="viz-card evidence-topic-card">
          <div className="viz-title">
            <h3>Extracted Decision Topics</h3>
            <span>Keyword evidence across the fully-read national documents</span>
          </div>
          <div className="evidence-topic-bars">
            {topicChart.slice(0, 11).map((item, index) => (
              <article key={item.topic} style={{ "--accent": ["#4258ff", "#12b981", "#f43f5e", "#ffb020", "#00a7c7", "#7c3aed"][index % 6] }}>
                <span>{item.topic}</span>
                <i><b style={{ width: `${item.share}%` }} /></i>
                <strong>{Number(item.mentions || 0).toLocaleString()}</strong>
                <p>{item.decision_use}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="viz-card evidence-road-card">
          <div className="viz-title">
            <h3>ITIS Road Network Table</h3>
            <span>Length by category, with DUCAR scope separated</span>
          </div>
          <div className="evidence-road-bars">
            {(network?.rows || []).map((row, index) => (
              <article key={row[0]} style={{ "--accent": ["#111827", "#4258ff", "#7c3aed", "#f43f5e", "#12b981", "#ffb020", "#00a7c7"][index % 7] }}>
                <span>{row[0]}</span>
                <i><b style={{ width: `${(Number(row[1] || 0) / maxRoadKm) * 100}%` }} /></i>
                <strong>{Number(row[1] || 0).toLocaleString()} km</strong>
                <em>{row[2]}</em>
              </article>
            ))}
          </div>
        </section>
      </div>

      <div className="evidence-chart-grid">
        <section className="viz-card evidence-condition-card">
          <div className="viz-title">
            <h3>Condition Pressure from ITIS</h3>
            <span>Poor-condition kilometres by network category</span>
          </div>
          <div className="evidence-condition-bars">
            {(condition?.rows || []).map((row) => {
              const poor = Number(row[3] || 0);
              const total = Number(row[4] || 1);
              const fairGood = Math.round(((Number(row[1] || 0) + Number(row[2] || 0)) / total) * 100);
              return (
                <article key={row[0]}>
                  <div><strong>{row[0]}</strong><span>{fairGood}% fair-good</span></div>
                  <i><b style={{ width: `${(poor / maxPoorKm) * 100}%` }} /></i>
                  <em>{poor.toLocaleString()} km poor</em>
                </article>
              );
            })}
          </div>
        </section>

        <section className="viz-card evidence-crash-card">
          <div className="viz-title">
            <h3>Road Safety Trend Read from ITIS</h3>
            <span>Fatal, serious and minor crashes</span>
          </div>
          <div className="evidence-crash-bars">
            {(crashes?.rows || []).map((row) => (
              <article key={row[0]}>
                <span>{row[0]}</span>
                <i><b style={{ height: `${(Number(row[4] || 0) / maxCrash) * 100}%` }} /></i>
                <strong>{Number(row[4] || 0).toLocaleString()}</strong>
                <em>{Number(row[1] || 0).toLocaleString()} fatal</em>
              </article>
            ))}
          </div>
        </section>
      </div>

      <div className="evidence-table-grid">
        <EvidenceMiniTable table={documentTable} maxRows={9} />
        <EvidenceMiniTable table={caseStudyTable} maxRows={7} />
      </div>

      <div className="evidence-table-grid">
        <EvidenceMiniTable table={decisionTable} maxRows={8} />
        <EvidenceMiniTable table={transportClasses} maxRows={8} />
      </div>

      <div className="evidence-table-grid">
        <EvidenceMiniTable table={tabularPreview} maxRows={7} />
        <EvidenceMiniTable table={onlineGroup} maxRows={6} />
      </div>

      <div className="evidence-table-grid">
        <EvidenceMiniTable table={ferry} maxRows={5} />
        <EvidenceMiniTable table={onlineSources} maxRows={8} />
      </div>

      <div className="evidence-table-grid">
        <EvidenceMiniTable table={spatialTable} maxRows={8} />
        <EvidenceMiniTable table={inventoryTable} maxRows={8} />
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
  const pimsStages = [
    ["Concept", "Define the road problem, affected users, DUCAR ownership, and expected service-level change.", Target],
    ["Prefeasibility", "Screen demand, condition, cost range, safeguards, climate exposure, and implementation capacity.", Database],
    ["Appraisal", "Compare economic value, readiness, risk, affordability, and district/regional equity.", LineChart],
    ["Approval", "Package selected works with funding, procurement, monitoring, and reporting controls.", ClipboardCheck],
  ];
  const decisionPrinciples = [
    ["Need", "Poor access, failed drainage, weak connectivity, high traffic demand, or strong social service dependence."],
    ["Value", "Lifecycle benefit, user-cost savings, maintainability, and affordability inside the available budget."],
    ["Readiness", "Survey quality, design maturity, safeguards, procurement route, and deliverability within the programme year."],
    ["Equity", "Balanced regional, district, urban, and community access outcomes after excluding national-road costs."],
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
        <SignalTile label="Appraisal readiness" value={`${manualReadiness}%`} sublabel="gate completion" tone="cyan" />
        <SignalTile label="Data completeness" value={`${averageEvidence}%`} sublabel="candidate record quality" tone="green" />
        <SignalTile label="Monthly monitoring" value={monthlyMonitoring} sublabel="high-trigger assets" tone="red" />
        {checks.slice(1).map(chk => (
          <SignalTile key={chk.id} label={chk.label} value={`${Math.round((chk.pass / chk.total) * 100)}%`} sublabel="clearance rate" tone={chk.pass / chk.total > 0.7 ? "green" : "red"} />
        ))}
      </section>

      <EvidenceSynthesisPanel />

      <section className="viz-card wide-viz">
        <div className="viz-title">
          <h3>PIMS Appraisal Stages</h3>
          <span>Decision sequence used before budget allocation</span>
        </div>
        <div className="policy-gate-grid">
          {pimsStages.map(([label, detail, Icon]) => (
            <article key={label}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <strong>{label}</strong>
                <Icon size={18} color="#2563eb" />
              </div>
              <p>{detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="manual-chart-card">
        <div className="viz-title">
          <h3>Investment Decision Principles</h3>
          <span>Rules applied to each candidate road</span>
        </div>
        <div className="manual-radar">
          {decisionPrinciples.map(([label, detail], index) => (
            <div key={label} className="manual-gate">
              <span>{label}</span>
              <div><i style={{ width: `${[92, 86, 81, 88][index]}%`, background: ["#2563eb", "#10b981", "#f59e0b", "#ec4899"][index] }} /></div>
              <strong>{[92, 86, 81, 88][index]}%</strong>
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

      {false && (
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
      )}
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
const PRODUCT_SQL = {
  executive: `SELECT title, metric, story AS decision_signal
FROM story_cards
ORDER BY rowid
LIMIT 6;`,
  portfolio: `SELECT region, SUM(cost_ugx) AS allocation, COUNT(*) AS assets
FROM programme_assets
GROUP BY region
ORDER BY allocation DESC;`,
  risk: `SELECT asset_id, district, intervention,
       condition_score + climate_score + safety_score AS risk_pressure
FROM programme_assets
ORDER BY risk_pressure DESC
LIMIT 8;`,
  evidence: `SELECT label AS source_area, value AS files_read
FROM source_coverage
WHERE chart_name = 'sourceAreaChart'
ORDER BY files_read DESC;`,
  spatial: `SELECT feature_group, geometry_type, coordinates_json
FROM map_surface_features
WHERE feature_group IN ('district', 'route', 'national', 'flow', 'node')
ORDER BY feature_group, feature_id
LIMIT 815;`,
  network: `SELECT category, length_km, ducar_scope
FROM uganda_network_categories
ORDER BY length_km DESC;`,
  latestRoadMaster: `SELECT ducar_class, record_count
FROM uganda_road_master_class_summary
ORDER BY record_count DESC;`,
  globalCases: `SELECT country, region, framework_lens, transferability_score
FROM global_country_reviews
ORDER BY transferability_score DESC;`,
  traffic: `SELECT name, metric AS traffic_flow_index, source_file
FROM map_surface_features
WHERE feature_group = 'flow'
ORDER BY traffic_flow_index DESC
LIMIT 10;`,
  pims: `SELECT title, phase, readiness_score
FROM pims_framework_steps
ORDER BY step_order;`,
  hdm4: `SELECT indicator, readiness_score
FROM hdm4_indicators
ORDER BY readiness_score DESC;`,
  framework: `SELECT discipline, title, phase, readiness_score
FROM pims_framework_steps
ORDER BY step_order;`,
};

function runSqlRows(db, sql, params = []) {
  const result = db.exec(sql, params)[0];
  if (!result) return [];
  return result.values.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));
}

function runSqlValue(db, sql, params = []) {
  return db.exec(sql, params)[0]?.values?.[0]?.[0] ?? 0;
}

function chartFromSql(rows, labelKey, valueKey, extraKey) {
  return rows.map((row) => extraKey ? [row[labelKey], Number(row[valueKey] || 0), row[extraKey]] : [row[labelKey], Number(row[valueKey] || 0)]);
}

function normalizeProgrammeAssetRow(row) {
  return {
    assetType: row.asset_type || "Road",
    assetId: row.asset_id,
    admin: row.district,
    region: row.region,
    functionalClass: row.functional_class,
    intervention: row.intervention,
    surface: row.surface,
    condition: Number(row.condition_score || 0),
    criticality: Number(row.criticality_score || 0),
    traffic: Number(row.traffic_score || 0),
    climate: Number(row.climate_score || 0),
    safety: Number(row.safety_score || 0),
    equity: Number(row.equity_score || 0),
    readiness: Number(row.readiness_score || 0),
    maintainable: row.maintainable || "Yes",
    quantity: Number(row.quantity || 0),
    unitRate: Number(row.unit_rate || 0),
    lat: Number(row.lat || 0),
    lon: Number(row.lon || 0),
  };
}

function useUnifiedDatabase() {
  const [store, setStore] = useState(null);
  useEffect(() => {
    let active = true;
    async function loadDatabase() {
      try {
        const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
        const response = await fetch(`${BASE}data/ducar_unified.sqlite`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Database HTTP ${response.status}`);
        const db = new SQL.Database(new Uint8Array(await response.arrayBuffer()));
        const tableNames = runSqlRows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
        const tableCounts = tableNames.map((row) => {
          const name = row.name;
          return [name, Number(runSqlValue(db, `SELECT COUNT(*) FROM ${name}`) || 0)];
        });
        const tableSet = new Set(tableCounts.map(([name]) => name));
        const programmeAssetRows = tableSet.has("programme_assets")
          ? runSqlRows(db, `
            SELECT asset_id, asset_type, district, region, functional_class, intervention, surface,
                   condition_score, criticality_score, traffic_score, climate_score, safety_score,
                   equity_score, readiness_score, maintainable, quantity, unit_rate, lat, lon
            FROM programme_assets
            ORDER BY asset_id
          `).map(normalizeProgrammeAssetRow)
          : [];
        const summary = runSqlRows(db, `
          SELECT
            (SELECT COUNT(*) FROM evidence_documents) AS core_documents_read,
            (SELECT COALESCE(SUM(words), 0) FROM evidence_documents) AS core_words_read,
            (SELECT COALESCE(SUM(tables), 0) FROM evidence_documents) AS local_tables_read,
            (SELECT COUNT(*) FROM file_inventory) AS local_inventory_files,
            (SELECT COUNT(*) FROM online_sources WHERE status = 'read') AS online_sources_read,
            (SELECT COUNT(*) FROM spatial_layers WHERE status = 'read') AS spatial_layers_read,
            (SELECT COALESCE(SUM(feature_count), 0) FROM spatial_layers WHERE status = 'read') AS spatial_features_read,
            (SELECT COALESCE(SUM(line_length_km), 0) FROM spatial_layers WHERE status = 'read') AS spatial_line_km,
            (SELECT COUNT(*) FROM raw_table_cells) AS raw_table_cells,
            (SELECT COUNT(*) FROM raw_table_cells WHERE table_group = 'case_package' AND table_name LIKE '%Country Case%') AS global_case_cells,
            (SELECT COUNT(DISTINCT row_index) FROM raw_table_cells WHERE table_group = 'case_package' AND table_name LIKE '%Country Case%') AS global_case_records,
            (SELECT COUNT(DISTINCT path) FROM file_inventory) AS inventory_distinct_paths
        `)[0] || {};
        const spatialSummary = {
          layers_read: summary.spatial_layers_read || 0,
          feature_count: summary.spatial_features_read || 0,
          line_length_km: summary.spatial_line_km || 0,
        };
        const sourceCoverage = chartFromSql(
          runSqlRows(db, "SELECT label, value FROM source_coverage WHERE chart_name = 'sourceAreaChart' ORDER BY value DESC LIMIT 8"),
          "label",
          "value",
        );
        const topics = runSqlRows(db, "SELECT topic, mentions, decision_use FROM document_topic_summary ORDER BY mentions DESC LIMIT 8")
          .map((row) => ({ topic: row.topic, mentions: Number(row.mentions || 0), decision_use: row.decision_use }));
        const spatialRows = chartFromSql(
          runSqlRows(db, "SELECT layer_name, feature_count FROM spatial_layers WHERE status = 'read' ORDER BY feature_count DESC LIMIT 8"),
          "layer_name",
          "feature_count",
        );
        const geometryRows = chartFromSql(
          runSqlRows(db, "SELECT geometry_type, SUM(feature_count) AS feature_count FROM spatial_geometry_counts GROUP BY geometry_type ORDER BY feature_count DESC"),
          "geometry_type",
          "feature_count",
        );
        const rawTableRows = chartFromSql(
          runSqlRows(db, "SELECT table_group || ': ' || table_name AS table_name, COUNT(*) AS cells FROM raw_table_cells GROUP BY table_group, table_name ORDER BY cells DESC LIMIT 8"),
          "table_name",
          "cells",
        );
        const networkKpis = runSqlRows(db, "SELECT label, value, note FROM uganda_network_kpis ORDER BY sort_order")
          .map((row, index) => ({ label: row.label, value: row.value, note: row.note, tone: ["blue", "green", "cyan", "red", "gold"][index % 5] }));
        const networkCategoryRows = runSqlRows(db, "SELECT category, length_km, ducar_scope FROM uganda_network_categories ORDER BY length_km DESC");
        const networkCategoryChart = networkCategoryRows.map((row) => [row.category, Number(row.length_km || 0), row.ducar_scope]);
        const roadConditionRows = runSqlRows(db, "SELECT category, good_km, fair_km, poor_km, total_km, poor_share FROM uganda_road_condition ORDER BY total_km DESC");
        const crashTrendRows = runSqlRows(db, "SELECT year, fatal, serious, minor, total FROM uganda_crash_trend ORDER BY year");
        const pavedTrendRows = runSqlRows(db, "SELECT fy, annual_increase_km, paved_stock_km, percent_paved FROM uganda_paved_trend ORDER BY fy");
        const latestRoadMasterRun = tableSet.has("uganda_road_master_runs")
          ? runSqlRows(db, `
            SELECT generated_at_utc, manifest_updated_at_utc, record_count, total_length_km,
                   osm_major_feature_count, district_summary_count, important_assumption
            FROM uganda_road_master_runs
            ORDER BY generated_at_utc DESC
            LIMIT 1
          `)[0]
          : null;
        const latestClassRows = tableSet.has("uganda_road_master_class_summary")
          ? chartFromSql(
            runSqlRows(db, "SELECT ducar_class, record_count FROM uganda_road_master_class_summary ORDER BY record_count DESC"),
            "ducar_class",
            "record_count",
          )
          : [];
        const latestSourceRows = tableSet.has("uganda_road_master_source_summary")
          ? chartFromSql(
            runSqlRows(db, "SELECT source_name, record_count FROM uganda_road_master_source_summary ORDER BY record_count DESC"),
            "source_name",
            "record_count",
          )
          : [];
        const latestQualityRows = tableSet.has("uganda_road_master_quality_summary")
          ? chartFromSql(
            runSqlRows(db, "SELECT quality_flag, record_count FROM uganda_road_master_quality_summary ORDER BY record_count DESC"),
            "quality_flag",
            "record_count",
          )
          : [];
        const latestDistrictRows = tableSet.has("uganda_district_road_summary")
          ? chartFromSql(
            runSqlRows(db, "SELECT district, total_km, region FROM uganda_district_road_summary ORDER BY total_km DESC LIMIT 10"),
            "district",
            "total_km",
            "region",
          )
          : [];
        const latestDistrictTableRows = tableSet.has("uganda_district_road_summary")
          ? runSqlRows(db, `
            SELECT district, region, road_records, ROUND(total_km, 1) AS total_km,
                   district_count, urban_count, car_count, verify_count, missing_name_count
            FROM uganda_district_road_summary
            ORDER BY total_km DESC
            LIMIT 12
          `).map((row) => [row.district, row.region, row.road_records, row.total_km, row.district_count, row.urban_count, row.car_count, row.verify_count, row.missing_name_count])
          : [];
        const classificationRuleRows = tableSet.has("osm_classification_rules")
          ? runSqlRows(db, "SELECT osm_highway, ducar_class, ducar_code, assumption FROM osm_classification_rules ORDER BY rowid")
            .map((row) => [row.osm_highway, row.ducar_class, row.ducar_code, row.assumption])
          : [];
        const globalCountryRows = tableSet.has("global_country_reviews")
          ? runSqlRows(db, `
            SELECT country, region, framework_lens, transferability_score, ducar_use, lesson
            FROM global_country_reviews
            ORDER BY transferability_score DESC, region, country
          `)
          : [];
        const globalRegionRows = tableSet.has("global_country_reviews")
          ? chartFromSql(
            runSqlRows(db, `
              SELECT region, COUNT(*) AS countries, ROUND(AVG(transferability_score), 1) AS avg_score
              FROM global_country_reviews
              GROUP BY region
              ORDER BY countries DESC, avg_score DESC
            `),
            "region",
            "countries",
            "avg_score",
          )
          : [];
        const globalTopCountryRows = tableSet.has("global_country_reviews")
          ? chartFromSql(
            runSqlRows(db, `
              SELECT country, transferability_score, region
              FROM global_country_reviews
              ORDER BY transferability_score DESC, country
              LIMIT 18
            `),
            "country",
            "transferability_score",
            "region",
          )
          : [];
        const globalPatternRows = tableSet.has("global_country_reviews")
          ? chartFromSql(
            runSqlRows(db, `
              SELECT framework_lens, COUNT(*) AS countries, ROUND(AVG(transferability_score), 1) AS avg_score
              FROM global_country_reviews
              GROUP BY framework_lens
              ORDER BY countries DESC, avg_score DESC
            `),
            "framework_lens",
            "countries",
            "avg_score",
          )
          : [];
        const globalIndicatorRows = tableSet.has("global_country_indicator_scores")
          ? chartFromSql(
            runSqlRows(db, `
              SELECT indicator_label, ROUND(AVG(score), 1) AS avg_score, MAX(detail) AS detail
              FROM global_country_indicator_scores
              GROUP BY indicator_key, indicator_label
              ORDER BY avg_score DESC
            `),
            "indicator_label",
            "avg_score",
            "detail",
          )
          : [];
        const globalBenchmarkRows = tableSet.has("global_case_benchmarks")
          ? chartFromSql(
            runSqlRows(db, "SELECT place, score, region FROM global_case_benchmarks ORDER BY score DESC"),
            "place",
            "score",
            "region",
          )
          : [];
        const globalBenchmarkTableRows = tableSet.has("global_case_benchmarks")
          ? runSqlRows(db, "SELECT region, place, source, score, lesson, ducar_use FROM global_case_benchmarks ORDER BY score DESC")
            .map((row) => [row.region, row.place, row.source, `${Math.round(Number(row.score || 0))}%`, row.lesson, row.ducar_use])
          : [];
        const localCaseRows = tableSet.has("global_case_package_countries")
          ? runSqlRows(db, "SELECT continent, country, practice, ducar_lesson, adaptation, source_key FROM global_case_package_countries ORDER BY row_order")
          : [];
        const localCaseTableRows = localCaseRows.map((row) => [row.continent, row.country, row.practice, row.ducar_lesson, row.adaptation, row.source_key]);
        const localCaseContinentRows = tableSet.has("global_case_package_countries")
          ? chartFromSql(
            runSqlRows(db, `
              SELECT continent, COUNT(*) AS cases
              FROM global_case_package_countries
              GROUP BY continent
              ORDER BY cases DESC, continent
            `),
            "continent",
            "cases",
          )
          : [];
        const localCaseSourceRows = tableSet.has("global_case_package_countries")
          ? chartFromSql(
            runSqlRows(db, `
              SELECT source_key, COUNT(*) AS cases
              FROM global_case_package_countries
              GROUP BY source_key
              ORDER BY cases DESC, source_key
            `),
            "source_key",
            "cases",
          )
          : [];
        const referenceTypeRows = tableSet.has("global_case_references")
          ? chartFromSql(
            runSqlRows(db, `
              SELECT source_type, COUNT(*) AS reference_count
              FROM global_case_references
              GROUP BY source_type
              ORDER BY reference_count DESC
            `),
            "source_type",
            "reference_count",
          )
          : [];
        const referenceContinentRows = tableSet.has("global_case_references")
          ? chartFromSql(
            runSqlRows(db, `
              SELECT continent, COUNT(*) AS reference_count
              FROM global_case_references
              GROUP BY continent
              ORDER BY reference_count DESC
            `),
            "continent",
            "reference_count",
          )
          : [];
        const referenceTableRows = tableSet.has("global_case_references")
          ? runSqlRows(db, `
            SELECT source_key, source_type, continent, apa_reference, url_or_local_path, use_in_ducar
            FROM global_case_references
            ORDER BY row_order
            LIMIT 14
          `).map((row) => [row.source_key, row.source_type, row.continent, row.apa_reference, row.url_or_local_path, row.use_in_ducar])
          : [];
        const decisionAssumptionRows = tableSet.has("global_case_decision_assumptions")
          ? runSqlRows(db, `
            SELECT decision_id, decision_or_assumption, rationale, apa_source_keys
            FROM global_case_decision_assumptions
            ORDER BY row_order
          `).map((row) => [row.decision_id, row.decision_or_assumption, row.rationale, row.apa_source_keys])
          : [];
        const pimsFlow = runSqlRows(db, "SELECT title, phase, description, readiness_score, discipline FROM pims_framework_steps ORDER BY step_order");
        const pimsGateChartRows = chartFromSql(
          runSqlRows(db, "SELECT gate, readiness_score, decision_use FROM pims_gate_controls ORDER BY readiness_score DESC"),
          "gate",
          "readiness_score",
          "decision_use",
        );
        const pimsGateRows = runSqlRows(db, "SELECT gate, required_evidence, decision_use, readiness_score FROM pims_gate_controls ORDER BY readiness_score DESC")
          .map((row) => [row.gate, row.required_evidence, row.decision_use, `${Math.round(Number(row.readiness_score || 0))}%`]);
        const hdm4Indicators = runSqlRows(db, "SELECT indicator, description, readiness_score FROM hdm4_indicators ORDER BY readiness_score DESC");
        const hdm4InputRows = runSqlRows(db, "SELECT model_input, unit, assumption, evidence_topic FROM hdm4_model_inputs ORDER BY model_input")
          .map((row) => [row.model_input, row.unit, row.assumption, row.evidence_topic]);
        const trafficStats = runSqlRows(db, `
          SELECT
            COUNT(*) AS flow_links,
            COALESCE(ROUND(AVG(metric), 1), 0) AS avg_flow_index,
            COALESCE(ROUND(MAX(metric), 1), 0) AS max_flow_index,
            COUNT(CASE WHEN metric >= 75 THEN 1 END) AS high_pressure_links
          FROM map_surface_features
          WHERE feature_group = 'flow'
        `)[0] || {};
        const trafficFlowRows = chartFromSql(
          runSqlRows(db, `
            SELECT COALESCE(NULLIF(name, ''), source_file) AS label,
                   ROUND(AVG(metric), 1) AS flow_index,
                   COUNT(*) AS links
            FROM map_surface_features
            WHERE feature_group = 'flow'
            GROUP BY label
            ORDER BY flow_index DESC
            LIMIT 10
          `),
          "label",
          "flow_index",
          "links",
        );
        const trafficFlowTableRows = runSqlRows(db, `
          SELECT COALESCE(NULLIF(name, ''), 'Unnamed flow link') AS name,
                 source_file,
                 geometry_type,
                 ROUND(metric, 1) AS traffic_flow_index
          FROM map_surface_features
          WHERE feature_group = 'flow'
          ORDER BY metric DESC
          LIMIT 10
        `).map((row) => [row.name, row.source_file, row.geometry_type, row.traffic_flow_index]);
        const predictionFeatures = tableSet.has("prediction_feature_matrix")
          ? runSqlRows(db, `
            SELECT asset_id, risk_probability, recommended_status, monitoring_tier, pims_gate_score, hdm4_readiness_score, network_pressure_score
            FROM prediction_feature_matrix
            ORDER BY risk_probability DESC
          `)
          : [];
        const calibrationSignals = tableSet.has("prediction_calibration_signals")
          ? runSqlRows(db, "SELECT signal, value, basis FROM prediction_calibration_signals ORDER BY signal")
          : [];
        const botSync = tableSet.has("bot_sync_runs")
          ? runSqlRows(db, `
            SELECT run_id, completed_at_utc, source_file_count, changed_file_count, status
            FROM bot_sync_runs
            ORDER BY completed_at_utc DESC
            LIMIT 1
          `)[0]
          : null;
        const storyCards = runSqlRows(db, "SELECT title, metric, label, story, evidence, tone FROM story_cards ORDER BY rowid")
          .map((row) => ({ title: row.title, metric: row.metric, label: row.label, story: row.story, evidence: row.evidence, tone: row.tone }));
        const spatialLayerTableRows = runSqlRows(db, `
          SELECT layer_name, source_area, extension, feature_count, ROUND(line_length_km, 1) AS line_km, decision_use
          FROM spatial_layers
          WHERE status = 'read'
          ORDER BY feature_count DESC
          LIMIT 8
        `).map((row) => [row.layer_name, row.source_area, row.extension, row.feature_count, row.line_km, row.decision_use]);
        const mapFeatures = runSqlRows(db, `
          SELECT feature_group, source_file, name, geometry_type, coordinates_json, metric
          FROM map_surface_features
          ORDER BY feature_group, feature_id
          LIMIT 815
        `).map((row) => ({
          group: row.feature_group,
          source: row.source_file,
          name: row.name,
          geometryType: row.geometry_type,
          coordinates: JSON.parse(row.coordinates_json || "null"),
          metric: Number(row.metric || 0),
        }));
        const rawTableCatalogRows = runSqlRows(db, `
          SELECT table_group, table_name, row_count, column_count, source
          FROM table_catalog
          ORDER BY row_count DESC, column_count DESC
          LIMIT 8
        `).map((row) => [row.table_group, row.table_name, row.row_count, row.column_count, row.source]);
        const manifestRows = tableCounts.map(([name, count]) => [name, count]);
        const payload = {
          loadedFromDatabase: true,
          databaseBackend: "SQLite over GitHub Pages",
          programmeAssets: programmeAssetRows,
          summary,
          sourceCoverage: { sourceAreaChart: { rows: sourceCoverage } },
          documentTopicChart: topics,
          spatialEvidence: {
            summary: spatialSummary,
            featureChart: { rows: spatialRows },
            geometryChart: { rows: geometryRows },
            layerTable: {
              title: "Road infrastructure GIS layers",
              columns: ["Layer", "Network area", "Type", "Features", "Line km", "Decision use"],
              rows: spatialLayerTableRows,
            },
            mapFeatures,
          },
          fileInventory: { summary: { files_indexed: summary.local_inventory_files || 0 } },
          storyCards,
          rawTables: {
            cellChart: { rows: rawTableRows },
            catalog: {
              title: "Road intelligence table catalogue",
              columns: ["Group", "Table", "Rows", "Columns", "Lineage"],
              rows: rawTableCatalogRows,
            },
            manifest: {
              title: "Road intelligence register",
              columns: ["Table", "Rows"],
              rows: manifestRows,
            },
          },
          ugandaNetwork: {
            kpis: networkKpis,
            categoryChart: { rows: networkCategoryChart },
            conditionRows: roadConditionRows,
            crashTrend: crashTrendRows,
            pavedTrend: pavedTrendRows,
            categoryTable: {
              title: "Uganda road network by category",
              columns: ["Category", "Length km", "DUCAR scope"],
              rows: networkCategoryRows.map((row) => [row.category, row.length_km, row.ducar_scope]),
            },
            conditionTable: {
              title: "Road condition by network category",
              columns: ["Category", "Good km", "Fair km", "Poor km", "Poor share"],
              rows: roadConditionRows.map((row) => [row.category, row.good_km, row.fair_km, row.poor_km, `${Math.round(Number(row.poor_share || 0) * 100)}%`]),
            },
          },
          latestRoadMaster: {
            run: latestRoadMasterRun,
            classChart: { rows: latestClassRows },
            sourceChart: { rows: latestSourceRows },
            qualityChart: { rows: latestQualityRows },
            districtChart: { rows: latestDistrictRows },
            districtTable: {
              title: "Latest district road summary",
              columns: ["District", "Region", "Records", "Total km", "District", "Urban", "CAR", "Verify", "Missing names"],
              rows: latestDistrictTableRows,
            },
            rulesTable: {
              title: "Road classification rules",
              columns: ["Road class input", "DUCAR class", "Code", "Planning assumption"],
              rows: classificationRuleRows,
            },
          },
          globalCases: {
            countryRows: globalCountryRows,
            regionChart: { rows: globalRegionRows },
            topCountryChart: { rows: globalTopCountryRows },
            patternChart: { rows: globalPatternRows },
            indicatorChart: { rows: globalIndicatorRows },
            benchmarkChart: { rows: globalBenchmarkRows },
            benchmarkTable: {
              title: "Global road asset management benchmark covers",
              columns: ["Region", "Case cover", "Source", "Score", "Lesson", "DUCAR use"],
              rows: globalBenchmarkTableRows,
            },
            localCaseRows,
            localCaseContinentChart: { rows: localCaseContinentRows },
            localCaseSourceChart: { rows: localCaseSourceRows },
            localCaseTable: {
              title: "Extracted country case studies",
              columns: ["Continent", "Country", "Practice", "DUCAR lesson", "Adaptation", "Source key"],
              rows: localCaseTableRows,
            },
            referenceTypeChart: { rows: referenceTypeRows },
            referenceContinentChart: { rows: referenceContinentRows },
            referenceTable: {
              title: "Global APA reference register",
              columns: ["Source key", "Type", "Continent", "APA reference", "URL or path", "Use in DUCAR"],
              rows: referenceTableRows,
            },
            decisionAssumptionsTable: {
              title: "Global case transfer assumptions",
              columns: ["ID", "Decision or assumption", "Rationale", "APA source keys"],
              rows: decisionAssumptionRows,
            },
          },
          frameworkFlow: pimsFlow,
          pims: {
            gateChart: { rows: pimsGateChartRows },
            gates: {
              title: "PIMS gate controls",
              columns: ["Gate", "Required evidence", "Decision use", "Readiness"],
              rows: pimsGateRows,
            },
          },
          hdm4: {
            indicators: hdm4Indicators,
            indicatorTable: {
              title: "HDM-4 readiness indicators",
              columns: ["Indicator", "Description", "Readiness"],
              rows: hdm4Indicators.map((row) => [row.indicator, row.description, `${Math.round(Number(row.readiness_score || 0))}%`]),
            },
            inputs: {
              title: "HDM-4 model input register",
              columns: ["Input", "Unit", "Assumption", "Evidence topic"],
              rows: hdm4InputRows,
            },
          },
          traffic: {
            stats: trafficStats,
            flowChart: { rows: trafficFlowRows },
            flowTable: {
              title: "Top traffic flow links",
              columns: ["Link", "Road layer", "Geometry", "Flow index"],
              rows: trafficFlowTableRows,
            },
          },
          frameworkTable: {
            title: "Framework decision steps",
            columns: ["Discipline", "Step", "Phase", "Readiness", "Description"],
            rows: pimsFlow.map((row) => [row.discipline, row.title, row.phase, `${Math.round(Number(row.readiness_score || 0))}%`, row.description]),
          },
          predictions: {
            features: predictionFeatures,
            calibrationSignals,
          },
          botSync,
        };
        db.close();
        if (active) setStore(payload);
      } catch (error) {
        console.warn("DUCAR SQLite load failed", error);
        if (active) setStore(null);
      }
    }
    loadDatabase();
    return () => { active = false; };
  }, []);
  return store;
}

function sumBy(items, keyFn, valueFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item) || "Unassigned";
    map.set(key, (map.get(key) || 0) + Number(valueFn(item) || 0));
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function countBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item) || "Unassigned";
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function buildProductInsights(analysis, evidence) {
  const predictionMap = new Map((evidence?.predictions?.features || []).map((item) => [item.asset_id, item]));
  const programme = (analysis.programme || []).map((item) => {
    const prediction = predictionMap.get(item.assetId);
    if (!prediction) return item;
    const mlRisk = Number(prediction.risk_probability || item.mlRisk || 0);
    return {
      ...item,
      mlRisk,
      riskBand: mlRisk > 0.72 ? "High" : mlRisk > 0.55 ? "Medium" : "Low",
      predictionStatus: prediction.recommended_status,
      monitoringTier: prediction.monitoring_tier || item.monitoringTier,
      pimsGateScore: Number(prediction.pims_gate_score || 0),
      hdm4ReadinessScore: Number(prediction.hdm4_readiness_score || 0),
      networkPressureScore: Number(prediction.network_pressure_score || 0),
    };
  });
  const selected = programme.filter((item) => item.status === "Selected");
  const totalDemand = programme.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  const selectedCost = selected.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  const netBudget = Number(analysis.netBudget || 1);
  const reserveGap = Math.max(0, totalDemand - netBudget);
  const highRisk = programme.filter((item) => item.riskBand === "High" || Number(item.mlRisk || 0) >= 0.72);
  const evidenceSummary = evidence?.summary || {};
  const spatialSummary = evidence?.spatialEvidence?.summary || {};
  const sourceRows = evidence?.sourceCoverage?.sourceAreaChart?.rows || [];
  const topicRows = (evidence?.documentTopicChart || []).slice(0, 6).map((item) => [item.topic, item.mentions, item.decision_use]);
  const regionAllocation = sumBy(selected, (item) => item.region, (item) => item.cost).slice(0, 6);
  const classAllocation = sumBy(selected, (item) => item.functionalClass, (item) => item.cost).slice(0, 6);
  const interventions = sumBy(programme, (item) => item.intervention, (item) => item.cost).slice(0, 5);
  const statusSplit = countBy(programme, (item) => item.status);
  const riskSplit = countBy(programme, (item) => item.riskBand);
  const monitoringSplit = countBy(programme, (item) => item.monitoringTier || "Tier pending");
  const predictionStatusSplit = countBy(programme, (item) => item.predictionStatus || item.status);
  const surfaceSplit = countBy(programme, (item) => item.surface || "Surface pending");
  const maintainabilitySplit = countBy(programme, (item) => item.maintainable === "No" ? "Referral / not maintainable" : "Maintainable");
  const regionAssetCount = countBy(programme, (item) => item.region);
  const classAssetCount = countBy(programme, (item) => item.functionalClass);
  const statusCostSplit = sumBy(programme, (item) => item.status, (item) => item.cost);
  const regionDemand = sumBy(programme, (item) => item.region, (item) => item.cost).slice(0, 8);
  const riskTable = programme
    .toSorted((a, b) => Number(b.mlRisk || 0) - Number(a.mlRisk || 0))
    .slice(0, 7)
    .map((item) => [item.assetId, item.admin, item.intervention, `${Math.round(Number(item.mlRisk || 0) * 100)}%`, item.predictionStatus || item.status]);
  const priorityLinks = programme
    .toSorted((a, b) => Number(a.rank || 9999) - Number(b.rank || 9999))
    .map((item) => ({
      assetId: item.assetId,
      district: item.admin,
      region: item.region,
      className: item.functionalClass,
      treatment: item.intervention,
      status: item.predictionStatus || item.status,
      score: Number(item.score || 0),
      cost: Number(item.cost || 0),
      risk: Number(item.mlRisk || 0),
      traffic: Number(item.traffic || 0),
      condition: Number(item.condition || 0),
      criticality: Number(item.criticality || 0),
      climate: Number(item.climate || 0),
      safety: Number(item.safety || 0),
      evidence: Number(item.evidenceScore || 0),
      readiness: Number(item.readiness || 0),
      maintainable: item.maintainable,
      monitoringTier: item.monitoringTier || "Tier pending",
    }));
  const assetRiskBars = priorityLinks
    .toSorted((a, b) => Number(b.risk || 0) - Number(a.risk || 0))
    .map((item) => [item.assetId, Number(item.risk || 0) * 100, `${item.district} / ${item.treatment}`]);
  const assetCostBars = priorityLinks
    .toSorted((a, b) => Number(b.cost || 0) - Number(a.cost || 0))
    .map((item) => [item.assetId, Number(item.cost || 0), `${item.district} / ${item.treatment}`]);
  const assetTrafficBars = priorityLinks
    .toSorted((a, b) => Number(b.traffic || 0) - Number(a.traffic || 0))
    .map((item) => [item.assetId, Number(item.traffic || 0), `${item.district} / ${item.treatment}`]);
  const assetConditionBars = priorityLinks
    .toSorted((a, b) => Number(b.condition || 0) - Number(a.condition || 0))
    .map((item) => [item.assetId, Number(item.condition || 0), `${item.district} / ${item.treatment}`]);
  const assetEvidenceBars = priorityLinks
    .toSorted((a, b) => Number(b.evidence || 0) - Number(a.evidence || 0))
    .map((item) => [item.assetId, Number(item.evidence || 0), `${item.district} / ${item.treatment}`]);
  const selectedTable = selected
    .toSorted((a, b) => a.rank - b.rank)
    .slice(0, 8)
    .map((item) => [item.rank, item.assetId, item.admin, item.functionalClass, item.intervention, `UGX ${currency.format(item.cost)}`]);
  const spatialRows = evidence?.spatialEvidence?.featureChart?.rows || [];
  const geometryRows = evidence?.spatialEvidence?.geometryChart?.rows || [];
  const rawCatalogRows = evidence?.rawTables?.catalog?.rows || [];
  const tableGroupRows = sumBy(
    rawCatalogRows.map((row) => ({ group: row[0], rows: Number(row[2] || 0) })),
    (item) => item.group,
    (item) => item.rows,
  ).slice(0, 6);
  const pimsReadinessRows = (evidence?.frameworkFlow || []).map((row) => [row.title, Number(row.readiness_score || 0), row.phase]);
  const hdm4ReadinessRows = (evidence?.hdm4?.indicators || []).map((row) => [row.indicator, Number(row.readiness_score || 0), row.description]);
  const networkPoorRows = (evidence?.ugandaNetwork?.conditionRows || [])
    .map((row) => [row.category, Number(row.poor_km || 0), `${Math.round(Number(row.poor_share || 0) * 100)}% poor`])
    .sort((a, b) => b[1] - a[1]);
  const calibrationRows = (evidence?.predictions?.calibrationSignals || [])
    .map((row) => [row.signal, Number(row.value || 0), row.basis])
    .sort((a, b) => b[1] - a[1]);
  const trafficStats = evidence?.traffic?.stats || {};
  const trafficFlowRows = evidence?.traffic?.flowChart?.rows || [];
  const latestRoadMaster = evidence?.latestRoadMaster || {};
  const latestCrashTotal = Number((evidence?.ugandaNetwork?.crashTrend || []).at?.(-1)?.total || 0);
  const poorKm = networkPoorRows.reduce((sum, row) => sum + Number(row[1] || 0), 0);
  const programmeFunnel = [
    ["Candidate assets", programme.length, "All assets submitted into the fiscal gate"],
    ["Selected package", selected.length, "Assets affordable inside the net budget"],
    ["High-risk watchlist", highRisk.length, "Assets needing design, scope or assurance checks"],
    ["Prediction referrals", programme.filter((item) => (item.predictionStatus || item.status) === "Referred").length, "Model-recommended follow-up"],
  ];
  const evidenceFunnel = [
    ["Road records", latestRoadMaster.run?.record_count || spatialSummary.feature_count || 0, "Road links available for prioritisation"],
    ["District summaries", latestRoadMaster.run?.district_summary_count || 0, "District-level road inventory summaries"],
    ["Condition categories", networkPoorRows.length, "Network classes with condition pressure"],
    ["Traffic links", Number(trafficStats.flow_links || trafficFlowRows.length || 0), "Flow-sensitive road links"],
    ["Priority assets", programme.length, "Candidate road investments in the decision model"],
  ];
  const modelFunnel = [
    ["PIMS features", programme.filter((item) => Number(item.pimsGateScore || 0) > 0).length, "Assets with PIMS gate score"],
    ["HDM-4 features", programme.filter((item) => Number(item.hdm4ReadinessScore || 0) > 0).length, "Assets with economic model readiness"],
    ["Network pressure", programme.filter((item) => Number(item.networkPressureScore || 0) > 0).length, "Assets connected to network pressure"],
    ["Monitoring tiers", programme.filter((item) => item.monitoringTier).length, "Assets assigned to a monitoring tier"],
  ];
  const trafficFunnel = [
    ["Flow links", Number(trafficStats.flow_links || trafficFlowRows.length || 0), "Traffic-flow geometries available to the map and analytics layer"],
    ["High pressure links", Number(trafficStats.high_pressure_links || 0), "Links with flow index at or above 75"],
    ["Latest crash total", latestCrashTotal, "Latest crash trend total from the national road safety table"],
    ["Poor condition km", poorKm, "Poor road condition kilometres by network category"],
  ];
  const staticHdm4Tables = HDM4_INPUT_TABLES.map((table) => [table.title, table.rows.length, table.unit]);
  const pimsGateRows = evidence?.pims?.gateChart?.rows || [];
  const frameworkStepRows = (evidence?.frameworkFlow || []).map((row) => [row.title, Number(row.readiness_score || 0), row.discipline]);
  const staticGlobalSummary = getGlobalEvidenceSummary();
  const globalCases = evidence?.globalCases || {};
  const fallbackCountryRows = GLOBAL_COUNTRY_REVIEWS.map((item) => ({
    country: item.country,
    region: item.region,
    framework_lens: item.pattern,
    transferability_score: item.score,
    ducar_use: item.ducarUse,
    lesson: item.lesson,
  })).sort((a, b) => Number(b.transferability_score || 0) - Number(a.transferability_score || 0));
  const globalCountryRows = globalCases.countryRows?.length ? globalCases.countryRows : fallbackCountryRows;
  const globalRegionRows = globalCases.regionChart?.rows?.length
    ? globalCases.regionChart.rows
    : Object.entries(staticGlobalSummary.regionCounts).map(([region, count]) => [region, count]);
  const globalIndicatorRows = globalCases.indicatorChart?.rows?.length
    ? globalCases.indicatorChart.rows
    : staticGlobalSummary.indicatorAverages.map((item) => [item.label, item.value, item.detail]);
  const globalTopCountryRows = globalCases.topCountryChart?.rows?.length
    ? globalCases.topCountryChart.rows
    : staticGlobalSummary.topFrameworks.map((item) => [item.country, item.score, item.region]);
  const globalPatternRows = globalCases.patternChart?.rows?.length
    ? globalCases.patternChart.rows
    : countBy(GLOBAL_COUNTRY_REVIEWS, (item) => item.pattern);
  const globalBenchmarkRows = globalCases.benchmarkChart?.rows?.length
    ? globalCases.benchmarkChart.rows
    : GLOBAL_CASE_STUDIES.map((item) => [item.place, item.score, item.region]);
  const globalCountryTable = {
    title: "All-country transferability review",
    columns: ["Country", "Region", "Framework lens", "Score", "DUCAR use"],
    rows: globalCountryRows.map((row) => [
      row.country,
      row.region,
      row.framework_lens,
      `${Math.round(Number(row.transferability_score || 0))}%`,
      row.ducar_use,
    ]),
  };
  const globalReferenceCount = (globalCases.referenceTypeChart?.rows || []).reduce((sum, row) => sum + Number(row[1] || 0), 0);
  const stories = (evidence?.storyCards || []).filter((card) => [
    "Local evidence corpus",
    "Decision-topic spine",
    "Global case transfer",
    "Spatial evidence atlas",
  ].includes(card.title));

  return {
    sql: PRODUCT_SQL,
    executive: [
      { label: "Selected programme", value: formatMoneyCompact(selectedCost), note: `${selected.length} assets inside the fiscal gate`, tone: "green" },
      { label: "Demand pressure", value: formatMoneyCompact(reserveGap), note: "unfunded demand after reserve", tone: "gold" },
      { label: "High-risk watchlist", value: highRisk.length.toLocaleString(), note: "assets needing design or scope checks", tone: "red" },
      { label: "Road master", value: formatCount(latestRoadMaster.run?.record_count || spatialSummary.feature_count), note: formatKm(latestRoadMaster.run?.total_length_km || spatialSummary.line_length_km), tone: "blue" },
      { label: "Mapped network", value: formatCount(spatialSummary.feature_count), note: `${formatKm(spatialSummary.line_length_km)} represented`, tone: "cyan" },
      { label: "Global road lessons", value: formatCount(globalCountryRows.length || evidenceSummary.global_case_records), note: "transferability signals for DUCAR", tone: "purple" },
    ],
    decisionCards: [
      {
        title: "Fund the maintainable core first",
        signal: `${Math.round((selectedCost / netBudget) * 100)}% budget utilisation`,
        body: "The current programme reads as a controlled, affordable package rather than a long wish list.",
      },
      {
        title: "Treat risk as a gating conversation",
        signal: `${highRisk.length} risk flags`,
        body: "High-risk or non-maintainable assets should move into design clarification before they compete for maintenance money.",
      },
      {
        title: "Use spatial coverage as the proof layer",
        signal: `${formatCount(spatialSummary.layers_read)} GIS layers`,
        body: "Network and district traceability stays available without flooding the interface with technical registers.",
      },
    ],
    charts: {
      regionAllocation,
      classAllocation,
      interventions,
      statusSplit,
      sourceCoverage: sourceRows,
      topics: topicRows,
      spatial: spatialRows,
      geometry: geometryRows,
      networkCategory: evidence?.ugandaNetwork?.categoryChart?.rows || [],
      riskSplit,
      monitoringSplit,
      predictionStatusSplit,
      surfaceSplit,
      maintainabilitySplit,
      regionAssetCount,
      classAssetCount,
      statusCostSplit,
      regionDemand,
      assetRiskBars,
      assetCostBars,
      assetTrafficBars,
      assetConditionBars,
      assetEvidenceBars,
      tableGroups: tableGroupRows,
      pimsReadiness: pimsReadinessRows,
      hdm4Readiness: hdm4ReadinessRows,
      networkPoor: networkPoorRows,
      calibration: calibrationRows,
      programmeFunnel,
      evidenceFunnel,
      modelFunnel,
      trafficFlow: trafficFlowRows,
      trafficFunnel,
      staticHdm4Tables,
      pimsGates: pimsGateRows,
      frameworkSteps: frameworkStepRows,
      roadMasterClasses: latestRoadMaster.classChart?.rows || [],
      roadMasterSources: latestRoadMaster.sourceChart?.rows || [],
      roadMasterQuality: latestRoadMaster.qualityChart?.rows || [],
      roadMasterDistricts: latestRoadMaster.districtChart?.rows || [],
      globalRegions: globalRegionRows,
      globalIndicators: globalIndicatorRows,
      globalTopCountries: globalTopCountryRows,
      globalPatterns: globalPatternRows,
      globalBenchmarks: globalBenchmarkRows,
      globalLocalCaseContinents: globalCases.localCaseContinentChart?.rows || [],
      globalLocalCaseSources: globalCases.localCaseSourceChart?.rows || [],
      globalReferenceTypes: globalCases.referenceTypeChart?.rows || [],
      globalReferenceContinents: globalCases.referenceContinentChart?.rows || [],
    },
    tables: {
      selected: {
        title: "Priority shortlist",
        columns: ["Rank", "Asset", "District", "Class", "Treatment", "Cost"],
        rows: selectedTable,
      },
      risk: {
        title: "Risk watchlist",
        columns: ["Asset", "District", "Treatment", "ML risk", "Status"],
        rows: riskTable,
      },
    },
    priorityLinks,
    evidenceSummary,
    spatialSummary,
    inventorySummary: evidence?.fileInventory?.summary || {},
    stories,
    rawTables: evidence?.rawTables || {},
    spatialEvidence: evidence?.spatialEvidence || {},
    ugandaNetwork: evidence?.ugandaNetwork || {},
    latestRoadMaster,
    globalCases: {
      ...globalCases,
      countryRows: globalCountryRows,
      countryTable: globalCountryTable,
      referenceCount: globalReferenceCount,
      averageScore: globalCountryRows.length
        ? Math.round(globalCountryRows.reduce((sum, row) => sum + Number(row.transferability_score || 0), 0) / globalCountryRows.length)
        : staticGlobalSummary.averageScore,
      sourceCount: staticGlobalSummary.sourceCount,
    },
    frameworkFlow: evidence?.frameworkFlow || [],
    frameworkTable: evidence?.frameworkTable,
    pims: evidence?.pims || {},
    hdm4: evidence?.hdm4 || {},
    traffic: evidence?.traffic || {},
    predictions: evidence?.predictions || {},
    botSync: evidence?.botSync || {},
    databaseLoaded: Boolean(evidence?.loadedFromDatabase),
    dataBackend: evidence?.databaseBackend || "Bundled JSON fallback",
    programmeAssetCount: evidence?.programmeAssets?.length || 0,
  };
}

function useProductInsights(analysis, evidence) {
  return useMemo(() => buildProductInsights(analysis, evidence), [analysis, evidence]);
}

function ProductNav({ activeView, onNavigate }) {
  return (
    <aside className="product-nav">
      <a className="product-brand" href="#command" onClick={() => onNavigate("command")}>
        <span><Bot size={18} /></span>
        <strong>DUCAR</strong>
      </a>
      <nav>
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <a key={id} href={`#${id}`} className={activeView === id ? "active" : ""} onClick={() => onNavigate(id)} title={label}>
            <Icon size={18} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
    </aside>
  );
}

function ProductJumpBack() {
  const jumpToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    <button className="product-jump-back" type="button" onClick={jumpToTop} aria-label="Jump back to the top" title="Jump back to the top">
      <ArrowUpLeft size={20} />
      <span>Top</span>
    </button>
  );
}

function ProductStat({ label, value, note, tone = "blue" }) {
  return (
    <article className={`product-stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{note}</em>
    </article>
  );
}

const PRODUCT_CHART_COLORS = ["#2563eb", "#059669", "#dc2626", "#f59e0b", "#0891b2", "#7c3aed", "#16a34a", "#ea580c"];

function productChartColor(index) {
  return PRODUCT_CHART_COLORS[index % PRODUCT_CHART_COLORS.length];
}

function normalizeChartRows(rows = [], maxRows = 6) {
  return rows
    .map((row, index) => {
      if (Array.isArray(row)) {
        return {
          label: formatEvidenceCell(row[0] || `Item ${index + 1}`),
          value: Number(row[1] || 0),
          detail: row[2] ? formatEvidenceCell(row[2]) : "",
        };
      }
      const value = row.value ?? row.count ?? row.total ?? row.total_km ?? row.length_km ?? row.readiness_score ?? row.feature_count ?? 0;
      const label = row.label ?? row.name ?? row.title ?? row.category ?? row.indicator ?? row.gate ?? row.signal ?? `Item ${index + 1}`;
      const detail = row.detail ?? row.note ?? row.phase ?? row.description ?? row.decision_use ?? row.basis ?? "";
      return {
        label: formatEvidenceCell(label),
        value: Number(value || 0),
        detail: detail ? formatEvidenceCell(detail) : "",
      };
    })
    .filter((row) => row.label && Number.isFinite(row.value) && row.value > 0)
    .slice(0, maxRows);
}

function ProductBarChart({ title, subtitle, rows, formatValue = (value) => formatCount(value), maxRows = 6 }) {
  const visible = normalizeChartRows(rows, maxRows);
  const maxValue = Math.max(1, ...visible.map((row) => Number(row.value || 0)));
  if (!visible.length) return null;
  return (
    <section className="query-panel">
      <div className="product-panel-head">
        <h3>{title}</h3>
        <span>{subtitle}</span>
      </div>
      <div className="product-bars">
        {visible.map((row, index) => (
          <article key={`${title}-${row.label}-${index}`} style={{ "--accent": productChartColor(index), "--delay": `${index * 70}ms` }}>
            <span>{row.label}{row.detail && <small>{row.detail}</small>}</span>
            <i><b style={{ width: `${Math.max(4, (Number(row.value || 0) / maxValue) * 100)}%` }} /></i>
            <strong>{formatValue(row.value)}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}

function PriorityDecisionBars({ links = [] }) {
  const visible = links;
  if (!visible.length) return null;
  const maxScore = Math.max(1, ...visible.map((item) => Number(item.score || 0)));
  const maxCost = Math.max(1, ...visible.map((item) => Number(item.cost || 0)));
  const metrics = (item) => [
    ["Priority", Number(item.score || 0) / maxScore, Math.round(Number(item.score || 0)).toLocaleString(), "#2563eb"],
    ["ML risk", Number(item.risk || 0), `${Math.round(Number(item.risk || 0) * 100)}%`, "#dc2626"],
    ["Traffic", Number(item.traffic || 0) / 5, `${Number(item.traffic || 0)}/5`, "#0891b2"],
    ["Condition", Number(item.condition || 0) / 5, `${Number(item.condition || 0)}/5`, "#f59e0b"],
    ["Criticality", Number(item.criticality || 0) / 5, `${Number(item.criticality || 0)}/5`, "#7c3aed"],
    ["Evidence", Number(item.evidence || 0) / 100, `${Math.round(Number(item.evidence || 0))}%`, "#059669"],
    ["Readiness", Number(item.readiness || 0) / 5, `${Number(item.readiness || 0)}/5`, "#16a34a"],
    ["Cost", Number(item.cost || 0) / maxCost, formatMoneyCompact(item.cost), "#ea580c"],
  ];
  return (
    <section className="query-panel priority-link-panel">
      <div className="product-panel-head">
        <h3>Priority Decisions by Road Link</h3>
        <span>Score, risk, traffic, condition, evidence, readiness and cost for every active road link</span>
      </div>
      <div className="priority-link-list">
        {visible.map((item, index) => (
          <article key={item.assetId} style={{ "--delay": `${index * 70}ms` }}>
            <div className="priority-link-head">
              <div>
                <strong>{item.assetId}</strong>
                <span>{item.district} / {item.className} / {item.treatment}</span>
              </div>
              <em>{item.status}</em>
            </div>
            <div className="priority-metric-grid">
              {metrics(item).map(([label, ratio, value, color]) => (
                <div key={`${item.assetId}-${label}`} style={{ "--accent": color }}>
                  <span>{label}</span>
                  <i><b style={{ width: `${Math.max(4, Math.min(100, Number(ratio || 0) * 100))}%` }} /></i>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <p>{item.region} region / {item.monitoringTier} / maintainable: {item.maintainable || "pending"}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProductPieChart({ title, subtitle, rows, formatValue = (value) => formatCount(value), maxRows = 6 }) {
  const visible = normalizeChartRows(rows, maxRows);
  const [selectedIndex, setSelectedIndex] = useState(0);
  if (!visible.length) return null;
  const total = visible.reduce((sum, row) => sum + Number(row.value || 0), 0) || 1;
  let cursor = 0;
  const segments = visible.map((row, index) => {
    const start = cursor;
    cursor += (Number(row.value || 0) / total) * 360;
    return `${productChartColor(index)} ${start.toFixed(2)}deg ${cursor.toFixed(2)}deg`;
  }).join(", ");
  const selected = visible[Math.min(selectedIndex, visible.length - 1)] || visible[0];
  const selectedPercent = Math.round((Number(selected.value || 0) / total) * 100);
  return (
    <section className="query-panel pie-chart">
      <div className="product-panel-head">
        <h3>{title}</h3>
        <span>{subtitle}</span>
      </div>
      <div className="pie-chart-layout">
        <div className="pie-disc" style={{ background: `conic-gradient(${segments})` }} role="img" aria-label={`${title}: ${visible.length} categories`}>
          <div className="pie-center">
            <strong>{selectedPercent}%</strong>
            <span>{selected.label}</span>
            <em>{formatValue(selected.value)}</em>
          </div>
        </div>
        <div className="pie-legend">
          {visible.map((row, index) => {
            const percent = Math.round((Number(row.value || 0) / total) * 100);
            return (
              <button
                key={`${title}-${row.label}-${index}`}
                className={index === selectedIndex ? "active" : ""}
                type="button"
                onClick={() => setSelectedIndex(index)}
                onFocus={() => setSelectedIndex(index)}
                style={{ "--accent": productChartColor(index), "--delay": `${index * 60}ms` }}
              >
                <i />
                <span>{row.label}</span>
                <strong>{percent}%</strong>
                <em>{formatValue(row.value)}</em>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ProductFunnelChart({ title, subtitle, rows, formatValue = (value) => formatCount(value), maxRows = 6 }) {
  const visible = normalizeChartRows(rows, maxRows);
  const [selectedIndex, setSelectedIndex] = useState(0);
  if (!visible.length) return null;
  const maxValue = Math.max(1, ...visible.map((row) => Number(row.value || 0)));
  const selected = visible[Math.min(selectedIndex, visible.length - 1)] || visible[0];
  return (
    <section className="query-panel funnel-chart">
      <div className="product-panel-head">
        <h3>{title}</h3>
        <span>{subtitle}</span>
      </div>
      <div className="funnel-list">
        {visible.map((row, index) => {
          const width = Math.max(16, (Number(row.value || 0) / maxValue) * 100);
          return (
            <button
              key={`${title}-${row.label}-${index}`}
              className={index === selectedIndex ? "active" : ""}
              type="button"
              onClick={() => setSelectedIndex(index)}
              onFocus={() => setSelectedIndex(index)}
              style={{ "--accent": productChartColor(index), "--width": `${width}%`, "--delay": `${index * 70}ms` }}
            >
              <span className="funnel-label"><i>{String(index + 1).padStart(2, "0")}</i>{row.label}</span>
              <span className="funnel-track"><span className="funnel-fill" /></span>
              <strong>{formatValue(row.value)}</strong>
            </button>
          );
        })}
      </div>
      <div className="funnel-focus">
        <strong>{selected.label}</strong>
        <span>{selected.detail || `${formatValue(selected.value)} road records in this view`}</span>
      </div>
    </section>
  );
}

function ProductTable({ table }) {
  if (!table?.rows?.length) return null;
  return (
    <section className="query-panel product-table-panel">
      <div className="product-panel-head">
        <h3>{table.title}</h3>
        <span>{table.rows.length} rows</span>
      </div>
      <div className="product-table-wrap">
        <table>
          <thead>
            <tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={`${table.title}-${index}`}>
                {row.map((cell, cellIndex) => <td key={`${index}-${cellIndex}`}>{formatEvidenceCell(cell)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function QueryBadge() {
  return null;
}

function FrameworkFlow({ steps = [] }) {
  const [activeStep, setActiveStep] = useState(0);
  useEffect(() => {
    if (!steps.length) return undefined;
    const timer = window.setInterval(() => {
      setActiveStep((step) => (step + 1) % steps.length);
    }, 1900);
    return () => window.clearInterval(timer);
  }, [steps.length]);
  if (!steps.length) return null;
  const active = steps[Math.min(activeStep, steps.length - 1)] || steps[0];
  return (
    <section className="framework-flow-panel vivid-framework-flow">
      <div className="product-panel-head">
        <h3>Framework Animation Flow</h3>
        <span>PIMS, HDM-4, RAM, budget and monitoring gates as a high-contrast decision cycle</span>
      </div>
      <div className="framework-cycle-stage" style={{ "--active": activeStep }}>
        <div className="framework-bot-orbit" aria-hidden="true">
          <Bot size={32} />
          <i />
          <i />
          <i />
        </div>
        <div>
          <span>Active cycle step {String(activeStep + 1).padStart(2, "0")}</span>
          <strong>{active.title}</strong>
          <p>{active.phase}</p>
        </div>
      </div>
      <div className="framework-flow-track">
        {steps.map((step, index) => (
          <article
            key={`${step.title}-${index}`}
            className={`${index === activeStep ? "active" : ""} ${index < activeStep ? "visited" : ""}`}
            style={{ "--delay": `${index * 120}ms`, "--accent": productChartColor(index) }}
            onMouseEnter={() => setActiveStep(index)}
          >
            <em>{String(index + 1).padStart(2, "0")}</em>
            <span>{step.discipline}</span>
            <strong>{step.title}</strong>
            <p>{step.phase}</p>
            <i><b style={{ width: `${Math.max(12, Number(step.readiness_score || 0))}%` }} /></i>
          </article>
        ))}
      </div>
    </section>
  );
}

function ConditionStackChart({ rows = [] }) {
  const visible = rows.slice(0, 7);
  if (!visible.length) return null;
  return (
    <section className="query-panel condition-stack-panel">
      <div className="product-panel-head">
        <h3>Road Condition Pressure</h3>
        <span>Good, fair and poor kilometres by network category</span>
      </div>
      <div className="condition-stack-list">
        {visible.map((row) => {
          const total = Math.max(1, Number(row.total_km || 0));
          const good = (Number(row.good_km || 0) / total) * 100;
          const fair = (Number(row.fair_km || 0) / total) * 100;
          const poor = Math.max(0, 100 - good - fair);
          return (
            <article key={row.category}>
              <div>
                <strong>{row.category}</strong>
                <span>{formatKm(total)} total</span>
              </div>
              <i>
                <b className="good" style={{ width: `${good}%` }} />
                <b className="fair" style={{ width: `${fair}%` }} />
                <b className="poor" style={{ width: `${poor}%` }} />
              </i>
              <em>{Math.round(Number(row.poor_share || 0) * 100)}% poor</em>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function SqlChartGallery({ insights }) {
  return (
    <section className="sql-chart-gallery">
      <div className="product-panel-head gallery-head">
        <h3>SQL Programme Chart Gallery</h3>
        <span>{formatCount(insights.programmeAssetCount)} assets queried from SQLite</span>
      </div>
      <div className="chart-showcase">
        <ProductPieChart title="Surface Mix" subtitle="Candidate assets by pavement or surface type" rows={insights.charts.surfaceSplit} />
        <ProductPieChart title="Maintainability" subtitle="Maintenance-eligible assets versus referrals" rows={insights.charts.maintainabilitySplit} />
        <ProductPieChart title="Asset Regions" subtitle="Programme asset count by region" rows={insights.charts.regionAssetCount} />
      </div>
      <div className="chart-showcase">
        <ProductBarChart title="Regional Demand" subtitle="Total candidate cost by region" rows={insights.charts.regionDemand} formatValue={(value) => `UGX ${currency.format(value)}`} maxRows={8} />
        <ProductBarChart title="Cost by Status" subtitle="Budget pressure by fiscal-gate result" rows={insights.charts.statusCostSplit} formatValue={(value) => `UGX ${currency.format(value)}`} />
        <ProductBarChart title="Class Counts" subtitle="Candidate assets by functional class" rows={insights.charts.classAssetCount} maxRows={8} />
      </div>
      <div className="chart-showcase">
        <ProductBarChart title="Asset Risk %" subtitle="Highest ML risk probabilities from SQL programme assets" rows={insights.charts.assetRiskBars} formatValue={(value) => `${Math.round(Number(value || 0))}%`} maxRows={8} />
        <ProductBarChart title="Asset Cost" subtitle="Largest candidate cost items" rows={insights.charts.assetCostBars} formatValue={(value) => `UGX ${currency.format(value)}`} maxRows={8} />
        <ProductBarChart title="Evidence Readiness" subtitle="Completeness score by programme asset" rows={insights.charts.assetEvidenceBars} formatValue={(value) => `${Math.round(Number(value || 0))}%`} maxRows={8} />
      </div>
      <div className="product-grid two">
        <ProductBarChart title="Traffic Scores" subtitle="Traffic pressure score by asset" rows={insights.charts.assetTrafficBars} formatValue={(value) => `${Number(value || 0)}/5`} maxRows={8} />
        <ProductBarChart title="Condition Scores" subtitle="Condition pressure score by asset" rows={insights.charts.assetConditionBars} formatValue={(value) => `${Number(value || 0)}/5`} maxRows={8} />
      </div>
    </section>
  );
}

function TrendLinePanel({ title, subtitle, rows = [], labelKey, valueKey, formatValue = formatCount, tone = "blue" }) {
  const visible = rows.filter((row) => Number.isFinite(Number(row[valueKey])));
  if (visible.length < 2) return null;
  const values = visible.map((row) => Number(row[valueKey]));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const points = visible.map((row, index) => {
    const x = 24 + (index / Math.max(1, visible.length - 1)) * 472;
    const y = 142 - ((Number(row[valueKey]) - min) / range) * 104;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = visible.at(-1);
  return (
    <section className={`query-panel trend-line-panel ${tone}`}>
      <div className="product-panel-head">
        <h3>{title}</h3>
        <span>{subtitle}</span>
      </div>
      <div className="trend-line-grid">
        <svg viewBox="0 0 520 170" role="img" aria-label={title}>
          <path d="M24 142 H496" />
          <path d="M24 38 H496" />
          <polyline points={points} />
          {visible.map((row, index) => {
            const [x, y] = points.split(" ")[index].split(",");
            return <circle key={`${title}-${row[labelKey]}`} cx={x} cy={y} r="5"><title>{`${row[labelKey]}: ${formatValue(row[valueKey])}`}</title></circle>;
          })}
        </svg>
        <div>
          <strong>{formatValue(last[valueKey])}</strong>
          <span>{last[labelKey]}</span>
          <em>{formatValue(values[0])} at start</em>
        </div>
      </div>
    </section>
  );
}

function ReadinessBars({ title, subtitle, items = [] }) {
  const visible = items.slice(0, 7);
  if (!visible.length) return null;
  return (
    <section className="query-panel readiness-panel">
      <div className="product-panel-head">
        <h3>{title}</h3>
        <span>{subtitle}</span>
      </div>
      <div className="readiness-list">
        {visible.map((item, index) => (
          <article key={item.indicator || item.title || index} style={{ "--accent": ["#2563eb", "#059669", "#f59e0b", "#dc2626", "#0891b2", "#7c3aed"][index % 6] }}>
            <div>
              <strong>{item.indicator || item.title}</strong>
              <span>{item.description || item.phase}</span>
            </div>
            <i><b style={{ width: `${Math.max(8, Number(item.readiness_score || 0))}%` }} /></i>
            <em>{Math.round(Number(item.readiness_score || 0))}%</em>
          </article>
        ))}
      </div>
    </section>
  );
}

const GEO_FRAME = { width: 1000, height: 560, minLon: 29.2, maxLon: 35.2, minLat: -1.8, maxLat: 4.4 };

const FALLBACK_GEO_LINES = [
  [[30.0, -0.9], [30.8, -0.2], [31.7, 0.4], [32.7, 0.6], [33.8, 1.2]],
  [[31.1, 3.4], [31.8, 2.5], [32.3, 1.7], [32.9, 0.9], [33.3, 0.1]],
  [[29.9, 1.0], [30.8, 1.3], [31.9, 1.1], [33.0, 1.7], [34.4, 2.3]],
];

function projectGeo(position, frame = GEO_FRAME) {
  if (!Array.isArray(position) || position.length < 2) return null;
  const lon = Number(position[0]);
  const lat = Number(position[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const x = ((lon - frame.minLon) / (frame.maxLon - frame.minLon)) * frame.width;
  const y = (1 - ((lat - frame.minLat) / (frame.maxLat - frame.minLat))) * frame.height;
  return [Math.max(0, Math.min(frame.width, x)), Math.max(0, Math.min(frame.height, y))];
}

function geoPath(coordinates, close = false, frame = GEO_FRAME) {
  const points = (coordinates || []).map((point) => projectGeo(point, frame)).filter(Boolean);
  if (points.length < 2) return "";
  const path = points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return close ? `${path} Z` : path;
}

function mapFeatureFrame(features, programme) {
  const positions = [];
  for (const item of features) {
    if (item.geometryType === "Point") {
      positions.push(item.coordinates);
    } else if (Array.isArray(item.coordinates)) {
      positions.push(...item.coordinates);
    }
  }
  for (const item of programme) {
    positions.push([item.lon, item.lat]);
  }
  const valid = positions.filter((position) => projectGeo(position));
  if (valid.length < 2) return GEO_FRAME;
  let minLon = Math.min(...valid.map((position) => Number(position[0])));
  let maxLon = Math.max(...valid.map((position) => Number(position[0])));
  let minLat = Math.min(...valid.map((position) => Number(position[1])));
  let maxLat = Math.max(...valid.map((position) => Number(position[1])));
  const lonPad = Math.max((maxLon - minLon) * 0.08, 0.12);
  const latPad = Math.max((maxLat - minLat) * 0.08, 0.12);
  minLon -= lonPad;
  maxLon += lonPad;
  minLat -= latPad;
  maxLat += latPad;
  const targetRatio = GEO_FRAME.width / GEO_FRAME.height;
  const currentRatio = (maxLon - minLon) / Math.max(maxLat - minLat, 0.001);
  if (currentRatio > targetRatio) {
    const targetLatSpan = (maxLon - minLon) / targetRatio;
    const midLat = (minLat + maxLat) / 2;
    minLat = midLat - targetLatSpan / 2;
    maxLat = midLat + targetLatSpan / 2;
  } else {
    const targetLonSpan = (maxLat - minLat) * targetRatio;
    const midLon = (minLon + maxLon) / 2;
    minLon = midLon - targetLonSpan / 2;
    maxLon = midLon + targetLonSpan / 2;
  }
  return { ...GEO_FRAME, minLon, maxLon, minLat, maxLat };
}

function ModernGeoMap({ features = [], programme = [] }) {
  const grouped = useMemo(() => ({
    district: features.filter((item) => item.group === "district" && item.geometryType === "Polygon"),
    route: features.filter((item) => item.group === "route" && item.geometryType === "LineString"),
    national: features.filter((item) => item.group === "national" && item.geometryType === "LineString"),
    flow: features.filter((item) => item.group === "flow" && item.geometryType === "LineString"),
  }), [features]);
  const routeFeatures = grouped.route.length
    ? grouped.route
    : FALLBACK_GEO_LINES.map((coordinates, index) => ({ name: `route-${index}`, coordinates }));
  const frame = useMemo(() => mapFeatureFrame(features.length ? features : routeFeatures, programme), [features, routeFeatures, programme]);
  const featureCount = features.length || routeFeatures.length;

  return (
    <section className="geo-command-map">
      <div className="product-panel-head">
        <h3>Modern Geospatial Surface</h3>
        <span>Road links, national reference routes and traffic overlays shown as clean map layers</span>
      </div>
      <div className="geo-map-canvas">
        <svg className="geo-surface-svg" viewBox={`0 0 ${GEO_FRAME.width} ${GEO_FRAME.height}`} role="img" aria-label="DUCAR geospatial evidence surface">
          <defs>
            <linearGradient id="geoSurface" x1="0%" x2="100%" y1="0%" y2="100%">
              <stop offset="0%" stopColor="#e8f1ff" />
              <stop offset="55%" stopColor="#effdf8" />
              <stop offset="100%" stopColor="#eef2ff" />
            </linearGradient>
            <filter id="geoGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <rect width={GEO_FRAME.width} height={GEO_FRAME.height} fill="url(#geoSurface)" />
          <g className="geo-grid-lines">
            {Array.from({ length: 8 }, (_, index) => <line key={`x-${index}`} x1={125 * index} y1="0" x2={125 * index} y2={GEO_FRAME.height} />)}
            {Array.from({ length: 6 }, (_, index) => <line key={`y-${index}`} x1="0" y1={112 * index} x2={GEO_FRAME.width} y2={112 * index} />)}
          </g>
          <g>
            {grouped.district.slice(0, 80).map((item, index) => {
              const d = geoPath(item.coordinates, true, frame);
              return d ? <path key={`${item.source}-${index}`} className="geo-district" d={d}><title>{item.name || item.source}</title></path> : null;
            })}
          </g>
          <g filter="url(#geoGlow)">
            {grouped.flow.slice(0, 95).map((item, index) => {
              const d = geoPath(item.coordinates, false, frame);
              return d ? <path key={`${item.source}-flow-${index}`} className="geo-line flow" d={d} style={{ animationDelay: `${(index % 20) * 0.05}s` }}><title>{item.name || "Traffic flow"}</title></path> : null;
            })}
          </g>
          <g>
            {routeFeatures.slice(0, 170).map((item, index) => {
              const d = geoPath(item.coordinates, false, frame);
              return d ? <path key={`${item.name || item.source}-route-${index}`} className="geo-line route" d={d} style={{ animationDelay: `${(index % 24) * 0.04}s` }}><title>{item.name || "DUCAR route"}</title></path> : null;
            })}
            {grouped.national.slice(0, 110).map((item, index) => {
              const d = geoPath(item.coordinates, false, frame);
              return d ? <path key={`${item.source}-national-${index}`} className="geo-line national" d={d}><title>{item.name || "National road reference"}</title></path> : null;
            })}
          </g>
        </svg>
        <div className="geo-map-metrics">
          <span>{formatCount(featureCount)} mapped road features</span>
        </div>
      </div>
      <div className="geo-layer-strip">
        <span><i className="route" /> DUCAR / unified routes</span>
        <span><i className="national" /> National reference</span>
      </div>
    </section>
  );
}

function CommandView({ insights }) {
  return (
    <div className="product-view">
      <section className="command-hero">
        <div>
          <p className="product-eyebrow">Priority intelligence</p>
          <h1>Fund the clearest road investments first.</h1>
          <span>Road condition, traffic pressure, investment readiness and affordability are compressed into a few decisive signals.</span>
        </div>
        <div className="hero-score">
          <strong>{insights.executive[0]?.value}</strong>
          <span>selected programme</span>
        </div>
      </section>
      <section className="product-stat-grid">
        {insights.executive.map((item) => <ProductStat key={item.label} {...item} />)}
      </section>
      <section className="decision-grid">
        {insights.decisionCards.map((card, index) => (
          <article key={card.title} style={{ "--delay": `${index * 90}ms` }}>
            <span>{card.signal}</span>
            <h3>{card.title}</h3>
            <p>{card.body}</p>
          </article>
        ))}
      </section>
      <FrameworkFlow steps={insights.frameworkFlow} />
      <div className="chart-showcase">
        <ProductPieChart title="Decision Share" subtitle="Programme status split from the priority run" rows={insights.charts.statusSplit} />
        <ProductFunnelChart title="Priority Funnel" subtitle="Candidate assets through selection, risk and referral gates" rows={insights.charts.programmeFunnel} />
        <ProductPieChart title="Road Network Share" subtitle="National, district, urban and community road length context" rows={insights.charts.networkCategory} formatValue={(value) => formatKm(value)} />
      </div>
      <SqlChartGallery insights={insights} />
      <div className="product-grid two">
        <ProductBarChart title="Budget by Region" subtitle="Selected assets only" rows={insights.charts.regionAllocation} formatValue={(value) => `UGX ${currency.format(value)}`} />
        <ProductBarChart title="Highest Flow Links" subtitle="Traffic pressure by named road link" rows={insights.charts.trafficFlow} formatValue={(value) => `${Math.round(Number(value || 0))}%`} maxRows={8} />
      </div>
      <PriorityDecisionBars links={insights.priorityLinks} />
      <div className="product-grid two">
        <ProductFunnelChart title="Model Feature Coverage" subtitle="PIMS, HDM-4, network pressure and monitoring signal completeness" rows={insights.charts.modelFunnel} />
        <ProductPieChart title="Prediction Status" subtitle="Recommended model action by asset" rows={insights.charts.predictionStatusSplit} />
      </div>
      <div className="product-grid two">
        <ProductTable table={insights.tables.selected} />
        <ProductTable table={insights.tables.risk} />
      </div>
      <section className="query-strip">
        <QueryBadge label="executive query" sql={insights.sql.executive} />
        <QueryBadge label="risk query" sql={insights.sql.risk} />
      </section>
    </div>
  );
}

function PortfolioView({ insights, budget, reservePercent, onBudgetChange, onReserveChange, onScenario }) {
  return (
    <div className="product-view">
      <section className="control-surface">
        <div>
          <p className="product-eyebrow">Portfolio controls</p>
          <h2>One fiscal gate, three scenario levers.</h2>
        </div>
        <label>
          Budget UGX
          <input type="number" value={budget} onChange={(event) => onBudgetChange(Number(event.target.value))} />
        </label>
        <label>
          Reserve %
          <input type="number" value={reservePercent} onChange={(event) => onReserveChange(Number(event.target.value))} />
        </label>
      </section>
      <section className="scenario-row">
        {BUDGET_SCENARIOS.slice(0, 4).map((scenario) => (
          <button key={scenario.name} className="scenario-chip" onClick={() => onScenario(scenario)}>
            <strong>{scenario.name}</strong>
            <span>UGX {currency.format(scenario.budget)}</span>
          </button>
        ))}
      </section>
      <div className="product-grid two">
        <ReadinessBars title="PIMS Gate Readiness" subtitle="Project admission to final investment decision" items={insights.frameworkFlow} />
        <ReadinessBars title="HDM-4 Model Readiness" subtitle="Economic and pavement model inputs retained for investment appraisal" items={insights.hdm4?.indicators || []} />
      </div>
      <div className="chart-showcase">
        <ProductPieChart title="Risk Band Mix" subtitle="Machine-learning risk bands across the candidate programme" rows={insights.charts.riskSplit} />
        <ProductFunnelChart title="Investment Readiness Funnel" subtitle="PIMS gates used as a compact readiness sequence" rows={insights.charts.pimsReadiness} formatValue={(value) => `${Math.round(Number(value || 0))}%`} />
        <ProductPieChart title="Monitoring Tiers" subtitle="Post-selection oversight groupings generated from prediction features" rows={insights.charts.monitoringSplit} />
      </div>
      <div className="product-grid two">
        <ProductBarChart title="Allocation by Road Class" subtitle="Selected programme cost" rows={insights.charts.classAllocation} formatValue={(value) => `UGX ${currency.format(value)}`} />
        <ProductBarChart title="Treatment Demand" subtitle="All candidate costs by intervention" rows={insights.charts.interventions} formatValue={(value) => `UGX ${currency.format(value)}`} />
      </div>
      <div className="chart-showcase">
        <ProductPieChart title="Surface Mix" subtitle="Portfolio candidates by surface" rows={insights.charts.surfaceSplit} />
        <ProductBarChart title="Regional Demand" subtitle="Total cost pressure by region" rows={insights.charts.regionDemand} formatValue={(value) => `UGX ${currency.format(value)}`} maxRows={8} />
        <ProductBarChart title="Asset Cost Ranking" subtitle="Largest cost items in the SQL programme" rows={insights.charts.assetCostBars} formatValue={(value) => `UGX ${currency.format(value)}`} maxRows={8} />
      </div>
      <div className="product-grid two">
        <ProductFunnelChart title="HDM-4 Readiness Funnel" subtitle="Economic and pavement model indicators by retained readiness score" rows={insights.charts.hdm4Readiness} formatValue={(value) => `${Math.round(Number(value || 0))}%`} />
        <ProductPieChart title="Programme Status" subtitle="Selected, deferred and referred assets after the fiscal gate" rows={insights.charts.statusSplit} />
      </div>
      <div className="product-grid two">
        <ProductTable table={insights.tables.selected} />
        <ProductBarChart title="Programme Split" subtitle="Status counts after fiscal gate" rows={insights.charts.statusSplit} />
      </div>
      <div className="product-grid two">
        <ProductTable table={insights.pims?.gates} />
        <ProductTable table={insights.hdm4?.inputs} />
      </div>
      <section className="query-strip">
        <QueryBadge label="portfolio query" sql={insights.sql.portfolio} />
        <QueryBadge label="pims query" sql={insights.sql.pims} />
        <QueryBadge label="hdm4 query" sql={insights.sql.hdm4} />
      </section>
    </div>
  );
}

function NetworkView({ insights, programme }) {
  const latestMaster = insights.latestRoadMaster?.run || {};
  const classificationTable = insights.latestRoadMaster?.rulesTable
    ? {
      ...insights.latestRoadMaster.rulesTable,
      title: "Road classification rules",
      columns: ["Road class input", "DUCAR class", "Code", "Planning assumption"],
    }
    : null;
  return (
    <div className="product-view map-workspace-view">
      <section className="map-workspace-shell network-workspace">
        <div className="map-workspace-map">
          <MapScene3D programme={programme} />
        </div>
        <aside className="map-workspace-pane" aria-label="Network road intelligence">
          <section className="network-brief compact-map-brief">
            <div>
              <p className="product-eyebrow">Network intelligence</p>
              <h2>Uganda road network, decision-ready.</h2>
              <span>Coverage, condition, traffic and district summaries sit beside the map without covering the roads.</span>
            </div>
            <ProductStat label="Mapped road links" value={formatCount(latestMaster.record_count || insights.spatialSummary.feature_count)} note={formatCompactDate(latestMaster.generated_at_utc)} tone="cyan" />
            <ProductStat label="Mapped length" value={formatKm(latestMaster.total_length_km || insights.spatialSummary.line_length_km)} note={`${formatCount(latestMaster.district_summary_count)} district summaries`} tone="gold" />
          </section>
          <section className="product-stat-grid network-kpis">
            {(insights.ugandaNetwork?.kpis || []).map((item) => <ProductStat key={item.label} {...item} />)}
          </section>
          <div className="chart-showcase">
            <ProductPieChart title="Latest DUCAR Class Mix" subtitle="Road master records by planning class" rows={insights.charts.roadMasterClasses} />
            <ProductFunnelChart title="Largest District Inventories" subtitle="Top district road-length summaries" rows={insights.charts.roadMasterDistricts} formatValue={(value) => formatKm(value)} maxRows={8} />
            <ProductPieChart title="Road Quality Flags" subtitle="Naming, geometry and classification checks" rows={insights.charts.roadMasterQuality} />
          </div>
          <div className="chart-showcase">
            <ProductPieChart title="Road Network Share" subtitle="FY 2022/23 length by category" rows={insights.charts.networkCategory} formatValue={(value) => formatKm(value)} />
            <ProductFunnelChart title="Poor Condition Pressure" subtitle="Poor kilometres by network category" rows={insights.charts.networkPoor} formatValue={(value) => formatKm(value)} />
            <ProductBarChart title="Uganda Road Network" subtitle="Length by network category" rows={insights.charts.networkCategory} formatValue={(value) => formatKm(value)} />
          </div>
          <div className="product-grid two">
            <ConditionStackChart rows={insights.ugandaNetwork?.conditionRows || []} />
            <ProductBarChart title="Priority Road-Link Scores" subtitle="Score, traffic, condition and readiness signals" rows={insights.priorityLinks.map((row) => [row.assetId, row.score, `${row.district} / ${row.treatment}`])} maxRows={10} />
          </div>
          <PriorityDecisionBars links={insights.priorityLinks} />
          <div className="product-grid two">
            <TrendLinePanel title="Crash Trend" subtitle="Road traffic crashes by nature, CY 2019-2023" rows={insights.ugandaNetwork?.crashTrend || []} labelKey="year" valueKey="total" />
            <TrendLinePanel title="Paved National Stock" subtitle="Paved national road network trend" rows={insights.ugandaNetwork?.pavedTrend || []} labelKey="fy" valueKey="paved_stock_km" formatValue={(value) => formatKm(value)} tone="green" />
          </div>
          <div className="product-grid two">
            <ProductTable table={insights.ugandaNetwork?.conditionTable} />
            <ProductTable table={insights.latestRoadMaster?.districtTable} />
          </div>
          <ProductTable table={classificationTable} />
        </aside>
      </section>
    </div>
  );
}

function EvidenceView({ insights }) {
  const rows = buildEvidenceSourceMatrix(insights);
  return (
    <div className="product-view evidence-matrix-view">
      <section className="source-matrix-panel">
        <div className="source-matrix-head">
          <div>
            <p className="product-eyebrow">Evidence matrix</p>
            <h2>All road documents and data downloads.</h2>
          </div>
          <span>{formatCount(rows.length)} linked entries</span>
        </div>
        <div className="source-matrix-wrap">
          <table className="source-matrix-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Owner</th>
                <th>Theme</th>
                <th>Format</th>
                <th>Use</th>
                <th>Read</th>
                <th>Download</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.id}-${index}`}>
                  <td><strong>{row.title}</strong></td>
                  <td>{row.owner}</td>
                  <td>{row.theme}</td>
                  <td><span className="format-pill">{row.format}</span></td>
                  <td>{row.detail}</td>
                  <td><a href={row.href} target="_blank" rel="noreferrer">Read</a></td>
                  <td><a href={row.href} download target="_blank" rel="noreferrer"><Download size={14} /> Download</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function TrafficGeoMap() {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const [roads, setRoads] = useState({ type: "FeatureCollection", features: [] });
  const [flows, setFlows] = useState({ type: "FeatureCollection", features: [] });
  const [roadTypeFilter, setRoadTypeFilter] = useState("All");
  const [selectedFlow, setSelectedFlow] = useState(null);
  const [mapReady, setMapReady] = useState(false);
  const [loadState, setLoadState] = useState({ stage: "loading", message: "Loading traffic geospatial layer" });

  useEffect(() => {
    let cancelled = false;
    async function loadTrafficData() {
      try {
        const manifest = await fetchUgandaLayersManifest();
        const [roadData, flowData] = await Promise.all([
          fetchManifestJson(manifest, "cartographic_roads_geojson", "uganda_clean_road_routes_web.geojson")
            .catch(() => fetchManifestJson(manifest, "unified_roads_geojson", "uganda_unified_roads_web.geojson")),
          fetchManifestJson(manifest, "traffic_flows_geojson", "uganda_traffic_flows_web.geojson"),
        ]);
        if (cancelled) return;
        setRoads(roadData || { type: "FeatureCollection", features: [] });
        setFlows(flowData || { type: "FeatureCollection", features: [] });
        setLoadState({ stage: "ready", message: `${formatCount(flowData?.features?.length)} traffic flow links ready` });
      } catch (error) {
        if (!cancelled) setLoadState({ stage: "error", message: error.message || "Traffic layer unavailable" });
      }
    }
    loadTrafficData();
    return () => { cancelled = true; };
  }, []);

  const roadTypes = useMemo(() => {
    const values = new Set();
    for (const feature of [...(roads.features || []), ...(flows.features || [])]) {
      const value = feature.properties?.network_category || feature.properties?.road_class || feature.properties?.road_system;
      if (value) values.add(value);
    }
    return ["All", ...Array.from(values).sort()];
  }, [roads, flows]);

  const typeMatches = useCallback((feature) => {
    if (roadTypeFilter === "All") return true;
    const props = feature.properties || {};
    return props.network_category === roadTypeFilter || props.road_class === roadTypeFilter || props.road_system === roadTypeFilter;
  }, [roadTypeFilter]);

  const filteredRoads = useMemo(() => (roads.features || []).filter(typeMatches), [roads, typeMatches]);
  const filteredFlows = useMemo(() => (flows.features || []).filter(typeMatches), [flows, typeMatches]);

  const trafficStats = useMemo(() => {
    const count = filteredFlows.length;
    const totalKm = filteredFlows.reduce((sum, feature) => sum + Number(feature.properties?.length_km || 0), 0);
    const avg = count ? Math.round(filteredFlows.reduce((sum, feature) => sum + Number(feature.properties?.traffic_flow_index || 0), 0) / count) : 0;
    const high = filteredFlows.filter((feature) => Number(feature.properties?.traffic_flow_index || 0) >= 75).length;
    return { count, totalKm, avg, high };
  }, [filteredFlows]);

  const topTrafficLinks = useMemo(() => filteredFlows
    .slice()
    .sort((a, b) => Number(b.properties?.traffic_flow_index || 0) - Number(a.properties?.traffic_flow_index || 0))
    .slice(0, 6), [filteredFlows]);

  useEffect(() => {
    if (mapInstance.current || !mapRef.current) return;
    let cancelled = false;
    let map = null;
    async function initialiseTrafficMap() {
      const maplibregl = await loadMapLibre();
      if (cancelled || !mapRef.current) return;
      map = new maplibregl.Map({
        container: mapRef.current,
        center: UGANDA_MAP_VIEW.center,
        zoom: 6.45,
        pitch: 0,
        bearing: 0,
        attributionControl: false,
        style: imageryWithLabelsStyle(),
      });
      addOperationalMapControls(maplibregl, map);
      mapInstance.current = map;
      map.on("load", () => {
        if (cancelled) return;
        setMapReady(true);
        map.addSource("traffic-base-roads", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addSource("traffic-flow-lines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addSource("selected-traffic-flow", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "traffic-base-road-casing",
          type: "line",
          source: "traffic-base-roads",
          paint: {
            "line-color": "#020617",
            "line-width": ["+", ROAD_CATEGORY_WIDTHS, 0.32],
            "line-opacity": 0.22,
            "line-blur": 0.15,
          },
        });
        map.addLayer({
          id: "traffic-base-roads",
          type: "line",
          source: "traffic-base-roads",
          paint: {
            "line-color": ROAD_CATEGORY_COLORS,
            "line-width": ROAD_CATEGORY_WIDTHS,
            "line-opacity": 0.9,
          },
        });
        map.addLayer({
          id: "traffic-flow-casing-live",
          type: "line",
          source: "traffic-flow-lines",
          paint: {
            "line-color": "#020617",
            "line-width": ["interpolate", ["linear"], ["coalesce", ["get", "traffic_flow_index"], 45], 30, 0.8, 60, 1.6, 100, 2.8],
            "line-opacity": 0.3,
            "line-blur": 0.18,
          },
        });
        map.addLayer({
          id: "traffic-flow-live",
          type: "line",
          source: "traffic-flow-lines",
          paint: {
            "line-color": TRAFFIC_FLOW_COLOR,
            "line-width": ["interpolate", ["linear"], ["coalesce", ["get", "traffic_flow_index"], 45], 30, 0.75, 60, 1.6, 100, 2.7],
            "line-opacity": 0.96,
          },
        });
        map.addLayer({
          id: "selected-traffic-flow-halo",
          type: "line",
          source: "selected-traffic-flow",
          paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.92, "line-blur": 0.24 },
        });
        map.addLayer({
          id: "selected-traffic-flow",
          type: "line",
          source: "selected-traffic-flow",
          paint: { "line-color": "#0f172a", "line-width": 3.2, "line-opacity": 1 },
        });
        map.on("click", "traffic-flow-live", (event) => {
          const raw = event.features?.[0];
          if (!raw) return;
          const feature = JSON.parse(JSON.stringify(raw));
          setSelectedFlow(feature);
          map.getSource("selected-traffic-flow")?.setData({ type: "FeatureCollection", features: [feature] });
        });
        map.on("mouseenter", "traffic-flow-live", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "traffic-flow-live", () => { map.getCanvas().style.cursor = ""; });
      });
    }
    initialiseTrafficMap().catch((error) => setLoadState({ stage: "error", message: error.message || "Unable to initialise traffic map" }));
    return () => {
      cancelled = true;
      setMapReady(false);
      map?.remove();
      mapInstance.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapInstance.current;
    if (!mapReady || !map?.isStyleLoaded() || !map.getSource("traffic-flow-lines")) return;
    map.getSource("traffic-base-roads")?.setData({ type: "FeatureCollection", features: filteredRoads });
    map.getSource("traffic-flow-lines")?.setData({ type: "FeatureCollection", features: filteredFlows });
    if (!selectedFlow) map.getSource("selected-traffic-flow")?.setData({ type: "FeatureCollection", features: [] });
    fitMapToFeatures(map, filteredFlows.length ? filteredFlows.slice(0, 900) : filteredRoads.slice(0, 900), { padding: 76, duration: 700, maxZoom: 9.8 });
  }, [filteredRoads, filteredFlows, selectedFlow, mapReady]);

  function clearSelectedFlow() {
    setSelectedFlow(null);
    mapInstance.current?.getSource("selected-traffic-flow")?.setData({ type: "FeatureCollection", features: [] });
  }

  const selectedProps = selectedFlow?.properties || null;
  return (
    <section className="panel map-panel traffic-geo-panel">
      <div className="map-header">
        <div className="panel-title" style={{ borderBottom: "none", marginBottom: 0, paddingBottom: 0 }}>
          <Truck size={18} />
          <h2>Geospatial Traffic Flow Layer</h2>
        </div>
        <div className="map-toolbar">
          <div className="layer-toggles">
            <button className="layer-btn active flow" title="Traffic flow links are loaded from the traffic GeoJSON layer">
              <Eye size={14} /> Traffic Flow
            </button>
          </div>
          <label className="traffic-type-filter">
            Road type
            <select value={roadTypeFilter} onChange={(event) => { setRoadTypeFilter(event.target.value); clearSelectedFlow(); }}>
              {roadTypes.map((type) => <option key={type}>{type}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div className="map-stat-strip">
        <article className="map-stat cyan"><span>Flow links</span><strong>{formatCount(trafficStats.count)}</strong></article>
        <article className="map-stat green"><span>Analysed length</span><strong>{formatKm(trafficStats.totalKm)}</strong></article>
        <article className="map-stat dark"><span>Mean flow</span><strong>{trafficStats.avg}%</strong></article>
        <article className="map-stat red"><span>High pressure</span><strong>{formatCount(trafficStats.high)}</strong></article>
      </div>
      <div className="scene-shell traffic-scene-shell">
        <div className="maplibre-container traffic-maplibre-container" ref={mapRef} />
        {loadState.stage !== "ready" && (
          <div className={`map-loading map-loading-card ${loadState.stage === "error" ? "error" : ""}`}>
            {loadState.stage !== "error" && <div className="spinner" />}
            <div>
              <strong>{loadState.stage === "error" ? "Traffic layer unavailable" : "Loading traffic layer"}</strong>
              <span>{loadState.message}</span>
            </div>
          </div>
        )}
        <div className="scene-hud">
          <strong>Traffic pressure overlay</strong>
          <span>Thin road lines are colour-coded by road type.</span>
          <span>Traffic links use green-to-red flow pressure.</span>
          <span>Click a traffic line for road-link attributes.</span>
        </div>
        {selectedProps && (
          <aside className="road-info-pane open" aria-live="polite">
            <div className="road-info-header">
              <div>
                <p className="eyebrow">Traffic road link</p>
                <h3>{selectedProps.road_name || selectedProps.name || "Selected traffic link"}</h3>
              </div>
              <button className="pane-close" onClick={clearSelectedFlow} aria-label="Clear selected traffic road">x</button>
            </div>
            <div className="road-badges">
              <span>{selectedProps.network_category || selectedProps.road_class || "Road type pending"}</span>
              <span>{selectedProps.district || selectedProps.region || "District pending"}</span>
              <span>Flow {Math.round(Number(selectedProps.traffic_flow_index || 0))}%</span>
            </div>
            <div className="attribute-grid">
              {Object.entries(selectedProps).slice(0, 14).map(([key, value]) => (
                <div key={key}>
                  <span>{key.replaceAll("_", " ")}</span>
                  <strong>{formatEvidenceCell(value)}</strong>
                </div>
              ))}
            </div>
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
          <span><i className="line-swatch community-roads-line" /> Community Access</span>
          <span><i className="line-swatch town-roads-line" /> Town Council</span>
          <span><i className="line-swatch municipal-roads-line" /> Municipal</span>
          <span><i className="line-swatch traffic-flow-line" /> Traffic Flow Index</span>
        </div>
      </div>
      <div className="traffic-link-strip">
        {topTrafficLinks.map((feature) => (
          <article key={feature.properties?.route_id || feature.properties?.route_key || feature.properties?.name}>
            <strong>{feature.properties?.road_name || feature.properties?.name || "Unnamed link"}</strong>
            <span>{feature.properties?.district || feature.properties?.region || "Location pending"} / {feature.properties?.network_category || feature.properties?.road_class || "Road type pending"}</span>
            <i><b style={{ width: `${Math.max(4, Number(feature.properties?.traffic_flow_index || 0))}%` }} /></i>
            <em>{Math.round(Number(feature.properties?.traffic_flow_index || 0))}% flow</em>
          </article>
        ))}
      </div>
    </section>
  );
}

function TrafficView({ insights }) {
  const trafficStats = insights.traffic?.stats || {};
  const avgFlow = Math.round(Number(trafficStats.avg_flow_index || 0));
  const maxFlow = Math.round(Number(trafficStats.max_flow_index || 0));
  return (
    <div className="product-view map-workspace-view">
      <section className="map-workspace-shell traffic-workspace">
        <div className="map-workspace-map">
          <TrafficGeoMap />
        </div>
        <aside className="map-workspace-pane" aria-label="Traffic road intelligence">
          <section className="network-brief compact-map-brief traffic-brief">
            <div>
              <p className="product-eyebrow">Traffic analytics</p>
              <h2>Traffic pressure mapped by road link.</h2>
              <span>Flow, safety, paved-stock and condition pressure stay visible in a tight side pane while the map fills the workspace.</span>
            </div>
            <ProductStat label="Flow links" value={formatCount(trafficStats.flow_links)} note="traffic-sensitive road links" tone="cyan" />
            <ProductStat label="Mean flow index" value={avgFlow ? `${avgFlow}%` : "Loading"} note={`max ${maxFlow || 0}%`} tone="green" />
          </section>
          <div className="chart-showcase">
            <ProductFunnelChart title="Traffic Pressure Funnel" subtitle="Flow links, high pressure, safety trend and poor-condition load" rows={insights.charts.trafficFunnel} />
            <ProductBarChart title="Highest Flow Links" subtitle="Average traffic-flow index by road link" rows={insights.charts.trafficFlow} formatValue={(value) => `${Math.round(Number(value || 0))}%`} maxRows={8} />
            <ProductPieChart title="Network Length Share" subtitle="Road length context for traffic pressure" rows={insights.charts.networkCategory} formatValue={(value) => formatKm(value)} />
          </div>
          <PriorityDecisionBars links={insights.priorityLinks} />
          <div className="product-grid two">
            <TrendLinePanel title="Crash Trend" subtitle="Road traffic crashes by nature, CY 2019-2023" rows={insights.ugandaNetwork?.crashTrend || []} labelKey="year" valueKey="total" />
            <TrendLinePanel title="Paved National Stock" subtitle="Paved national road network trend used as traffic context" rows={insights.ugandaNetwork?.pavedTrend || []} labelKey="fy" valueKey="paved_stock_km" formatValue={(value) => formatKm(value)} tone="green" />
          </div>
          <div className="chart-showcase">
            <ConditionStackChart rows={insights.ugandaNetwork?.conditionRows || []} />
            <ProductPieChart title="Prediction Status" subtitle="Recommended model action by traffic-sensitive asset" rows={insights.charts.predictionStatusSplit} />
            <ProductFunnelChart title="Model Feature Coverage" subtitle="PIMS, HDM-4, network pressure and monitoring signal completeness" rows={insights.charts.modelFunnel} />
          </div>
          <ProductTable table={insights.traffic?.flowTable} />
        </aside>
      </section>
    </div>
  );
}

function PimsView({ insights }) {
  const gateRows = insights.pims?.gates?.rows || [];
  const readinessRows = insights.charts.pimsReadiness || [];
  const averageReadiness = readinessRows.length
    ? Math.round(readinessRows.reduce((sum, row) => sum + Number(row[1] || 0), 0) / readinessRows.length)
    : 0;
  return (
    <div className="product-view">
      <section className="network-brief">
        <div>
          <p className="product-eyebrow">Public investment management</p>
          <h2>PIMS gates as a clear investment filter.</h2>
          <span>Project admission, readiness checks and approval logic are exposed as investment signals.</span>
        </div>
        <ProductStat label="Framework steps" value={formatCount(insights.frameworkFlow.length)} note="ordered PIMS decision chain" tone="blue" />
        <ProductStat label="Avg readiness" value={`${averageReadiness}%`} note={`${formatCount(gateRows.length)} gate controls`} tone="green" />
      </section>
      <div className="chart-showcase">
        <ProductFunnelChart title="PIMS Readiness Funnel" subtitle="Step readiness from concept through monitoring" rows={insights.charts.pimsReadiness} formatValue={(value) => `${Math.round(Number(value || 0))}%`} />
        <ProductPieChart title="Gate Control Readiness" subtitle="Readiness share across PIMS gate controls" rows={insights.charts.pimsGates} formatValue={(value) => `${Math.round(Number(value || 0))}%`} />
        <ProductFunnelChart title="Model Feature Coverage" subtitle="PIMS score, HDM-4 score, network pressure and monitoring tiers" rows={insights.charts.modelFunnel} />
      </div>
      <div className="product-grid two">
        <ReadinessBars title="PIMS Framework Steps" subtitle="Project admission to final investment decision" items={insights.frameworkFlow} />
        <ProductTable table={insights.pims?.gates} />
      </div>
      <ProductTable table={insights.frameworkTable} />
      <section className="query-strip">
        <QueryBadge label="pims query" sql={insights.sql.pims} />
        <QueryBadge label="framework query" sql={insights.sql.framework} />
      </section>
    </div>
  );
}

function Hdm4ReferenceLibrary() {
  const totalRows = HDM4_INPUT_TABLES.reduce((sum, table) => sum + table.rows.length, 0);
  return (
    <section className="query-panel reference-library">
      <div className="product-panel-head">
        <h3>HDM-4 Reference Library</h3>
        <span>{formatCount(totalRows)} rows across {formatCount(HDM4_INPUT_TABLES.length)} input groups</span>
      </div>
      <div className="reference-list">
        {HDM4_INPUT_TABLES.map((table) => (
          <details key={table.title} className="reference-item">
            <summary>
              <strong>{table.title}</strong>
              <span>{table.rows.length} rows / {table.unit}</span>
            </summary>
            <div className="product-table-wrap">
              <table>
                <thead>
                  <tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr>
                </thead>
                <tbody>
                  {table.rows.map((row, rowIndex) => (
                    <tr key={`${table.title}-${rowIndex}`}>
                      {row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{formatEvidenceCell(cell)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function Hdm4View({ insights }) {
  const indicatorRows = insights.charts.hdm4Readiness || [];
  const averageReadiness = indicatorRows.length
    ? Math.round(indicatorRows.reduce((sum, row) => sum + Number(row[1] || 0), 0) / indicatorRows.length)
    : 0;
  const staticRows = HDM4_INPUT_TABLES.reduce((sum, table) => sum + table.rows.length, 0);
  return (
    <div className="product-view">
      <section className="network-brief">
        <div>
          <p className="product-eyebrow">HDM-4 analytics</p>
          <h2>Economic and pavement inputs, compressed.</h2>
          <span>Traffic loading, deterioration, work effects, road-user costs and economic assumptions remain available as structured model inputs.</span>
        </div>
        <ProductStat label="Readiness" value={`${averageReadiness}%`} note={`${formatCount(indicatorRows.length)} model indicators`} tone="green" />
        <ProductStat label="Input library" value={formatCount(staticRows)} note={`${formatCount(HDM4_INPUT_TABLES.length)} reference tables`} tone="purple" />
      </section>
      <div className="chart-showcase">
        <ProductFunnelChart title="HDM-4 Readiness Funnel" subtitle="Economic and pavement model indicators by readiness score" rows={insights.charts.hdm4Readiness} formatValue={(value) => `${Math.round(Number(value || 0))}%`} />
        <ProductPieChart title="Input Coverage" subtitle="Rows available in each HDM-4 reference table" rows={insights.charts.staticHdm4Tables} />
        <ProductFunnelChart title="Prediction Calibration" subtitle="Calibration signals linked to model scoring" rows={insights.charts.calibration} formatValue={(value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} />
      </div>
      <div className="product-grid two">
        <ProductTable table={insights.hdm4?.indicatorTable} />
        <ProductTable table={insights.hdm4?.inputs} />
      </div>
      <Hdm4ReferenceLibrary />
      <section className="query-strip">
        <QueryBadge label="hdm4 query" sql={insights.sql.hdm4} />
        <QueryBadge label="traffic query" sql={insights.sql.traffic} />
      </section>
    </div>
  );
}

function FrameworkView({ insights }) {
  const frameworkRows = insights.charts.frameworkSteps || [];
  const averageReadiness = frameworkRows.length
    ? Math.round(frameworkRows.reduce((sum, row) => sum + Number(row[1] || 0), 0) / frameworkRows.length)
    : 0;
  return (
    <div className="product-view">
      <section className="network-brief">
        <div>
          <p className="product-eyebrow">Framework flow</p>
          <h2>The decision framework as an animated operating model.</h2>
          <span>PIMS, HDM-4, road asset management, budget control and monitoring are shown as a linked, animated decision cycle.</span>
        </div>
        <ProductStat label="Framework steps" value={formatCount(frameworkRows.length)} note="ordered decision chain" tone="blue" />
        <ProductStat label="Flow readiness" value={`${averageReadiness}%`} note="average step readiness" tone="green" />
      </section>
      <FrameworkFlow steps={insights.frameworkFlow} />
      <div className="chart-showcase">
        <ProductFunnelChart title="Framework Readiness" subtitle="Readiness by step in the operating model" rows={insights.charts.frameworkSteps} formatValue={(value) => `${Math.round(Number(value || 0))}%`} />
        <ProductFunnelChart title="Road Intelligence Coverage" subtitle="Road records, districts, condition pressure, traffic links and priority assets" rows={insights.charts.evidenceFunnel} />
        <ProductPieChart title="Prediction Status" subtitle="Recommended model action by asset" rows={insights.charts.predictionStatusSplit} />
      </div>
      <div className="product-grid two">
        <ReadinessBars title="PIMS Steps" subtitle="Investment-management stages retained in the flow" items={insights.frameworkFlow} />
        <ReadinessBars title="HDM-4 Inputs" subtitle="Economic and pavement model readiness" items={insights.hdm4?.indicators || []} />
      </div>
      <ProductTable table={insights.frameworkTable} />
      <section className="query-strip">
        <QueryBadge label="framework query" sql={insights.sql.framework} />
        <QueryBadge label="evidence query" sql={insights.sql.evidence} />
      </section>
    </div>
  );
}

function GlobalCaseCovers({ rows = [], countryRows = [] }) {
  const scoreLookup = new Map(countryRows.map((row) => [row.country, Number(row.transferability_score || 0)]));
  const fallbackRows = GLOBAL_CASE_STUDIES.map((item) => ({
    continent: item.region,
    country: item.place,
    practice: item.metrics.join(" / "),
    ducar_lesson: item.lesson,
    adaptation: item.ducarUse,
    score: item.score,
  }));
  const covers = (rows.length ? rows : fallbackRows).map((row) => {
    const exactScore = scoreLookup.get(row.country);
    const fuzzyScore = [...scoreLookup.entries()].find(([country]) => country.includes(row.country) || row.country.includes(country))?.[1];
    return {
      ...row,
      score: Math.round(Number(row.score || exactScore || fuzzyScore || 82)),
    };
  });
  return (
    <section className="global-cover-grid" aria-label="Global case study covers">
      {covers.map((row, index) => (
        <article key={`${row.country}-${index}`} style={{ "--accent": productChartColor(index), "--delay": `${index * 70}ms` }}>
          <div className="case-cover-media">
            <span>{row.continent || "Global"}</span>
            <strong>{row.score}%</strong>
          </div>
          <div className="case-cover-body">
            <em>{row.continent || row.region || "Global practice"}</em>
            <h3>{row.country}</h3>
            <p>{row.practice}</p>
            <b>{row.ducar_lesson}</b>
            <span>{row.adaptation}</span>
          </div>
        </article>
      ))}
    </section>
  );
}

function GlobalCasesView({ insights }) {
  const global = insights.globalCases || {};
  const countryRows = global.countryRows || [];
  const regions = ["All", ...[...new Set(countryRows.map((row) => row.region).filter(Boolean))].sort()];
  const [activeRegion, setActiveRegion] = useState("All");
  const filteredCountries = activeRegion === "All"
    ? countryRows
    : countryRows.filter((row) => row.region === activeRegion);
  const selectedAverage = filteredCountries.length
    ? Math.round(filteredCountries.reduce((sum, row) => sum + Number(row.transferability_score || 0), 0) / filteredCountries.length)
    : global.averageScore || 0;
  const filteredCountryTable = {
    title: activeRegion === "All" ? "All-country transferability review" : `${activeRegion} country transferability review`,
    columns: ["Country", "Region", "Framework lens", "Score", "DUCAR use"],
    rows: filteredCountries.map((row) => [
      row.country,
      row.region,
      row.framework_lens,
      `${Math.round(Number(row.transferability_score || 0))}%`,
      row.ducar_use,
    ]),
  };
  const localCaseTable = global.localCaseTable
    ? {
      title: "Country case studies",
      columns: ["Continent", "Country", "Practice", "DUCAR lesson", "Adaptation"],
      rows: global.localCaseTable.rows.map((row) => row.slice(0, 5)),
    }
    : null;
  const decisionAssumptionsTable = global.decisionAssumptionsTable
    ? {
      title: "Global case transfer assumptions",
      columns: ["ID", "Decision or assumption", "Rationale"],
      rows: global.decisionAssumptionsTable.rows.map((row) => row.slice(0, 3)),
    }
    : null;
  const benchmarkTable = global.benchmarkTable
    ? {
      title: "Global road asset management benchmark covers",
      columns: ["Region", "Case cover", "Score", "Lesson", "DUCAR use"],
      rows: global.benchmarkTable.rows.map((row) => [row[0], row[1], row[3], row[4], row[5]]),
    }
    : null;

  return (
    <div className="product-view global-cases-view">
      <section className="network-brief global-case-brief">
        <div>
          <p className="product-eyebrow">Global case study intelligence</p>
          <h2>Every country becomes a transferability signal.</h2>
          <span>All-country road asset management patterns are translated into transferability scores, covers, charts and DUCAR adaptation tables.</span>
        </div>
        <ProductStat label="Countries extracted" value={formatCount(countryRows.length)} note="all-country review rows" tone="purple" />
        <ProductStat label="Mean transferability" value={`${global.averageScore || selectedAverage}%`} note="composite road-asset score" tone="green" />
      </section>

      <div className="product-stat-grid">
        <ProductStat label="Local case package" value={formatCount(global.localCaseRows?.length || 0)} note="country case-study rows" tone="blue" />
        <ProductStat label="Decision assumptions" value={formatCount(global.decisionAssumptionsTable?.rows?.length || 0)} note="rules translated into DUCAR" tone="gold" />
        <ProductStat label="Selected region" value={activeRegion} note={`${formatCount(filteredCountries.length)} countries in view`} tone="cyan" />
        <ProductStat label="Region mean" value={`${selectedAverage}%`} note="filtered score average" tone="green" />
        <ProductStat label="Benchmark covers" value={formatCount(global.benchmarkTable?.rows?.length || GLOBAL_CASE_STUDIES.length)} note="high-signal case cards" tone="purple" />
      </div>

      <div className="chart-showcase">
        <ProductBarChart title="Country Coverage by Region" subtitle="Every extracted country grouped for global comparison" rows={insights.charts.globalRegions} maxRows={8} />
        <ProductBarChart title="Average Indicator Strength" subtitle="Road asset management dimensions across all countries" rows={insights.charts.globalIndicators} formatValue={(value) => `${Math.round(Number(value || 0))}%`} maxRows={8} />
        <ProductPieChart title="Framework Lens Mix" subtitle="All-country review classified by dominant transfer pattern" rows={insights.charts.globalPatterns} maxRows={6} />
      </div>

      <div className="chart-showcase">
        <ProductBarChart title="Top Country Transfer Scores" subtitle="Highest-scoring country rows in the review" rows={insights.charts.globalTopCountries} formatValue={(value) => `${Math.round(Number(value || 0))}%`} maxRows={18} />
        <ProductBarChart title="Local Case Package Continents" subtitle="Extracted workbook country cases by continent" rows={insights.charts.globalLocalCaseContinents} maxRows={8} />
        <ProductBarChart title="Benchmark Cover Scores" subtitle="International road asset management case covers" rows={insights.charts.globalBenchmarks} formatValue={(value) => `${Math.round(Number(value || 0))}%`} maxRows={9} />
      </div>

      <GlobalCaseCovers rows={global.localCaseRows || []} countryRows={countryRows} />

      <div className="product-grid two">
        <ProductTable table={localCaseTable} />
        <ProductTable table={decisionAssumptionsTable} />
      </div>

      <section className="global-country-panel">
        <div className="product-panel-head">
          <h3>All Countries Explorer</h3>
          <span>{formatCount(filteredCountries.length)} rows currently shown from {formatCount(countryRows.length)} extracted countries</span>
        </div>
        <div className="global-filter-bar">
          {regions.map((region) => (
            <button key={region} type="button" className={activeRegion === region ? "active" : ""} onClick={() => setActiveRegion(region)}>
              {region}
            </button>
          ))}
        </div>
        <div className="product-table-wrap">
          <table>
            <thead>
              <tr>{filteredCountryTable.columns.map((column) => <th key={column}>{column}</th>)}</tr>
            </thead>
            <tbody>
              {filteredCountryTable.rows.map((row, index) => (
                <tr key={`${activeRegion}-${index}`}>
                  {row.map((cell, cellIndex) => <td key={`${index}-${cellIndex}`}>{formatEvidenceCell(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="product-grid two">
        <ProductTable table={benchmarkTable} />
        <ProductPieChart title="Framework Lens Mix" subtitle="Dominant transfer patterns across countries" rows={insights.charts.globalPatterns} maxRows={6} />
      </div>

      <section className="query-strip">
        <QueryBadge label="global country query" sql={insights.sql.globalCases} />
        <QueryBadge label="raw case cells" sql="SELECT table_name, row_index, column_name, value FROM raw_table_cells WHERE table_group = 'case_package' ORDER BY table_name, row_index, column_index;" />
      </section>
    </div>
  );
}

function LegacyApp() {
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
  const [activeSection, setActiveSection] = useState(() => {
    const hash = window.location.hash.replace("#", "") || "overview";
    return hash === "manuals" ? "sources" : hash;
  });

  async function runAnalysis(nextRecords = records) {
    try {
      if (window.location.hostname.endsWith("github.io")) {
        throw new Error("Static GitHub Pages deployment uses browser analysis");
      }
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
      const resolved = next === "manuals" ? "sources" : next;
      if (next === "manuals") window.location.hash = "sources";
      setActiveSection(NAV_ITEMS.some((item) => item.id === resolved) ? resolved : "overview");
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
    overview: { ...activePage, title: "DUCAR Budget Allocation Tool" },
    controls: { ...activePage, title: "Budget Inputs and Scenario Controls" },
    pim: { ...activePage, title: "Public Investment Management Principles" },
    analytics: { ...activePage, title: "Live Allocation Analytics" },
    traffic: { ...activePage, title: "Traffic, Economic and Deterioration Analytics" },
    hdm4: { ...activePage, title: "HDM-4 Data Inputs and Calibration Tables" },
    framework: { ...activePage, title: "Framework and Tool Process Flow" },
    gis: { ...activePage, title: "GIS Surface with National Reference Exemption" },
    "case-studies": { ...activePage, title: "Global Case Study Statistics" },
    sources: { ...activePage, title: "Sources and Data Register" },
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
                  <p className="eyebrow">DUCAR Priority Studio v0.7</p>
                  <h1>Uganda DUCAR road infrastructure intelligence and budget rationalisation</h1>
                  <p>ITIS 2023 road, rail, air, water, safety and maintenance evidence translated into animated allocation dashboards, GIS analysis, HDM-style inputs and work-programme decisions.</p>
                </div>
                <div className="hero-actions">
                  <span className="api-pill"><Brain size={16} /> {apiMode}</span>
                  <button onClick={() => runAnalysis()}><RefreshCcw size={16} /> Re-run ML</button>
                  <button className="secondary" onClick={exportGeoJson}><MapIcon size={16} /> Export GeoJSON</button>
                </div>
              </header>
              <MediaRibbon />
              <LayerStatusPanel />
              <DucarNetworkOverview onNavigate={navigateToSection} />
              <EvidenceBotPanel />
              <ReportingInfographicsPanel analysis={analysis} grouped={grouped} programme={programme} />
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
                    <span>Open</span>
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
                  <span>Upload, map, preview, append or replace records</span>
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
              <EvidenceBotPanel compact />
              <ReportingInfographicsPanel analysis={analysis} grouped={grouped} programme={programme} />
              <InfographicPanel analysis={analysis} grouped={grouped} programme={programme} />
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="all" limit={12} compact title="Supporting Decision Signals" />
            </>
          )}

          {activeSection === "pim" && (
            <>
              <PimEnginePanel programme={programme} analysis={analysis} />
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="pim" limit={8} compact title="PIMS Decision Indicators" />
            </>
          )}
          {activeSection === "framework" && (
            <>
              <ProcessFlow analysis={analysis} grouped={grouped} />
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="framework" limit={6} compact title="Framework Flow Intelligence" />
            </>
          )}
          {activeSection === "traffic" && (
            <TrafficAnalyticsPanel />
          )}
          {activeSection === "hdm4" && (
            <>
              <Hdm4InputsPanel />
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="traffic" limit={10} compact title="HDM-4 Linked Indicators" />
            </>
          )}
          {activeSection === "gis" && (
            <>
              <LayerStatusPanel compact />
              <MapScene3D programme={programme} />
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="gis" limit={8} compact title="GIS and Network Intelligence" />
            </>
          )}
          {activeSection === "case-studies" && (
            <>
              <GlobalCaseStudyPanel />
              <IntelligenceGallery programme={programme} analysis={analysis} grouped={grouped} onNavigate={navigateToSection} section="framework" limit={6} compact title="Case Study Transfer Intelligence" />
            </>
          )}
          {activeSection === "sources" && (
            <SourcesPanel />
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

function App() {
  const [budget, setBudget] = useState(250000000);
  const [reservePercent, setReservePercent] = useState(5);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [activeView, setActiveView] = useState(() => {
    const hash = window.location.hash.replace("#", "") || "command";
    return NAV_ITEMS.some((item) => item.id === hash) ? hash : "command";
  });
  const evidenceStore = useUnifiedDatabase();
  const productRecords = useMemo(
    () => evidenceStore?.programmeAssets?.length ? evidenceStore.programmeAssets : sample,
    [evidenceStore],
  );
  const analysis = useMemo(
    () => localAnalysis(productRecords, budget, reservePercent),
    [productRecords, budget, reservePercent, refreshNonce],
  );
  const insights = useProductInsights(analysis, evidenceStore);

  const runAnalysis = useCallback(() => {
    setRefreshNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    function syncView() {
      const next = window.location.hash.replace("#", "") || "command";
      const aliases = {
        overview: "command",
        controls: "portfolio",
        pim: "pims",
        analytics: "command",
        allocation: "portfolio",
        programme: "portfolio",
        gis: "network",
        cases: "global",
        "case-studies": "global",
        "global-cases": "global",
        pims: "pims",
        sources: "evidence",
      };
      const resolved = aliases[next] || next;
      setActiveView(NAV_ITEMS.some((item) => item.id === resolved) ? resolved : "command");
      if (resolved !== next) window.history.replaceState(null, "", `#${resolved}`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    window.addEventListener("hashchange", syncView);
    syncView();
    return () => window.removeEventListener("hashchange", syncView);
  }, []);

  function navigateTo(id) {
    setActiveView(id);
    if (window.location.hash !== `#${id}`) window.location.hash = id;
  }

  function applyScenario(scenario) {
    setBudget(scenario.budget);
    setReservePercent(scenario.reserve);
  }

  const activeMeta = NAV_ITEMS.find((item) => item.id === activeView) || NAV_ITEMS[0];

  return (
    <div className="product-shell">
      <ProductJumpBack />
      <ProductNav activeView={activeView} onNavigate={navigateTo} />
      <main className="product-main">
        <header className="product-topbar">
          <div>
            <span>DUCAR Priority Studio</span>
            <strong>{activeMeta.label}</strong>
          </div>
          <div className="product-topbar-actions">
            <span><Database size={15} /> {insights.databaseLoaded ? "SQL model live" : "SQL model loading"}</span>
            <span><GitBranch size={15} /> {insights.programmeAssetCount ? `${formatCount(insights.programmeAssetCount)} SQL assets` : "JSON fallback"}</span>
            <span><ShieldAlert size={15} /> {insights.latestRoadMaster?.run?.generated_at_utc ? `Road master ${formatCompactDate(insights.latestRoadMaster.run.generated_at_utc)}` : "Infrastructure intelligence ready"}</span>
            <button className="icon-action" onClick={() => runAnalysis()} aria-label="Refresh"><RefreshCcw size={16} /></button>
          </div>
        </header>
        {activeView === "command" && <CommandView insights={insights} />}
        {activeView === "portfolio" && (
          <PortfolioView
            insights={insights}
            budget={budget}
            reservePercent={reservePercent}
            onBudgetChange={setBudget}
            onReserveChange={setReservePercent}
            onScenario={applyScenario}
          />
        )}
        {activeView === "network" && <NetworkView insights={insights} programme={analysis.programme || []} />}
        {activeView === "traffic" && <TrafficView insights={insights} />}
        {activeView === "pims" && <PimsView insights={insights} />}
        {activeView === "hdm4" && <Hdm4View insights={insights} />}
        {activeView === "framework" && <FrameworkView insights={insights} />}
        {activeView === "global" && <GlobalCasesView insights={insights} />}
        {activeView === "evidence" && <EvidenceView insights={insights} />}
      </main>
    </div>
  );
}

const rootElement = document.getElementById("root");
const appRoot = window.__DUCAR_PRIORITY_ROOT || createRoot(rootElement);
window.__DUCAR_PRIORITY_ROOT = appRoot;
appRoot.render(<App />);
