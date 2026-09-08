/**
 * Money Panel — Google Apps Script backend.
 *
 * The spreadsheet this script is bound to is the database. Four tabs are used:
 *   Items      one row per expense occurrence (pending or paid)
 *   Months     one row per month: salary, typed-in bank balance, amount set aside
 *   Recurring  templates that are expanded into Items the first time a month is opened
 *   Settings   key/value: currency, categories
 *
 * The tabs are created automatically the first time the owner opens the web app.
 * Any other tabs in the spreadsheet are never touched.
 */

var SHEET_ITEMS = 'Items';
var SHEET_MONTHS = 'Months';
var SHEET_RECURRING = 'Recurring';
var SHEET_SETTINGS = 'Settings';

// Leave blank to treat the script owner (the account the web app executes as) as the editor.
// Set it to force a specific account, e.g. 'me@gmail.com'.
var OWNER_EMAIL = '';

// Defaults used until the owner changes them in the Settings tab.
var DEFAULT_CATEGORIES = ['Rent', 'Bills', 'School', 'Travel', 'Other', 'Planned'];
var INCOME = 'Income';

var ITEM_COLS = ['id', 'month', 'name', 'category', 'amount', 'status', 'paid_on', 'source', 'template', 'notes'];
var MONTH_COLS = ['month', 'salary', 'balance', 'balance_updated', 'expanded', 'reserve'];
var REC_COLS = ['id', 'name', 'category', 'amount', 'every_n_months', 'start_month', 'end_month', 'active'];
var SETTINGS_COLS = ['key', 'value'];

// ---------------------------------------------------------------------------
// Web app entry
// ---------------------------------------------------------------------------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Money Panel')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function getBootstrap() {
  var today = todayStr();
  var owner = isOwner_();
  var ready = !!ss_().getSheetByName(SHEET_ITEMS) && !!ss_().getSheetByName(SHEET_SETTINGS);
  if (!ready && owner) { setupSheets(); ready = true; }
  if (ready) ensureColumns_(SHEET_MONTHS, MONTH_COLS);
  var currency = ready ? setting_('currency', '') : '';
  return {
    isOwner: owner,
    email: activeEmail_(),
    today: today,
    currentMonth: today.slice(0, 7),
    categories: ready ? categories_() : DEFAULT_CATEGORIES,
    currency: currency,
    configured: !!currency,
    ready: ready
  };
}

/**
 * First-run setup from the welcome screen: currency, optional salary template and balance.
 * input: {currency, salary?, balance?}
 */
function completeSetup(input) {
  requireOwner_();
  input = input || {};
  var currency = String(input.currency || '').trim().toUpperCase().slice(0, 5);
  if (!currency) throw new Error('Currency is required');
  var month = todayStr().slice(0, 7);
  return withLock_(function () {
    setupSheets();
    setSetting_('currency', currency);
    if (!setting_('categories', '')) setSetting_('categories', DEFAULT_CATEGORIES.join(', '));
    var salary = num_(input.salary);
    if (salary > 0) {
      appendRow_(SHEET_RECURRING, REC_COLS, {
        id: uuid_(), name: 'Salary', category: INCOME, amount: salary,
        every_n_months: 1, start_month: month, end_month: '', active: 'yes'
      });
    }
    var m = ensureMonthRow_(month);
    if (salary > 0) m.salary = salary;
    if (input.balance !== '' && input.balance !== undefined && input.balance !== null) {
      m.balance = num_(input.balance); m.balance_updated = todayStr();
    }
    writeRow_(SHEET_MONTHS, MONTH_COLS, m);
    return getBootstrap();
  });
}

// ---------------------------------------------------------------------------
// Setup. Runs automatically on the owner's first visit; safe to re-run.
// ---------------------------------------------------------------------------

function setupSheets() {
  ensureSheet_(SHEET_ITEMS, ITEM_COLS, { month: '@', paid_on: '@' });
  ensureSheet_(SHEET_MONTHS, MONTH_COLS, { month: '@', balance_updated: '@' });
  ensureColumns_(SHEET_MONTHS, MONTH_COLS);
  ensureSheet_(SHEET_RECURRING, REC_COLS, { start_month: '@', end_month: '@' });
  ensureSheet_(SHEET_SETTINGS, SETTINGS_COLS, {});
  return 'ok';
}

