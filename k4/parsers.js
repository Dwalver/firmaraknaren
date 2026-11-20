/* K4-hjälpen – inläsning av mäklarfiler (CSV).
 * Varje parser returnerar {broker, events, notes} där events följer formatet i engine.js.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.K4Parsers = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- CSV ----------
  function detectDelimiter(text) {
    var first = text.split(/\r?\n/).slice(0, 5).join("\n");
    var counts = { ",": 0, ";": 0, "\t": 0 };
    var q = false;
    for (var i = 0; i < first.length; i++) {
      var ch = first[i];
      if (ch === '"') q = !q;
      else if (!q && counts[ch] != null) counts[ch]++;
    }
    var best = ",";
    for (var k in counts) if (counts[k] > counts[best]) best = k;
    return best;
  }
  function parseCSV(text, delim) {
    text = String(text).replace(/^﻿/, "");
    delim = delim || detectDelimiter(text);
    var rows = [], row = [], field = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
        } else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += ch;
    }
    if (field !== "" || row.length) { row.push(field); if (row.length > 1 || row[0] !== "") rows.push(row); }
    return rows;
  }

  // ---------- Tal och datum ----------
  // decimalComma: true om filen använder decimalkomma (t.ex. svensk export).
  function num(s, decimalComma) {
    if (s == null) return NaN;
    if (typeof s === "number") return s;
    var t = String(s).replace(/[\s  ']/g, "").replace(/[^0-9,.\-−+()]/g, "");
    var neg = /^\(.*\)$/.test(t) || /[-−]/.test(t);
    t = t.replace(/[()\-−+]/g, "");
    if (!t) return NaN;
    var lc = t.lastIndexOf(","), ld = t.lastIndexOf(".");
    if (lc >= 0 && ld >= 0) {
      if (lc > ld) t = t.replace(/\./g, "").replace(",", ".");
      else t = t.replace(/,/g, "");
    } else if (lc >= 0) {
      if (decimalComma) t = t.replace(/,/g, ".");
      else if (/^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, "");
      else t = t.replace(",", ".");
    }
    var v = parseFloat(t);
    return neg ? -v : v;
  }
  function isoDate(s) {
    s = String(s || "").trim();
    var m;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return m[1] + "-" + m[2] + "-" + m[3];
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) return m[1] + "-" + m[2] + "-" + m[3];
    if ((m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})/))) return m[3] + "-" + pad(m[2]) + "-" + pad(m[1]);
    return null;
  }
  function timeOf(s) {
    var m = String(s || "").match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    return m ? pad(m[1]) + ":" + m[2] + ":" + (m[3] || "00") : "";
  }
  function pad(n) { n = String(n); return n.length < 2 ? "0" + n : n; }
  function lower(a) { return a.map(function (x) { return String(x || "").trim().toLowerCase(); }); }
  function idx(head, names) {
    for (var i = 0; i < names.length; i++) {
      var j = head.indexOf(names[i]);
      if (j >= 0) return j;
    }
    return -1;
  }

  // ---------- Interactive Brokers (Activity Statement, CSV) ----------
  function isIBKR(rows) {
    return rows.some(function (r) { return r[0] === "Statement" && r[1] === "Header"; }) ||
      rows.some(function (r) { return r[0] === "Trades" && r[1] === "Header"; });
  }
  function parseIBKR(rows, fileId) {
    var events = [], notes = [], headers = {};
    var acc = { id: "IBKR", type: "CCY" };
    var base = "SEK", skippedOpt = 0, skippedOther = {}, corp = 0;
    var hasOrder = rows.some(function (r) { return r[0] === "Trades" && r[1] === "Data" && /^order$/i.test(r[2] || ""); });
    rows.forEach(function (r) {
      var sect = r[0], kind = r[1];
      if (kind === "Header") { headers[sect] = lower(r.slice(2)); return; }
      if (kind !== "Data") return;
      var h = headers[sect] || [], d = r.slice(2);
      function f(name) { var j = h.indexOf(name); return j >= 0 ? d[j] : undefined; }
      if (sect === "Account Information" && /base currency/i.test(d[0] || "")) base = (d[1] || "SEK").trim();
      if (sect === "Trades") {
        var disc = f("datadiscriminator");
        if (disc && !(hasOrder ? /^order$/i : /^(order|trade)$/i).test(disc)) return;
        var cat = f("asset category") || "";
        var ccy = (f("currency") || "").trim();
        var sym = (f("symbol") || "").trim();
        var dt = f("date/time") || "";
        var date = isoDate(dt), time = timeOf(dt.split(",")[1] || dt.slice(10));
        var q = num(f("quantity")), price = num(f("t. price")), proceeds = num(f("proceeds"));
        var feeRaw = f("comm/fee"); if (feeRaw === undefined) feeRaw = f("comm in " + base.toLowerCase());
        var fee = Math.abs(num(feeRaw) || 0);
        if (!date || !q) return;
        if (/forex/i.test(cat)) {
          // T.ex. USD.SEK: köp/sälj av basvalutan (USD) mot kvotvaluta (SEK).
          var pr = sym.split(".");
          if (pr.length !== 2) return;
          var b = pr[0], qc = pr[1];
          var quoteAmt = Math.abs(proceeds) || Math.abs(q * price);
          var feeCcy = h.indexOf("comm in " + base.toLowerCase()) >= 0 ? base : qc;
          // Värde i SEK: om ena sidan är SEK används faktisk växlingskurs.
          var sekVal = qc === "SEK" ? quoteAmt : (b === "SEK" ? Math.abs(q) : null);
          if (q > 0) {
            events.push({ kind: "CASH", date: date, time: time, account: acc, currency: b, amount: Math.abs(q), sekValue: sekVal, label: "Växling " + qc + "→" + b, source: "IBKR" });
            events.push({ kind: "CASH", date: date, time: time, account: acc, currency: qc, amount: -quoteAmt, sekValue: sekVal, label: "Växling " + qc + "→" + b, source: "IBKR" });
          } else {
            events.push({ kind: "CASH", date: date, time: time, account: acc, currency: b, amount: -Math.abs(q), sekValue: sekVal, label: "Växling " + b + "→" + qc, source: "IBKR" });
            events.push({ kind: "CASH", date: date, time: time, account: acc, currency: qc, amount: quoteAmt, sekValue: sekVal, label: "Växling " + b + "→" + qc, source: "IBKR" });
          }
          if (fee && feeCcy !== "SEK") events.push({ kind: "CASH", date: date, time: time, account: acc, currency: feeCcy, amount: -fee, label: "Växlingsavgift", source: "IBKR" });
          return;
        }
        if (/option|future|bond|warrant|cfd/i.test(cat)) { skippedOpt++; return; }
        if (!/stock|etf|fund/i.test(cat)) { skippedOther[cat] = 1; return; }
        events.push({
          kind: "TRADE", side: q > 0 ? "BUY" : "SELL", date: date, time: time, symbol: sym, name: sym,
          qty: Math.abs(q), price: price, currency: ccy, fee: fee,
          account: ccy === "SEK" ? { id: "IBKR", type: "SEK" } : acc, source: "IBKR"
        });
        return;
      }
      if (sect === "Financial Instrument Information") {
        // Kopplar symbol -> namn och ISIN
        var s2 = f("symbol"), desc = f("description"), isin = f("security id") || f("isin");
        if (s2) events.push({ kind: "_INFO", symbol: s2.trim(), name: desc, isin: isin && /^[A-Z]{2}[A-Z0-9]{10}$/.test(isin.trim()) ? isin.trim() : "" });
        return;
      }
      var cashSects = { "Deposits & Withdrawals": "Insättning/uttag", "Dividends": "Utdelning", "Withholding Tax": "Källskatt", "Fees": "Avgift", "Interest": "Ränta", "Other Fees": "Avgift" };
      if (cashSects[sect]) {
        var c = (f("currency") || "").trim();
        if (!c || /^total/i.test(c) || c === base && c === "SEK") return;
        var dd = isoDate(f("settle date") || f("date") || "");
        var amt = num(f("amount"));
        if (!dd || !amt || c === "SEK") return;
        events.push({ kind: "CASH", date: dd, account: acc, currency: c, amount: amt, label: cashSects[sect] + (f("description") ? ": " + f("description") : ""), source: "IBKR" });
        return;
      }
      if (sect === "Corporate Actions") corp++;
    });
    // Namn och ISIN från instrumentlistan
    var info = {};
    events.filter(function (e) { return e.kind === "_INFO"; }).forEach(function (e) { info[e.symbol] = e; });
    events = events.filter(function (e) { return e.kind !== "_INFO"; });
    events.forEach(function (e) {
      if (e.kind === "TRADE" && info[e.symbol]) { e.name = info[e.symbol].name || e.symbol; if (info[e.symbol].isin) e.isin = info[e.symbol].isin; }
    });
    if (base !== "SEK") notes.push("Kontots basvaluta är " + base + ". Insättningar räknas om med Riksbankens kurs.");
    if (skippedOpt) notes.push(skippedOpt + " affärer i optioner/terminer/obligationer hoppades över (stöds inte ännu).");
    var oth = Object.keys(skippedOther); if (oth.length) notes.push("Hoppade över tillgångsslag: " + oth.join(", ") + ".");
    if (corp) notes.push(corp + " bolagshändelser (split, fusion m.m.) finns i filen. Lägg in splitar manuellt under \"Egna justeringar\".");
    return { broker: "Interactive Brokers", events: events, notes: notes };
  }

  // ---------- Trading 212 ----------
  function isT212(head) { return head.indexOf("action") >= 0 && head.indexOf("no. of shares") >= 0; }
  function parseT212(rows) {
    var head = lower(rows[0]), events = [], notes = [], other = {}, nonSek = 0;
    var iA = head.indexOf("action"), iT = head.indexOf("time"), iIsin = head.indexOf("isin"), iTk = head.indexOf("ticker"),
      iN = head.indexOf("name"), iQ = head.indexOf("no. of shares"), iP = head.indexOf("price / share"),
      iPc = head.indexOf("currency (price / share)"), iTot = head.indexOf("total"), iTotC = head.indexOf("currency (total)");
    for (var r = 1; r < rows.length; r++) {
      var d = rows[r], a = (d[iA] || "").toLowerCase();
      var date = isoDate(d[iT]); if (!date) continue;
      var side = /buy/.test(a) ? "BUY" : /sell/.test(a) ? "SELL" : null;
      if (!side) { if (a) other[a] = 1; continue; }
      var tot = num(d[iTot]), totC = (d[iTotC] || "").trim();
      var ev = {
        kind: "TRADE", side: side, date: date, time: timeOf(d[iT]), symbol: d[iTk], name: d[iN], isin: d[iIsin],
        qty: num(d[iQ]), price: num(d[iP]), currency: (d[iPc] || "").trim() || "SEK", fee: 0,
        account: { id: "T212", type: "SEK" }, source: "Trading 212"
      };
      if (!isNaN(tot) && totC === "SEK") ev.sekAmount = Math.abs(tot);
      else if (!isNaN(tot) && totC) { ev.currency = totC; ev.price = Math.abs(tot) / Math.abs(ev.qty); nonSek++; }
      events.push(ev);
    }
    if (nonSek) notes.push(nonSek + " affärer har kontovaluta annan än SEK och räknas om med Riksbankens kurs.");
    var o = Object.keys(other).filter(function (x) { return !/deposit|withdraw|interest|dividend|card|cashback|currency conversion/.test(x); });
    if (o.length) notes.push("Ignorerade rader: " + o.join(", ") + ".");
    return { broker: "Trading 212", events: events, notes: notes };
  }

  // ---------- Revolut (aktier) ----------
  function isRevolut(head) { return head.indexOf("ticker") >= 0 && head.indexOf("type") >= 0 && head.indexOf("price per share") >= 0; }
  function parseRevolut(rows) {
    var head = lower(rows[0]), events = [], notes = [], acc = { id: "Revolut", type: "CCY" };
    var iD = head.indexOf("date"), iTk = head.indexOf("ticker"), iTy = head.indexOf("type"), iQ = head.indexOf("quantity"),
      iP = head.indexOf("price per share"), iTot = head.indexOf("total amount"), iC = head.indexOf("currency");
    var splits = 0;
    for (var r = 1; r < rows.length; r++) {
      var d = rows[r], ty = (d[iTy] || "").toUpperCase(), date = isoDate(d[iD]);
      if (!date) continue;
      var ccy = (d[iC] || "USD").trim(), tot = num(d[iTot]), q = num(d[iQ]), p = num(d[iP]);
      var time = timeOf(String(d[iD]).slice(10));
      if (/^BUY/.test(ty) || /^SELL/.test(ty)) {
        var side = /^BUY/.test(ty) ? "BUY" : "SELL";
        // Avgift = skillnaden mellan totalbelopp och antal × kurs (om den finns).
        var gross = Math.abs(q * p), fee = 0;
        if (!isNaN(tot)) fee = Math.max(0, side === "BUY" ? Math.abs(tot) - gross : gross - Math.abs(tot));
        if (fee > gross * 0.05) fee = 0; // orimlig – troligen avrundning i kurs
        events.push({ kind: "TRADE", side: side, date: date, time: time, symbol: d[iTk], name: d[iTk], qty: Math.abs(q), price: Math.abs(p), currency: ccy, fee: fee, account: acc, source: "Revolut" });
      } else if (/STOCK SPLIT/.test(ty)) {
        // Revolut anger antalet nya aktier. Läggs till som köp utan kostnad (samma effekt på snittet).
        if (q) { events.push({ kind: "ADJUST", date: date, time: time, symbol: d[iTk], name: d[iTk], qty: q, source: "Revolut" }); splits++; }
      } else if (/TOP-UP|TOPUP|DEPOSIT/.test(ty)) {
        events.push({ kind: "CASH", date: date, time: time, account: acc, currency: ccy, amount: Math.abs(tot), label: "Insättning", source: "Revolut" });
      } else if (/WITHDRAW/.test(ty)) {
        events.push({ kind: "CASH", date: date, time: time, account: acc, currency: ccy, amount: -Math.abs(tot), label: "Uttag", source: "Revolut" });
      } else if (/DIVIDEND/.test(ty)) {
        events.push({ kind: "CASH", date: date, time: time, account: acc, currency: ccy, amount: Math.abs(tot), label: "Utdelning " + (d[iTk] || ""), source: "Revolut" });
      } else if (/FEE|TAX/.test(ty)) {
        events.push({ kind: "CASH", date: date, time: time, account: acc, currency: ccy, amount: -Math.abs(tot), label: ty, source: "Revolut" });
      }
    }
    notes.push("Revolut-kontot behandlas som valutakonto. Insättningar räknas om med Riksbankens kurs, eftersom växlingen sker utanför filen.");
    if (splits) notes.push(splits + " splitar lades in automatiskt.");
    return { broker: "Revolut", events: events, notes: notes };
  }

  // ---------- Degiro (Transactions.csv) ----------
  function isDegiro(head) {
    return (head.indexOf("produkt") >= 0 || head.indexOf("product") >= 0) && head.indexOf("isin") >= 0 &&
      (head.indexOf("växelkurs") >= 0 || head.indexOf("exchange rate") >= 0);
  }
  function parseDegiro(rows) {
    var head = lower(rows[0]), events = [], notes = [];
    var iD = idx(head, ["datum", "date"]), iT = idx(head, ["tid", "time"]), iPr = idx(head, ["produkt", "product"]),
      iIsin = head.indexOf("isin"), iQ = idx(head, ["antal", "quantity"]), iP = idx(head, ["kurs", "price"]),
      iTot = idx(head, ["totalt", "total"]), iFee = -1;
    for (var k = 0; k < head.length; k++) if (/avgift|fee|transaction cost|kostnad/.test(head[k])) { iFee = k; break; }
    var decComma = rows.slice(1, 6).some(function (r) { return /^-?\d+,\d+$/.test(String(r[iP] || "").trim()); });
    var nonSek = 0;
    for (var r = 1; r < rows.length; r++) {
      var d = rows[r], date = isoDate(d[iD]); if (!date) continue;
      var q = num(d[iQ], decComma); if (!q) continue;
      var pc = (d[iP + 1] || "").trim() || "EUR";
      var tot = num(d[iTot], decComma), totC = (d[iTot + 1] || "").trim();
      var fee = iFee >= 0 ? Math.abs(num(d[iFee], decComma) || 0) : 0;
      var ev = { kind: "TRADE", side: q > 0 ? "BUY" : "SELL", date: date, time: timeOf(d[iT]), symbol: d[iPr], name: d[iPr], isin: d[iIsin],
        qty: Math.abs(q), price: Math.abs(num(d[iP], decComma)), currency: pc, fee: 0, account: { id: "Degiro", type: "SEK" }, source: "Degiro" };
      if (!isNaN(tot) && totC === "SEK") ev.sekAmount = Math.abs(tot);
      else { nonSek++; if (pc === (d[iFee + 1] || "").trim()) ev.fee = fee; }
      events.push(ev);
    }
    if (nonSek) notes.push(nonSek + " affärer saknar totalbelopp i SEK och räknas om med Riksbankens kurs.");
    return { broker: "Degiro", events: events, notes: notes };
  }

  // ---------- Egen mall ----------
  // Datum;Typ;Värdepapper;ISIN;Antal;Kurs;Valuta;Avgift;Belopp SEK
  function isTemplate(head) { return head.indexOf("datum") >= 0 && head.indexOf("typ") >= 0 && (head.indexOf("värdepapper") >= 0 || head.indexOf("vardepapper") >= 0); }
  function parseTemplate(rows) {
    var head = lower(rows[0]), events = [], notes = [], bad = 0;
    var iD = head.indexOf("datum"), iTy = head.indexOf("typ"), iV = idx(head, ["värdepapper", "vardepapper"]), iIsin = head.indexOf("isin"),
      iQ = head.indexOf("antal"), iP = head.indexOf("kurs"), iC = head.indexOf("valuta"), iF = head.indexOf("avgift"),
      iS = idx(head, ["belopp sek", "belopp i sek", "belopp_sek"]);
    for (var r = 1; r < rows.length; r++) {
      var d = rows[r], date = isoDate(d[iD]); if (!date) { if (d.join("").trim()) bad++; continue; }
      var ty = (d[iTy] || "").trim().toUpperCase().replace("Ö", "O").replace("Ä", "A").replace("Å", "A");
      var dc = true;
      var q = num(d[iQ], dc), p = iP >= 0 ? num(d[iP], dc) : 0, f = iF >= 0 ? num(d[iF], dc) || 0 : 0;
      var sek = iS >= 0 && String(d[iS] || "").trim() !== "" ? num(d[iS], dc) : null;
      var base = { date: date, symbol: d[iV], name: d[iV], isin: iIsin >= 0 ? (d[iIsin] || "").trim() : "", source: "Egen fil" };
      if (/^(KOP|BUY)/.test(ty) || /^(SALJ|SELL)/.test(ty)) {
        events.push(Object.assign(base, { kind: "TRADE", side: /^(KOP|BUY)/.test(ty) ? "BUY" : "SELL", qty: Math.abs(q), price: Math.abs(p || 0), currency: (d[iC] || "SEK").trim().toUpperCase() || "SEK", fee: Math.abs(f), sekAmount: sek == null || isNaN(sek) ? undefined : Math.abs(sek), account: { id: "Egen", type: "SEK" } }));
      } else if (/^SPLIT/.test(ty)) {
        events.push(Object.assign(base, { kind: "SPLIT", ratio: q }));
      } else if (/^(INGAENDE|INGAENDE|INGÅENDE|OPENING)/.test(ty) || /^ING/.test(ty)) {
        events.push(Object.assign(base, { kind: "OPENING", qty: Math.abs(q), costSEK: Math.abs(sek || 0) }));
      } else bad++;
    }
    if (bad) notes.push(bad + " rader kunde inte tolkas och hoppades över.");
    return { broker: "Egen fil", events: events, notes: notes };
  }

  function parseFile(text, name) {
    var rows = parseCSV(text);
    if (!rows.length) throw new Error("Filen är tom.");
    if (isIBKR(rows)) return parseIBKR(rows);
    var head = lower(rows[0]);
    if (isT212(head)) return parseT212(rows);
    if (isRevolut(head)) return parseRevolut(rows);
    if (isDegiro(head)) return parseDegiro(rows);
    if (isTemplate(head)) return parseTemplate(rows);
    throw new Error("Känner inte igen formatet i " + (name || "filen") + ". Stöds: Interactive Brokers (Activity Statement CSV), Trading 212, Revolut (aktier), Degiro (Transaktioner) och vår mall.");
  }

  return { parseCSV: parseCSV, num: num, isoDate: isoDate, parseFile: parseFile };
});
