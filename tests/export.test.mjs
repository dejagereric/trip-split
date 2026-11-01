import assert from 'node:assert/strict';
import { toCsv } from '../js/export.js';

const one = (v) => toCsv([[v]]);

// Text that a spreadsheet would run as a formula is turned into plain text.
assert.equal(one('=HYPERLINK("http://example.com","click")'), `"'=HYPERLINK(""http://example.com"",""click"")"`);
assert.equal(one('=1+1'), "'=1+1");
assert.equal(one('+1 guest'), "'+1 guest");
assert.equal(one('-cmd'), "'-cmd");
assert.equal(one('@SUM(A1)'), "'@SUM(A1)");
assert.equal(one('\tTab'), "'\tTab");
assert.equal(one('\r=1+1'), `"'\r=1+1"`);

// Ordinary text and numbers are unchanged; negative numbers stay numbers.
assert.equal(one('Dinner at the harbor'), 'Dinner at the harbor');
assert.equal(one('Fuel, water'), '"Fuel, water"');
assert.equal(one('Say "ciao"'), '"Say ""ciao"""');
assert.equal(one('a = b'), 'a = b');
assert.equal(one(-12.5), '-12.5');
assert.equal(one(1860), '1860');
assert.equal(one(null), '');
assert.equal(one(undefined), '');

// Rows and columns.
assert.equal(toCsv([['Date', 'Description'], ['2026-10-17', '=bad'], ['2026-10-18', 'Ferry']]),
  "Date,Description\r\n2026-10-17,'=bad\r\n2026-10-18,Ferry");

console.log('export tests passed');
