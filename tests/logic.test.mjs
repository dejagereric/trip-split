import assert from 'node:assert/strict';
import { cents, splitEqual, computeBalances, minimalTransfers } from '../js/logic.js';

const IDS = ['A', 'B', 'C'];
const entries = [
  { kind: 'expense', amount: 186000, payer: 'A', shares: { A: 62000, B: 62000, C: 62000 } },
  { kind: 'expense', amount: 41250, payer: 'B', shares: { A: 13750, B: 13750, C: 13750 } },
  { kind: 'expense', amount: 9630, payer: 'C', shares: { A: 3210, B: 3210, C: 3210 } },
  { kind: 'expense', amount: 14800, payer: 'B', shares: { B: 7400, C: 7400 } },
  { kind: 'expense', amount: 9000, payer: 'C', shares: { A: 4500, C: 4500 } },
  { kind: 'expense', amount: 21000, payer: 'C', shares: { B: 14000, C: 7000 } },
  { kind: 'payment', amount: 20000, from: 'C', to: 'A' },
];

assert.equal(cents('12.345'), 1235);
assert.equal(cents('$1,234.50'), 123450);
assert.equal(cents(''), 0);
assert.deepEqual(splitEqual(1000, ['A', 'B', 'C']), { A: 334, B: 333, C: 333 });

const { b, net, total, expCount } = computeBalances(entries, IDS);
assert.equal(total, 281680);
assert.equal(expCount, 6);
assert.deepEqual([b.A.paid, b.B.paid, b.C.paid], [186000, 56050, 39630]);
assert.deepEqual([b.A.share, b.B.share, b.C.share], [83460, 100360, 97860]);
assert.deepEqual(net, { A: 82540, B: -44310, C: -38230 });
assert.equal(net.A + net.B + net.C, 0);

const tr = minimalTransfers(net, IDS);
assert.deepEqual(tr, [{ from: 'B', to: 'A', amount: 44310 }, { from: 'C', to: 'A', amount: 38230 }]);

// After recording those payments everyone is square.
const settled = entries.concat(tr.map((t) => ({ kind: 'payment', ...t })));
const after = computeBalances(settled, IDS);
assert.deepEqual(after.net, { A: 0, B: 0, C: 0 });
assert.equal(minimalTransfers(after.net, IDS).length, 0);

console.log('logic tests passed');

// currency conversion
import { convert, convertShares } from '../js/logic.js';
assert.equal(convert(9000, 1.1237), 10113);
const cs = convertShares({ A: 3333, B: 3333, C: 3334 }, 1.1237, convert(10000, 1.1237));
assert.equal(Object.values(cs).reduce((a, b) => a + b, 0), 11237);
assert.deepEqual(convertShares({ A: 5000 }, 0.5, 2500), { A: 2500 });
console.log('currency tests passed');
