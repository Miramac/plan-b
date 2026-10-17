// plan-b – reine Logik: Kombinationen bilden, Ergebnisse auswerten, sortieren, Umstiegsrisiko bewerten.
// Keine DOM-, Browser- oder Netzwerkzugriffe. Alle Zeiten sind Millisekunden (Date.now()-Format).
// → wandert später fast unverändert in einen NestJS-Service (z. B. RoutingLogicService).

/**
 * @typedef {import('./config.js').StopConfig} StopConfig
 * @typedef {import('./config.js').StageOption} StageOption
 * @typedef {import('./config.js').Journey} Journey
 * @typedef {import('./config.js').FixedPart} FixedPart
 */

/**
 * @typedef {Object} ResolvedStop
 * @property {string} key
 * @property {'ok'|'ambiguous'|'notFound'|'error'} status
 * @property {'config'|'geocode'|'choice'} [source]
 * @property {string|null} id
 * @property {string} name        Name laut API (bzw. Config)
 * @property {string} expected    Name laut Config
 * @property {string} place
 * @property {string} [area]      Ort laut API
 * @property {number} [lat]
 * @property {number} [lon]
 * @property {Array<{id:string,name:string,area:string,lat:number,lon:number}>} [candidates]
 * @property {string} [error]
 */

/**
 * Eine Kombination aus Etappe 1 + Etappe 2 = eine Variante in der Rangliste.
 * @typedef {Object} Combination
 * @property {string} id               z. B. "bike+A2"
 * @property {string} name             Anzeigename
 * @property {string[]} from
 * @property {string[]} to
 * @property {string[]} via
 * @property {FixedPart|null} fixedBefore
 * @property {FixedPart|null} fixedAfter
 * @property {string[]} busTransferAt
 * @property {Record<string, number|{minutes: number, towards?: string}>} minBufferAt  Ausnahmen vom Mindestpuffer je Halt
 * @property {{to:string, minutes:number, label:string}|null} fallback
 * @property {boolean} usesBike
 */

/**
 * Eine konkrete Abfrage an /plan.
 * @typedef {Object} PlanQuery
 * @property {string} fromPlace   Stop-ID oder "lat,lon"
 * @property {string} toPlace
 * @property {string[]} via       Stop-IDs
 * @property {number} time
 * @property {number} [maxPreTransitTime]
 */

/**
 * @typedef {Object} DisplayLeg
 * @property {'transit'|'walk'|'bike'|'estimate'} kind
 * @property {string} mode
 * @property {string} line
 * @property {string} [headsign]
 * @property {string} fromName
 * @property {string} toName
 * @property {number} start
 * @property {number} end
 * @property {number} scheduledStart
 * @property {number} scheduledEnd
 * @property {number} delayStartMin
 * @property {number} delayEndMin
 * @property {boolean} realTime
 * @property {boolean} cancelled
 * @property {string} [tripId]
 * @property {string} [fromStopId]
 * @property {string} [toStopId]
 * @property {string} [label]
 * @property {boolean} [interline]  gleiches Fahrzeug wie das vorige Leg (sitzen bleiben, kein Umstieg)
 * @property {boolean} [onDemand]   Rufbus/On-Demand (ggf. vorher anmelden)
 */

/**
 * @typedef {Object} TransferRisk
 * @property {string} atName
 * @property {number} transferMin Umstiegszeit: Abfahrt − Ankunft (inkl. Echtzeit)
 * @property {number} walkMin     davon Fußweg laut Router
 * @property {number} bufferMin   Puffer = Umstiegszeit − Fußweg (inkl. Echtzeit)
 * @property {'ok'|'tight'|'missed'} level
 * @property {boolean} critical   Anschluss fährt nur stündlich
 * @property {string} nextLine
 */

/**
 * @typedef {Object} Connection
 * @property {string} id
 * @property {string} comboId
 * @property {string} name
 * @property {number} departure         Losgehen/-fahren (inkl. fester Anteile)
 * @property {number} arrival           Voraussichtliche Ankunft (Echtzeit + feste Anteile + Schätzung)
 * @property {number} scheduledArrival
 * @property {number} transfers
 * @property {DisplayLeg[]} legs
 * @property {TransferRisk[]} risks
 * @property {'ok'|'tight'|'critical'|'missed'} riskLevel
 * @property {number} depDelayMin
 * @property {number} arrDelayMin
 * @property {'full'|'partial'|'none'} realtime
 * @property {boolean} estimated
 * @property {boolean} [onDemand]      enthält Rufbus/On-Demand-Fahrt
 * @property {boolean} usesBike
 * @property {number|null} bikeTime    Zeitpunkt der Radfahrt (für Wetter)
 * @property {boolean} [best]
 */

const MIN = 60_000;
// ODM/FLEX (Rufbus, On-Demand) sind echte Fahrten und zählen als ÖPNV – werden aber markiert (Anmeldung nötig)
const NON_TRANSIT = new Set(['WALK', 'BIKE', 'CAR', 'CAR_PARKING', 'CAR_DROPOFF', 'RENTAL', 'DEBUG_BUS_ROUTE', 'DEBUG_RAILWAY_ROUTE', 'DEBUG_FERRY_ROUTE']);
const ON_DEMAND = new Set(['ODM', 'FLEX']);
const STATION_WORDS = new Set(['bahnhof', 'bf', 'hbf', 'bahnhofsvorplatz']);

// ---------------------------------------------------------------------------
// Text-Normalisierung & Haltestellen-Abgleich
// ---------------------------------------------------------------------------

/** "Waldstr." → "waldstrasse", "Neulußheim" → "neulussheim" usw. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/(\p{L})str\b\.?/gu, '$1strasse')
    .replace(/\bstr\b\.?/g, 'strasse')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** @returns {string[]} */
export function tokens(text) {
  return normalize(text).split(' ').filter(Boolean);
}

/**
 * Wählt aus Geocoding-Treffern die passende Haltestelle aus – oder meldet Mehrdeutigkeit.
 * Regel: Alle Wörter von Name + Ort müssen im Treffer (Name + Ortsangaben) vorkommen.
 * Exakter Kernname gewinnt. Bleiben mehrere unterschiedliche Halte übrig → "ambiguous" (nicht raten!).
 *
 * @param {string} key
 * @param {StopConfig} cfg
 * @param {Array<any>} matches  Match-Objekte aus /api/v1/geocode
 * @returns {ResolvedStop}
 */
