export const roadWeights = [25,20,15,15,10,10,5];
export const bridgeWeights = [30,25,10,15,10,5,5];

export function priorityScore(record) {
  const weights = record.assetType === 'Bridge' ? bridgeWeights : roadWeights;
  const values = [record.condition, record.criticality, record.traffic, record.climate, record.safety, record.equity, record.readiness].map(Number);
  return Math.round(values.reduce((sum, value, index) => sum + value * weights[index], 0) / 5 * 100) / 100;
}

export function classify(record) {
  if (record.maintainable === 'No') return 'Referral';
  const cost = Number(record.quantity || 0) * Number(record.unitRate || 0);
  return cost > 0 ? 'Eligible' : 'Check cost';
}

export function prioritise(records, budget) {
  let running = 0;
  return records.map((record) => ({
    ...record,
    cost: Number(record.quantity || 0) * Number(record.unitRate || 0),
    score: priorityScore(record),
    eligibility: classify(record),
  })).sort((a, b) => b.score - a.score).map((record, index) => {
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
    return acc;
  }, { total: 0, cost: 0, Selected: 0, Deferred: 0, Referred: 0, "Check cost": 0, byRegion: {}, byClass: {} });
}
