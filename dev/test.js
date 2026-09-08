// Runs the real Code.gs against the in-memory shim. Usage: node dev/test.js
var fs = require('fs'), path = require('path'), vm = require('vm');
var assert = require('assert');
var root = path.join(__dirname, '..');
var ctx = vm.createContext({ console: console, Date: Date, Math: Math, Number: Number, String: String, Object: Object, Array: Array, Error: Error, isNaN: isNaN });
vm.runInContext(fs.readFileSync(path.join(__dirname, 'gas-shim.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'Code.gs'), 'utf8'), ctx);
var g = ctx;

function names(items) { return Array.prototype.slice.call(items).map(function (i) { return i.name; }).sort().join(','); }
function byName(items, n) { return Array.prototype.slice.call(items).filter(function (i) { return i.name === n; })[0]; }

// First open as owner creates the tabs; nothing is configured yet.
var boot = g.getBootstrap();
assert.strictEqual(boot.isOwner, true);
assert.strictEqual(boot.ready, true);
assert.strictEqual(boot.configured, false);
assert.ok(g.__gasShim.book.sheets.Settings, 'settings tab created');
var cur = boot.currentMonth;

// Welcome flow.
boot = g.completeSetup({ currency: 'usd', salary: 5200, balance: 5200 });
assert.strictEqual(boot.currency, 'USD');
assert.strictEqual(boot.configured, true);
assert.strictEqual(boot.categories.join(','), 'Rent,Bills,School,Travel,Other,Planned');
console.log('setup ok', cur);

// Templates.
[['Rent', 'Rent', 1500, 2], ['Electricity', 'Bills', 120, 1], ['Water', 'Bills', 40, 1], ['Internet', 'Bills', 60, 1], ['Phone', 'Bills', 45, 1], ['Insurance', 'Bills', 90, 1]]
  .forEach(function (t) { g.saveRecurring({ name: t[0], category: t[1], amount: t[2], every_n_months: t[3], start_month: cur }); });

var m = g.getMonth(cur);
assert.strictEqual(names(m.items), 'Electricity,Insurance,Internet,Phone,Rent,Water');
assert.strictEqual(m.salary, 5200);
assert.strictEqual(m.balance, 5200);
assert.strictEqual(m.totals.pending, 1500 + 120 + 40 + 60 + 45 + 90);
assert.strictEqual(m.left, 5200 - m.totals.pending);
assert.strictEqual(g.getMonth(cur).items.length, 6, 'reopening does not duplicate');
console.log('month expanded ok, left =', m.left);

var next = g.monthAdd_(cur, 1);
var n = g.getMonth(next);
assert.strictEqual(names(n.items), 'Electricity,Insurance,Internet,Phone,Water', 'rent is every 2 months');
assert.strictEqual(n.balance, null);
assert.strictEqual(n.salary, 5200);

// Mark paid keeps the row and lowers pending.
var elec = byName(m.items, 'Electricity');
g.markPaid(elec.id, true);
var m2 = g.getMonth(cur);
assert.strictEqual(m2.totals.paid, 120);
assert.strictEqual(m2.left, 5200 - (m.totals.pending - 120));
assert.strictEqual(byName(m2.items, 'Electricity').status, 'paid');
console.log('mark paid ok');

// Manual + recurring adds.
g.addItem({ month: g.monthAdd_(cur, 2), name: 'Fridge', category: 'Planned', amount: 900 });
var gym = g.addItem({ month: cur, name: 'Gym', category: 'Bills', amount: 45, recurring: { every_n_months: 1 } });
assert.strictEqual(gym.source, 'recurring');
assert.strictEqual(names(g.getPlanned()), 'Fridge');
assert.strictEqual(byName(g.getMonth(cur).items, 'Gym').amount, 45);
assert.ok(byName(g.getMonth(next).items, 'Gym'), 'added to the already-opened next month too');
assert.strictEqual(g.addItem({ month: cur, name: 'Odd', category: 'Nope', amount: 1 }).category, 'Planned', 'unknown category falls back to the last one');
console.log('add item ok');

// Forecast.
var fc = g.getForecast(cur, 6);
var m3 = g.getMonth(cur);
assert.strictEqual(fc.length, 6);
assert.strictEqual(fc[0].running, m3.left);
assert.strictEqual(fc[2].expanded, false);
assert.ok(byName(fc[2].items, 'Rent') && byName(fc[2].items, 'Rent').status === 'projected');
assert.ok(byName(fc[2].items, 'Fridge'));
assert.ok(!byName(fc[3].items, 'Rent'));
assert.strictEqual(fc[1].running, fc[0].running + fc[1].net);
console.log('forecast ok');

// Stop water after this month.
var water = byName(g.getRecurring(), 'Water');
assert.strictEqual(g.stopRecurring(water.id, cur).removed, 1);
assert.ok(byName(g.getMonth(cur).items, 'Water'));
assert.ok(!byName(g.getMonth(next).items, 'Water'));
assert.ok(!byName(g.getForecast(cur, 4)[3].items, 'Water'));
console.log('stop recurring ok');

// Delete from one month only.
g.deleteItem(byName(g.getMonth(next).items, 'Internet').id);
assert.ok(!byName(g.getMonth(next).items, 'Internet'));
assert.ok(byName(g.getMonth(cur).items, 'Internet'));
assert.ok(byName(g.getMonth(g.monthAdd_(cur, 2)).items, 'Internet'));
console.log('delete single month ok');

// Edit template with applyToPending: paid rows untouched.
var elecT = byName(g.getRecurring(), 'Electricity');
g.saveRecurring({ id: elecT.id, name: 'Electricity', category: 'Bills', amount: 130, every_n_months: 1, start_month: elecT.start_month }, { applyToPending: true });
assert.strictEqual(byName(g.getMonth(cur).items, 'Electricity').amount, 120);
assert.strictEqual(byName(g.getMonth(next).items, 'Electricity').amount, 130);
console.log('edit template ok');

// New template lands in opened months and is projected in unopened ones.
g.saveRecurring({ name: 'Streaming', category: 'Bills', amount: 12, every_n_months: 1, start_month: cur });
assert.ok(byName(g.getMonth(cur).items, 'Streaming'));
assert.ok(byName(g.getMonth(next).items, 'Streaming'));
assert.strictEqual(byName(g.getForecast(cur, 4)[3].items, 'Streaming').status, 'projected');
console.log('new template ok');

// Balance, salary, reserve.
g.setBalance(cur, 4000);
assert.strictEqual(g.getMonth(cur).balance, 4000);
g.setSalary(next, 5500);
assert.strictEqual(g.getMonth(next).salary, 5500);
g.setReserve(g.monthAdd_(cur, -1), 300);
g.setReserve(cur, 200);
var mr = g.getMonth(cur);
assert.strictEqual(mr.reserveTotal, 500);
assert.strictEqual(mr.left, 4000 - mr.totals.pending - 500);
var fr = g.getForecast(cur, 3);
assert.strictEqual(fr[0].running, mr.left);
assert.strictEqual(fr[1].reserve, 200, 'future month assumes the latest set-aside');
assert.strictEqual(fr[1].running, fr[0].running + fr[1].salary - fr[1].expenses - 200);
g.setReserve(cur, -100);
assert.strictEqual(g.getMonth(cur).reserveTotal, 200);
console.log('balance / salary / reserve ok');

// Custom categories via Settings.
g.setSetting_('categories', 'Home, Utilities, Fun');
assert.strictEqual(g.getBootstrap().categories.join(','), 'Home,Utilities,Fun');
assert.strictEqual(g.addItem({ month: cur, name: 'Cinema', category: 'Fun', amount: 20 }).category, 'Fun');
console.log('custom categories ok');

// Older Months tab without the reserve column gets it added.
var msh = g.__gasShim.book.sheets.Months;
msh.rows[0] = msh.rows[0].slice(0, 5);
g.getBootstrap();
assert.strictEqual(msh.rows[0][5], 'reserve');
console.log('column migration ok');

// Viewer cannot write, can read.
g.__gasShim.setViewer('someone@else.com');
assert.strictEqual(g.getBootstrap().isOwner, false);
assert.throws(function () { g.markPaid(elec.id, false); }, /View only/);
assert.throws(function () { g.completeSetup({ currency: 'EUR' }); }, /View only/);
assert.ok(g.getMonth(cur).items.length > 0);
console.log('viewer guard ok');

// Dates coming back from the sheet as Date objects are normalised.
g.__gasShim.setViewer('owner@example.com');
msh.rows[1][0] = new Date(2026, 8, 1);
assert.strictEqual(g.getMonth('2026-09').month, '2026-09');
console.log('date normalisation ok');

console.log('\nALL TESTS PASSED');
