// Tests für logic.js und planner.js – ohne Netzwerk (Fake-Client). Start: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STOPS, OUTBOUND, RETURN, RULES, WEATHER } from '../config.js';
import {
  normalize, pickStopMatch, buildCombinations, combinationsEnRoute, analyzeTransfers,
  weatherAt, rankConnections, fitsVariant, meetsMinBuffer, nextOccurrence, withoutTransferReserve,
  mergeItineraries, meetsStartBuffer, zonedTime, requiredBuffer, recommendationChanged, recommendationKey, nextStopOfTrip,
} from '../logic.js';
import { resolveStops, planJourney } from '../planner.js';
import { createFakeClient, MATCHES } from './fake-transitous.js';

const MIN = 60_000;
const NOW = Date.parse('2026-10-19T05:30:00Z');
// Für die Tests ohne feste IDs → Haltestellen werden über den Fake-Geocoder gesucht
const GEO_STOPS = Object.fromEntries(Object.entries(STOPS).map(([k, v]) => [k, { ...v, id: null }]));

test('normalize vereinheitlicht Umlaute, ß und Straßen-Abkürzungen', () => {
  assert.equal(normalize('Philipp-Reis-Str.'), 'philipp reis strasse');
  assert.equal(normalize('Neulußheim'), 'neulussheim');
  assert.equal(normalize('Waldstr'), 'waldstrasse');
});

test('pickStopMatch: Bahnhof wird eindeutig erkannt (Bus-Halt "Bahnhof" daneben zählt als derselbe)', () => {
  const r = pickStopMatch('grabenNeudorf', STOPS.grabenNeudorf, MATCHES['Graben-Neudorf Bahnhof']);
  assert.equal(r.status, 'ok');
  assert.equal(r.id, 'de:08215:2000');
});

test('pickStopMatch: mehrdeutig → kein Raten', () => {
  const r = pickStopMatch('oftersheim', STOPS.oftersheim, MATCHES.Oftersheim);
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.id, null);
  assert.equal(r.candidates.length, 2);
});

test('pickStopMatch: Name mit abgekürzter Straße und Ort im Namen', () => {
  const r = pickStopMatch('workHdm', STOPS.workHdm, MATCHES['HDM Philipp-Reis-Straße Walldorf']);
  assert.equal(r.status, 'ok');
  assert.equal(r.id, 'de:08226:9000');
});

test('pickStopMatch: nichts Passendes → notFound', () => {
  const r = pickStopMatch('home', STOPS.home, MATCHES.Bruchsal);
  assert.equal(r.status, 'notFound');
});

test('buildCombinations: Hinweg 2×4, Via-Halte in Fahrtreihenfolge', () => {
  const combos = buildCombinations(OUTBOUND);
  assert.equal(combos.length, 8);
  const busA1 = combos.find((c) => c.id === 'bus+A1');
  assert.deepEqual(busA1.via, ['grabenNeudorf', 'neulussheim']);
  assert.deepEqual(busA1.from, ['home']);
  assert.deepEqual(busA1.to, ['workIndustrie', 'workHdm']);
  const bikeB = combos.find((c) => c.id === 'bike+B');
  assert.deepEqual(bikeB.from, ['grabenNeudorf']);
  assert.equal(bikeB.fixedBefore.minutes, 28);
  assert.ok(bikeB.usesBike);
  assert.ok(bikeB.fallback);
});

test('buildCombinations: Rückweg – Rad am Ende, Fußweg am Anfang', () => {
  const combos = buildCombinations(RETURN);
  assert.equal(combos.length, 8);
  const bBike = combos.find((c) => c.id === 'B+bike');
  assert.deepEqual(bBike.from, ['wieslochWalldorf']);
  assert.deepEqual(bBike.to, ['grabenNeudorf']);
  assert.equal(bBike.fixedBefore.mode, 'walk');
  assert.equal(bBike.fixedAfter.mode, 'bike');
  assert.deepEqual(combos.find((c) => c.id === 'A2+bus').via, ['hockenheim', 'grabenNeudorf']);
});

