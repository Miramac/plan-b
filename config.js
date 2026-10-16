// plan-b – zentrale Konfiguration.
// Hier änderst du Haltestellen, Varianten, feste Zeiten und Wetter-Schwellenwerte.
// Keine Logik, nur Daten → wandert später 1:1 in ein NestJS-Config-Modul.

/**
 * @typedef {Object} StopConfig
 * @property {string} name      Erwarteter Haltestellenname (ohne Ort), z. B. "Waldstraße"
 * @property {string} place     Ort, in dem die Haltestelle liegen muss
 * @property {string} [query]   Suchtext fürs Geocoding (Standard: "<place> <name>")
 * @property {boolean} [rail]   true = Bahnhof (bei Gleichstand wird der Halt mit Bahnverkehr bevorzugt)
 * @property {string|null} id   Transitous-Stop-ID. Ist sie gesetzt, entfällt das Geocoding.
 *                              Nach der ersten Abfrage zeigt die App die gefundenen IDs zum Kopieren an.
 * @property {number} [lat]     Koordinaten (optional, für den GPS-Unterwegs-Modus hilfreich)
 * @property {number} [lon]
 */

/** @type {Record<string, StopConfig>} */
export const STOPS = {
  home:             { name: 'Hochstetten Waldstraße', place: 'Linkenheim-Hochstetten', id: null },
  grabenNeudorf:    { name: 'Graben-Neudorf', place: 'Graben-Neudorf', rail: true, id: null },
  bruchsal:         { name: 'Bruchsal', place: 'Bruchsal', rail: true, id: null },
  wieslochWalldorf: { name: 'Wiesloch-Walldorf', place: 'Walldorf', query: 'Wiesloch-Walldorf Bahnhof', rail: true, id: null },
  neulussheim:      { name: 'Neulußheim', place: 'Neulußheim', rail: true, id: null },
  hockenheim:       { name: 'Hockenheim', place: 'Hockenheim', rail: true, id: null },
  oftersheim:       { name: 'Oftersheim', place: 'Oftersheim', rail: true, id: null },
  workIndustrie:    { name: 'Industriestraße', place: 'Walldorf', id: null },
  workHdm:          { name: 'HDM Philipp-Reis-Straße', place: 'Walldorf', id: null },
};

/** Beide Arbeits-Haltestellen sind gleichwertig – es wird zu/ab beiden gesucht. */
const WORK = ['workIndustrie', 'workHdm'];

/**
 * Eine Etappen-Option liefert einen Teil der späteren Abfrage.
 * Zwei Optionen (Etappe 1 + Etappe 2) werden zu einer Kombination zusammengesetzt:
 *   from/to: spätere Option überschreibt, via: wird aneinandergehängt (max. 2 – MOTIS-Grenze).
 *
 * @typedef {Object} FixedPart
 * @property {number} minutes   Feste Dauer inkl. Puffer
 * @property {'bike'|'walk'} mode
 * @property {string} label
 *
 * @typedef {Object} StageOption
 * @property {string} key
 * @property {string} name
 * @property {string[]} [from]              Start-Haltestellen (Keys aus STOPS)
 * @property {string[]} [to]                Ziel-Haltestellen
 * @property {string[]} [via]               Via-Halte in Fahrtreihenfolge
 * @property {FixedPart} [fixedBefore]      Fester Anteil VOR der ÖPNV-Suche (Suche startet jetzt + minutes)
 * @property {FixedPart} [fixedAfter]       Fester Anteil NACH der ÖPNV-Fahrt
 * @property {string[]} [criticalTransfers] Umstiege an diesen Halten sind kritisch (Bus nur 1x pro Stunde)
 * @property {{to: string, minutes: number, label: string}} [fallback]
 *           Liefert die API zum Ziel nichts: bis fallback.to suchen und minutes als Schätzung aufschlagen.
 *
 * @typedef {Object} Journey
 * @property {string} key
 * @property {string} label
 * @property {StageOption[]} stage1
 * @property {StageOption[]} stage2
 */

