// Kör: node _src/k4/test.js
const assert = require("assert");
const path = require("path");
const E = require(path.join(__dirname, "../../k4/engine.js"));
const P = require(path.join(__dirname, "../../k4/parsers.js"));

let n = 0;
function test(name, fn) { fn(); n++; console.log("ok -", name); }

const rates = E.Rates.fromTable({
  EUR: { "2025-01-10": 10.60, "2025-02-10": 10.30, "2025-06-10": 11.20, "2025-09-10": 11.60 },
  USD: { "2025-03-07": 10.00, "2025-03-10": 11.00, "2025-03-11": 10.50, "2025-05-02": 9.80, "2025-11-03": 9.50 },
});

test("kurs: helg använder senast publicerade kurs", () => {
  assert.strictEqual(E.Rates.prototype.get.call(rates, "USD", "2025-03-09").rate, 10.00);
  assert.strictEqual(rates.get("USD", "2025-03-09").date, "2025-03-07");
  assert.strictEqual(rates.get("SEK", "2025-03-09").rate, 1);
  assert.strictEqual(rates.get("USD", "2024-01-01"), null);
});

test("Rates läser komprimerat JSON-format och enhet per 100", () => {
  const r = new E.Rates({ currencies: { JPY: { unit: 100, years: { "2025": "0102:7.1,0103:7.2" } } } });
  assert.ok(Math.abs(r.get("JPY", "2025-01-03").rate - 0.072) < 1e-12);
});

test("Skatteverkets exempel: aktier via utländsk depå med valutakonto (EUR)", () => {
  const acc = { id: "DE", type: "CCY" };
  const ev = [
    { kind: "CASH", date: "2025-01-10", account: acc, currency: "EUR", amount: 20000, sekValue: 212000, label: "Insättning" },
    { kind: "TRADE", side: "BUY", date: "2025-02-10", symbol: "X", qty: 100, price: 180, currency: "EUR", account: acc },
    { kind: "TRADE", side: "SELL", date: "2025-06-10", symbol: "X", qty: 100, price: 210, currency: "EUR", account: acc },
    { kind: "CASH", date: "2025-09-10", account: acc, currency: "EUR", amount: -23000, sekValue: 266800, label: "Uttag" },
  ];
  const res = E.compute(ev, { rates });
  const k4 = E.k4Rows(res, { year: 2025 });
  assert.strictEqual(k4.A.length, 1);
  assert.strictEqual(k4.A[0].proceedsR, 235200);
  assert.strictEqual(k4.A[0].omkR, 185400);
  assert.strictEqual(k4.A[0].gain, 49800);
  assert.strictEqual(k4.C.length, 1, "en valutarad");
  assert.strictEqual(k4.C[0].proceedsR, 266800);
  assert.strictEqual(k4.C[0].omkR, 261800);
  assert.strictEqual(k4.C[0].gain, 5000);
  assert.strictEqual(k4.C[0].beteckning, "EUR");
});

test("valutakonto: ingen beskattning så länge omkostnadsbeloppet räcker", () => {
  const acc = { id: "A", type: "CCY" };
  const ev = [
    { kind: "CASH", date: "2025-01-10", account: acc, currency: "EUR", amount: 20000, sekValue: 212000 },
    { kind: "TRADE", side: "BUY", date: "2025-02-10", symbol: "X", qty: 100, price: 180, currency: "EUR", account: acc },
  ];
  const res = E.compute(ev, { rates });
  assert.strictEqual(res.fxEvents.length, 0);
  assert.ok(Math.abs(res.cash[0].omk - 26600) < 1e-6);
  assert.ok(Math.abs(res.cash[0].bal - 2000) < 1e-6);
});

test("valutakonto: förlust när kontot töms med kvarvarande omkostnadsbelopp", () => {
  const acc = { id: "A", type: "CCY" };
  const ev = [
    { kind: "CASH", date: "2025-01-10", account: acc, currency: "EUR", amount: 1000, sekValue: 11600 },
    { kind: "CASH", date: "2025-02-10", account: acc, currency: "EUR", amount: -1000, sekValue: 10300 },
  ];
  const k4 = E.k4Rows(E.compute(ev, { rates }), { year: 2025 });
  assert.strictEqual(k4.C[0].loss, 1300);
  assert.strictEqual(k4.C[0].gain, 0);
});