test('combinationsEnRoute: passierte Via-Halte fallen weg, gleiche Wege werden zusammengefasst', () => {
  const combos = combinationsEnRoute(buildCombinations(OUTBOUND), (k) => k === 'grabenNeudorf');
  assert.equal(combos.length, 4); // Bus·A1 und Rad·A1 sind ab hier identisch
  const a1 = combos.find((c) => c.via.includes('neulussheim'));
  assert.equal(a1.name, 'S9 + Bus über Neulußheim');
  assert.equal(a1.fixedBefore, null);
});

test('analyzeTransfers: Puffer inkl. Fußweg, knapp + stündlich erkannt', () => {
  const t0 = NOW;
  const leg = (from, to, start, end, kind = 'transit') => ({
    kind, mode: kind === 'transit' ? 'SUBURBAN' : 'WALK', line: 'S9', fromName: from, toName: to,
    start, end, scheduledStart: start, scheduledEnd: end, delayStartMin: 0, delayEndMin: 0, realTime: true,
  });
  const legs = [
    leg('Graben-Neudorf', 'Neulußheim', t0, t0 + 20 * MIN),
    leg('Neulußheim', 'Neulußheim Bahnhof', t0 + 20 * MIN, t0 + 22 * MIN, 'walk'),
    leg('Neulußheim Bahnhof', 'Walldorf Industriestraße', t0 + 26 * MIN, t0 + 40 * MIN),
  ];
  const [risk] = analyzeTransfers(legs, [{ key: 'neulussheim', expected: 'Neulußheim', name: 'Neulußheim', id: 'x' }], 5);
  assert.equal(risk.bufferMin, 4); // 6 Min. Abstand − 2 Min. Fußweg
  assert.equal(risk.level, 'tight');
  assert.equal(risk.critical, true);
});

test('weatherAt: Schwellenwerte aus config', () => {
  const hour = Math.ceil(NOW / 3_600_000) * 3_600_000;
  const data = { current: { time: NOW, temperature: 12, precipitation: 0, wind: 10 }, hourly: [{ time: hour, temperature: 4, precipitation: 0.5, wind: 35 }] };
  const w = weatherAt(data, NOW, WEATHER.goodBikeWeather);
  assert.equal(w.good, false);
  assert.deepEqual(w.reasons, ['Regen', 'kalt', 'Wind']);
  const ok = weatherAt({ ...data, hourly: [] }, NOW, WEATHER.goodBikeWeather);
  assert.equal(ok.good, true);
});

test('rankConnections: früheste Ankunft gewinnt, ausgefallene ans Ende', () => {
  const c = (id, arrival, extra = {}) => ({ id, arrival, departure: 0, transfers: 1, riskLevel: 'ok', cancelled: false, ...extra });
  const r = rankConnections([c('a', 300), c('b', 100, { cancelled: true }), c('c', 200)]);
  assert.deepEqual(r.map((x) => x.id), ['c', 'a', 'b']);
  assert.equal(r[0].best, true);
  assert.equal(r[2].best, false);
});

test('recommendationChanged vergleicht nur noch offene Fahrten', () => {
  const conn = (trips) => ({ legs: trips.map(([tripId, end]) => ({ kind: 'transit', tripId, end })) });
  const prev = recommendationKey(conn([['s9', NOW - MIN], ['bus1', NOW + 30 * MIN]]));
  assert.equal(recommendationChanged(prev, conn([['bus1', NOW + 31 * MIN]]), NOW), false);
  assert.equal(recommendationChanged(prev, conn([['bus2', NOW + 25 * MIN]]), NOW), true);
});

test('nextStopOfTrip: nächster Halt nach jetzt', () => {
  const iso = (m) => new Date(NOW + m * MIN).toISOString();
  const trip = { legs: [{ mode: 'SUBURBAN', from: { name: 'A', departure: iso(-10) }, intermediateStops: [{ name: 'B', arrival: iso(-2) }, { name: 'C', arrival: iso(3), stopId: 'c' }], to: { name: 'D', arrival: iso(9) } }] };
  const { next, passed } = nextStopOfTrip(trip, NOW);
  assert.equal(next.name, 'C');
  assert.deepEqual(passed.map((p) => p.name), ['A', 'B']);
});