export function pickStopMatch(key, cfg, matches) {
  const placeTok = tokens(cfg.place);
  const wanted = tokens(cfg.name);
  const wantedCore = coreTokens(wanted, placeTok);

  const candidates = (matches ?? [])
    .filter((m) => !m.type || m.type === 'STOP')
    .filter(hasTransit)
    .map((m) => {
      const areaNames = (m.areas ?? []).map((a) => a.name);
      const all = new Set([...tokens(m.name), ...areaNames.flatMap(tokens)]);
      const core = coreTokens(tokens(m.name), placeTok);
      return {
        m,
        area: pickArea(m.areas),
        fits: wanted.every((t) => all.has(t)) && placeTok.every((t) => all.has(t)),
        exact: sameSet(core, wantedCore),
        rail: (m.modes ?? []).some((x) => /RAIL|SUBURBAN|METRO|HIGHSPEED|LONG_DISTANCE|NIGHT_RAIL/.test(x)),
      };
    })
    .filter((c) => c.fits);

  let pool = candidates.some((c) => c.exact) ? candidates.filter((c) => c.exact) : candidates;
  pool = dedupeNearby(pool);
  if (pool.length > 1 && cfg.rail && pool.some((c) => c.rail)) pool = pool.filter((c) => c.rail);

  const toCandidate = (c) => ({ id: c.m.id, name: c.m.name, area: c.area, lat: c.m.lat, lon: c.m.lon });
  const base = { key, expected: cfg.name, place: cfg.place };

  if (pool.length === 0) {
    return { ...base, status: 'notFound', id: null, name: cfg.name, candidates: (matches ?? []).slice(0, 5).map((m) => toCandidate({ m, area: pickArea(m.areas) })) };
  }
  if (pool.length > 1) {
    return { ...base, status: 'ambiguous', id: null, name: cfg.name, candidates: pool.map(toCandidate) };
  }
  const c = pool[0];
  return { ...base, status: 'ok', source: 'geocode', id: c.m.id, name: c.m.name, area: c.area, lat: c.m.lat, lon: c.m.lon };
}

/** Nur Halte mit Bus/Bahn – Transitous enthält auch Mitfahr- und Parkpunkte (z. B. Quelle "amarillo"). */
function hasTransit(m) {
  if (!m.modes) return true;
  return m.modes.some((x) => !['RIDE_SHARING', 'ODM', 'FLEX', 'CAR', 'BIKE', 'WALK', 'RENTAL'].includes(x));
}

function coreTokens(tok, placeTok) {
  const core = tok.filter((t) => !STATION_WORDS.has(t) && !placeTok.includes(t));
  return core.length ? core : tok.filter((t) => !STATION_WORDS.has(t));
}
function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}
function pickArea(areas) {
  const list = areas ?? [];
  return (list.find((a) => a.default) ?? list.find((a) => a.adminLevel === 8) ?? list[0])?.name ?? '';
}
/** Gleichnamige Halte im Umkreis von 400 m (z. B. Bahnsteige eines Bahnhofs) als einen zählen. */
function dedupeNearby(pool) {
  const out = [];
  for (const c of pool) {
    const dup = out.find((o) => distanceKm(o.m, c.m) < 0.4);
    if (!dup) out.push(c);
    else if (c.rail && !dup.rail) out[out.indexOf(dup)] = c;
  }
  return out;
}

/** Luftlinie in km (Haversine). */
export function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// Kombinationen bilden
// ---------------------------------------------------------------------------

/**
 * Bildet alle Kombinationen Etappe 1 × Etappe 2.
 * from/to: spätere Etappe überschreibt; via wird aneinandergehängt.
 * @param {Journey} journey
 * @returns {Combination[]}
 */
export function buildCombinations(journey) {
  const combos = [];
  for (const s1 of journey.stage1) {
    for (const s2 of journey.stage2) {
      const via = [...(s1.via ?? []), ...(s2.via ?? [])];
      combos.push({
        id: `${s1.key}+${s2.key}`,
        name: `${s1.name} · ${s2.name}`,
        stage1: s1.key,
        stage2: s2.key,
        stage1Name: s1.name,
        stage2Name: s2.name,
        from: s2.from ?? s1.from ?? [],
        to: s2.to ?? s1.to ?? [],
        via,
        fixedBefore: s1.fixedBefore ?? s2.fixedBefore ?? null,
        fixedAfter: s2.fixedAfter ?? s1.fixedAfter ?? null,
        busTransferAt: [...(s1.busTransferAt ?? []), ...(s2.busTransferAt ?? [])],
        minBufferAt: { ...(s1.minBufferAt ?? {}), ...(s2.minBufferAt ?? {}) },
        fallback: s2.fallback ?? s1.fallback ?? null,
        usesBike: [s1.fixedBefore, s2.fixedBefore, s1.fixedAfter, s2.fixedAfter].some((f) => f?.mode === 'bike'),
      });
    }
  }
  return combos;
}

/**
 * Unterwegs: Kombinationen ab dem aktuellen Standort.
 * - Feste Anteile VOR der Fahrt entfallen (ich bin ja schon unterwegs).
 * - Bereits passierte Via-Halte und der Startort selbst werden entfernt.
 * - Danach identische Kombinationen zusammenfassen (z. B. "Bus·A2" und "Rad·A2" ab Graben-Neudorf).
 *
 * @param {Combination[]} combos
 * @param {(stopKey: string) => boolean} isPassed  true, wenn der Halt schon hinter mir liegt
 * @param {string} [mergedName]  Name, wenn Varianten mit verschiedenen Etappen zusammenfallen
 * @returns {Combination[]}
 */
export function combinationsEnRoute(combos, isPassed, mergedName = 'Beliebige Route ab hier') {
  const groups = new Map();
  for (const c of combos) {
    // Via-Halte sind in Fahrtreihenfolge: Liegt einer hinter mir, gilt das auch für alle davor
    // (z. B. ab Bruchsal ist Graben-Neudorf erledigt, auch wenn ich dort nicht vorbeigekommen bin).
    const lastPassed = c.via.reduce((acc, v, i) => (isPassed(v) ? i : acc), -1);
    const via = c.via.slice(lastPassed + 1).filter((v) => !isPassed(v));
    const adapted = {
      ...c,
      from: [],
      via,
      busTransferAt: c.busTransferAt.filter((v) => via.includes(v) || (!c.via.includes(v) && !isPassed(v))),
      fixedBefore: null,
      usesBike: c.fixedAfter?.mode === 'bike',
    };
    const sig = JSON.stringify([adapted.via, adapted.to, adapted.fixedAfter, adapted.fallback, adapted.busTransferAt, adapted.minBufferAt]);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(adapted);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const sameS1 = group.every((g) => g.stage1 === first.stage1);
    const sameS2 = group.every((g) => g.stage2 === first.stage2);
    let name = first.name;
    if (!sameS1 && sameS2) name = first.stage2Name;
    else if (sameS1 && !sameS2) name = first.stage1Name;
    else if (!sameS1 && !sameS2) name = mergedName;
    return {
      ...first,
      id: group.map((g) => g.id).join('|'),
      name,
    };
  });
}