/** Add any header columns that are missing (columns are only ever appended at the end). */
function ensureColumns_(name, cols) {
  var sh = sheet_(name);
  var have = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(function (v) { return String(v).trim(); });
  for (var i = 0; i < cols.length; i++) {
    if (have.indexOf(cols[i]) < 0) {
      sh.getRange(1, i + 1).setValue(cols[i]).setFontWeight('bold');
      have[i] = cols[i];
    }
  }
}

function ensureSheet_(name, cols, textCols) {
  var s = ss_();
  var sh = s.getSheetByName(name);
  if (sh) return sh;
  sh = s.insertSheet(name);
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  sh.setFrozenRows(1);
  Object.keys(textCols || {}).forEach(function (c) {
    var idx = cols.indexOf(c);
    if (idx >= 0) sh.getRange(2, idx + 1, sh.getMaxRows() - 1, 1).setNumberFormat(textCols[c]);
  });
  return sh;
}

// ---------------------------------------------------------------------------
// Read APIs
// ---------------------------------------------------------------------------

function getMonth(month) {
  month = normMonth_(month);
  requireReady_();
  var m = ensureMonth_(month);
  var items = itemsFor_(month);
  var pending = 0, paid = 0;
  items.forEach(function (it) {
    if (it.status === 'paid') paid += it.amount; else pending += it.amount;
  });
  var balance = m.balance === '' ? null : Number(m.balance);
  var reserveTotal = reserveTotal_(readRows_(SHEET_MONTHS, MONTH_COLS), month);
  return {
    month: month,
    salary: m.salary === '' ? null : Number(m.salary),
    balance: balance,
    balance_updated: m.balance_updated || '',
    reserve: m.reserve === '' ? 0 : Number(m.reserve),
    reserveTotal: reserveTotal,
    items: items,
    totals: { pending: pending, paid: paid },
    left: balance === null ? null : balance - pending - reserveTotal,
    isOwner: isOwner_()
  };
}

function getForecast(fromMonth, count) {
  fromMonth = normMonth_(fromMonth);
  count = Math.max(1, Math.min(24, Number(count) || 6));
  requireReady_();
  var cats = categories_();
  var templates = readRows_(SHEET_RECURRING, REC_COLS);
  var allItems = readRows_(SHEET_ITEMS, ITEM_COLS);
  var months = readRows_(SHEET_MONTHS, MONTH_COLS);
  var monthMap = {};
  months.forEach(function (m) { monthMap[m.month] = m; });

  var out = [];
  var running = null;
  for (var i = 0; i < count; i++) {
    var month = monthAdd_(fromMonth, i);
    var mrow = monthMap[month];
    var items = allItems.filter(function (it) { return it.month === month; });
    var projected = [];
    if (!mrow || mrow.expanded !== 'yes') {
      var have = {};
      items.forEach(function (it) { if (it.template) have[it.template] = true; });
      dueTemplates_(templates, month).forEach(function (t) {
        if (t.category === INCOME || have[t.id]) return;
        projected.push({ name: t.name, category: t.category, amount: t.amount, template: t.id, status: 'projected' });
      });
    }
    var salary = mrow && mrow.salary !== '' ? Number(mrow.salary) : salaryFromTemplates_(templates, month, months);
    var reserve = mrow && mrow.reserve !== '' ? Number(mrow.reserve) : (i === 0 ? 0 : assumedReserve_(months, month));
    var byCategory = {};
    cats.forEach(function (c) { byCategory[c] = 0; });
    var expenses = 0, pending = 0, paid = 0;
    items.concat(projected).forEach(function (it) {
      var c = cats.indexOf(it.category) >= 0 ? it.category : cats[cats.length - 1];
      byCategory[c] += it.amount;
      expenses += it.amount;
      if (it.status === 'paid') paid += it.amount; else pending += it.amount;
    });
    var net = salary - expenses - reserve;
    if (i === 0) {
      var bal = mrow && mrow.balance !== '' ? Number(mrow.balance) : null;
      running = bal === null ? net : bal - pending - reserveTotal_(months, month);
    } else {
      running += net;
    }
    out.push({
      month: month, salary: salary, expenses: expenses, pending: pending, paid: paid, reserve: reserve,
      byCategory: byCategory, net: net, running: running,
      expanded: !!(mrow && mrow.expanded === 'yes'),
      items: items.concat(projected).map(function (it) {
        return { id: it.id || '', name: it.name, category: it.category, amount: it.amount, status: it.status, template: it.template || '' };
      })
    });
  }
  return out;
}