test('planJourney Hinweg: Kombinationen, Rad-Zeitversatz, Rangliste, mehrdeutige Haltestelle', async () => {
  const { client, calls } = createFakeClient();
  const stops = await resolveStops(client, GEO_STOPS);
  assert.equal(stops.oftersheim.status, 'ambiguous');
  assert.equal(stops.home.id, 'de:08215:1001');

  const weather = { current: { time: NOW, temperature: 15, precipitation: 0, wind: 5 }, hourly: [] };
  const { connections, results } = await planJourney({
    client, journey: OUTBOUND, stops, rules: RULES, now: NOW, weather, weatherThresholds: WEATHER.goodBikeWeather,
  });

  // A3 (Oftersheim) nicht geklärt → Fehler statt Raten
  assert.equal(results.filter((r) => r.status === 'error').length, 2);
  assert.match(results.find((r) => r.combo.id === 'bus+A3').error, /Oftersheim/);

  // Rad: Suche ab Graben-Neudorf startet jetzt + 28 Min.
  const bikePlan = calls.find((c) => c.type === 'plan' && c.fromPlace === 'de:08215:2000');
  assert.equal(bikePlan.time, NOW + 28 * MIN);

  // Beste Verbindung hervorgehoben, sortiert nach Ankunft
  assert.equal(connections.filter((c) => c.best).length, 1);
  for (let i = 1; i < connections.length; i++) assert.ok(connections[i - 1].arrival <= connections[i].arrival);

  // Rad-Verbindungen: Losfahren 28 Min. vor Abfahrt, Wetter angehängt
  const bike = connections.find((c) => c.usesBike);
  assert.equal(bike.legs[0].kind, 'bike');
  assert.equal(bike.legs[1].start - bike.departure, 28 * MIN);
  assert.equal(bike.weather.good, true);

  // Neulußheim-Umstieg ist knapp (3 Min.) und kritisch
  const a1 = connections.find((c) => c.comboId === 'bus+A1');
  assert.equal(a1.riskLevel, 'critical');

  // Echtzeit-Hinweis
  assert.ok(connections.some((c) => c.realtime === 'none'));
});

test('planJourney: Weg B ohne Ergebnis zur Arbeit → Schätzung ab Wiesloch-Walldorf (+15 Min.)', async () => {
  const { client } = createFakeClient({ emptyTo: ['de:08226:8000', 'de:08226:9000'] });
  const stops = await resolveStops(client, GEO_STOPS);
  const { connections } = await planJourney({ client, journey: OUTBOUND, stops, rules: RULES, now: NOW, weather: null, weatherThresholds: WEATHER.goodBikeWeather });
  const b = connections.filter((c) => c.comboId.endsWith('+B'));
  assert.ok(b.length > 0);
  assert.ok(b.every((c) => c.estimated));
  const est = b[0].legs.find((l) => l.kind === 'estimate');
  assert.equal(est.end - est.start, 15 * MIN);
});

test('planJourney GPS: Start mit Koordinaten, Graben-Neudorf liegt hinter mir', async () => {
  const { client, calls } = createFakeClient();
  const stops = await resolveStops(client, GEO_STOPS);
  // Standort bei Waghäusel (zwischen Graben-Neudorf und Neulußheim)
  await planJourney({ client, journey: OUTBOUND, stops, rules: RULES, now: NOW, start: { type: 'gps', lat: 49.25, lon: 8.52 }, weather: null, weatherThresholds: WEATHER.goodBikeWeather });
  const plans = calls.filter((c) => c.type === 'plan');
  assert.ok(plans.every((p) => p.fromPlace === '49.25,8.52'));
  assert.ok(plans.every((p) => !p.via.includes('de:08215:2000')));
  assert.equal(plans[0].maxPreTransitTime, RULES.maxPreTransitSecondsFromGps);
});