/**
 * Entscheidet für GPS-Starts, ob ein Via-Halt schon "hinter mir" liegt:
 * Bin ich dem Ziel näher als der Via-Halt, gilt er als passiert.
 * @param {{lat:number,lon:number}} me
 * @param {{lat:number,lon:number}|undefined} target
 * @param {{lat:number,lon:number}|undefined} viaStop
 */
export function isViaBehind(me, target, viaStop) {
  if (!target || !viaStop || viaStop.lat == null || target.lat == null) return false;
  return distanceKm(me, target) < distanceKm(viaStop, target);
}

/**
 * Erzeugt die konkreten /plan-Abfragen einer Kombination (jede Start- × jede Ziel-Haltestelle).
 * Feste Anteile: Suche startet "jetzt + feste Dauer" am jeweiligen Bahnhof.
 *
 * @param {Combination} combo
 * @param {Record<string, ResolvedStop>} stops
 * @param {number} now
 * @param {{place: string, time?: number, maxPreTransitTime?: number}} [start]  Unterwegs-Startpunkt
 * @returns {{queries: PlanQuery[], missing: string[]}}
 */
export function buildQueries(combo, stops, now, start) {
  const missing = [];
  const idOf = (key) => {
    const s = stops[key];
    if (!s || !s.id) missing.push(key);
    return s?.id;
  };
  const via = combo.via.map(idOf);
  const to = combo.to.map(idOf);
  const from = start ? [start.place] : combo.from.map(idOf);
  if (via.length > 2) missing.push('(mehr als 2 Via-Halte – MOTIS erlaubt max. 2)');
  if (missing.length) return { queries: [], missing: [...new Set(missing)] };

  const time = (start?.time ?? now) + (combo.fixedBefore ? combo.fixedBefore.minutes * MIN : 0);
  const queries = [];
  for (const f of from) {
    for (const t of to) {
      queries.push({ fromPlace: f, toPlace: t, via, time, maxPreTransitTime: start?.maxPreTransitTime });
    }
  }
  return { queries, missing: [] };
}

// ---------------------------------------------------------------------------
// Ergebnisse auswerten
// ---------------------------------------------------------------------------

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
export const isTransitMode = (mode) => !NON_TRANSIT.has(mode);

/**
 * Führt die Itineraries mehrerer Abfragen (z. B. zu beiden Arbeits-Haltestellen) zusammen:
 * gleiche Erstfahrt → nur die mit früherer Ankunft behalten (ist die nicht machbar: zusätzlich die beste
 * machbare); dann die nächsten N nach Abfahrt.
 * @param {any[]} itineraries  MOTIS-Itineraries
 * @param {number} limit
 * @param {number} notBefore    frühestmögliche Abfahrt
 */