function getPlanned() {
  requireReady_();
  var cur = todayStr().slice(0, 7);
  return readRows_(SHEET_ITEMS, ITEM_COLS)
    .filter(function (it) { return it.status !== 'paid' && it.source === 'manual' && it.month >= cur; })
    .sort(function (a, b) { return a.month < b.month ? -1 : a.month > b.month ? 1 : a.name.localeCompare(b.name); })
    .map(stripRow_);
}

function getRecurring() {
  requireReady_();
  return readRows_(SHEET_RECURRING, REC_COLS).map(stripRow_);
}

// ---------------------------------------------------------------------------
// Write APIs (owner only)
// ---------------------------------------------------------------------------

function addItem(input) {
  requireOwner_();
  requireReady_();
  var month = normMonth_(input.month);
  var amount = num_(input.amount);
  var name = String(input.name || '').trim();
  if (!name) throw new Error('Name is required');
  if (!(amount > 0)) throw new Error('Amount must be greater than zero');
  var cats = categories_();
  var category = cats.indexOf(input.category) >= 0 ? input.category : cats[cats.length - 1];

  return withLock_(function () {
    ensureMonthRow_(month);
    var templateId = '';
    if (input.recurring && Number(input.recurring.every_n_months) > 0) {
      templateId = uuid_();
      appendRow_(SHEET_RECURRING, REC_COLS, {
        id: templateId, name: name, category: category, amount: amount,
        every_n_months: Number(input.recurring.every_n_months), start_month: month, end_month: '', active: 'yes'
      });
    }
    var item = {
      id: uuid_(), month: month, name: name, category: category, amount: amount,
      status: 'pending', paid_on: '', source: templateId ? 'recurring' : 'manual',
      template: templateId, notes: String(input.notes || '')
    };
    appendRow_(SHEET_ITEMS, ITEM_COLS, item);
    if (templateId) materializeTemplate_(findRow_(SHEET_RECURRING, REC_COLS, templateId), month);
    return item;
  });
}

function updateItem(id, patch) {
  requireOwner_();
  return withLock_(function () {
    var row = findRow_(SHEET_ITEMS, ITEM_COLS, id);
    if (!row) throw new Error('Item not found');
    if (patch.name !== undefined) row.name = String(patch.name).trim() || row.name;
    if (patch.category !== undefined && categories_().indexOf(patch.category) >= 0) row.category = patch.category;
    if (patch.amount !== undefined) { var a = num_(patch.amount); if (a > 0) row.amount = a; }
    if (patch.month !== undefined) { row.month = normMonth_(patch.month); ensureMonthRow_(row.month); }
    if (patch.notes !== undefined) row.notes = String(patch.notes);
    writeRow_(SHEET_ITEMS, ITEM_COLS, row);
    return stripRow_(row);
  });
}

function markPaid(id, paid) {
  requireOwner_();
  return withLock_(function () {
    var row = findRow_(SHEET_ITEMS, ITEM_COLS, id);
    if (!row) throw new Error('Item not found');
    row.status = paid ? 'paid' : 'pending';
    row.paid_on = paid ? todayStr() : '';
    writeRow_(SHEET_ITEMS, ITEM_COLS, row);
    return stripRow_(row);
  });
}

function deleteItem(id) {
  requireOwner_();
  return withLock_(function () {
    var row = findRow_(SHEET_ITEMS, ITEM_COLS, id);
    if (!row) throw new Error('Item not found');
    deleteRow_(SHEET_ITEMS, row._row);
    return stripRow_(row);
  });
}

function setBalance(month, balance) {
  requireOwner_();
  month = normMonth_(month);
  return withLock_(function () {
    var m = ensureMonthRow_(month);
    m.balance = balance === '' || balance === null ? '' : num_(balance);
    m.balance_updated = todayStr();
    writeRow_(SHEET_MONTHS, MONTH_COLS, m);
    return getMonth(month);
  });
}

function setSalary(month, salary) {
  requireOwner_();
  month = normMonth_(month);
  return withLock_(function () {
    var m = ensureMonthRow_(month);
    m.salary = salary === '' || salary === null ? '' : num_(salary);
    writeRow_(SHEET_MONTHS, MONTH_COLS, m);
    return getMonth(month);
  });
}

