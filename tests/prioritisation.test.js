import assert from 'node:assert/strict';
import { priorityScore, prioritise, summarise } from '../src/prioritisation.js';
import sample from '../data/sample_assets.json' with { type: 'json' };

assert.equal(priorityScore(sample[0]) > 0, true);
const programme = prioritise(sample, 50000000);
assert.equal(programme[0].rank, 1);
assert.equal(programme.some((item) => item.status === 'Selected'), true);
const summary = summarise(programme);
assert.equal(summary.total, sample.length);
assert.equal(Object.keys(summary.byRegion).length > 0, true);
assert.equal(Object.keys(summary.byClass).length > 0, true);
console.log('DUCAR prioritisation tests passed');