export function mergeItineraries(itineraries, limit, notBefore = 0) {
  // Gruppieren nach erster Fahrt (z. B. derselbe Zug, danach Bus zur Industriestraße bzw. zum HDM,
  // oder dieselbe Verbindung aus mehreren Abfragen). Je Gruppe die früheste Ankunft behalten.
  // Ist die laut Echtzeit nicht mehr zu schaffen, zusätzlich die beste machbare Alternative.
  const groups = new Map();
  for (const it of itineraries) {
    const transit = (it.legs ?? []).filter((l) => isTransitMode(l.mode));
    if (!transit.length) continue; // reine Fußwege ignorieren
    if (ms(transit[0].startTime) < notBefore - MIN) continue;
    const key = transit[0].tripId ?? `${transit[0].routeShortName}@${transit[0].scheduledStartTime}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const out = [];
  for (const group of groups.values()) {
    group.sort((a, b) => ms(a.endTime) - ms(b.endTime) || ms(b.startTime) - ms(a.startTime));
    out.push(group[0]);
    if (isBroken(group[0])) {
      const alt = group.find((it) => !isBroken(it));
      if (alt) out.push(alt);
    }
  }
  return out
    .sort((a, b) => firstTransitStart(a) - firstTransitStart(b) || ms(a.endTime) - ms(b.endTime))
    .slice(0, limit);
}

/** Laut Echtzeit nicht machbar: Anschluss verpasst oder eine Fahrt/ein Halt fällt aus. */
function isBroken(it) {
  return hasMissedTransfer(it) || (it.legs ?? []).some((l) => isTransitMode(l.mode) && (l.cancelled || l.from?.cancelled || l.to?.cancelled));
}

/** Ist ein Umstieg laut Echtzeit nicht mehr zu schaffen (Anschluss fährt vor Ankunft + Fußweg)? */
function hasMissedTransfer(it) {
  return transfersOf((it.legs ?? []).map(toDisplayLeg)).some(({ prev, next, walkMs }) => next.start - prev.end - walkMs < 0);
}

/** Schlüssel einer Verbindung zum Zählen/Entdoppeln (Fahrtenfolge). */
export function itineraryKey(it) {
  return (it.legs ?? []).filter((l) => isTransitMode(l.mode)).map((l) => l.tripId ?? l.routeShortName).join('>');
}

function firstTransitStart(it) {
  const l = it.legs.find((x) => isTransitMode(x.mode));
  return ms(l?.startTime ?? it.startTime);
}

/** MOTIS-Leg → Anzeige-Leg */
export function toDisplayLeg(l) {
  const transit = isTransitMode(l.mode);
  const start = ms(l.startTime);
  const end = ms(l.endTime);
  const scheduledStart = ms(l.scheduledStartTime ?? l.startTime);
  const scheduledEnd = ms(l.scheduledEndTime ?? l.endTime);
  return {
    kind: transit ? 'transit' : l.mode === 'BIKE' ? 'bike' : 'walk',
    mode: l.mode,
    line: transit ? (l.displayName || l.routeShortName || l.tripShortName || l.mode) : '',
    headsign: l.headsign,
    fromName: l.from?.name ?? '',
    toName: l.to?.name ?? '',
    fromStopId: l.from?.stopId,
    toStopId: l.to?.stopId,
    start, end, scheduledStart, scheduledEnd,
    delayStartMin: Math.round((start - scheduledStart) / MIN),
    delayEndMin: Math.round((end - scheduledEnd) / MIN),
    realTime: !!l.realTime,
    cancelled: !!(l.cancelled || l.from?.cancelled || l.to?.cancelled),
    tripId: l.tripId,
    interline: !!l.interlineWithPreviousLeg,
    onDemand: ON_DEMAND.has(l.mode),
  };
}

/**
 * Prüft, ob ein Ort einer Config-Haltestelle entspricht (über ID oder Name).
 * @param {{name?:string, stopId?:string}} place
 * @param {ResolvedStop|undefined} stop
 */
export function placeMatchesStop(place, stop) {
  if (!stop || !place) return false;
  // Deutsche Haltestellen-IDs (DHID) enthalten die Stationsnummer, z. B. "de-DELFI_de:08215:32585:4:4"
  // → "de:08215:32585". Haben beide eine, entscheidet nur sie (sonst wäre "Graben-Neudorf Nord"
  // dasselbe wie "Graben-Neudorf"). Bahnsteige und Bushalte am Bahnhof teilen die Stationsnummer.
  const a = stationCode(place.stopId);
  const b = stationCode(stop.id);
  if (a && b) return a === b;
  if (stop.id && place.stopId) {
    if (place.stopId === stop.id || place.parentId === stop.id || place.stopId.startsWith(`${stop.id}:`)) return true;
  }
  const want = tokens(stop.expected ?? stop.name).filter((t) => !STATION_WORDS.has(t));
  const have = new Set(tokens(place.name));
  return want.length > 0 && want.every((t) => have.has(t));
}

/** Stationsnummer aus einer Stop-ID ("de-KVV_Pde:08215:7702" → "de:08215:7702"), sonst null. */
export function stationCode(id) {
  const m = /([a-z]{2}:\d{5}:\d+)/.exec(id ?? '');
  return m ? m[1] : null;
}

/**
 * Bewertet die Umstiege: Puffer = Abfahrt nächster Zug/Bus − Ankunft vorheriger − Fußweg dazwischen.
 * Echtzeit-Zeiten fließen automatisch ein (startTime/endTime sind bei Echtzeit schon korrigiert).
 *
 * @param {DisplayLeg[]} legs
 * @param {ResolvedStop[]} criticalStops
 * @param {number} tightMinutes
 * @returns {TransferRisk[]}
 */
export function analyzeTransfers(legs, criticalStops, tightMinutes) {
  return transfersOf(legs).map(({ prev, next, walkMs }) => {
    const transferMin = Math.floor((next.start - prev.end) / MIN);
    const walkMin = Math.ceil(walkMs / MIN);
    const bufferMin = Math.floor((next.start - prev.end - walkMs) / MIN);
    const critical = criticalStops.some((s) => transferIsAt(prev, next, s));
    return {
      atName: prev.toName,
      transferMin,
      walkMin,
      bufferMin,
      level: bufferMin < 0 ? 'missed' : bufferMin < tightMinutes ? 'tight' : 'ok',
      critical,
      nextLine: next.line,
    };
  });
}

/**
 * Alle Umstiege einer Verbindung: je zwei aufeinanderfolgende ÖPNV-Legs plus Fußweg dazwischen.
 * @param {DisplayLeg[]} legs
 * @returns {Array<{prev: DisplayLeg, next: DisplayLeg, walkMs: number, walkScheduledMs: number}>}
 */
function transfersOf(legs) {
  const out = [];
  let prev = null;
  let walkMs = 0;
  let walkScheduledMs = 0;
  for (const leg of legs) {
    if (leg.kind !== 'transit') {
      if (prev) {
        walkMs += leg.end - leg.start;
        walkScheduledMs += leg.scheduledEnd - leg.scheduledStart;
      }
      continue;
    }
    if (prev && !leg.interline) out.push({ prev, next: leg, walkMs, walkScheduledMs });
    prev = leg;
    walkMs = 0;
    walkScheduledMs = 0;
  }
  return out;
}

/** Findet der Umstieg prev → next an dieser Haltestelle statt? */
function transferIsAt(prev, next, stop) {
  return placeMatchesStop({ name: prev.toName, stopId: prev.toStopId }, stop) ||
    placeMatchesStop({ name: next.fromName, stopId: next.fromStopId }, stop);
}

/**
 * Die Abfrage reserviert per additionalTransferTime Puffer an jedem Umstieg (so findet der Router
 * Alternativen statt zu knapper Anschlüsse). MOTIS rechnet diese Reserve in die Fußweg-Legs ein –
 * hier wird sie wieder abgezogen, damit Fußweg und Puffer in der Anzeige stimmen.
 * @param {any} it          MOTIS-Itinerary
 * @param {number} reserveMin  verwendete additionalTransferTime in Minuten
 * @returns {any} neues Itinerary (Original bleibt unverändert)
 */
export function withoutTransferReserve(it, reserveMin) {
  if (!reserveMin) return it;
  const legs = it.legs ?? [];
  const transitIdx = legs.map((l, i) => (isTransitMode(l.mode) ? i : -1)).filter((i) => i >= 0);
  const [first, last] = [transitIdx[0], transitIdx[transitIdx.length - 1]];
  const shift = (iso, sec) => (iso ? new Date(Date.parse(iso) - sec * 1000).toISOString() : iso);
  return {
    ...it,
    legs: legs.map((l, i) => {
      if (isTransitMode(l.mode) || !(i > first && i < last)) return l; // nur Umstiegs-Fußwege
      const cut = Math.min(reserveMin * 60, Math.max(0, (l.duration ?? 0)));
      return { ...l, duration: (l.duration ?? 0) - cut, endTime: shift(l.endTime, cut), scheduledEndTime: shift(l.scheduledEndTime, cut) };
    }),
  };
}

/**
 * Regel "zu knappe Umstiege nie nutzen": Jeder Umstieg braucht laut FAHRPLAN mindestens
 * rules.minBufferMinutes Puffer (Umstiegszeit − Fußweg). Ausnahmen je Halt über combo.minBufferAt
 * (z. B. Bruchsal → Graben-Neudorf: 2 Min.). Echtzeit-Verspätungen führen nicht zum Verwerfen,
 * sondern nur zur Markierung "knapp" (siehe analyzeTransfers).
 *
 * @param {any} it  MOTIS-Itinerary
 * @param {Combination} combo
 * @param {Record<string, ResolvedStop>} stops
 * @param {{minBufferMinutes: number}} rules
 * @returns {boolean}
 */
export function meetsMinBuffer(it, combo, stops, rules) {
  const legs = (it.legs ?? []).map(toDisplayLeg);
  return transfersOf(legs).every(({ prev, next, walkScheduledMs }) => {
    const planned = Math.floor((next.scheduledStart - prev.scheduledEnd - walkScheduledMs) / MIN);
    return planned >= requiredBuffer(prev, next, combo, stops, rules);
  });
}

/**
 * Mindestpuffer für einen Umstieg prev → next: Standard aus RULES oder Ausnahme aus combo.minBufferAt.
 * Eine Ausnahme mit "towards" gilt nur, wenn die Weiterfahrt dorthin führt (Bruchsal → Graben-Neudorf).
 */
export function requiredBuffer(prev, next, combo, stops, rules) {
  for (const [key, rule] of Object.entries(combo.minBufferAt ?? {})) {
    const { minutes, towards } = typeof rule === 'number' ? { minutes: rule } : rule;
    if (!stops[key] || !transferIsAt(prev, next, stops[key])) continue;
    if (towards && !placeMatchesStop({ name: next.toName, stopId: next.toStopId }, stops[towards])) continue;
    return minutes;
  }
  return rules.minBufferMinutes;
}

/** Kleinste Puffer-Ausnahme der Kombination (für die Router-Reserve). */
export function exceptionMinutes(combo) {
  return Object.values(combo.minBufferAt ?? {}).map((r) => (typeof r === 'number' ? r : r.minutes));
}

/**
 * Unterwegs ab dem nächsten Halt meiner Fahrt: Der Umstieg DORT sieht der Router nicht als Umstieg
 * (die Suche beginnt ja an diesem Halt). Deshalb hier prüfen: sitzen bleiben ist immer ok,
 * sonst braucht auch dieser Umstieg den Mindestpuffer laut Fahrplan.
 * @param {any} it
 * @param {{place: {stopId: string, name: string}, tripId?: string, arrivalScheduled?: number}} start
 */
export function meetsStartBuffer(it, start, combo, stops, rules) {
  if (!start?.arrivalScheduled) return true;
  const legs = (it.legs ?? []).map(toDisplayLeg);
  const idx = legs.findIndex((l) => l.kind === 'transit');
  if (idx < 0) return true;
  const first = legs[idx];
  if (start.tripId && first.tripId === start.tripId) return true; // sitzen bleiben
  const walk = legs.slice(0, idx).reduce((sum, l) => sum + (l.scheduledEnd - l.scheduledStart), 0);
  const planned = Math.floor((first.scheduledStart - start.arrivalScheduled - walk) / MIN);
  const arrivingLeg = { toName: start.place.name, toStopId: start.place.stopId };
  return planned >= requiredBuffer(arrivingLeg, first, combo, stops, rules);
}

/** Gesamtrisiko einer Verbindung */
export function overallRisk(risks) {
  if (risks.some((r) => r.level === 'missed')) return 'missed';
  if (risks.some((r) => r.level === 'tight' && r.critical)) return 'critical';
  if (risks.some((r) => r.level === 'tight')) return 'tight';
  return 'ok';
}

const isBus = (mode) => mode === 'BUS' || mode === 'COACH' || ON_DEMAND.has(mode);

/**
 * Passt das Itinerary zur Variante? An jedem busTransferAt-Halt muss zwischen Bus und Bahn umgestiegen
 * werden. Nötig, weil der Router sonst z. B. "über Neulußheim" mit einer S-Bahn erfüllt, die dort nur hält.
 * @param {any} it  MOTIS-Itinerary
 * @param {Combination} combo
 * @param {Record<string, ResolvedStop>} stops
 */
export function fitsVariant(it, combo, stops) {
  const t = (it.legs ?? []).filter((l) => isTransitMode(l.mode));
  return combo.busTransferAt.every((key) => {
    const stop = stops[key];
    if (!stop) return false;
    for (let i = 1; i < t.length; i++) {
      const [a, b] = [t[i - 1], t[i]];
      const mixed = isBus(a.mode) !== isBus(b.mode);
      if (mixed && (placeMatchesStop(a.to, stop) || placeMatchesStop(b.from, stop))) return true;
    }
    return false;
  });
}

/**
 * Wandelt ein MOTIS-Itinerary in eine bewertete Verbindung um (inkl. fester Anteile und Schätzung).
 *
 * @param {any} it
 * @param {Combination} combo
 * @param {Record<string, ResolvedStop>} stops
 * @param {{tightTransferMinutes:number}} rules
 * @param {{minutes:number,label:string}|null} [estimate]  Fallback-Schätzung (Weg B)
 * @returns {Connection}
 */
export function analyzeItinerary(it, combo, stops, rules, estimate = null) {
  const legs = (it.legs ?? []).map(toDisplayLeg);
  // Fuß-/Radwege des Routers am Anfang/Ende bleiben drin (z. B. GPS-Start zur Haltestelle).
  const transit = legs.filter((l) => l.kind === 'transit');
  const firstT = transit[0];
  const lastT = transit[transit.length - 1];
  const itStart = ms(it.startTime);
  let itEnd = ms(it.endTime);
  let scheduledEnd = legs.length ? legs[legs.length - 1].scheduledEnd : itEnd;

  const out = [...legs];
  let departure = itStart;
  let bikeTime = null;

  if (combo.fixedBefore) {
    const f = combo.fixedBefore;
    departure = itStart - f.minutes * MIN;
    out.unshift(fixedLeg(f, departure, itStart));
    if (f.mode === 'bike') bikeTime = departure;
  }
  if (estimate) {
    out.push({ ...fixedLeg({ mode: 'estimate', label: estimate.label }, itEnd, itEnd + estimate.minutes * MIN), kind: 'estimate' });
    itEnd += estimate.minutes * MIN;
    scheduledEnd += estimate.minutes * MIN;
  }
  let arrival = itEnd;
  if (combo.fixedAfter) {
    const f = combo.fixedAfter;
    out.push(fixedLeg(f, itEnd, itEnd + f.minutes * MIN));
    if (f.mode === 'bike') bikeTime = itEnd;
    arrival = itEnd + f.minutes * MIN;
    scheduledEnd += f.minutes * MIN;
  }

  const criticalStops = combo.busTransferAt.map((k) => stops[k]).filter(Boolean);
  const risks = analyzeTransfers(legs, criticalStops, rules.tightTransferMinutes);
  const rtCount = transit.filter((l) => l.realTime).length;

  return {
    id: `${combo.id}#${firstT?.tripId ?? ''}@${firstT?.scheduledStart ?? itStart}`,
    comboId: combo.id,
    name: combo.name,
    departure,
    arrival,
    scheduledArrival: scheduledEnd,
    transfers: Math.max(0, transit.length - 1),
    legs: out,
    risks,
    riskLevel: overallRisk(risks),
    depDelayMin: firstT?.delayStartMin ?? 0,
    arrDelayMin: lastT?.delayEndMin ?? 0,
    realtime: rtCount === 0 ? 'none' : rtCount === transit.length ? 'full' : 'partial',
    cancelled: transit.some((l) => l.cancelled),
    onDemand: transit.some((l) => l.onDemand),
    estimated: !!estimate,
    usesBike: combo.usesBike,
    bikeTime,
  };
}