/** Amount set aside (added to the reserve) in a month. Negative takes money back out. */
function setReserve(month, amount) {
  requireOwner_();
  month = normMonth_(month);
  return withLock_(function () {
    var m = ensureMonthRow_(month);
    m.reserve = amount === '' || amount === null ? '' : num_(amount);
    writeRow_(SHEET_MONTHS, MONTH_COLS, m);
    return getMonth(month);
  });
}

/**
 * Create or update a recurring template.
 * t: {id?, name, category, amount, every_n_months, start_month, end_month?, active?}
 * opts.applyToPending: also update name/category/amount on pending rows created from this
 *                      template for the current month onward.
 * A newly created template is also added, as pending rows, to any month from max(start, now)
 * onward that has already been opened (expanded); months not yet opened pick it up on open.
 */
function saveRecurring(t, opts) {
  requireOwner_();
  requireReady_();
  opts = opts || {};
  var name = String(t.name || '').trim();
  if (!name) throw new Error('Name is required');
  var amount = num_(t.amount);
  if (!(amount > 0)) throw new Error('Amount must be greater than zero');
  var every = Math.max(1, Math.round(Number(t.every_n_months) || 1));
  var cats = categories_();
  var category = t.category === INCOME || cats.indexOf(t.category) >= 0 ? t.category : cats[0];
  var start = normMonth_(t.start_month);
  var end = t.end_month ? normMonth_(t.end_month) : '';

  return withLock_(function () {
    var row = t.id ? findRow_(SHEET_RECURRING, REC_COLS, t.id) : null;
    var isNew = !row;
    if (isNew) row = { id: uuid_() };
    row.name = name; row.category = category; row.amount = amount;
    row.every_n_months = every; row.start_month = start; row.end_month = end;
    row.active = t.active === 'no' ? 'no' : 'yes';
    if (isNew) appendRow_(SHEET_RECURRING, REC_COLS, row); else writeRow_(SHEET_RECURRING, REC_COLS, row);

    var cur = todayStr().slice(0, 7);
    if (!isNew && opts.applyToPending && category !== INCOME) {
      readRows_(SHEET_ITEMS, ITEM_COLS).forEach(function (it) {
        if (it.template === row.id && it.status !== 'paid' && it.month >= cur) {
          it.name = name; it.category = category; it.amount = amount;
          writeRow_(SHEET_ITEMS, ITEM_COLS, it);
        }
      });
    }
    if (isNew && category !== INCOME) {
      materializeTemplate_(row, cur > start ? cur : start);
    }
    if (category === INCOME) {
      // Refresh salary on months from start onward that have no typed-in salary override.
      var templates = readRows_(SHEET_RECURRING, REC_COLS);
      var months = readRows_(SHEET_MONTHS, MONTH_COLS);
      months.forEach(function (mm) {
        if (mm.month >= start && mm.month >= cur) {
          mm.salary = salaryFromTemplates_(templates, mm.month, months);
          writeRow_(SHEET_MONTHS, MONTH_COLS, mm);
        }
      });
    }
    return stripRow_(row);
  });
}

/**
 * Stop a template after lastMonth (inclusive). Pending rows already created for later
 * months are removed. Paid rows and rows up to lastMonth are left untouched.
 */
function stopRecurring(id, lastMonth) {
  requireOwner_();
  lastMonth = normMonth_(lastMonth);
  return withLock_(function () {
    var row = findRow_(SHEET_RECURRING, REC_COLS, id);
    if (!row) throw new Error('Template not found');
    row.end_month = lastMonth;
    writeRow_(SHEET_RECURRING, REC_COLS, row);
    var doomed = readRows_(SHEET_ITEMS, ITEM_COLS).filter(function (it) {
      return it.template === id && it.status !== 'paid' && it.month > lastMonth;
    });
    // Delete bottom-up so row numbers stay valid.
    doomed.sort(function (a, b) { return b._row - a._row; }).forEach(function (it) { deleteRow_(SHEET_ITEMS, it._row); });
    return { template: stripRow_(row), removed: doomed.length };
  });
}

// ---------------------------------------------------------------------------
// Month expansion
// ---------------------------------------------------------------------------

/** Make sure a Months row exists, without expanding recurring templates into it. */
function ensureMonthRow_(month) {
  var m = findMonth_(month);
  if (m) return m;
  var templates = readRows_(SHEET_RECURRING, REC_COLS);
  var months = readRows_(SHEET_MONTHS, MONTH_COLS);
  m = { month: month, salary: salaryFromTemplates_(templates, month, months), balance: '', balance_updated: '', expanded: 'no', reserve: '' };
  appendRow_(SHEET_MONTHS, MONTH_COLS, m);
  return findMonth_(month);
}

