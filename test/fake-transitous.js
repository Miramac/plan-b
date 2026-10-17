// Test-Doppel für die Transitous-API: liefert MOTIS-ähnliche Antworten ohne Netzwerk.

const MIN = 60_000;

/** Geocoding-Treffer nach MOTIS-Schema (Match) */
export const MATCHES = {
  'Hochstetten Waldstraße Linkenheim-Hochstetten': [
    match('de:08215:1001', 'Hochstetten Waldstraße', 'Linkenheim-Hochstetten', 49.12, 8.42, ['BUS']),
    match('de:08215:1002', 'Hochstetten Rathaus', 'Linkenheim-Hochstetten', 49.125, 8.42, ['BUS']),
  ],
  'Graben-Neudorf Bahnhof': [
    match('de:08215:2000', 'Graben-Neudorf', 'Graben-Neudorf', 49.165, 8.49, ['SUBURBAN', 'REGIONAL_RAIL']),
    match('de:08215:2001', 'Graben-Neudorf Bahnhof', 'Graben-Neudorf', 49.1652, 8.4902, ['BUS']),
    match('de:08215:2002', 'Graben-Neudorf Rathaus', 'Graben-Neudorf', 49.17, 8.50, ['BUS']),
  ],
  Bruchsal: [match('de:08215:3000', 'Bruchsal', 'Bruchsal', 49.124, 8.59, ['REGIONAL_RAIL'])],
  'Wiesloch-Walldorf Bahnhof': [match('de:08226:4000', 'Wiesloch-Walldorf, Bf', 'Wiesloch', 49.29, 8.66, ['SUBURBAN', 'BUS'])],
  Neulußheim: [match('de:08226:5000', 'Neulußheim', 'Neulußheim', 49.29, 8.52, ['SUBURBAN'])],
  Hockenheim: [match('de:08226:6000', 'Hockenheim', 'Hockenheim', 49.32, 8.55, ['SUBURBAN'])],
  // Absichtlich mehrdeutig: zwei verschiedene Halte, keiner heißt exakt "Oftersheim"
  Oftersheim: [
    match('de:08226:7001', 'Oftersheim Bahnhof Nord', 'Oftersheim', 49.37, 8.58, ['SUBURBAN']),
    match('de:08226:7002', 'Oftersheim Bahnhof Süd', 'Oftersheim', 49.36, 8.59, ['SUBURBAN']),
  ],
  'Industriestraße Walldorf': [match('de:08226:8000', 'Walldorf Industriestraße', 'Walldorf (Baden)', 49.30, 8.63, ['BUS'])],
  'HDM Philipp-Reis-Straße Walldorf': [match('de:08226:9000', 'Walldorf HDM Philipp-Reis-Str.', 'Walldorf (Baden)', 49.305, 8.635, ['BUS'])],
};

function match(id, name, area, lat, lon, modes) {
  return { type: 'STOP', id, name, lat, lon, modes, tokens: [], score: 1, areas: [{ name: area, adminLevel: 8, matched: true, default: true }] };
}

const BUS_STOPS = ['de:08215:1001', 'de:08226:8000', 'de:08226:9000'];
const NAMES = Object.fromEntries(Object.values(MATCHES).flat().map((m) => [m.id, m.name]));

/**
 * Baut ein Itinerary: from → via… → to, je Abschnitt 15 Min. Fahrt.
 * Umstieg in Neulußheim nur 3 Min. (knapp + stündlich), sonst 6 Min.
 */
function itinerary(stopIds, start, { delayMin = 0, realTime = true } = {}) {
  const legs = [];
  let t = start;
  for (let i = 0; i < stopIds.length - 1; i++) {
    const from = stopIds[i];
    const to = stopIds[i + 1];
    const dep = t;
    const arr = dep + 15 * MIN;
    const d = i === 0 ? delayMin * MIN : 0;
    legs.push({
      // Bus von/zu Zuhause und Arbeit, sonst S-Bahn (wie in echt)
      mode: [from, to].some((id) => BUS_STOPS.includes(id)) ? 'BUS' : 'SUBURBAN',
      from: { name: NAMES[from] ?? from, stopId: from, lat: 0, lon: 0 },
      to: { name: NAMES[to] ?? to, stopId: to, lat: 0, lon: 0 },
      startTime: new Date(dep + d).toISOString(),
      endTime: new Date(arr + d).toISOString(),
      scheduledStartTime: new Date(dep).toISOString(),
      scheduledEndTime: new Date(arr).toISOString(),
      realTime,
      scheduled: true,
      duration: 900,
      tripId: `trip-${from}-${to}-${dep}`,
      routeShortName: i === 0 ? 'S9' : `L${i}`,
      headsign: NAMES[to],
      legGeometry: {},
    });
    t = arr + (to === 'de:08226:5000' ? 3 : 6) * MIN;
  }
  return {
    id: stopIds.join('>') + start,
    startTime: legs[0].startTime,
    endTime: legs[legs.length - 1].endTime,
    duration: 0,
    transfers: legs.length - 1,
    legs,
  };
}

/** @returns {{client: any, calls: any[]}} */
export function createFakeClient({ emptyTo = [], failVia = [] } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async geocode(text) {
        calls.push({ type: 'geocode', text });
        return MATCHES[text] ?? [];
      },
      async plan(q) {
        calls.push({ type: 'plan', ...q });
        if (q.via.some((v) => failVia.includes(v))) throw new Error('Transitous: Fehler 500');
        const toPlace = q.toStops?.[0] ?? q.toPlace; // POST mit Offsets: erste Ziel-Haltestelle
        const fromPlace = q.fromStops?.[0] ?? q.fromPlace;
        if ((q.toStops ?? [q.toPlace]).every((t) => emptyTo.includes(t))) return { itineraries: [] };
        const from = fromPlace.includes(',') ? 'gps' : fromPlace;
        const seq = [from, ...q.via, toPlace];
        return {
          itineraries: [0, 20, 40].map((off, i) =>
            itinerary(seq, q.time + (5 + off) * MIN, { delayMin: i === 0 ? 2 : 0, realTime: i !== 2 })),
        };
      },
      async trip(tripId) {
        calls.push({ type: 'trip', tripId });
        return { legs: [] };
      },
    },
  };
}
