// plan-b – Ablaufsteuerung: verbindet api.js (Daten holen) mit logic.js (auswerten).
// Kein DOM. Später in NestJS: PlannerService, der TransitousService + RoutingLogic nutzt.

import {
  pickStopMatch, buildCombinations, combinationsEnRoute, buildQueries, mergeItineraries,
  analyzeItinerary, fitsVariant, meetsMinBuffer, meetsStartBuffer, exceptionMinutes, withoutTransferReserve,
  itineraryKey, rankConnections, weatherAt, isViaBehind, placeMatchesStop,
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
 *         | {type: 'trip', place: {stopId: string, name: string}, time: number, passed: Array<{name: string, stopId?: string}>, label: string,
 *            tripId?: string, arrivalScheduled?: number}} EnRouteStart
 *   tripId/arrivalScheduled: Fahrt, in der ich sitze, und ihre planmäßige Ankunft am Start-Halt (Umstiegsprüfung)
 *
 * @typedef {Object} ComboResult
 * @property {Combination} combo
 * @property {'ok'|'empty'|'error'} status
 * @property {string} [error]
 * @property {{variant: number, buffer: number}} [dropped]  verworfene Verbindungen (falsche Route / zu knapper Umstieg), je Fahrtenfolge gezählt
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
    return { type: 'trip', place: { stopId: leg.fromStopId, name: leg.fromName }, time: leg.start, passed, label: `${leg.line} ab ${leg.fromName}`, tripId: leg.tripId };
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
    tripId: leg.tripId,
    arrivalScheduled: Date.parse(next.scheduledArrival ?? next.scheduledDeparture ?? next.arrival ?? next.departure),
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
 * @param {number} p.now                     Suchzeit (jetzt oder geplante Abfahrt)
 * @param {number} [p.realNow]                tatsächliche Uhrzeit (Standard: now) – Echtzeit gibt es nur nahe jetzt
 * @param {EnRouteStart} [p.start]            Unterwegs-Startpunkt (GPS oder Fahrt)
 * @param {WeatherData|null} [p.weather]
 * @param {Object} [p.weatherThresholds]
 * @returns {Promise<{connections: Connection[], results: ComboResult[]}>}
 */
