/* K4-hjälpen – beräkningsmotor.
 *
 * Allt räknas lokalt i webbläsaren. Motorn tar normaliserade händelser
 * (köp, försäljningar, kassaflöden på valutakonto) och räknar fram
 * rader till bilaga K4 enligt:
 *  - genomsnittsmetoden (48 kap. 7 § IL) för värdepapper,
 *  - schablonmetoden (20 % av försäljningspriset) som tillval för marknadsnoterade aktier,
 *  - Skatteverkets regel för amortering av fordran i utländsk valuta (valutakonto):
 *    vinst eller förlust uppstår först när omkostnadsbeloppet är förbrukat
 *    eller kontot har tömts (Rättslig vägledning 2026, "Fordringar i utländsk valuta").
 *  - Riksbankens publicerade kurs för dagen, eller senast publicerade kurs före.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.K4Engine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var EPS = 1e-9;

  // ---------- Datum ----------
  function addDays(iso, n) {
    var d = new Date(iso + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // ---------- Valutakurser ----------
  function Rates(json) {
    this.source = (json && json.source) || "";
    this.updated = (json && json.updated) || "";
    this.map = {};
    var cur = (json && json.currencies) || {};
    for (var c in cur) {
      var m = {}, unit = cur[c].unit || 1, years = cur[c].years || {};
      for (var y in years) {
        var parts = years[y].split(",");
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i].split(":");
          if (p.length !== 2) continue;
          m[y + "-" + p[0].slice(0, 2) + "-" + p[0].slice(2, 4)] = parseFloat(p[1]) / unit;
        }
      }
      this.map[c] = { rates: m, first: cur[c].first, last: cur[c].last };
    }
  }
  Rates.fromTable = function (table) {
    // table: {USD: {"2025-01-02": 11.05, ...}} – används i tester
    var r = new Rates(null);
    for (var c in table) {
      var dates = Object.keys(table[c]).sort();
      r.map[c] = { rates: table[c], first: dates[0], last: dates[dates.length - 1] };
    }
    return r;
  };
  Rates.prototype.has = function (ccy) { return ccy === "SEK" || !!this.map[ccy]; };
  // Returnerar {rate, date} eller null. Använder senast publicerade kurs (upp till 10 dagar bakåt).
  Rates.prototype.get = function (ccy, date) {
    if (!ccy || ccy === "SEK") return { rate: 1, date: date };
    var c = this.map[ccy];
    if (!c) return null;
    var d = date;
    for (var i = 0; i <= 10; i++) {
      if (c.rates[d] != null) return { rate: c.rates[d], date: d };
      d = addDays(d, -1);
    }
    return null;
  };

  // ---------- Hjälpfunktioner ----------
  function keyOf(t) {
    return (t.isin && String(t.isin).trim().toUpperCase()) || String(t.symbol || t.name || "").trim().toUpperCase();
  }
  function round(x) { return Math.round(x + (x >= 0 ? 1e-9 : -1e-9)); }

  /* Huvudberäkning.
   * events: lista med objekt:
   *  {kind:"TRADE", side:"BUY"|"SELL", date, time?, symbol, name?, isin?, qty, price, currency,
   *   fee?, sekAmount?, account?: {id, type:"SEK"|"CCY"}, source?}
   *     sekAmount = faktiskt belopp i SEK från mäklaren (köp: totalt betalt inkl. avgifter,
   *     försäljning: netto efter avgifter). Används när kontot är i SEK och mäklaren växlat.
   *  {kind:"CASH", date, time?, account:{id}, currency, amount (+in / -ut), sekValue?, label}
   *  {kind:"SPLIT", date, symbol/isin, ratio}
   *  {kind:"OPENING", date, symbol, name?, isin?, qty, costSEK}
   * opts: {rates: Rates}
   */
  function compute(events, opts) {
    var rates = opts.rates;
    var warnings = [];
    var sec = {};      // key -> {qty, cost, symbol, name, isin}
    var cash = {};     // accountId|ccy -> {bal, omk}
    var sales = [];
    var fxEvents = [];
    var missingRates = {};

    function warn(msg, date) { warnings.push({ date: date || "", msg: msg }); }

    function rateOf(ccy, date) {
      var r = rates.get(ccy, date);
      if (!r) {
        missingRates[ccy + " " + date] = true;
        return null;
      }
      return r.rate;
    }

    var list = events.map(function (e, i) { return Object.assign({ _i: i }, e); });
    list.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      var ta = a.time || "", tb = b.time || "";
      if (ta !== tb) return ta < tb ? -1 : 1;
      // Samma tidpunkt: ingående innehav först, sedan split, sedan i filordning.
      var oa = { OPENING: 0, SPLIT: 1 }[a.kind], ob = { OPENING: 0, SPLIT: 1 }[b.kind];
      oa = oa == null ? 2 : oa; ob = ob == null ? 2 : ob;
      if (oa !== ob) return oa - ob;
      return a._i - b._i;
    });

    function S(t) {
      var k = keyOf(t);
      if (!sec[k]) sec[k] = { qty: 0, cost: 0, symbol: t.symbol || "", name: t.name || "", isin: t.isin || "" };
      var s = sec[k];
      if (!s.name && t.name) s.name = t.name;
      if (!s.symbol && t.symbol) s.symbol = t.symbol;
      if (!s.isin && t.isin) s.isin = t.isin;
      return s;
    }
    function C(accId, ccy) {
      var k = (accId || "konto") + "|" + ccy;
      if (!cash[k]) cash[k] = { bal: 0, omk: 0, ccy: ccy, account: accId || "konto" };
      return cash[k];
    }
    function cashIn(acc, ccy, amount, sek, date, label) {
      if (ccy === "SEK" || amount <= EPS) return;
      var c = C(acc, ccy);
      if (c.bal < -0.005) warn("Negativt saldo i " + ccy + " (" + c.account + ") före " + date + ". Lån i valuta beräknas inte, kontrollera valutaresultatet manuellt.", date);
      c.bal += amount; c.omk += sek;
    }
    function cashOut(acc, ccy, amount, sek, date, label) {
      if (ccy === "SEK" || amount <= EPS) return;
      var c = C(acc, ccy);
      var omkBefore = c.omk;
      c.bal -= amount;
      var emptied = c.bal < 0.01;
      if (c.bal < -0.01) {
        // Mer ut än in: behandla det som går över saldot som tomt konto och varna.
        warn("Saldot i " + ccy + " blev negativt (" + c.bal.toFixed(2) + ") den " + date + ". Saknas en insättning eller växling i filerna?", date);
        emptied = true;
      }
      if (emptied) {
        fxEvents.push({ date: date, currency: ccy, account: c.account, amount: amount, proceeds: sek, omk: omkBefore, label: label });
        c.omk = 0;
        c.bal = 0;
      } else if (sek <= omkBefore + EPS) {
        c.omk = omkBefore - sek;
      } else {
        fxEvents.push({ date: date, currency: ccy, account: c.account, amount: amount, proceeds: sek, omk: omkBefore, label: label });
        c.omk = 0;
      }
    }

    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var acc = t.account || { id: "konto", type: "SEK" };
      if (t.kind === "OPENING") {
        var so = S(t);
        so.qty += +t.qty; so.cost += +t.costSEK;
        continue;
      }
      if (t.kind === "SPLIT") {
        var ss = S(t);
        if (!(t.ratio > 0)) { warn("Ogiltig split för " + (t.symbol || t.isin), t.date); continue; }
        ss.qty *= t.ratio;
        continue;
      }
      if (t.kind === "ADJUST") {
        // Ändrat antal utan kostnad (t.ex. split där mäklaren anger antal nya/borttagna aktier).
        var sa = S(t);
        sa.qty += +t.qty;
        if (sa.qty <= 1e-7) { sa.qty = 0; sa.cost = 0; }
        continue;
      }
      if (t.kind === "CASH") {
        var amt = +t.amount;
        if (!t.currency || t.currency === "SEK" || !amt) continue;
        var sv = t.sekValue;
        if (sv == null) {
          var rc = rateOf(t.currency, t.date);
          if (rc == null) continue;
          sv = Math.abs(amt) * rc;
        }
        if (amt > 0) cashIn(acc.id, t.currency, amt, Math.abs(sv), t.date, t.label);
        else cashOut(acc.id, t.currency, -amt, Math.abs(sv), t.date, t.label);
        continue;
      }
      if (t.kind !== "TRADE") continue;

      var qty = Math.abs(+t.qty), price = Math.abs(+t.price || 0), fee = Math.abs(+t.fee || 0);
      var ccy = t.currency || "SEK";
      if (!(qty > 0)) continue;
      var gross = qty * price;
      var r = null;
      var needRate = ccy !== "SEK" && (t.sekAmount == null || acc.type === "CCY");
      if (needRate) {
        r = rateOf(ccy, t.date);
        if (r == null) continue;
      }
      var s = S(t);
      if (t.side === "BUY") {
        var cost = t.sekAmount != null && acc.type !== "CCY" ? Math.abs(+t.sekAmount) : (gross + fee) * (r == null ? 1 : r);
        s.qty += qty; s.cost += cost;
        if (acc.type === "CCY") cashOut(acc.id, ccy, gross + fee, (gross + fee) * r, t.date, "Köp " + (t.symbol || t.name || ""));
      } else if (t.side === "SELL") {
        var net = gross - fee;
        var proceeds = t.sekAmount != null && acc.type !== "CCY" ? Math.abs(+t.sekAmount) : net * (r == null ? 1 : r);
        var held = s.qty, omk = 0, w = [];
        if (held <= EPS) {
          w.push("Inga köp hittades före försäljningen. Lägg till ingående innehav eller ladda upp äldre filer.");
          omk = 0;
        } else {
          var use = Math.min(qty, held);
          omk = s.cost * use / held;
          if (qty > held + 1e-6) w.push("Sålde " + fmtQ(qty) + " men innehavet var " + fmtQ(held) + ". Saknas köp i filerna?");
          s.qty = held - use; s.cost -= omk;
          if (s.qty <= 1e-7) { s.qty = 0; s.cost = 0; }
        }
        sales.push({
          date: t.date, key: keyOf(t), symbol: s.symbol || t.symbol, name: s.name || t.name || t.symbol,
          isin: s.isin, qty: qty, proceeds: proceeds, omk: omk, currency: ccy, warnings: w, source: t.source || ""
        });
        if (acc.type === "CCY") cashIn(acc.id, ccy, net, net * r, t.date, "Försäljning " + (t.symbol || ""));
      }
    }

    var miss = Object.keys(missingRates);
    if (miss.length) warn("Valutakurs saknas för " + miss.length + " datum (t.ex. " + miss.slice(0, 3).join(", ") + "). De händelserna är inte medräknade.");

    var holdings = Object.keys(sec).filter(function (k) { return sec[k].qty > 1e-7; }).map(function (k) {
      var h = sec[k];
      return { key: k, symbol: h.symbol, name: h.name, qty: h.qty, cost: h.cost, avg: h.cost / h.qty };
    });
    var cashState = Object.keys(cash).map(function (k) { return cash[k]; });
    return { sales: sales, fxEvents: fxEvents, warnings: warnings, holdings: holdings, cash: cashState };
  }

  function fmtQ(q) { return (Math.round(q * 10000) / 10000).toString(); }

  /* Bygger K4-rader för ett inkomstår.
   * opts: {year, schablon:bool, merge:bool, categories:{key:"A"|"C"}}
   */
  function k4Rows(result, opts) {
    var y = String(opts.year);
    var cats = opts.categories || {};
    var A = [], Cc = [];
    result.sales.forEach(function (s) {
      if (s.date.slice(0, 4) !== y) return;
      var cat = cats[s.key] || "A";
      var omk = s.omk, method = "genomsnitt";
      if (opts.schablon && cat === "A") {
        var sch = 0.2 * Math.max(0, s.proceeds);
        if (sch > omk) { omk = sch; method = "schablon"; }
      }
      var row = { key: s.key, beteckning: s.name || s.symbol, symbol: s.symbol, qty: s.qty, proceeds: s.proceeds, omk: omk, method: method, date: s.date, sales: 1, warnings: s.warnings.slice() };
      (cat === "C" ? Cc : A).push(row);
    });
    var fx = result.fxEvents.filter(function (e) { return e.date.slice(0, 4) === y; }).map(function (e) {
      return { key: "VALUTA:" + e.currency, beteckning: e.currency, symbol: e.currency, qty: e.amount, proceeds: e.proceeds, omk: e.omk, method: "valutakonto", date: e.date, sales: 1, warnings: [], isCurrency: true, account: e.account };
    });
    Cc = Cc.concat(fx);
    if (opts.merge) { A = merge(A); Cc = merge(Cc); }
    function finish(r) {
      r.proceedsR = round(r.proceeds);
      r.omkR = round(r.omk);
      var g = r.proceedsR - r.omkR;
      r.gain = g > 0 ? g : 0;
      r.loss = g < 0 ? -g : 0;
      r.qtyR = r.isCurrency ? round(r.qty) : Math.max(r.qty > 0 ? 1 : 0, round(r.qty));
      return r;
    }
    A = A.map(finish); Cc = Cc.map(finish);
    function sum(rows) {
      return rows.reduce(function (t, r) { t.proceeds += r.proceedsR; t.omk += r.omkR; t.gain += r.gain; t.loss += r.loss; return t; }, { proceeds: 0, omk: 0, gain: 0, loss: 0 });
    }
    return { A: A, C: Cc, sumA: sum(A), sumC: sum(Cc) };
  }

  function merge(rows) {
    var by = {}, out = [];
    rows.forEach(function (r) {
      var k = r.key + "|" + r.method;
      if (!by[k]) { by[k] = Object.assign({}, r, { warnings: r.warnings.slice() }); out.push(by[k]); return; }
      var m = by[k];
      m.qty += r.qty; m.proceeds += r.proceeds; m.omk += r.omk; m.sales += 1;
      m.warnings = m.warnings.concat(r.warnings);
      if (r.date > m.date) m.date = r.date;
    });
    return out;
  }

  // ---------- Personnummer ----------
  function normalizePnr(p) {
    var d = String(p || "").replace(/\D/g, "");
    if (d.length === 10) {
      var yy = +d.slice(0, 2), now = new Date().getFullYear() % 100;
      var plus = /\+/.test(p);
      var century = plus ? 19 : (yy > now ? 19 : 20);
      if (plus && yy <= now) century = 19;
      d = century + d;
    }
    if (d.length !== 12) return null;
    var ten = d.slice(2), sum = 0;
    for (var i = 0; i < 10; i++) {
      var n = +ten[i] * (i % 2 === 0 ? 2 : 1);
      sum += n > 9 ? n - 9 : n;
    }
    if (sum % 10 !== 0) return null;
    return d;
  }

  // ---------- SRU ----------
  function sruText(s) {
    return String(s == null ? "" : s).replace(/[\r\n#]/g, " ").replace(/\s+/g, " ").trim();
  }
  function stamp(now) {
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + " " + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds());
  }
  /* person: {pnr, namn, adress?, postnr, postort, email?}; rows: från k4Rows; year */
  function buildSRU(rows, person, year, now) {
    now = now || new Date();
    var pnr = normalizePnr(person.pnr);
    if (!pnr) throw new Error("Personnumret är inte giltigt.");
    var ts = stamp(now);
    var info = [
      "#DATABESKRIVNING_START",
      "#PRODUKT SRU",
      "#SKAPAD " + ts,
      "#PROGRAM K4HJALPEN 1.0",
      "#FILNAMN BLANKETTER.SRU",
      "#DATABESKRIVNING_SLUT",
      "#MEDIELEV_START",
      "#ORGNR " + pnr,
      "#NAMN " + sruText(person.namn)
    ];
    if (person.adress) info.push("#ADRESS " + sruText(person.adress));
    info.push("#POSTNR " + String(person.postnr || "").replace(/\D/g, ""));
    info.push("#POSTORT " + sruText(person.postort));
    if (person.email) info.push("#EMAIL " + sruText(person.email));
    info.push("#MEDIELEV_SLUT");

    var A = rows.A, Cc = rows.C;
    var n = Math.max(Math.ceil(A.length / 9), Math.ceil(Cc.length / 7), 1);
    var b = [];
    for (var k = 0; k < n; k++) {
      b.push("#BLANKETT K4-" + year + "P4");
      b.push("#IDENTITET " + pnr + " " + ts);
      b.push("#NAMN " + sruText(person.namn));
      b.push("#UPPGIFT 7014 " + (k + 1));
      var a = A.slice(k * 9, k * 9 + 9);
      a.forEach(function (r, i) {
        var base = 3100 + i * 10;
        b.push("#UPPGIFT " + base + " " + r.qtyR);
        b.push("#UPPGIFT " + (base + 1) + " " + sruText(r.beteckning).slice(0, 80));
        b.push("#UPPGIFT " + (base + 2) + " " + r.proceedsR);
        b.push("#UPPGIFT " + (base + 3) + " " + r.omkR);
        if (r.gain) b.push("#UPPGIFT " + (base + 4) + " " + r.gain);
        if (r.loss) b.push("#UPPGIFT " + (base + 5) + " " + r.loss);
      });
      if (a.length) {
        var sa = sumRows(a);
        b.push("#UPPGIFT 3300 " + sa.proceeds);
        b.push("#UPPGIFT 3301 " + sa.omk);
        if (sa.gain) b.push("#UPPGIFT 3304 " + sa.gain);
        if (sa.loss) b.push("#UPPGIFT 3305 " + sa.loss);
      }
      var c = Cc.slice(k * 7, k * 7 + 7);
      c.forEach(function (r, i) {
        var base = 3310 + i * 10;
        b.push("#UPPGIFT " + base + " " + r.qtyR);
        b.push("#UPPGIFT " + (base + 1) + " " + sruText(r.beteckning).slice(0, 80));
        b.push("#UPPGIFT " + (base + 2) + " " + r.proceedsR);
        b.push("#UPPGIFT " + (base + 3) + " " + r.omkR);
        if (r.gain) b.push("#UPPGIFT " + (base + 4) + " " + r.gain);
        if (r.loss) b.push("#UPPGIFT " + (base + 5) + " " + r.loss);
      });
      if (c.length) {
        var sc = sumRows(c);
        b.push("#UPPGIFT 3400 " + sc.proceeds);
        b.push("#UPPGIFT 3401 " + sc.omk);
        if (sc.gain) b.push("#UPPGIFT 3403 " + sc.gain);
        if (sc.loss) b.push("#UPPGIFT 3404 " + sc.loss);
      }
      b.push("#BLANKETTSLUT");
    }
    b.push("#FIL_SLUT");
    return { info: info.join("\r\n") + "\r\n", blanketter: b.join("\r\n") + "\r\n", count: n };
  }
  function sumRows(rows) {
    return rows.reduce(function (t, r) { t.proceeds += r.proceedsR; t.omk += r.omkR; t.gain += r.gain; t.loss += r.loss; return t; }, { proceeds: 0, omk: 0, gain: 0, loss: 0 });
  }
  // ISO-8859-1-bytes för nedladdning.
  function latin1Bytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      out[i] = c < 256 ? c : 63;
    }
    return out;
  }

  return { Rates: Rates, compute: compute, k4Rows: k4Rows, buildSRU: buildSRU, normalizePnr: normalizePnr, latin1Bytes: latin1Bytes, keyOf: keyOf, addDays: addDays };
});