function fixedLeg(f, start, end) {
  return {
    kind: f.mode === 'bike' ? 'bike' : f.mode === 'walk' ? 'walk' : 'estimate',
    mode: f.mode.toUpperCase(),
    line: '',
    label: f.label,
    fromName: '', toName: '',
    start, end, scheduledStart: start, scheduledEnd: end,
    delayStartMin: 0, delayEndMin: 0,
    realTime: false, cancelled: false,
  };
}

/**
 * Gemeinsame Rangliste (ohne Duplikate): nach voraussichtlicher Ankunft, bei Gleichstand spätere Abfahrt
 * (weniger Wartezeit), dann weniger Umstiege. Ausgefallene/verpasste Anschlüsse ans Ende.
 * Markiert die beste Verbindung mit best = true.
 * @param {Connection[]} list
 * @returns {Connection[]}
 */
export function rankConnections(list) {
  const broken = (c) => c.cancelled || c.riskLevel === 'missed';
  // Identische Fahrten aus verschiedenen Varianten nur einmal zeigen (z. B. unterwegs, wenn Via-Halte wegfallen)
  const seen = new Set();
  const unique = list.filter((c) => {
    const key = `${(c.legs ?? []).filter((l) => l.kind === 'transit').map((l) => l.tripId ?? l.line).join('>')}|${c.arrival}`;
    if (c.legs?.length && seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const sorted = unique.sort(
    (a, b) => Number(broken(a)) - Number(broken(b)) ||
      a.arrival - b.arrival ||
      b.departure - a.departure ||
      a.transfers - b.transfers,
  );
  return sorted.map((c, i) => ({ ...c, best: i === 0 && !broken(c) }));
}

/**
 * Normale Suche: Die Abfahrtszeit steht fest. Je Variante nur die beste(n) Verbindung(en), die höchstens
 * maxWaitMinutes nach der gewünschten Abfahrt starten (früheste Ankunft, bei Gleichstand spätere Abfahrt,
 * nicht machbare zuletzt). Wer um 7:30 los will, braucht keine Verbindung ab 10 Uhr.
 * @param {Connection[]} connections  Verbindungen EINER Variante
 * @param {number} departAt           gewünschte Abfahrt
 * @param {{maxWaitMinutes: number, perVariant?: number}} opts
 * @returns {{connections: Connection[], nextDeparture: number|null}}  nextDeparture: früheste Abfahrt, falls alle zu spät
 */
export function forDeparture(connections, departAt, { maxWaitMinutes, perVariant = 1 }) {
  const broken = (c) => c.cancelled || c.riskLevel === 'missed';
  const inWindow = connections.filter((c) => c.departure <= departAt + maxWaitMinutes * MIN);
  const ranked = [...inWindow].sort(
    (a, b) => Number(broken(a)) - Number(broken(b)) || a.arrival - b.arrival || b.departure - a.departure || a.transfers - b.transfers,
  );
  return {
    connections: ranked.slice(0, perVariant),
    nextDeparture: inWindow.length || !connections.length ? null : Math.min(...connections.map((c) => c.departure)),
  };
}

// ---------------------------------------------------------------------------
// Wetter
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WeatherPoint
 * @property {number} time
 * @property {number} temperature  °C
 * @property {number} precipitation mm/h
 * @property {number} wind         km/h
 *
 * @typedef {Object} WeatherData
 * @property {WeatherPoint} current
 * @property {WeatherPoint[]} hourly
 */

/**
 * Wetter zum Zeitpunkt der Radfahrt (passende Stunde der Vorhersage) + Bewertung.
 * @param {WeatherData|null} data
 * @param {number} time
 * @param {{maxPrecipitationMm:number,minTemperatureC:number,maxWindKmh:number}} t
 */
export function weatherAt(data, time, t) {
  if (!data) return null;
  // Open-Meteo-Stundenwerte gelten für die Stunde VOR dem Zeitstempel → aufrunden.
  const hour = Math.ceil(time / 3_600_000) * 3_600_000;
  // Ohne passende Vorhersage-Stunde nur dann die aktuellen Werte nehmen, wenn die Fahrt bald ist
  const p = data.hourly.find((h) => h.time === hour) ??
    (Math.abs(time - data.current.time) < 90 * MIN ? data.current : null);
  if (!p) return null;
  const reasons = [];
  if (!(p.precipitation < t.maxPrecipitationMm)) reasons.push('Regen');
  if (!(p.temperature > t.minTemperatureC)) reasons.push('kalt');
  if (!(p.wind < t.maxWindKmh)) reasons.push('Wind');
  return { ...p, good: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Unterwegs: Position in einer Fahrt, Empfehlungswechsel
// ---------------------------------------------------------------------------

/**
 * Findet in der aktuellen Fahrt (Antwort von /trip) den nächsten Halt nach "now".
 * @param {any} tripItinerary  Itinerary aus /api/v6/trip
 * @param {number} now
 * @returns {{next: any|null, passed: any[], terminus: any|null, endsEarly: boolean}}
 *   next = nächster bedienter Halt (MOTIS-Place), terminus = letzter bedienter Halt, endsEarly = Zug endet vorzeitig
 */
export function nextStopOfTrip(tripItinerary, now) {
  const seq = tripSequence(tripItinerary);
  if (!seq.length) return { next: null, passed: [], terminus: null, endsEarly: false };
  // Ein Halt ist erst passiert, wenn der Zug dort ABGEFAHREN ist (steht er noch, ist er "nächster Halt").
  // Entfallende Halte (cancelled) werden übersprungen – dort kann man weder aus- noch einsteigen.
  const gone = (p) => ms(p.departure ?? p.arrival) <= now;
  const served = seq.filter((p) => !p.cancelled);
  const terminus = served[served.length - 1] ?? null; // letzter bedienter Halt (bei "endet vorzeitig" nicht das Fahrplan-Ziel)
  const endsEarly = !!terminus && seq.indexOf(terminus) < seq.length - 1;
  const idx = seq.findIndex((p) => !p.cancelled && !gone(p));
  if (idx === -1) return { next: null, passed: served, terminus, endsEarly };
  return { next: seq[idx], passed: seq.slice(0, idx).filter((p) => !p.cancelled), terminus, endsEarly };
}

/** Alle Halte einer Fahrt (Antwort von /trip) in Reihenfolge. */
export function tripSequence(tripItinerary) {
  const leg = tripItinerary?.legs?.find((l) => isTransitMode(l.mode)) ?? tripItinerary?.legs?.[0];
  if (!leg) return [];
  return [leg.from, ...(leg.intermediateStops ?? []), leg.to].filter(Boolean);
}

/**
 * Die Fahrt, in der ich laut gewählter Verbindung gerade sitze (oder als nächstes einsteige).
 * @param {Connection} conn
 * @param {number} now
 */
export function currentTransitLeg(conn, now) {
  const t = conn.legs.filter((l) => l.kind === 'transit' && l.tripId);
  return t.find((l) => l.start <= now && now < l.end) ?? t.find((l) => l.start > now) ?? null;
}

/**
 * Nächster Handlungsschritt einer Verbindung ab "now" (für "Neue Empfehlung: …").
 * @param {Connection} conn
 * @param {number} now
 * @param {string} [ridingTripId]  Fahrt, in der ich gerade sitze
 * @returns {{type:'board'|'change'|'arrive', stop:string, line?:string, headsign?:string, time:number}}
 */
export function nextStep(conn, now, ridingTripId) {
  const transit = conn.legs.filter((l) => l.kind === 'transit');
  // Unterwegs: sitze ich schon in der ersten Fahrt, gilt sie als "gerade gefahren" – auch wenn sie laut Plan erst gleich weiterfährt
  const riding = ridingTripId && transit[0]?.tripId === ridingTripId
    ? lastInterlined(transit, 0)
    : transit.findIndex((l) => l.start <= now && now < l.end);
  if (riding >= 0) {
    const next = transit[riding + 1];
    return next
      ? { type: 'change', stop: transit[riding].toName, line: next.line, headsign: next.headsign, time: next.start }
      : { type: 'arrive', stop: transit[riding].toName, time: transit[riding].end };
  }
  const upcoming = transit.find((l) => l.start > now) ?? transit[0];
  return { type: 'board', stop: upcoming?.fromName ?? '', line: upcoming?.line, headsign: upcoming?.headsign, time: upcoming?.start ?? conn.departure };
}

/**
 * "Fingerabdruck" einer Empfehlung: die Folge der Fahrten (tripIds) mit Ankunftszeit.
 * Unabhängig von Varianten-IDs, damit der Wechsel normal → unterwegs nicht als neue Empfehlung zählt.
 * @param {Connection} conn
 * @returns {Array<{tripId: string, end: number}>}
 */
export function recommendationKey(conn) {
  return conn.legs.filter((l) => l.kind === 'transit').map((l) => ({ tripId: l.tripId ?? l.line, end: l.end }));
}

/**
 * Hat sich die beste Verbindung gegenüber der letzten Prüfung geändert?
 * Verglichen werden nur Fahrten, die noch nicht beendet sind.
 * @param {Array<{tripId: string, end: number}>|null} previous  recommendationKey der letzten besten Verbindung
 * @param {Connection|undefined} best
 * @param {number} now
 */
export function recommendationChanged(previous, best, now) {
  if (!previous || !best) return false;
  const remaining = (list) => list.filter((t) => t.end > now).map((t) => t.tripId).join('|');
  return remaining(previous) !== remaining(recommendationKey(best));
}

// ---------------------------------------------------------------------------
// Gewohnte Abfahrtszeiten (z. B. 7:30 zur Arbeit) – Zeitzone explizit, damit es auch auf einem Server stimmt
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Datum/Uhrzeit eines Zeitpunkts in einer Zeitzone (über Intl, ohne Bibliothek). */
export function zonedParts(time, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(time)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, weekday: WEEKDAYS.indexOf(p.weekday) };
}

/**
 * Ortszeit (Jahr, Monat, Tag, Stunde, Minute in timeZone) → Zeitpunkt in ms.
 * Zeitumstellung wie Temporal "compatible": doppelte Stunde (Herbst) → frühere; fehlende Stunde
 * (Frühjahr, z. B. 02:30) → um die Lücke nach vorn (03:30).
 */
export function zonedTime(y, m, d, h, min, timeZone) {
  const wanted = Date.UTC(y, m - 1, d, h, min);
  const offsetAt = (t) => { const p = zonedParts(t, timeZone); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - t; };
  const day = 86_400_000;
  const offsets = [...new Set([offsetAt(wanted - day), offsetAt(wanted), offsetAt(wanted + day)])];
  const valid = offsets.map((o) => wanted - o).filter((t) => t + offsetAt(t) === wanted);
  if (valid.length) return Math.min(...valid);
  return wanted - offsetAt(wanted - day); // Lücke: Offset VOR der Umstellung → landet dahinter
}

/**
 * Nächster Zeitpunkt mit Uhrzeit "HH:MM" nach now, optional nur an bestimmten Wochentagen.
 * Beispiel: Freitag 23:00, "07:30", Werktage → Montag 07:30.
 * @param {number} now
 * @param {string} hhmm
 * Ist die Zeit heute erst vor weniger als graceMinutes vorbei (z. B. 7:35 bei "07:30"), wird "now"
 * zurückgegeben – sonst bekäme man um 7:31 schon die Verbindungen von morgen.
 * @param {{timeZone: string, weekdays?: number[], graceMinutes?: number}} opts  weekdays: 0 = Sonntag … 6 = Samstag
 */
export function nextOccurrence(now, hhmm, { timeZone, weekdays, graceMinutes = 0 }) {
  const [h, min] = hhmm.split(':').map(Number);
  const today = zonedParts(now, timeZone);
  for (let add = 0; add < 8; add++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + add)); // reine Kalender-Rechnung
    if (weekdays && !weekdays.includes(day.getUTCDay())) continue;
    const t = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, min, timeZone);
    if (t > now) return t;
    if (add === 0 && now - t < graceMinutes * MIN) return now;
  }
  throw new Error(`Keine nächste Abfahrt für ${hhmm} gefunden`);
}

// ---------------------------------------------------------------------------
// Unterwegs: "In welchem Zug sitze ich?" und "Wo steige ich am besten aus?"
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Departure
 * @property {string} tripId
 * @property {string} stopId         Bahnsteig/Halt der Abfahrt
 * @property {string} line
 * @property {string} headsign
 * @property {string} mode
 * @property {number} time           Abfahrt laut Echtzeit (sonst Fahrplan)
 * @property {number} scheduledTime
 * @property {number} delayMin
 * @property {boolean} realTime
 * @property {boolean} cancelled
 */

/**
 * Abfahrten einer Haltestelle (Antwort von /stoptimes) für die Zugauswahl aufbereiten:
 * nur die letzten pastMinutes bis nächsten futureMinutes, ohne Doppelte, nach Abfahrt sortiert.
 * @param {any[]} stopTimes
 * @param {number} now
 * @param {{pastMinutes?: number, futureMinutes?: number}} [opts]
 * @returns {Departure[]}
 */
export function recentDepartures(stopTimes, now, { pastMinutes = 60, futureMinutes = 20 } = {}) {
  const seen = new Set();
  return (stopTimes ?? [])
    .filter((s) => s.place?.departure || s.place?.scheduledDeparture) // Endhalte haben keine Abfahrt
    .map((s) => {
      const scheduledTime = ms(s.place.scheduledDeparture ?? s.place.departure);
      const time = ms(s.place.departure ?? s.place.scheduledDeparture);
      return {
        tripId: s.tripId,
        stopId: s.place.stopId, // genauer Bahnsteig – für die Verortung in der Fahrt
        line: s.displayName || s.routeShortName || s.tripShortName || s.mode,
        headsign: s.headsign,
        mode: s.mode,
        time,
        scheduledTime,
        delayMin: Math.round((time - scheduledTime) / MIN),
        realTime: !!s.realTime,
        cancelled: !!(s.cancelled || s.tripCancelled),
      };
    })
    .filter((d) => d.time >= now - pastMinutes * MIN && d.time <= now + futureMinutes * MIN)
    .filter((d) => !seen.has(d.tripId) && seen.add(d.tripId))
    .sort((a, b) => a.time - b.time);
}

/**
 * Nächstgelegene Config-Haltestelle zu einer Position (für "Bahnhof per GPS").
 * @param {Record<string, {lat?: number, lon?: number}>} stops
 * @param {{lat: number, lon: number}} me
 * @returns {string|null} Key aus STOPS
 */
export function nearestStopKey(stops, me) {
  let best = null;
  for (const [key, s] of Object.entries(stops)) {
    if (s.lat == null || s.lon == null) continue;
    const d = distanceKm(me, s);
    if (!best || d < best.d) best = { key, d };
  }
  return best?.key ?? null;
}

/**
 * Kommende Halte einer Fahrt (Antwort von /trip) ab "now", mit Echtzeit und Verspätung.
 * @param {any} tripItinerary
 * @param {number} now
 * @returns {Array<{name: string, stopId: string, time: number, scheduledTime: number, delayMin: number, cancelled: boolean}>}
 */
export function upcomingStops(tripItinerary, now) {
  return tripSequence(tripItinerary)
    .filter((p) => ms(p.departure ?? p.arrival) > now) // noch nicht abgefahren
    .map((p) => {
      const time = ms(p.arrival ?? p.departure);
      const scheduledTime = ms(p.scheduledArrival ?? p.scheduledDeparture ?? p.arrival ?? p.departure);
      return { name: p.name, stopId: p.stopId, time, scheduledTime, delayMin: Math.round((time - scheduledTime) / MIN), cancelled: !!p.cancelled };
    });
}

/**
 * @typedef {Object} ExitOption
 * @property {Connection} connection
 * @property {DisplayLeg[]} onward   ÖPNV-Fahrten nach dem Ausstieg
 * @property {{bufferMin: number, level: 'ok'|'tight'|'missed', critical: boolean}|null} transfer  Umstieg am Ausstieg
 *
 * @typedef {Object} ExitGroup
 * @property {string} exitName       Hier aussteigen
 * @property {number} exitTime       Ankunft dort (Echtzeit)
 * @property {number} exitDelayMin
 * @property {boolean} seated        bis zum Ziel sitzen bleiben (kein Umstieg mehr)
 * @property {ExitOption[]} options  Weiterfahrten ab hier, beste zuerst
 * @property {boolean} best          enthält die insgesamt beste Verbindung
 */

/**
 * Unterwegs-Ansicht "Wo aussteigen?": Verbindungen nach dem Halt gruppieren, an dem ich meine
 * aktuelle Fahrt verlasse. Reihenfolge entlang der Fahrt (frühester Ausstieg zuerst).
 * @param {Connection[]} connections  bereits sortiert (rankConnections)
 * @param {{tripId?: string, place: {name: string}, time: number, delayMin?: number}} start
 * @param {number} tightMinutes
 * @returns {ExitGroup[]}
 */
export function groupByExit(connections, start, tightMinutes) {
  const groups = new Map();
  for (const c of connections) {
    const transit = c.legs.filter((l) => l.kind === 'transit');
    if (!transit.length) continue;
    const first = transit[0];
    const seatedFirst = !!start.tripId && first.tripId === start.tripId;
    let exit;
    let option;
    if (seatedFirst) {
      // Ich bleibe zunächst sitzen (auch über eine umsteigefreie Weiterfahrt) und steige an last.toName aus
      const lastIdx = lastInterlined(transit, 0);
      const last = transit[lastIdx];
      exit = { name: last.toName, time: last.end, delay: last.delayEndMin, seated: lastIdx === transit.length - 1 };
      const r = c.risks[0];
      option = { connection: c, onward: transit.slice(lastIdx + 1), transfer: r ? { bufferMin: r.bufferMin, level: r.level, critical: r.critical } : null };
    } else {
      // Aussteigen schon am nächsten Halt; Puffer = Abfahrt Anschluss − Ankunft − Fußweg dorthin
      exit = { name: start.place.name, time: start.time, delay: start.delayMin ?? 0, seated: false };
      const idx = c.legs.indexOf(first);
      const walk = c.legs.slice(0, idx).filter((l) => l.kind === 'walk').reduce((sum, l) => sum + (l.end - l.start), 0);
      const bufferMin = Math.floor((first.start - start.time - walk) / MIN);
      option = { connection: c, onward: transit, transfer: { bufferMin, level: bufferMin < 0 ? 'missed' : bufferMin < tightMinutes ? 'tight' : 'ok', critical: false } };
    }
    const key = `${normalize(exit.name)}|${exit.seated}`;
    if (!groups.has(key)) {
      groups.set(key, { exitName: exit.name, exitTime: exit.time, exitDelayMin: exit.delay, seated: exit.seated, options: [], best: false });
    }
    const g = groups.get(key);
    g.options.push(option);
    if (c.best) g.best = true;
  }
  return [...groups.values()].sort((a, b) => a.exitTime - b.exitTime);
}

/** Index des letzten Legs, das ab transit[i] umsteigefrei (interline) weiterfährt. */
function lastInterlined(transit, i) {
  let j = i;
  while (transit[j + 1]?.interline) j++;
  return j;
}