test('planJourney: API-Fehler einer Variante bricht den Rest nicht ab', async () => {
  const { client } = createFakeClient({ failVia: ['de:08226:6000'] });
  const stops = await resolveStops(client, GEO_STOPS);
  const { results } = await planJourney({ client, journey: RETURN, stops, rules: RULES, now: NOW, weather: null, weatherThresholds: WEATHER.goodBikeWeather });
  assert.ok(results.some((r) => r.status === 'error' && /500/.test(r.error)));
  assert.ok(results.some((r) => r.status === 'ok'));
});

test('fitsVariant: "über Neulußheim" nur mit echtem Bus-Umstieg dort (Durchfahren zählt nicht)', () => {
  const combo = buildCombinations(OUTBOUND).find((c) => c.id === 'bike+A1');
  const stops = { neulussheim: { key: 'neulussheim', id: 'de-DELFI_de:08226:3101', expected: 'Neulußheim', name: 'Neulußheim, Bahnhof' } };
  const leg = (mode, from, to) => ({ mode, from: { name: from.n, stopId: from.id }, to: { name: to.n, stopId: to.id } });
  const gn = { n: 'Graben-Neudorf Bahnhof', id: 'x:gn' };
  const neul = { n: 'Neulußheim, Bahnhof', id: 'de-DELFI_de:08226:3101:1:2' }; // Bahnsteig-ID
  const neulBus = { n: 'Neulußheim, Bahnhof', id: 'de-DELFI_de:08226:3101:0:1' };
  const hock = { n: 'Hockenheim, Bahnhof', id: 'x:hock' };
  const work = { n: 'Walldorf, Industriestr.', id: 'x:work' };
  const viaBus = { legs: [leg('SUBURBAN', gn, neul), leg('WALK', neul, neulBus), leg('BUS', neulBus, work)] };
  const throughTrain = { legs: [leg('SUBURBAN', gn, hock), leg('BUS', hock, work)] };
  assert.equal(fitsVariant(viaBus, combo, stops), true);
  assert.equal(fitsVariant(throughTrain, combo, stops), false);
});

test('planJourney: Via-Halte mit Mindestaufenthalt (erzwingt Aussteigen)', async () => {
  const { client, calls } = createFakeClient();
  const stops = await resolveStops(client, GEO_STOPS);
  await planJourney({ client, journey: OUTBOUND, stops, rules: RULES, now: NOW, weather: null, weatherThresholds: WEATHER.goodBikeWeather });
  const p = calls.find((c) => c.type === 'plan' && c.via.length === 2);
  assert.deepEqual(p.viaMinimumStay, [RULES.viaMinimumStayMinutes, RULES.viaMinimumStayMinutes]);
});

test('resolveStops: feste IDs aus config.js → kein Geocoding', async () => {
  const { client, calls } = createFakeClient();
  const stops = await resolveStops(client, STOPS);
  assert.equal(calls.length, 0);
  assert.ok(Object.values(stops).every((s) => s.status === 'ok' && s.source === 'config'));
});

// --- Umstiegsregel: unter 3 Min. Puffer nie, Ausnahme Bruchsal → Graben-Neudorf (2 Min.)
const iso = (min) => new Date(NOW + min * MIN).toISOString();
const tleg = (mode, from, to, dep, arr) => ({
  mode, from: { name: from.n, stopId: from.id }, to: { name: to.n, stopId: to.id },
  startTime: iso(dep), endTime: iso(arr), scheduledStartTime: iso(dep), scheduledEndTime: iso(arr), realTime: false, tripId: `${mode}${dep}`,
});
const BR = { n: 'Bruchsal', id: 'de-DELFI_de:08215:1856:4:4' };
const WW = { n: 'Wiesloch-Walldorf, Bf', id: 'ww' };
const GN = { n: 'Graben-Neudorf Bahnhof', id: 'gn' };
const NEUL = { n: 'Neulußheim, Bahnhof', id: 'de-DELFI_de:08226:3101:1:1' };
const WORKSTOP = { n: 'Walldorf, Industriestr.', id: 'work' };
const realStops = {
  bruchsal: { key: 'bruchsal', id: 'de-DELFI_de:08215:1856', expected: 'Bruchsal', name: 'Bruchsal' },
  neulussheim: { key: 'neulussheim', id: 'de-DELFI_de:08226:3101', expected: 'Neulußheim', name: 'Neulußheim, Bahnhof' },
  grabenNeudorf: { key: 'grabenNeudorf', id: 'gn', expected: 'Graben-Neudorf', name: 'Graben-Neudorf Bahnhof' },
};

