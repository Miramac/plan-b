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
  // IDs per Transitous-Geocoding ermittelt und geprüft (Stand 16.10.2026).
  // Setzt du id: null, sucht die App die Haltestelle wieder selbst über name + place.
  home:             { name: 'Hochstetten Waldstraße', place: 'Linkenheim-Hochstetten', id: 'de-KVV_Pde:08215:7702', lat: 49.13485, lon: 8.4224 },
  grabenNeudorf:    { name: 'Graben-Neudorf', place: 'Graben-Neudorf', query: 'Graben-Neudorf Bahnhof', rail: true, id: 'de-DELFI_de:08215:32585', lat: 49.16207, lon: 8.49069 },
  // Bruchsal Hauptbahnhof (in den Fahrplandaten nur "Bruchsal"; ICE, RE, S3, S33)
  bruchsal:         { name: 'Bruchsal', place: 'Bruchsal', rail: true, id: 'de-DELFI_de:08215:1856', lat: 49.12462, lon: 8.58965 },
  wieslochWalldorf: { name: 'Wiesloch-Walldorf', place: 'Wiesloch', query: 'Wiesloch-Walldorf Bahnhof', rail: true, id: 'de-DELFI_de:08226:4252_G', lat: 49.29135, lon: 8.66415 },
  neulussheim:      { name: 'Neulußheim', place: 'Neulußheim', rail: true, id: 'de-DELFI_de:08226:3101', lat: 49.29295, lon: 8.53067 },
  hockenheim:       { name: 'Hockenheim', place: 'Hockenheim', rail: true, id: 'de-DELFI_de:08226:1620', lat: 49.31741, lon: 8.53738 },
  oftersheim:       { name: 'Oftersheim', place: 'Oftersheim', rail: true, id: 'de-DELFI_de:08226:3285', lat: 49.37335, lon: 8.57899 },
  // Bushalte: ID eines Steigs, die API berücksichtigt beide Fahrtrichtungen
  workIndustrie:    { name: 'Industriestraße', place: 'Walldorf', id: 'de-DELFI_de:08226:4277:0:1', lat: 49.29276, lon: 8.64824 },
  workHdm:          { name: 'HDM Philipp-Reis-Straße', place: 'Walldorf', id: 'de-DELFI_de:08226:4023:0:RiO', lat: 49.2898, lon: 8.65166 },
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
 * @property {string[]} [busTransferAt]  Hier MUSS zwischen Bus und Bahn umgestiegen werden (sonst wird die
 *                                        Verbindung verworfen). Der Bus fährt nur 1x pro Stunde → Umstieg ist kritisch.
 * @property {Record<string, number|{minutes: number, towards?: string}>} [minBufferAt]
 *           Ausnahme vom Mindestpuffer an einem Halt, optional nur in eine Richtung,
 *           z. B. { bruchsal: { minutes: 2, towards: 'grabenNeudorf' } }
 * @property {{to: string, minutes: number, label: string}} [fallback]
 *           Liefert die API zum Ziel nichts: bis fallback.to suchen und minutes als Schätzung aufschlagen.
 *
 * @typedef {Object} Journey
 * @property {string} key
 * @property {string} label
 * @property {string} usualTime   Gewohnte Abfahrt "HH:MM" (Auswahl "Gewohnt" in der App)
 * @property {StageOption[]} stage1
 * @property {StageOption[]} stage2
 */

/** @type {Journey} Hinweg: Zuhause → Arbeit */
export const OUTBOUND = {
  key: 'outbound',
  label: 'Zur Arbeit',
  usualTime: '07:30', // von daheim los
  stage1: [
    { key: 'bus', name: 'Bus', from: ['home'], via: ['grabenNeudorf'] },
    {
      key: 'bike', name: 'Rad',
      from: ['grabenNeudorf'],
      fixedBefore: { minutes: 28, mode: 'bike', label: 'Rad nach Graben-Neudorf (25 Min. + 3 Min. Abstellen)' },
    },
  ],
  stage2: [
    { key: 'A1', name: 'S9 + Bus über Neulußheim', via: ['neulussheim'], to: WORK, busTransferAt: ['neulussheim'] },
    { key: 'A2', name: 'S9 + Bus über Hockenheim', via: ['hockenheim'], to: WORK, busTransferAt: ['hockenheim'] },
    { key: 'A3', name: 'S9 + Bus über Oftersheim', via: ['oftersheim'], to: WORK, busTransferAt: ['oftersheim'] },
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
  usualTime: '17:00', // von der Arbeit los
  stage1: [
    { key: 'A1', name: 'Bus + S9 über Neulußheim', from: WORK, via: ['neulussheim'], busTransferAt: ['neulussheim'] },
    { key: 'A2', name: 'Bus + S9 über Hockenheim', from: WORK, via: ['hockenheim'], busTransferAt: ['hockenheim'] },
    { key: 'A3', name: 'Bus + S9 über Oftersheim', from: WORK, via: ['oftersheim'], busTransferAt: ['oftersheim'] },
    {
      key: 'B', name: 'Fußweg + S-Bahn über Wiesloch-Walldorf/Bruchsal',
      from: ['wieslochWalldorf'], via: ['bruchsal'],
      minBufferAt: { bruchsal: { minutes: 2, towards: 'grabenNeudorf' } }, // Ausnahme: Bruchsal → Graben-Neudorf reichen 2 Min.
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
  minBufferMinutes: 3, // Umstiege mit weniger Puffer (laut Fahrplan) nie nutzen – Ausnahmen: minBufferAt
  tightTransferMinutes: 5, // Puffer darunter = "knapp" (inkl. Echtzeit)
  viaMinimumStayMinutes: 1, // erzwingt Aussteigen am Via-Halt (bei 0 zählt auch Durchfahren)
  connectionsPerVariant: 3, // unterwegs: nächste N Verbindungen je Kombination (Alternativen)
  // Normale Suche (Jetzt / Gewohnt / Uhrzeit): Abfahrtszeit steht fest → je Variante nur die beste Verbindung,
  // die höchstens maxWaitMinutes nach der gewünschten Abfahrt startet. Spätere Abfahrten werden ausgeblendet.
  maxWaitMinutes: 30,
  perVariant: 1,
  itinerariesPerQuery: 5, // so viele je Abfrage holen – einige fallen durch die Umstiegsregeln weg
  maxParallelRequests: 4, // schont die Transitous-API
  autoRefreshMinutes: 3, // Unterwegs-Modus
  maxPreTransitSecondsFromGps: 1800, // max. Fußweg vom GPS-Standort zur ersten Haltestelle
};

/** Zeitzone und Arbeitstage für die "gewohnten" Abfahrtszeiten */
export const TIME = {
  timeZone: 'Europe/Berlin',
  workdays: [1, 2, 3, 4, 5], // 0 = Sonntag … 6 = Samstag
};

/** Wetter (Open-Meteo) für Linkenheim-Hochstetten */
export const WEATHER = {
  lat: 49.135,
  lon: 8.422,
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