/** Add pending rows for template t to every already-expanded month >= fromMonth where it is due. */
function materializeTemplate_(t, fromMonth) {
  if (!t || t.category === INCOME) return 0;
  var have = {};
  readRows_(SHEET_ITEMS, ITEM_COLS).forEach(function (it) { if (it.template === t.id) have[it.month] = true; });
  var added = 0;
  readRows_(SHEET_MONTHS, MONTH_COLS).forEach(function (m) {
    if (m.expanded !== 'yes' || m.month < fromMonth || have[m.month]) return;
    if (dueTemplates_([t], m.month).length === 0) return;
    appendRow_(SHEET_ITEMS, ITEM_COLS, {
      id: uuid_(), month: m.month, name: t.name, category: t.category, amount: t.amount,
      status: 'pending', paid_on: '', source: 'recurring', template: t.id, notes: ''
    });
    added++;
  });
  return added;
}

/** Make sure a Months row exists and recurring templates have been expanded into it. */
function ensureMonth_(month) {
  var templates = readRows_(SHEET_RECURRING, REC_COLS);
  var months = readRows_(SHEET_MONTHS, MONTH_COLS);
  var m = null;
  for (var i = 0; i < months.length; i++) if (months[i].month === month) { m = months[i]; break; }
  if (!m) {
    m = { month: month, salary: salaryFromTemplates_(templates, month, months), balance: '', balance_updated: '', expanded: 'no', reserve: '' };
    appendRow_(SHEET_MONTHS, MONTH_COLS, m);
    m = findMonth_(month);
  }
  if (m.expanded !== 'yes') {
    var existing = {};
    itemsFor_(month).forEach(function (it) { if (it.template) existing[it.template] = true; });
    dueTemplates_(templates, month).forEach(function (t) {
      if (t.category === INCOME || existing[t.id]) return;
      appendRow_(SHEET_ITEMS, ITEM_COLS, {
        id: uuid_(), month: month, name: t.name, category: t.category, amount: t.amount,
        status: 'pending', paid_on: '', source: 'recurring', template: t.id, notes: ''
      });
    });
    if (m.salary === '') m.salary = salaryFromTemplates_(templates, month, months);
    m.expanded = 'yes';
    writeRow_(SHEET_MONTHS, MONTH_COLS, m);
  }
  return m;
}

function dueTemplates_(templates, month) {
  return templates.filter(function (t) {
    if (t.active !== 'yes') return false;
    if (!t.start_month || month < t.start_month) return false;
    if (t.end_month && month > t.end_month) return false;
    var every = Math.max(1, Number(t.every_n_months) || 1);
    return monthDiff_(t.start_month, month) % every === 0;
  });
}

/** Sum of everything set aside in months up to and including `month`. */
function reserveTotal_(months, month) {
  var t = 0;
  months.forEach(function (m) { if (m.month <= month && m.reserve !== '') t += Number(m.reserve); });
  return t;
}

/** For a future month with no reserve entered, assume the most recent earlier month's amount. */
function assumedReserve_(months, month) {
  var best = null;
  months.forEach(function (m) { if (m.month < month && m.reserve !== '' && (!best || m.month > best.month)) best = m; });
  return best ? Number(best.reserve) : 0;
}

function salaryFromTemplates_(templates, month, months) {
  var sum = 0, any = false;
  dueTemplates_(templates, month).forEach(function (t) {
    if (t.category === INCOME) { sum += t.amount; any = true; }
  });
  if (any) return sum;
  // Fall back to the most recent earlier month that has a salary.
  var best = null;
  (months || []).forEach(function (m) {
    if (m.month < month && m.salary !== '' && (!best || m.month > best.month)) best = m;
  });
  return best ? Number(best.salary) : 0;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function setting_(key, dflt) {
  if (!ss_().getSheetByName(SHEET_SETTINGS)) return dflt;
  var rows = readRows_(SHEET_SETTINGS, SETTINGS_COLS);
  for (var i = 0; i < rows.length; i++) if (rows[i].key === key) return rows[i].value === '' ? dflt : rows[i].value;
  return dflt;
}

function setSetting_(key, value) {
  var rows = readRows_(SHEET_SETTINGS, SETTINGS_COLS);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === key) { rows[i].value = value; writeRow_(SHEET_SETTINGS, SETTINGS_COLS, rows[i]); return; }
  }
  appendRow_(SHEET_SETTINGS, SETTINGS_COLS, { key: key, value: value });
}