/** @type {Journey} Hinweg: Zuhause → Arbeit */
export const OUTBOUND = {
  key: 'outbound',
  label: 'Zur Arbeit',
  stage1: [
    { key: 'bus', name: 'Bus', from: ['home'], via: ['grabenNeudorf'] },
    {
      key: 'bike', name: 'Rad',
      from: ['grabenNeudorf'],
      fixedBefore: { minutes: 28, mode: 'bike', label: 'Rad nach Graben-Neudorf (25 Min. + 3 Min. Abstellen)' },
    },
  ],
  stage2: [
    { key: 'A1', name: 'S9 + Bus über Neulußheim', via: ['neulussheim'], to: WORK, criticalTransfers: ['neulussheim'] },
    { key: 'A2', name: 'S9 + Bus über Hockenheim', via: ['hockenheim'], to: WORK, criticalTransfers: ['hockenheim'] },
    { key: 'A3', name: 'S9 + Bus über Oftersheim', via: ['oftersheim'], to: WORK, criticalTransfers: ['oftersheim'] },
    {
      key: 'B', name: 'S33 + S-Bahn über Bruchsal/Wiesloch-Walldorf', via: ['bruchsal'], to: WORK,
      fallback: { to: 'wieslochWalldorf', minutes: 15, label: 'Bus ab Wiesloch-Walldorf (geschätzt, max. 15 Min.)' },
    },
  ],
};

/** @type {Journey} Rückweg: Arbeit → Zuhause */
export const RETURN = {
  key: 'return',
  label: 'Nach Hause',
  stage1: [
    { key: 'A1', name: 'Bus + S9 über Neulußheim', from: WORK, via: ['neulussheim'], criticalTransfers: ['neulussheim'] },
    { key: 'A2', name: 'Bus + S9 über Hockenheim', from: WORK, via: ['hockenheim'], criticalTransfers: ['hockenheim'] },
    { key: 'A3', name: 'Bus + S9 über Oftersheim', from: WORK, via: ['oftersheim'], criticalTransfers: ['oftersheim'] },
    {
      key: 'B', name: 'Fußweg + S-Bahn über Wiesloch-Walldorf/Bruchsal',
      from: ['wieslochWalldorf'], via: ['bruchsal'],
      fixedBefore: { minutes: 25, mode: 'walk', label: 'Zu Fuß zum Bahnhof Wiesloch-Walldorf (25 Min.)' },
    },
  ],
  stage2: [
    { key: 'bus', name: 'Bus', via: ['grabenNeudorf'], to: ['home'] },
    {
      key: 'bike', name: 'Rad', to: ['grabenNeudorf'],
      fixedAfter: { minutes: 25, mode: 'bike', label: 'Rad nach Hause (25 Min.)' },
    },
  ],
};

/** Umstiegs- und Abfrage-Parameter */
export const RULES = {
  tightTransferMinutes: 5, // Puffer darunter = "knapp"
  connectionsPerVariant: 3, // nächste N Verbindungen je Kombination
  maxParallelRequests: 4, // schont die Transitous-API
  autoRefreshMinutes: 3, // Unterwegs-Modus
  maxPreTransitSecondsFromGps: 1800, // max. Fußweg vom GPS-Standort zur ersten Haltestelle
};

/** Wetter (Open-Meteo) für Linkenheim-Hochstetten */
export const WEATHER = {
  lat: 49.118,
  lon: 8.415,
  goodBikeWeather: {
    maxPrecipitationMm: 0.2, // mm/h, darunter ok
    minTemperatureC: 5, // °C, darüber ok
    maxWindKmh: 30, // km/h, darunter ok
  },
};

export const API = {
  transitousBase: 'https://api.transitous.org',
  openMeteoBase: 'https://api.open-meteo.com',
};