test("genomsnittsmetoden med två köp och delförsäljning (SEK)", () => {
  const ev = [
    { kind: "TRADE", side: "BUY", date: "2025-01-02", symbol: "ABC", qty: 100, price: 10, currency: "SEK", fee: 0 },
    { kind: "TRADE", side: "BUY", date: "2025-02-02", symbol: "ABC", qty: 100, price: 20, currency: "SEK", fee: 0 },
    { kind: "TRADE", side: "SELL", date: "2025-03-02", symbol: "ABC", qty: 50, price: 30, currency: "SEK", fee: 0 },
    { kind: "TRADE", side: "SELL", date: "2025-04-02", symbol: "ABC", qty: 50, price: 10, currency: "SEK", fee: 0 },
  ];
  const res = E.compute(ev, { rates });
  const k4 = E.k4Rows(res, { year: 2025 });
  assert.strictEqual(k4.A[0].omkR, 750);
  assert.strictEqual(k4.A[0].gain, 750);
  assert.strictEqual(k4.A[1].omkR, 750);
  assert.strictEqual(k4.A[1].loss, 250);
  assert.strictEqual(res.holdings[0].qty, 100);
  assert.strictEqual(res.holdings[0].cost, 1500);
  const merged = E.k4Rows(res, { year: 2025, merge: true });
  assert.strictEqual(merged.A.length, 1);
  assert.strictEqual(merged.A[0].gain, 500);
});

test("courtage ingår i omkostnadsbelopp och dras från försäljningspris", () => {
  const ev = [
    { kind: "TRADE", side: "BUY", date: "2025-03-10", symbol: "AAPL", qty: 10, price: 100, currency: "USD", fee: 1, account: { id: "I", type: "CCY" } },
    { kind: "TRADE", side: "SELL", date: "2025-05-02", symbol: "AAPL", qty: 10, price: 120, currency: "USD", fee: 1, account: { id: "I", type: "CCY" } },
  ];
  const k4 = E.k4Rows(E.compute(ev, { rates }), { year: 2025 });
  assert.strictEqual(k4.A[0].omkR, Math.round(1001 * 11.0));
  assert.strictEqual(k4.A[0].proceedsR, Math.round(1199 * 9.8));
});

test("SEK-konto med mäklarens faktiska SEK-belopp går före Riksbankens kurs", () => {
  const acc = { id: "T", type: "SEK" };
  const ev = [
    { kind: "TRADE", side: "BUY", date: "2025-03-10", symbol: "AAPL", qty: 10, price: 100, currency: "USD", sekAmount: 10123, account: acc },
    { kind: "TRADE", side: "SELL", date: "2025-05-02", symbol: "AAPL", qty: 10, price: 120, currency: "USD", sekAmount: 11500, account: acc },
  ];
  const res = E.compute(ev, { rates });
  const k4 = E.k4Rows(res, { year: 2025 });
  assert.strictEqual(k4.A[0].omkR, 10123);
  assert.strictEqual(k4.A[0].proceedsR, 11500);
  assert.strictEqual(res.cash.length, 0, "inget valutakonto");
});

test("schablonmetoden väljs bara när den ger högre omkostnadsbelopp", () => {
  const ev = [
    { kind: "TRADE", side: "BUY", date: "2025-01-02", symbol: "A", qty: 100, price: 100, currency: "SEK" },
    { kind: "TRADE", side: "BUY", date: "2025-01-02", symbol: "B", qty: 100, price: 100, currency: "SEK" },
    { kind: "TRADE", side: "SELL", date: "2025-06-02", symbol: "A", qty: 100, price: 1000, currency: "SEK" },
    { kind: "TRADE", side: "SELL", date: "2025-06-02", symbol: "B", qty: 100, price: 120, currency: "SEK" },
  ];
  const k4 = E.k4Rows(E.compute(ev, { rates }), { year: 2025, schablon: true });
  assert.strictEqual(k4.A[0].method, "schablon");
  assert.strictEqual(k4.A[0].omkR, 20000);
  assert.strictEqual(k4.A[0].gain, 80000);
  assert.strictEqual(k4.A[1].method, "genomsnitt");
  assert.strictEqual(k4.A[1].omkR, 10000);
});

test("bara valt år hamnar på K4, men tidigare köp ingår i snittet", () => {
  const ev = [
    { kind: "TRADE", side: "BUY", date: "2023-05-02", symbol: "A", qty: 10, price: 50, currency: "SEK" },
    { kind: "TRADE", side: "SELL", date: "2024-05-02", symbol: "A", qty: 5, price: 60, currency: "SEK" },
    { kind: "TRADE", side: "SELL", date: "2025-05-02", symbol: "A", qty: 5, price: 70, currency: "SEK" },
  ];
  const k4 = E.k4Rows(E.compute(ev, { rates }), { year: 2025 });
  assert.strictEqual(k4.A.length, 1);
  assert.strictEqual(k4.A[0].omkR, 250);
  assert.strictEqual(k4.A[0].gain, 100);
});

