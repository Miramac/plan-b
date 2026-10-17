// plan-b – Ablaufsteuerung: verbindet api.js (Daten holen) mit logic.js (auswerten).
// Kein DOM. Später in NestJS: PlannerService, der TransitousService + RoutingLogic nutzt.

import {
  pickStopMatch, buildCombinations, combinationsEnRoute, buildQueries, mergeItineraries,
  analyzeItinerary, fitsVariant, meetsMinBuffer, meetsStartBuffer, exceptionMinutes, withoutTransferReserve,
  itineraryKey, rankConnections, forDeparture, weatherAt, isViaBehind, placeMatchesStop,
  nextStopOfTrip, currentTransitLeg, tokens, recentDepartures, upcomingStops, tripSequence,
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
 *            tripId?: string|null, arrivalScheduled?: number, delayMin?: number, realTime?: boolean, upcoming?: Array<any>,
 *            boardKey?: string, notBoarded?: boolean, boardCancelled?: boolean, endsEarly?: boolean, terminus?: string}} EnRouteStart
 *   boardKey: Config-Haltestelle, an der ich eingestiegen bin (alles davor liegt hinter mir)
 *   notBoarded: Zug ist am Einstiegsbahnhof noch nicht abgefahren → Planung ab dort
 *   tripId/arrivalScheduled: Fahrt, in der ich sitze, und ihre planmäßige Ankunft am Start-Halt (Umstiegsprüfung)
 *
 * @typedef {Object} ComboResult
 * @property {Combination} combo
 * @property {'ok'|'empty'|'error'|'late'} status   late = nur Abfahrten deutlich nach der gewünschten Zeit
 * @property {number} [nextDeparture]              bei late: früheste Abfahrt
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

/** Endgültiger Fehler unterwegs (Fahrt vorbei, Verbindung beendet) – im Gegensatz zu Netzwerkfehlern. */
export class FinalTripError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FinalTripError';
  }
}

/**
 * Zugauswahl unterwegs: Abfahrten der letzten Stunde (und der nächsten Minuten) an einer Haltestelle.
 * @param {TransitousClient} client
 * @param {string} stopId
 * @param {number} now
 * @returns {Promise<import('./logic.js').Departure[]>}
 */
export async function departuresAt(client, stopId, now) {
  const res = await client.stoptimes({ stopId, time: now - 60 * 60_000, n: 60 });
  return recentDepartures(res.stopTimes, now, { pastMinutes: 60, futureMinutes: 20 });
}

/**
 * "Ich sitze in diesem Zug": Fahrt live abfragen und den nächsten bedienten Halt (inkl. Echtzeit)
 * als neuen Startpunkt liefern.
 * - Ist der Zug am Einstiegsbahnhof noch nicht abgefahren → Start dort (ich steige erst ein).
 * - Entfallende Halte werden übersprungen; endet der Zug vorzeitig, ist der letzte bediente Halt das Ende.
 * - Als passiert zählen nur Halte ab dem Einstiegsbahnhof (bei Ringfahrten nicht die Runde davor).
 *
 * @param {TransitousClient} client
 * @param {string} tripId
 * @param {number} now
 * @param {{alsoPassed?: Array<{name: string, stopId?: string}>, board?: ResolvedStop, boardStopId?: string, label?: string}} [opts]
 *   board = Einstiegsbahnhof, boardStopId = genauer Bahnsteig aus der Abfahrtsliste,
 *   label = Zugname wie in der Abfahrtsliste (die Fahrt selbst heißt bei durchgebundenen Zügen evtl. anders)
 * @returns {Promise<EnRouteStart>}
 */