/** Expense categories, in display order. Edit the "categories" row in Settings to change them. */
function categories_() {
  var raw = String(setting_('categories', '') || '');
  var list = raw.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
  return list.length ? list : DEFAULT_CATEGORIES;
}

// ---------------------------------------------------------------------------
// Sheet access helpers
// ---------------------------------------------------------------------------

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" is missing. Open the web app as the owner once to create it.');
  return sh;
}

function requireReady_() { sheet_(SHEET_ITEMS); sheet_(SHEET_MONTHS); sheet_(SHEET_RECURRING); sheet_(SHEET_SETTINGS); }

function readRows_(name, cols) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    if (row.every(function (v) { return v === '' || v === null; })) continue;
    var obj = { _row: r + 2 };
    for (var c = 0; c < cols.length; c++) obj[cols[c]] = clean_(cols[c], row[c]);
    out.push(obj);
  }
  return out;
}

function clean_(col, v) {
  if (v === null || v === undefined) return '';
  if (col === 'amount' || col === 'salary' || col === 'balance' || col === 'every_n_months' || col === 'reserve') {
    return v === '' ? '' : num_(v);
  }
  if (col === 'month' || col === 'start_month' || col === 'end_month') {
    return v === '' ? '' : normMonth_(v);
  }
  if (col === 'paid_on' || col === 'balance_updated') {
    return v instanceof Date ? fmtDate_(v) : String(v);
  }
  return String(v).trim();
}

function appendRow_(name, cols, obj) {
  var sh = sheet_(name);
  sh.appendRow(cols.map(function (c) { return obj[c] === undefined ? '' : obj[c]; }));
  obj._row = sh.getLastRow();
  return obj;
}

function writeRow_(name, cols, obj) {
  sheet_(name).getRange(obj._row, 1, 1, cols.length)
    .setValues([cols.map(function (c) { return obj[c] === undefined ? '' : obj[c]; })]);
}

function deleteRow_(name, rowIndex) { sheet_(name).deleteRow(rowIndex); }

function findRow_(name, cols, id) {
  var rows = readRows_(name, cols);
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
  return null;
}

function findMonth_(month) {
  var rows = readRows_(SHEET_MONTHS, MONTH_COLS);
  for (var i = 0; i < rows.length; i++) if (rows[i].month === month) return rows[i];
  return null;
}

function itemsFor_(month) {
  return readRows_(SHEET_ITEMS, ITEM_COLS)
    .filter(function (it) { return it.month === month; })
    .map(stripRow_);
}

function stripRow_(obj) {
  var o = {};
  Object.keys(obj).forEach(function (k) { if (k !== '_row') o[k] = obj[k]; });
  return o;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function activeEmail_() {
  try { return (Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { return ''; }
}

function isOwner_() {
  var active = activeEmail_();
  var owner = (OWNER_EMAIL || Session.getEffectiveUser().getEmail() || '').toLowerCase();
  return !!active && !!owner && active === owner;
}

function requireOwner_() {
  if (!isOwner_()) throw new Error('View only: this account cannot make changes.');
}

// ---------------------------------------------------------------------------
// Date and number helpers
// ---------------------------------------------------------------------------

function tz_() { return Session.getScriptTimeZone() || 'Etc/UTC'; }

function fmtDate_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'); }

function todayStr() { return fmtDate_(new Date()); }

function normMonth_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM');
  var s = String(v || '').trim();
  var m = s.match(/^(\d{4})-(\d{1,2})/);
  if (!m) throw new Error('Bad month: ' + s);
  var mm = Number(m[2]);
  if (mm < 1 || mm > 12) throw new Error('Bad month: ' + s);
  return m[1] + '-' + (mm < 10 ? '0' : '') + mm;
}

function monthAdd_(month, n) {
  var p = month.split('-');
  var y = Number(p[0]), m = Number(p[1]) - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + '-' + (m + 1 < 10 ? '0' : '') + (m + 1);
}

function monthDiff_(a, b) {
  var pa = a.split('-'), pb = b.split('-');
  return (Number(pb[0]) - Number(pa[0])) * 12 + (Number(pb[1]) - Number(pa[1]));
}

function num_(v) {
  if (typeof v === 'number') return v;
  var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function uuid_() { return Utilities.getUuid(); }