test('meetsMinBuffer: 2 Min. Puffer (5 Min. Umstieg − 3 Min. Fußweg) wird verworfen, 3 Min. nicht', () => {
  const combo = buildCombinations(OUTBOUND).find((c) => c.id === 'bike+A1');
  const it = (busDep) => ({ legs: [
    tleg('SUBURBAN', GN, NEUL, 0, 11),
    tleg('WALK', NEUL, NEUL, 12, 15),
    tleg('BUS', NEUL, WORKSTOP, busDep, busDep + 23),
  ] });
  assert.equal(meetsMinBuffer(it(16), combo, realStops, RULES), false); // 16 − 11 − 3 = 2
  assert.equal(meetsMinBuffer(it(17), combo, realStops, RULES), true); // 3
});

test('meetsMinBuffer: Ausnahme nur Bruchsal → Graben (Rückweg B), nicht auf dem Hinweg', () => {
  const ret = buildCombinations(RETURN).find((c) => c.id === 'B+bus');
  const out = buildCombinations(OUTBOUND).find((c) => c.id === 'bike+B');
  const back = { legs: [tleg('SUBURBAN', WW, BR, 0, 15), tleg('SUBURBAN', BR, GN, 17, 30)] }; // 2 Min. in Bruchsal
  const there = { legs: [tleg('SUBURBAN', GN, BR, 0, 13), tleg('SUBURBAN', BR, WW, 15, 30)] }; // 2 Min. in Bruchsal
  assert.equal(meetsMinBuffer(back, ret, realStops, RULES), true);
  assert.equal(meetsMinBuffer(there, out, realStops, RULES), false);
  const back1 = { legs: [tleg('SUBURBAN', WW, BR, 0, 15), tleg('SUBURBAN', BR, GN, 16, 30)] }; // 1 Min. – zu knapp
  assert.equal(meetsMinBuffer(back1, ret, realStops, RULES), false);
});

test('meetsMinBuffer: entscheidet nach Fahrplan, nicht nach Echtzeit', () => {
  const combo = buildCombinations(OUTBOUND).find((c) => c.id === 'bike+A1');
  const late = { legs: [
    { ...tleg('SUBURBAN', GN, NEUL, 0, 11), endTime: iso(14) }, // 3 Min. Verspätung
    tleg('BUS', NEUL, WORKSTOP, 16, 39),
  ] };
  assert.equal(meetsMinBuffer(late, combo, realStops, RULES), true); // laut Plan 5 Min. → bleibt, wird nur "knapp"
});

test('nextOccurrence: Freitagabend → Montag 7:30 (Berlin, Sommerzeit)', () => {
  const fri = Date.parse('2026-10-16T21:30:00Z'); // Fr 23:30 MESZ
  assert.equal(new Date(nextOccurrence(fri, '07:30', { timeZone: 'Europe/Berlin', weekdays: [1, 2, 3, 4, 5] })).toISOString(), '2026-10-19T05:30:00.000Z');
  const monEarly = Date.parse('2026-10-19T04:00:00Z'); // Mo 06:00 → heute 17:00
  assert.equal(new Date(nextOccurrence(monEarly, '17:00', { timeZone: 'Europe/Berlin', weekdays: [1, 2, 3, 4, 5] })).toISOString(), '2026-10-19T15:00:00.000Z');
});

