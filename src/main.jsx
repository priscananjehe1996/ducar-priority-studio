import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Brain,
  CircleDollarSign,
  GitBranch,
  Layers,
  Map,
  RefreshCcw,
  Route,
  ShieldAlert,
} from "lucide-react";
import sample from "../data/sample_assets.json";
import { prioritise, summarise } from "./prioritisation.js";
import "./styles.css";

const currency = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

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
    ml: { model: "Browser fallback risk model", note: "Start Python API for deeper NumPy MLP/geospatial analysis." },
    geospatial: {
      hotspots: [],
      nearestBridge: {},
      bbox: {
        minLat: Math.min(...programme.map((p) => p.lat)),
        maxLat: Math.max(...programme.map((p) => p.lat)),
        minLon: Math.min(...programme.map((p) => p.lon)),
        maxLon: Math.max(...programme.map((p) => p.lon)),
      },
    },
  };
}

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

function MapPanel({ programme, geospatial }) {
  const bbox = geospatial?.bbox || { minLat: -1, maxLat: 4, minLon: 29, maxLon: 35 };
  const width = 760;
  const height = 420;
  const project = (lat, lon) => {
    const x = ((lon - bbox.minLon) / Math.max(0.001, bbox.maxLon - bbox.minLon)) * (width - 80) + 40;
    const y = height - (((lat - bbox.minLat) / Math.max(0.001, bbox.maxLat - bbox.minLat)) * (height - 80) + 40);
    return [x, y];
  };
  return (
    <section className="panel map-panel">
      <div className="panel-title">
        <Map size={18} />
        <h2>Geospatial Risk Surface</h2>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="DUCAR geospatial risk map">
        <rect x="0" y="0" width={width} height={height} rx="18" className="map-bg" />
        {[...Array(8)].map((_, i) => (
          <line key={`v${i}`} x1={40 + i * 94} x2={40 + i * 94} y1="35" y2="385" className="grid-line" />
        ))}
        {[...Array(5)].map((_, i) => (
          <line key={`h${i}`} x1="35" x2="725" y1={55 + i * 75} y2={55 + i * 75} className="grid-line" />
        ))}
        {geospatial?.hotspots?.map((h) => {
          const [x, y] = project(h.lat, h.lon);
          return (
            <g key={h.cluster}>
              <circle cx={x} cy={y} r={24 + h.averageRisk * 24} className="hotspot" />
              <text x={x} y={y + 4} className="hotspot-label">{h.cluster}</text>
            </g>
          );
        })}
        {programme.map((p) => {
          const [x, y] = project(p.lat, p.lon);
          return (
            <g key={p.assetId}>
              <circle cx={x} cy={y} r={p.assetType === "Bridge" ? 7 : 5} className={`asset ${p.status}`} />
              <text x={x + 9} y={y - 7} className="asset-label">{p.assetId}</text>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span><i className="dot selected" /> Selected</span>
        <span><i className="dot deferred" /> Deferred</span>
        <span><i className="dot referred" /> Referred</span>
        <span><i className="halo" /> ML hotspot</span>
      </div>
    </section>
  );
}

function App() {
  const [records, setRecords] = useState(sample);
  const [budget, setBudget] = useState(250000000);
  const [reservePercent, setReservePercent] = useState(5);
  const [analysis, setAnalysis] = useState(() => localAnalysis(sample, 250000000, 5));
  const [apiMode, setApiMode] = useState("checking");
  const [filter, setFilter] = useState("All");

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

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">DUCAR Priority Studio v0.3</p>
          <h1>Dynamic ML and Geospatial Budget Allocation Tool</h1>
          <p>
            React interface, Python NumPy ML risk scoring, geospatial clustering, budget rationalisation by region,
            district and functional classification, and GIS-ready outputs.
          </p>
        </div>
        <div className="hero-actions">
          <span className="api-pill"><Brain size={16} /> {apiMode}</span>
          <button onClick={() => runAnalysis()}><RefreshCcw size={16} /> Re-run ML</button>
          <button className="secondary" onClick={exportGeoJson}><Map size={16} /> Export GeoJSON</button>
        </div>
      </header>

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

      <section className="metrics-grid">
        <Metric icon={CircleDollarSign} label="Net budget" value={`UGX ${currency.format(analysis.netBudget || 0)}`} />
        <Metric icon={Activity} label="Selected cost" value={`UGX ${currency.format(analysis.summary?.selectedCost || 0)}`} tone="green" />
        <Metric icon={ShieldAlert} label="High ML risk assets" value={analysis.summary?.highRisk || 0} tone="red" />
        <Metric icon={Layers} label="Regions / classes" value={grouped.length} tone="gold" />
      </section>

      <main className="dashboard-grid">
        <MapPanel programme={programme} geospatial={analysis.geospatial} />

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

        <section className="panel wide">
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
                  <th>Priority</th>
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
                    <td>{p.score}</td>
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
  );
}

createRoot(document.getElementById("root")).render(<App />);
