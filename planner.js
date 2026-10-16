// plan-b – Ablaufsteuerung: verbindet api.js (Daten holen) mit logic.js (auswerten).
// Kein DOM. Später in NestJS: PlannerService, der TransitousService + RoutingLogic nutzt.

import {
  pickStopMatch, buildCombinations, combinationsEnRoute, buildQueries, mergeItineraries,
  analyzeItinerary, fitsVariant, rankConnections, weatherAt, isViaBehind, placeMatchesStop,
  nextStopOfTrip, currentTransitLeg, tokens,
} from './logic.js';

/**
 * @typedef {import('./logic.js').ResolvedStop} ResolvedStop
 * @typedef {import('./logic.js').Combination} Combination
 * @typedef {import('./logic.js').Connection} Connection
 * @typedef {import('./logic.js').WeatherData} WeatherData
 * @typedef {import('./config.js').Journey} Journey
 * @typedef {import('./config.js').StopConfig} StopConfig
 * @typedef {ReturnType<import('./api.js').createTransitousClient>} TransitousClient
 *
 * @typedef {{get: (key: string) => any, set: (key: string, value: any) => void}} KeyValueCache
 *
 * @typedef {{type: 'gps', lat: number, lon: number}
 *         | {type: 'trip', place: {stopId: string, name: string}, time: number, passed: Array<{name: string, stopId?: string}>, label: string}} EnRouteStart
 *
 * @typedef {Object} ComboResult
 * @property {Combination} combo
 * @property {'ok'|'empty'|'error'} status
 * @property {string} [error]
 * @property {Connection[]} connections
 */

/** Geocoding-Suchtext: Name, ergänzt um den Ort, falls der nicht schon im Namen steckt. */
function geocodeText(cfg) {
  if (cfg.query) return cfg.query;
  const nameTok = tokens(cfg.name);
  return tokens(cfg.place).every((t) => nameTok.includes(t)) ? cfg.name : `${cfg.name} ${cfg.place}`;
}

/**
 * Löst alle Haltestellen auf. Reihenfolge: ID aus config.js → Auswahl des Nutzers → Cache → Geocoding.
 * Es wird nie geraten: Mehrdeutige/fehlende Halte kommen mit status 'ambiguous'/'notFound' zurück.
 *
 * @param {TransitousClient} client
 * @param {Record<string, StopConfig>} stopsCfg
 * @param {{cache?: KeyValueCache, choices?: Record<string, any>}} [opts]
 * @returns {Promise<Record<string, ResolvedStop>>}
 */
export async function resolveStops(client, stopsCfg, { cache, choices = {} } = {}) {
  const entries = await Promise.all(Object.entries(stopsCfg).map(async ([key, cfg]) => {
    const base = { key, expected: cfg.name, place: cfg.place };
    if (cfg.id) {
      return [key, { ...base, status: 'ok', source: 'config', id: cfg.id, name: cfg.name, lat: cfg.lat, lon: cfg.lon }];
    }
    const sig = choiceSignature(cfg);
    const choice = choices[key];
    if (choice && choice.sig === sig) {
      return [key, { ...base, status: 'ok', source: 'choice', ...choice.stop }];
    }
    const cached = cache?.get(`stop:${key}`);
    if (cached && cached.sig === sig) return [key, cached.stop];
    try {
      const matches = await client.geocode(geocodeText(cfg));
      const stop = pickStopMatch(key, cfg, matches);
      if (stop.status === 'ok') cache?.set(`stop:${key}`, { sig, stop });
      return [key, stop];
    } catch (e) {
      return [key, { ...base, status: 'error', id: null, name: cfg.name, error: e.message }];
    }
  }));
  return Object.fromEntries(entries);
}

/** Signatur für gespeicherte Nutzer-Auswahl (wird ungültig, wenn sich config.js ändert). */
export function choiceSignature(cfg) {
  return `${cfg.name}|${cfg.place}|${cfg.query ?? ''}`;
}

/**
 * "Ich sitze gerade in …": aktuelle Fahrt der gewählten Verbindung live abfragen
 * und den nächsten Halt (inkl. Echtzeit-Verspätung) als neuen Startpunkt liefern.
 *
 * @param {TransitousClient} client
 * @param {Connection} conn
 * @param {number} now
 * @returns {Promise<EnRouteStart>}
 */
export async function locateInConnection(client, conn, now) {
  const leg = currentTransitLeg(conn, now);
  if (!leg) throw new Error('Diese Verbindung ist schon beendet – bitte eine aktuellere wählen oder GPS nutzen.');

  // Was laut Verbindung schon hinter mir liegt (z. B. Graben-Neudorf, wenn ich in der S9 sitze)
  const passed = conn.legs
    .filter((l) => l.kind === 'transit' && l.end <= now)
    .flatMap((l) => [{ name: l.fromName, stopId: l.fromStopId }, { name: l.toName, stopId: l.toStopId }]);

  if (leg.start > now) {
    // Noch nicht eingestiegen → ab der Einstiegshaltestelle planen
    return { type: 'trip', place: { stopId: leg.fromStopId, name: leg.fromName }, time: leg.start, passed, label: `${leg.line} ab ${leg.fromName}` };
  }

  const trip = await client.trip(leg.tripId);
  const { next, passed: passedInTrip } = nextStopOfTrip(trip, now);
  if (!next?.stopId) throw new Error('Nächster Halt dieser Fahrt nicht ermittelbar.');
  const time = Date.parse(next.arrival ?? next.departure);
  return {
    type: 'trip',
    place: { stopId: next.stopId, name: next.name },
    time: Math.max(now, time),
    passed: [...passed, ...passedInTrip.map((p) => ({ name: p.name, stopId: p.stopId }))],
    label: `${leg.line} → nächster Halt ${next.name}`,
  };
}