test("split och ingående innehav", () => {
  const ev = [
    { kind: "OPENING", date: "2020-01-01", symbol: "NVDA", qty: 10, costSEK: 10000 },
    { kind: "SPLIT", date: "2024-06-10", symbol: "NVDA", ratio: 10 },
    { kind: "TRADE", side: "SELL", date: "2025-03-10", symbol: "NVDA", qty: 50, price: 100, currency: "SEK" },
  ];
  const k4 = E.k4Rows(E.compute(ev, { rates }), { year: 2025 });
  assert.strictEqual(k4.A[0].omkR, 5000);
  assert.strictEqual(k4.A[0].qtyR, 50);
});

test("varning när försäljning saknar köp", () => {
  const res = E.compute([{ kind: "TRADE", side: "SELL", date: "2025-03-10", symbol: "Z", qty: 5, price: 10, currency: "SEK" }], { rates });
  assert.strictEqual(res.sales[0].omk, 0);
  assert.ok(res.sales[0].warnings.length === 1);
});

test("saknad valutakurs ger varning och händelsen hoppas över", () => {
  const res = E.compute([{ kind: "TRADE", side: "BUY", date: "2025-03-10", symbol: "Z", qty: 5, price: 10, currency: "XYZ", account: { id: "I", type: "CCY" } }], { rates });
  assert.ok(res.warnings.some(w => /Valutakurs saknas/.test(w.msg)));
});

test("bråkdelsaktier: antal avrundas till heltal, minst 1", () => {
  const ev = [
    { kind: "TRADE", side: "BUY", date: "2025-01-02", symbol: "F", qty: 0.3, price: 100, currency: "SEK" },
    { kind: "TRADE", side: "SELL", date: "2025-06-02", symbol: "F", qty: 0.3, price: 200, currency: "SEK" },
  ];
  const k4 = E.k4Rows(E.compute(ev, { rates }), { year: 2025 });
  assert.strictEqual(k4.A[0].qtyR, 1);
  assert.strictEqual(k4.A[0].gain, 30);
});

test("personnummer: kontrollsiffra och 10 → 12 siffror", () => {
  assert.strictEqual(E.normalizePnr("19121212-1212"), "191212121212");
  assert.strictEqual(E.normalizePnr("121212-1212"), "201212121212");
  assert.strictEqual(E.normalizePnr("121212+1212"), "191212121212");
  assert.strictEqual(E.normalizePnr("19121212-1213"), null);
});

