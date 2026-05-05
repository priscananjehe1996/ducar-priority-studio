import assert from 'node:assert/strict';
import { priorityScore, prioritise } from '../src/prioritisation.js';
import sample from '../data/sample_assets.json' with { type: 'json' };

assert.equal(priorityScore(sample[0]) > 0, true);
const programme = prioritise(sample, 50000000);
assert.equal(programme[0].rank, 1);
assert.equal(programme.some((item) => item.status === 'Selected'), true);
console.log('DUCAR prioritisation tests passed');