export async function planJourney({ client, journey, stops, rules, now, realNow = now, start, weather, weatherThresholds }) {
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
    startInfo = { place: start.place.stopId, time: start.time, trip: start };
  }

  const realtimeNear = Math.abs(now - realNow) < 90 * 60_000;
  const results = await Promise.all(combos.map((combo) => runCombination({ client, combo, stops, rules, now, startInfo, realtimeNear })));

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
async function runCombination({ client, combo, stops, rules, now, startInfo, realtimeNear }) {
  const { queries, missing } = buildQueries(combo, stops, now, startInfo);
  if (missing.length) {
    const names = missing.map((k) => stops[k]?.expected ?? k).join(', ');
    return { combo, status: 'error', error: `Haltestelle nicht geklärt: ${names}`, connections: [] };
  }

  // Wie die Umstiegsregel in die Routensuche kommt (alle Werte in Minuten):
  // - viaMinimumStay = 1 zwingt zum Aussteigen am Via-Halt (sonst zählt auch Durchfahren).
  // - additionalTransferTime = Reserve je Umstieg. Der Router plant dann nur Umstiege mit genug Luft und
  //   liefert auch "gleicher Zug, nächster Bus". An Via-Halten addiert MOTIS den Aufenthalt dazu,
  //   deshalb Reserve = Mindestpuffer − Aufenthalt. Ausnahmen (Bruchsal 2 Min.) bekommen eine eigene Abfrage.
  // - Nahe "jetzt" zusätzlich REALTIME_ANNOTATION_ONLY: Routing nach Fahrplan, Echtzeit nur als Info →
  //   eine Verspätung macht eine Verbindung "knapp", lässt sie aber nicht verschwinden.
  // - Wurde etwas wegen zu knapper Umstiege verworfen (Umstieg außerhalb der Via-Halte bzw. am
  //   Unterwegs-Start), folgt eine zweite Runde mit voller Reserve bzw. späterer Startzeit.
  const stay = combo.via.length ? rules.viaMinimumStayMinutes : 0;
  const R = rules.minBufferMinutes;
  const variants = [...new Set([R, ...exceptionMinutes(combo)])].map((m) => ({ reserve: Math.max(0, m - stay) }));
  if (realtimeNear) variants.push({ reserve: Math.max(0, R - stay), realtimeMode: 'REALTIME_ANNOTATION_ONLY' });

  const ask = (qs, vs) => Promise.allSettled(qs.flatMap((q) => vs.map(async (v) => {
    const res = await client.plan({
      ...q,
      viaMinimumStay: q.via.map(() => rules.viaMinimumStayMinutes),
      additionalTransferTime: v.reserve,
      realtimeMode: v.realtimeMode,
      numItineraries: rules.itinerariesPerQuery ?? rules.connectionsPerVariant,
    });
    return { ...res, itineraries: (res.itineraries ?? []).map((it) => withoutTransferReserve(it, v.reserve)) };
  })));

  // Nur Verbindungen behalten, die zur Variante passen (Bus-Umstieg am richtigen Bahnhof)
  // und keinen zu knappen Umstieg laut Fahrplan haben – auch nicht am Unterwegs-Start.
  const dropped = { variant: new Set(), buffer: new Set() };
  const collect = (settled) => settled
    .filter((s) => s.status === 'fulfilled')
    .flatMap((s) => s.value.itineraries ?? [])
    .filter((it) => {
      if (!fitsVariant(it, combo, stops)) { dropped.variant.add(itineraryKey(it)); return false; }
      if (!meetsMinBuffer(it, combo, stops, rules) || !meetsStartBuffer(it, startInfo?.trip, combo, stops, rules)) {
        dropped.buffer.add(itineraryKey(it));
        return false;
      }
      return true;
    });

  const run = async (qs) => {
    const settled = await ask(qs, variants);
    if (settled.every((s) => s.status === 'rejected')) return { error: settled[0].reason?.message ?? 'Abfrage fehlgeschlagen' };
    let found = collect(settled);
    if (dropped.buffer.size) {
      // Zweite Runde: volle Reserve (Umstiege außerhalb der Via-Halte), unterwegs ab Ankunft + Mindestpuffer
      const later = qs.map((q) => (startInfo?.trip?.arrivalScheduled ? { ...q, time: q.time + R * 60_000 } : q));
      found = found.concat(collect(await ask(later, [{ reserve: R }])));
    }
    return { found };
  };

  const first = await run(queries);
  if (first.error) return { combo, status: 'error', error: first.error, connections: [] };
  let itineraries = mergeItineraries(first.found, rules.connectionsPerVariant, queries[0].time);
  let estimate = null;

  // Weg B: Liefert die API bis zur Arbeit nichts, bis Wiesloch-Walldorf suchen und Bus schätzen.
  if (itineraries.length === 0 && combo.fallback && stops[combo.fallback.to]?.id) {
    const fbTo = stops[combo.fallback.to].id;
    const fbQueries = [...new Map(queries.map((q) => [q.fromPlace, { ...q, toPlace: fbTo }])).values()];
    const fb = await run(fbQueries);
    itineraries = mergeItineraries(fb.found ?? [], rules.connectionsPerVariant, queries[0].time);
    estimate = combo.fallback;
  }

  const connections = itineraries.map((it) => analyzeItinerary(it, combo, stops, rules, estimate));
  return {
    combo,
    status: connections.length ? 'ok' : 'empty',
    connections,
    dropped: { variant: dropped.variant.size, buffer: dropped.buffer.size },
  };
}