test('nextOccurrence: über die Zeitumstellung (25.10.2026) hinweg', () => {
  const fri = Date.parse('2026-10-23T18:00:00Z'); // Fr 20:00 MESZ
  // Montag 26.10. ist schon Winterzeit (MEZ, UTC+1)
  assert.equal(new Date(nextOccurrence(fri, '07:30', { timeZone: 'Europe/Berlin', weekdays: [1, 2, 3, 4, 5] })).toISOString(), '2026-10-26T06:30:00.000Z');
  const sat = Date.parse('2026-10-24T20:00:00Z'); // Sa 22:00 MESZ → So 25.10. 07:30 MEZ
  assert.equal(new Date(nextOccurrence(sat, '07:30', { timeZone: 'Europe/Berlin' })).toISOString(), '2026-10-25T06:30:00.000Z');
});

test('weatherAt: ohne Vorhersage für die Stunde und weit weg von jetzt → unbekannt', () => {
  const data = { current: { time: NOW, temperature: 12, precipitation: 0, wind: 10 }, hourly: [] };
  assert.equal(weatherAt(data, NOW + 3 * 24 * 60 * MIN, WEATHER.goodBikeWeather), null);
});

test('withoutTransferReserve: Reserve nur aus Umstiegs-Fußwegen herausrechnen', () => {
  const walk = (dep, arr) => ({ ...tleg('WALK', BR, BR, dep, arr), duration: (arr - dep) * 60 });
  const it = { legs: [walk(-5, 0), tleg('SUBURBAN', GN, BR, 0, 13), walk(14, 22), tleg('SUBURBAN', BR, WW, 30, 42), walk(42, 50)] };
  const out = withoutTransferReserve(it, 3);
  assert.equal(out.legs[2].duration, 5 * 60); // 8 Min. inkl. Reserve → 5 Min. Fußweg
  assert.equal(out.legs[2].endTime, iso(19));
  assert.equal(out.legs[0].duration, 5 * 60); // Zugang (kein Umstieg) unverändert
  assert.equal(out.legs[4].duration, 8 * 60); // Abgang unverändert
  assert.equal(it.legs[2].duration, 8 * 60); // Original unverändert
});

test('planJourney: Reserve = Mindestpuffer − Via-Aufenthalt, Bruchsal-Ausnahme eigene Abfrage', async () => {
  const { client, calls } = createFakeClient();
  const stops = await resolveStops(client, GEO_STOPS);
  // geplante Suche (Montag) → keine Echtzeit-Zusatzabfrage
  await planJourney({ client, journey: RETURN, stops, rules: RULES, now: NOW, realNow: NOW - 3 * 24 * 60 * MIN, weather: null, weatherThresholds: WEATHER.goodBikeWeather });
  const plans = calls.filter((c) => c.type === 'plan');
  const stay = RULES.viaMinimumStayMinutes;
  const fromWW = plans.filter((p) => p.fromPlace === 'de:08226:4000'); // Rückweg B+bus, B+bike
  assert.deepEqual(fromWW.map((p) => p.additionalTransferTime).sort(), [2 - stay, 2 - stay, 3 - stay, 3 - stay]);
  assert.ok(plans.filter((p) => p.fromPlace !== 'de:08226:4000').every((p) => p.additionalTransferTime === 3 - stay));
  assert.ok(plans.every((p) => !p.realtimeMode));
});

test('planJourney: nahe "jetzt" zusätzlich Routing nach Fahrplan mit Echtzeit-Info', async () => {
  const { client, calls } = createFakeClient();
  const stops = await resolveStops(client, GEO_STOPS);
  await planJourney({ client, journey: OUTBOUND, stops, rules: RULES, now: NOW, realNow: NOW, weather: null, weatherThresholds: WEATHER.goodBikeWeather });
  const plans = calls.filter((c) => c.type === 'plan');
  const ann = plans.filter((p) => p.realtimeMode === 'REALTIME_ANNOTATION_ONLY');
  assert.equal(ann.length, plans.length / 2);
});