/**
 * Kernablauf: Kombinationen bilden → alle parallel abfragen → auswerten → gemeinsame Rangliste.
 *
 * @param {Object} p
 * @param {TransitousClient} p.client
 * @param {Journey} p.journey
 * @param {Record<string, ResolvedStop>} p.stops
 * @param {import('./config.js').RULES} p.rules
 * @param {number} p.now
 * @param {EnRouteStart} [p.start]            Unterwegs-Startpunkt (GPS oder Fahrt)
 * @param {WeatherData|null} [p.weather]
 * @param {Object} [p.weatherThresholds]
 * @returns {Promise<{connections: Connection[], results: ComboResult[]}>}
 */
export async function planJourney({ client, journey, stops, rules, now, start, weather, weatherThresholds }) {
  let combos = buildCombinations(journey);
  /** @type {{place: string, time?: number, maxPreTransitTime?: number}|undefined} */
  let startInfo;

  if (start?.type === 'gps') {
    const me = { lat: start.lat, lon: start.lon };
    const target = stops[combos[0]?.to[0]];
    combos = combinationsEnRoute(combos, (key) => isViaBehind(me, target, stops[key]));
    startInfo = { place: `${start.lat},${start.lon}`, time: now, maxPreTransitTime: rules.maxPreTransitSecondsFromGps };
  } else if (start?.type === 'trip') {
    const isPassed = (key) =>
      placeMatchesStop(start.place, stops[key]) || start.passed.some((p) => placeMatchesStop(p, stops[key]));
    combos = combinationsEnRoute(combos, isPassed);
    startInfo = { place: start.place.stopId, time: start.time };
  }

  const results = await Promise.all(combos.map((combo) => runCombination({ client, combo, stops, rules, now, startInfo })));

  // Wetter an alle Rad-Kombinationen hängen (Zeitpunkt der Radfahrt)
  for (const r of results) {
    for (const c of r.connections) {
      if (c.usesBike && c.bikeTime) c.weather = weatherAt(weather ?? null, c.bikeTime, weatherThresholds);
    }
  }

  const connections = rankConnections(results.flatMap((r) => r.connections));
  return { connections, results };
}

/**
 * Eine Kombination abfragen (alle Start×Ziel-Paare), zusammenführen und ggf. Schätzung anwenden.
 * @returns {Promise<ComboResult>}
 */
async function runCombination({ client, combo, stops, rules, now, startInfo }) {
  const { queries, missing } = buildQueries(combo, stops, now, startInfo);
  if (missing.length) {
    const names = missing.map((k) => stops[k]?.expected ?? k).join(', ');
    return { combo, status: 'error', error: `Haltestelle nicht geklärt: ${names}`, connections: [] };
  }

  // viaMinimumStay ≥ 1 → am Via-Halt wird wirklich ausgestiegen (nicht nur durchgefahren)
  const viaMinimumStay = (q) => q.via.map(() => rules.viaMinimumStayMinutes);
  const ask = (qs) => Promise.allSettled(qs.map((q) => client.plan({ ...q, viaMinimumStay: viaMinimumStay(q), numItineraries: rules.connectionsPerVariant })));
  // Nur Verbindungen behalten, die zur Variante passen (Bus-Umstieg am richtigen Bahnhof)
  const collect = (settled) => settled
    .filter((s) => s.status === 'fulfilled')
    .flatMap((s) => s.value.itineraries ?? [])
    .filter((it) => fitsVariant(it, combo, stops));

  const settled = await ask(queries);
  if (settled.every((s) => s.status === 'rejected')) {
    return { combo, status: 'error', error: settled[0].reason?.message ?? 'Abfrage fehlgeschlagen', connections: [] };
  }
  let itineraries = mergeItineraries(collect(settled), rules.connectionsPerVariant, queries[0].time);
  let estimate = null;

  // Weg B: Liefert die API bis zur Arbeit nichts, bis Wiesloch-Walldorf suchen und Bus schätzen.
  if (itineraries.length === 0 && combo.fallback && stops[combo.fallback.to]?.id) {
    const fbTo = stops[combo.fallback.to].id;
    const fbQueries = [...new Map(queries.map((q) => [q.fromPlace, { ...q, toPlace: fbTo }])).values()];
    itineraries = mergeItineraries(collect(await ask(fbQueries)), rules.connectionsPerVariant, queries[0].time);
    estimate = combo.fallback;
  }

  const connections = itineraries.map((it) => analyzeItinerary(it, combo, stops, rules, estimate));
  return { combo, status: connections.length ? 'ok' : 'empty', connections };
}

