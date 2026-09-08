/**
 * Minimal in-memory shim of the Apps Script globals that Code.gs uses, so the real backend
 * can run in a browser preview or in Node for tests. Not a full emulation.
 */
(function (root) {
  function Range(sheet, r, c, nr, nc) { this.s = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  Range.prototype.getValues = function () {
    var out = [];
    for (var i = 0; i < this.nr; i++) {
      var row = [];
      for (var j = 0; j < this.nc; j++) {
        var line = this.s.rows[this.r - 1 + i] || [];
        row.push(line[this.c - 1 + j] === undefined ? '' : line[this.c - 1 + j]);
      }
      out.push(row);
    }
    return out;
  };
  Range.prototype.setValues = function (vals) {
    for (var i = 0; i < vals.length; i++) {
      while (this.s.rows.length < this.r + i) this.s.rows.push([]);
      var line = this.s.rows[this.r - 1 + i];
      for (var j = 0; j < vals[i].length; j++) line[this.c - 1 + j] = vals[i][j];
    }
    return this;
  };
  Range.prototype.setValue = function (v) { return this.setValues([[v]]); };
  Range.prototype.setFontWeight = function () { return this; };
  Range.prototype.setNumberFormat = function () { return this; };

  function Sheet(name) { this.name = name; this.rows = []; }
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.getLastRow = function () {
    var last = 0;
    for (var i = 0; i < this.rows.length; i++) {
      if (this.rows[i].some(function (v) { return v !== '' && v !== undefined && v !== null; })) last = i + 1;
    }
    return last;
  };
  Sheet.prototype.getMaxRows = function () { return Math.max(1000, this.rows.length); };
  Sheet.prototype.getLastColumn = function () { return this.rows.reduce(function (a, r) { return Math.max(a, r.length); }, 0); };
  Sheet.prototype.getRange = function (r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); };
  Sheet.prototype.appendRow = function (vals) { this.rows.push(vals.slice()); return this; };
  Sheet.prototype.deleteRow = function (r) { this.rows.splice(r - 1, 1); return this; };
  Sheet.prototype.setFrozenRows = function () { return this; };

  function Spreadsheet() { this.sheets = {}; }
  Spreadsheet.prototype.getSheetByName = function (n) { return this.sheets[n] || null; };
  Spreadsheet.prototype.insertSheet = function (n) { this.sheets[n] = new Sheet(n); return this.sheets[n]; };

  var book = new Spreadsheet();
  var user = { email: 'owner@example.com', active: 'owner@example.com' };

  root.SpreadsheetApp = { getActiveSpreadsheet: function () { return book; } };
  root.Session = {
    getActiveUser: function () { return { getEmail: function () { return user.active; } }; },
    getEffectiveUser: function () { return { getEmail: function () { return user.email; } }; },
    getScriptTimeZone: function () { return 'Etc/UTC'; }
  };
  root.LockService = {
    getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; }
  };
  root.Utilities = {
    getUuid: function () {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
      });
    },
    formatDate: function (d, tz, pattern) {
      var y = d.getFullYear(), m = ('0' + (d.getMonth() + 1)).slice(-2), day = ('0' + d.getDate()).slice(-2);
      return pattern === 'yyyy-MM' ? y + '-' + m : y + '-' + m + '-' + day;
    }
  };
  root.HtmlService = {
    createHtmlOutputFromFile: function () {
      var o = { setTitle: function () { return o; }, addMetaTag: function () { return o; } };
      return o;
    }
  };
  root.__gasShim = {
    book: book,
    setViewer: function (email) { user.active = email; },
    dump: function () {
      var out = {};
      Object.keys(book.sheets).forEach(function (n) { out[n] = book.sheets[n].rows; });
      return out;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