test("SRU-filer följer Skatteverkets fältkoder (K4 2026P4)", () => {
  const rows = { A: [], C: [] };
  for (let i = 0; i < 10; i++) rows.A.push({ qtyR: i + 1, beteckning: "Bolag " + i + " #x", proceedsR: 1000, omkR: 900, gain: 100, loss: 0 });
  rows.C.push({ qtyR: 23000, beteckning: "EUR", proceedsR: 266800, omkR: 261800, gain: 5000, loss: 0 });
  const s = E.buildSRU(rows, { pnr: "19121212-1212", namn: "Test Testsson", postnr: "123 45", postort: "Malmö" }, 2026, new Date(2027, 2, 1, 9, 5, 7));
  const b = s.blanketter.split("\r\n");
  assert.strictEqual(s.count, 2);
  assert.strictEqual(b[0], "#BLANKETT K4-2026P4");
  assert.strictEqual(b[1], "#IDENTITET 191212121212 20270301 090507");
  assert.ok(b.includes("#UPPGIFT 7014 1") && b.includes("#UPPGIFT 7014 2"));
  assert.ok(b.includes("#UPPGIFT 3100 1"));
  assert.ok(b.includes("#UPPGIFT 3181 Bolag 8 x"), "rad 9 + # tas bort");
  assert.ok(b.includes("#UPPGIFT 3300 9000"));
  assert.ok(b.includes("#UPPGIFT 3304 900"));
  assert.ok(!b.some(l => /^#UPPGIFT 3105 /.test(l)), "noll-förlust skrivs inte");
  assert.ok(b.includes("#UPPGIFT 3310 23000"));
  assert.ok(b.includes("#UPPGIFT 3311 EUR"));
  assert.ok(b.includes("#UPPGIFT 3403 5000"));
  assert.strictEqual(b[b.length - 2], "#FIL_SLUT");
  assert.ok(s.info.includes("#ORGNR 191212121212") && s.info.includes("#POSTNR 12345") && s.info.includes("#POSTORT Malmö"));
  const bytes = E.latin1Bytes("Malmö");
  assert.strictEqual(bytes[4], 0xf6);
});

// ---------- Parsers ----------
test("tal i olika format", () => {
  assert.strictEqual(P.num("1,234.56"), 1234.56);
  assert.strictEqual(P.num("1 234,56"), 1234.56);
  assert.strictEqual(P.num("-12,5", true), -12.5);
  assert.strictEqual(P.num("USD 1,500.00"), 1500);
  assert.strictEqual(P.num("(3.5)"), -3.5);
  assert.strictEqual(P.isoDate("03-02-2025"), "2025-02-03");
  assert.strictEqual(P.isoDate("2025-02-03T10:00:00Z"), "2025-02-03");
});

test("Interactive Brokers Activity Statement", () => {
  const csv = [
    "Statement,Header,Field Name,Field Value",
    "Statement,Data,Period,\"January 1, 2025 - December 31, 2025\"",
    "Account Information,Header,Field Name,Field Value",
    "Account Information,Data,Base Currency,SEK",
    "Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code",
    "Trades,Data,Order,Stocks,USD,AAPL,\"2025-03-10, 10:15:00\",10,100,101,-1000,-1,1001,0,10,O",
    "Trades,Data,Order,Stocks,USD,AAPL,\"2025-05-02, 15:00:00\",-10,120,120,1200,-1,-1001,198,0,C",
    "Trades,SubTotal,,Stocks,USD,AAPL,,0,,,200,-2,0,198,10,",
    "Trades,Data,Order,Equity and Index Options,USD,AAPL 250620C00200000,\"2025-03-10, 10:15:00\",1,2,2,-200,-1,201,0,0,O",
    "Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm in SEK,MTM in SEK,Code",
    "Trades,Data,Order,Forex,SEK,USD.SEK,\"2025-03-07, 09:00:00\",\"2,000\",10.2,10.2,-20400,-20,0,",
    "Deposits & Withdrawals,Header,Currency,Settle Date,Description,Amount",
    "Deposits & Withdrawals,Data,SEK,2025-03-06,Electronic Fund Transfer,25000",
    "Deposits & Withdrawals,Data,Total,,,25000",
    "Dividends,Header,Currency,Date,Description,Amount",
    "Dividends,Data,USD,2025-05-02,AAPL Cash Dividend,2.5",
    "Withholding Tax,Header,Currency,Date,Description,Amount,Code",
    "Withholding Tax,Data,USD,2025-05-02,AAPL US Tax,-0.38,",
    "Financial Instrument Information,Header,Asset Category,Symbol,Description,Conid,Security ID,Listing Exch,Multiplier,Type,Code",
    "Financial Instrument Information,Data,Stocks,AAPL,APPLE INC,265598,US0378331005,NASDAQ,1,COMMON,",
  ].join("\n");
  const p = P.parseFile(csv, "ibkr.csv");
  assert.strictEqual(p.broker, "Interactive Brokers");
  const trades = p.events.filter(e => e.kind === "TRADE");
  assert.strictEqual(trades.length, 2);
  assert.strictEqual(trades[0].name, "APPLE INC");
  assert.strictEqual(trades[0].isin, "US0378331005");
  assert.strictEqual(trades[0].fee, 1);
  const fx = p.events.filter(e => e.kind === "CASH" && /Växling/.test(e.label));
  assert.strictEqual(fx.length, 2, "båda benen; motorn hoppar över SEK-benet");
  assert.ok(p.notes.some(x => /optioner/.test(x)));
  const res = E.compute(p.events, { rates });
  const k4 = E.k4Rows(res, { year: 2025 });
  assert.strictEqual(k4.A.length, 1);
  assert.strictEqual(k4.A[0].beteckning, "APPLE INC");
  // USD-kontot: 2000 köpta för 20400 SEK, 1001 ut (köp), 1199 in (sälj), utdelning in, källskatt ut.
  const usd = res.cash.find(c => c.ccy === "USD");
  assert.ok(Math.abs(usd.bal - (2000 - 1001 + 1199 + 2.5 - 0.38)) < 1e-6);
  assert.strictEqual(res.fxEvents.length, 0);
});

test("Trading 212 med SEK-konto", () => {
  const csv = [
    "Action,Time,ISIN,Ticker,Name,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Total,Currency (Total),Currency conversion fee,Currency (Currency conversion fee)",
    "Deposit,2025-01-02 10:00:00,,,,abc,,,,,,,1000.00,SEK,,",
    "Market buy,2025-03-10 15:30:01,US0378331005,AAPL,Apple,id1,2.5,100.00,USD,0.0909,,,2760.50,SEK,4.10,SEK",
    "Market sell,2025-05-02 16:00:00,US0378331005,AAPL,Apple,id2,2.5,120.00,USD,0.1020,,,2935.00,SEK,4.40,SEK",
  ].join("\n");
  const p = P.parseFile(csv);
  assert.strictEqual(p.broker, "Trading 212");
  assert.strictEqual(p.events.length, 2);
  const k4 = E.k4Rows(E.compute(p.events, { rates }), { year: 2025 });
  assert.strictEqual(k4.A[0].omkR, 2761);
  assert.strictEqual(k4.A[0].proceedsR, 2935);
  assert.strictEqual(k4.A[0].gain, 174);
});

test("Revolut (aktier) som valutakonto", () => {
  const csv = [
    "Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency,FX Rate",
    "2025-03-07T09:00:00.000Z,,CASH TOP-UP,,,USD 2000,USD,1.0",
    "2025-03-10T14:00:00.000Z,TSLA,BUY - MARKET,4,USD 250,USD 1000,USD,1.0",
    "2025-05-02T14:00:00.000Z,TSLA,STOCK SPLIT,4,,,USD,1.0",
    "2025-11-03T14:00:00.000Z,TSLA,SELL - MARKET,8,USD 150,\"USD 1,200\",USD,1.0",
  ].join("\n");
  const p = P.parseFile(csv);
  assert.strictEqual(p.broker, "Revolut");
  const res = E.compute(p.events, { rates });
  const k4 = E.k4Rows(res, { year: 2025 });
  assert.strictEqual(k4.A[0].qtyR, 8);
  assert.strictEqual(k4.A[0].omkR, 11000);
  assert.strictEqual(k4.A[0].proceedsR, 11400);
});

test("Degiro, svensk export med decimalkomma", () => {
  const csv = [
    "Datum,Tid,Produkt,ISIN,Referensbörs,Utförandeplats,Antal,Kurs,,Lokalt värde,,Värde,,Växelkurs,Transaktionsavgift,,Totalt,,Order ID",
    "02-05-2025,15:00,APPLE INC,US0378331005,NDQ,XNAS,-10,\"120,00\",USD,\"1200,00\",USD,\"11760,00\",SEK,\"9,8000\",\"-5,00\",SEK,\"11755,00\",SEK,abc",
    "10-03-2025,10:00,APPLE INC,US0378331005,NDQ,XNAS,10,\"100,00\",USD,\"-1000,00\",USD,\"-11000,00\",SEK,\"11,0000\",\"-5,00\",SEK,\"-11005,00\",SEK,abd",
  ].join("\n");
  const p = P.parseFile(csv);
  assert.strictEqual(p.broker, "Degiro");
  const k4 = E.k4Rows(E.compute(p.events, { rates }), { year: 2025 });
  assert.strictEqual(k4.A[0].omkR, 11005);
  assert.strictEqual(k4.A[0].proceedsR, 11755);
  assert.strictEqual(k4.A[0].gain, 750);
});

test("egen mall", () => {
  const csv = [
    "Datum;Typ;Värdepapper;ISIN;Antal;Kurs;Valuta;Avgift;Belopp SEK",
    "2019-01-01;Ingående;Investor B;SE0015811963;100;;;;20000",
    "2025-03-10;Köp;Investor B;SE0015811963;100;300;SEK;10;",
    "2025-05-02;Sälj;Investor B;SE0015811963;50;350;SEK;10;",
  ].join("\n");
  const p = P.parseFile(csv);
  assert.strictEqual(p.broker, "Egen fil");
  const k4 = E.k4Rows(E.compute(p.events, { rates }), { year: 2025 });
  assert.strictEqual(k4.A[0].omkR, Math.round((20000 + 30010) / 200 * 50));
  assert.strictEqual(k4.A[0].proceedsR, 17490);
});

test("okänt format ger tydligt fel", () => {
  assert.throws(() => P.parseFile("a,b\n1,2", "x.csv"), /Känner inte igen/);
});

console.log(`\n${n} tester OK`);