test('mergeItineraries: gleiche erste Fahrt → schnellste; ist die verpasst, bleibt die Alternative', () => {
  const S = { n: 'Neulußheim, Bahnhof', id: 'n' };
  const train = tleg('SUBURBAN', GN, S, 0, 11);
  const bus = (dep, delayedArrival) => ({ legs: [
    { ...train, endTime: iso(delayedArrival ?? 11) },
    tleg('WALK', S, S, (delayedArrival ?? 11), (delayedArrival ?? 11) + 3),
    { ...tleg('BUS', S, WORKSTOP, dep, dep + 20), tripId: `bus${dep}` },
  ], startTime: iso(0), endTime: iso(dep + 20) });
  const merged = mergeItineraries([bus(16), bus(76)], 3);
  assert.equal(merged.length, 1); // gleiche S-Bahn → nur die schnellere
  const late = mergeItineraries([bus(16, 15), bus(76, 15)], 3); // S-Bahn 4 Min. zu spät → Bus 16 verpasst
  assert.equal(late.length, 2);
});

test('meetsStartBuffer: unterwegs zählt der Umstieg am nächsten Halt, sitzen bleiben ist ok', () => {
  const combo = buildCombinations(OUTBOUND).find((c) => c.id === 'bike+A1');
  const start = { place: { stopId: NEUL.id, name: NEUL.n }, tripId: 'S6-1', arrivalScheduled: NOW + 11 * MIN };
  const seated = { legs: [{ ...tleg('SUBURBAN', NEUL, WORKSTOP, 12, 30), tripId: 'S6-1' }] };
  const tight = { legs: [tleg('WALK', NEUL, NEUL, 11, 14), tleg('BUS', NEUL, WORKSTOP, 16, 39)] }; // 5 − 3 = 2
  const ok = { legs: [tleg('WALK', NEUL, NEUL, 11, 14), tleg('BUS', NEUL, WORKSTOP, 17, 40)] }; // 3
  assert.equal(meetsStartBuffer(seated, start, combo, realStops, RULES), true);
  assert.equal(meetsStartBuffer(tight, start, combo, realStops, RULES), false);
  assert.equal(meetsStartBuffer(ok, start, combo, realStops, RULES), true);
});

test('zonedTime: fehlende Stunde (29.03.2026 02:30) → 03:30 MESZ, doppelte (25.10. 02:30) → frühere', () => {
  assert.equal(new Date(zonedTime(2026, 3, 29, 2, 30, 'Europe/Berlin')).toISOString(), '2026-03-29T01:30:00.000Z');
  assert.equal(new Date(zonedTime(2026, 10, 25, 2, 30, 'Europe/Berlin')).toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(new Date(zonedTime(2026, 10, 19, 7, 30, 'Europe/Berlin')).toISOString(), '2026-10-19T05:30:00.000Z');
});

test('nextOccurrence: kurz nach der gewohnten Zeit → jetzt statt morgen', () => {
  const mon0732 = Date.parse('2026-10-19T05:32:00Z');
  const opts = { timeZone: 'Europe/Berlin', weekdays: [1, 2, 3, 4, 5], graceMinutes: 30 };
  assert.equal(nextOccurrence(mon0732, '07:30', opts), mon0732);
  const mon0815 = Date.parse('2026-10-19T06:15:00Z');
  assert.equal(new Date(nextOccurrence(mon0815, '07:30', opts)).toISOString(), '2026-10-20T05:30:00.000Z');
});

test('requiredBuffer: Bruchsal-Ausnahme nur Richtung Graben-Neudorf', () => {
  const combo = buildCombinations(RETURN).find((c) => c.id === 'B+bus');
  const arr = { toName: 'Bruchsal', toStopId: 'de-DELFI_de:08215:1856:4:4' };
  const toGN = { fromName: 'Bruchsal', fromStopId: 'de-DELFI_de:08215:1856:1:1', toName: 'Graben-Neudorf Bahnhof', toStopId: 'gn' };
  const toKA = { fromName: 'Bruchsal', fromStopId: 'de-DELFI_de:08215:1856:3:3', toName: 'Karlsruhe Hbf', toStopId: 'ka' };
  assert.equal(requiredBuffer(arr, toGN, combo, realStops, RULES), 2);
  assert.equal(requiredBuffer(arr, toKA, combo, realStops, RULES), RULES.minBufferMinutes);
});