export async function locateInTrip(client, tripId, now, { alsoPassed = [], board, boardStopId, label: shownLabel } = {}) {
  const trip = await client.trip(tripId);
  const leg = trip?.legs?.[0];
  const seq = tripSequence(trip);
  const line = leg?.displayName || leg?.routeShortName || '';
  const label = shownLabel ?? `${line}${leg?.headsign ? ` → ${leg.headsign}` : ''}`;
  const realTime = !!leg?.realTime;
  const t = (iso) => Date.parse(iso);
  const minutes = (a, b) => Math.round((a - b) / 60_000);
  // Einstieg: zuerst exakt über den Bahnsteig, sonst über die Station
  let boardIdx = boardStopId ? seq.findIndex((p) => p.stopId === boardStopId) : -1;
  if (boardIdx < 0 && board) boardIdx = seq.findIndex((p) => !p.cancelled && placeMatchesStop(p, board));

  // Noch nicht am Einstiegsbahnhof abgefahren → ich steige dort erst ein
  if (boardIdx >= 0) {
    const b = seq[boardIdx];
    const dep = t(b.departure ?? b.arrival);
    if (dep > now) {
      const sched = t(b.scheduledDeparture ?? b.departure ?? b.arrival);
      const { terminus, endsEarly } = nextStopOfTrip(trip, now);
      return {
        type: 'trip', place: { stopId: b.stopId, name: b.name }, time: dep, passed: alsoPassed,
        label: `${label} ab ${b.name}${b.cancelled ? ' (hält hier nicht!)' : ''}`, tripId, notBoarded: true, boardKey: board?.key,
        boardCancelled: !!b.cancelled, endsEarly, terminus: terminus?.name,
        delayMin: minutes(dep, sched), realTime, upcoming: upcomingStops(trip, now).filter((p) => seq.findIndex((x) => x.stopId === p.stopId) > boardIdx),
      };
    }
  }

  const { next, passed, terminus, endsEarly } = nextStopOfTrip(trip, now);
  const fromBoard = (list) => (boardIdx >= 0 ? list.filter((p) => seq.indexOf(p) >= boardIdx) : list);
  const toPassed = (list) => [...alsoPassed, ...fromBoard(list).map((p) => ({ name: p.name, stopId: p.stopId }))];

  if (!next) {
    // Zug ist am (evtl. vorzeitigen) Ende angekommen: kurz danach ab dort planen, ohne Weiterfahrt
    const arr = terminus ? t(terminus.arrival ?? terminus.departure) : 0;
    if (!terminus || arr < now - 30 * 60_000) throw new FinalTripError('Diese Fahrt ist schon am Ziel – bitte eine andere wählen.');
    // Zug endete schon VOR dem Einstiegsbahnhof → er war nie dort, wo ich bin
    if (boardIdx >= 0 && seq.indexOf(terminus) < boardIdx) {
      throw new FinalTripError(`Dieser Zug hat ${seq[boardIdx].name} nicht erreicht (endete in ${terminus.name}).`);
    }
    return {
      type: 'trip', place: { stopId: terminus.stopId, name: terminus.name }, time: now,
      passed: toPassed(passed.filter((p) => p !== terminus)), label: `${label} (endet in ${terminus.name})`,
      tripId: null, arrivalScheduled: t(terminus.scheduledArrival ?? terminus.arrival), delayMin: minutes(arr, t(terminus.scheduledArrival ?? terminus.arrival)),
      realTime, upcoming: [], boardKey: board?.key, endsEarly, terminus: terminus.name,
    };
  }

  const time = t(next.arrival ?? next.departure);
  const scheduled = t(next.scheduledArrival ?? next.scheduledDeparture ?? next.arrival ?? next.departure);
  return {
    type: 'trip',
    place: { stopId: next.stopId, name: next.name },
    time: Math.max(now, time),
    passed: toPassed(passed),
    label,
    tripId,
    arrivalScheduled: scheduled,
    delayMin: minutes(time, scheduled),
    realTime,
    upcoming: upcomingStops(trip, now),
    boardKey: board?.key,
    endsEarly,
    terminus: terminus?.name,
  };
}

/**
 * "Ich sitze gerade in …" aus der letzten Abfrage: die Fahrt, in der ich laut Verbindung gerade sitze.
 * @param {TransitousClient} client
 * @param {Connection} conn
 * @param {number} now
 * @returns {Promise<EnRouteStart>}
 */
export async function locateInConnection(client, conn, now) {
  const leg = currentTransitLeg(conn, now);
  if (!leg) throw new FinalTripError('Diese Verbindung ist schon beendet – bitte eine aktuellere wählen oder GPS nutzen.');

  // Was laut Verbindung schon hinter mir liegt (z. B. Graben-Neudorf, wenn ich in der S9 sitze)
  const passed = conn.legs
    .filter((l) => l.kind === 'transit' && l.end <= now)
    .flatMap((l) => [{ name: l.fromName, stopId: l.fromStopId }, { name: l.toName, stopId: l.toStopId }]);

  if (leg.start > now) {
    // Noch nicht eingestiegen → ab der Einstiegshaltestelle planen
    return {
      type: 'trip', place: { stopId: leg.fromStopId, name: leg.fromName }, time: leg.start, passed,
      label: `${leg.line} ab ${leg.fromName}`, tripId: leg.tripId, notBoarded: true,
      delayMin: leg.delayStartMin, realTime: leg.realTime,
    };
  }
  return locateInTrip(client, leg.tripId, now, { alsoPassed: passed, board: { key: null, id: leg.fromStopId, expected: leg.fromName, name: leg.fromName } });
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
    combos = combinationsEnRoute(combos, (key) => isViaBehind(me, target, stops[key]), `${journey.label}: beliebige Route ab hier`);
    startInfo = { place: `${start.lat},${start.lon}`, time: now, maxPreTransitTime: rules.maxPreTransitSecondsFromGps };
  } else if (start?.type === 'trip') {
    const isPassed = (key) =>
      key === start.boardKey ||
      placeMatchesStop(start.place, stops[key]) || start.passed.some((p) => placeMatchesStop(p, stops[key]));
    combos = combinationsEnRoute(combos, isPassed, `${journey.label}: beliebige Route ab hier`);
    startInfo = { place: start.place.stopId, time: start.time, trip: start };
  }

  const realtimeNear = Math.abs(now - realNow) < 90 * 60_000;
  const results = await Promise.all(combos.map((combo) => runCombination({ client, combo, stops, rules, now, startInfo, realtimeNear })));

  // Normale Suche: je Variante nur die beste Verbindung im Zeitfenster nach der gewünschten Abfahrt.
  // Unterwegs bleiben alle Alternativen erhalten.
  if (!start && rules.maxWaitMinutes != null) {
    for (const r of results) {
      if (r.status !== 'ok') continue;
      const picked = forDeparture(r.connections, now, { maxWaitMinutes: rules.maxWaitMinutes, perVariant: rules.perVariant });
      r.connections = picked.connections;
      if (!r.connections.length) Object.assign(r, { status: 'late', nextDeparture: picked.nextDeparture });
    }
  }

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
