export const roadWeights = [25,20,15,15,10,10,5];
export const bridgeWeights = [30,25,10,15,10,5,5];

export const sourceReferences = [
  "Ministry of Finance, Planning and Economic Development. (2017). Public investment manual for project preparation and appraisal. The Republic of Uganda.",
  "Ministry of Works and Transport. (2018). Road design and construction manual: Volume V, low volume sealed roads. The Republic of Uganda.",
  "Ministry of Works and Transport. (2024). Integrated transport infrastructure services annual budget monitoring report FY 2023/24. The Republic of Uganda.",
  "Ministry of Works and Transport. (2026). Terms of reference for consultancy services for guidelines for monitoring road performance indicators for DUCAR.",
  "Ministry of Works and Transport. (2026). Terms of reference for consultancy services for road condition monitoring guidelines for DUCAR.",
  "Ministry of Works and Transport. (2026). Terms of reference for consultancy services for road asset management for DUCAR.",
];

export const policyGates = [
  {
    id: "ducar_scope",
    label: "DUCAR scope",
    test: (record) => !String(record.functionalClass || "").toLowerCase().includes("national"),
    sourceIndex: 5,
  },
  {
    id: "maintainability",
    label: "Maintenance eligibility",
    test: (record) => record.maintainable !== "No",
    sourceIndex: 2,
  },
  {
    id: "monitoring",
    label: "Condition monitoring evidence",
    test: (record) => Number(record.condition || 0) > 0 && Number(record.readiness || 0) > 0,
    sourceIndex: 4,
  },
  {
    id: "cost",
    label: "Cost reasonableness",
    test: (record) => Number(record.quantity || 0) > 0 && Number(record.unitRate || 0) > 0,
    sourceIndex: 0,
  },
  {
    id: "risk",
    label: "Safety and climate risk screen",
    test: (record) => Number(record.safety || 0) >= 3 || Number(record.climate || 0) >= 3,
    sourceIndex: 1,
  },
];

function numeric(value) {
  const next = Number(value);
  return Number.isFinite(next) ? next : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function evidenceReadiness(record) {
  const required = ["assetType", "assetId", "admin", "region", "functionalClass", "intervention", "surface", "condition", "traffic", "climate", "safety", "readiness", "quantity", "unitRate", "lat", "lon"];
  const present = required.filter((field) => {
    const value = record[field];
    return value !== undefined && value !== null && value !== "";
  }).length;
  return Math.round((present / required.length) * 100);
}

export function policyAssessment(record) {
  const passed = policyGates.filter((gate) => gate.test(record));
  const failed = policyGates.filter((gate) => !gate.test(record));
  const evidenceScore = evidenceReadiness(record);
  const triggerScore =
    numeric(record.condition) * 1.4 +
    numeric(record.criticality) * 1.2 +
    numeric(record.climate) * 1.1 +
    numeric(record.safety) * 1.1 +
    numeric(record.traffic) * 0.8 +
    numeric(record.equity) * 0.7 +
    numeric(record.readiness) * 0.6;
  const monitoringTier = triggerScore >= 30 ? "Monthly" : triggerScore >= 24 ? "Quarterly" : "Semi-annual";
  const sourceIndexes = [...new Set(passed.concat(failed).map((gate) => gate.sourceIndex))].sort((a, b) => a - b);
  return {
    evidenceScore,
    passedGates: passed.map((gate) => gate.label),
    failedGates: failed.map((gate) => gate.label),
    monitoringTier,
    sourceIndexes,
    sourceCitations: sourceIndexes.map((index) => sourceReferences[index]),
  };
}

export function priorityScore(record) {
  const weights = record.assetType === 'Bridge' ? bridgeWeights : roadWeights;
  const values = [record.condition, record.criticality, record.traffic, record.climate, record.safety, record.equity, record.readiness].map(Number);
  const base = values.reduce((sum, value, index) => sum + value * weights[index], 0) / 5;
  const assessment = policyAssessment(record);
  const evidenceBonus = assessment.evidenceScore >= 90 ? 6 : assessment.evidenceScore >= 75 ? 3 : -4;
  const referralPenalty = record.maintainable === "No" ? -18 : 0;
  const pimsBonus = numeric(record.readiness) >= 4 ? 4 : numeric(record.readiness) <= 2 ? -3 : 0;
  const ducarPenalty = String(record.functionalClass || "").toLowerCase().includes("national") ? -40 : 0;
  const sourceAdjusted = base + evidenceBonus + referralPenalty + pimsBonus + ducarPenalty;
  return Math.round(clamp(sourceAdjusted, 0, 100) * 100) / 100;
}

export function classify(record) {
  if (String(record.functionalClass || "").toLowerCase().includes("national")) return "Reference only";
  if (record.maintainable === 'No') return 'Referral';
  const cost = Number(record.quantity || 0) * Number(record.unitRate || 0);
  return cost > 0 ? 'Eligible' : 'Check cost';
}

export function enrichRecord(record) {
  const assessment = policyAssessment(record);
  const cost = Number(record.quantity || 0) * Number(record.unitRate || 0);
  return {
    ...record,
    cost,
    score: priorityScore(record),
    eligibility: classify(record),
    evidenceScore: assessment.evidenceScore,
    monitoringTier: assessment.monitoringTier,
    passedGates: assessment.passedGates,
    failedGates: assessment.failedGates,
    sourceCitations: assessment.sourceCitations,
  };
}

export function prioritise(records, budget) {
  let running = 0;
  return records.map(enrichRecord).sort((a, b) => b.score - a.score).map((record, index) => {
    let status = 'Deferred';
    if (record.eligibility === 'Referral') status = 'Referred';
    else if (record.eligibility === 'Eligible' && running + record.cost <= budget) {
      status = 'Selected';
      running += record.cost;
    } else if (record.eligibility !== 'Eligible') status = record.eligibility;
    return {...record, rank: index + 1, status};
  });
}

export function summarise(programme) {
  return programme.reduce((acc, item) => {
    acc.total += 1;
    acc.cost += item.cost || 0;
    acc[item.status] = (acc[item.status] || 0) + 1;
    acc.byRegion[item.region || "Unclassified"] = (acc.byRegion[item.region || "Unclassified"] || 0) + (item.cost || 0);
    acc.byClass[item.functionalClass || "Unclassified"] = (acc.byClass[item.functionalClass || "Unclassified"] || 0) + (item.cost || 0);
    acc.evidenceTotal += item.evidenceScore || 0;
    acc.monitoring[item.monitoringTier || "Unassigned"] = (acc.monitoring[item.monitoringTier || "Unassigned"] || 0) + 1;
    for (const gate of item.failedGates || []) acc.failedGates[gate] = (acc.failedGates[gate] || 0) + 1;
    return acc;
  }, { total: 0, cost: 0, Selected: 0, Deferred: 0, Referred: 0, "Check cost": 0, "Reference only": 0, byRegion: {}, byClass: {}, evidenceTotal: 0, monitoring: {}, failedGates: {} });
}
