// plan-b – alle Abfragen an Transitous (MOTIS) und Open-Meteo.
// Nutzt nur fetch() → läuft im Browser und in Node 18+ (später NestJS: TransitousService/WeatherService).
// API-Doku: https://github.com/motis-project/motis/blob/master/openapi.yaml

/**
 * @typedef {import('./logic.js').PlanQuery} PlanQuery
 * @typedef {import('./logic.js').WeatherData} WeatherData
 */

/** Verständliche Fehler für die Anzeige */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, url?: string, cause?: unknown}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = info.status;
    this.url = info.url;
    this.cause = info.cause;
  }
}

/** Begrenzt gleichzeitige Requests (Rücksicht auf die freie Transitous-Infrastruktur). */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

async function getJson(fetchImpl, url, serviceName, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
  } catch (cause) {
    const msg = cause?.name === 'AbortError'
      ? `${serviceName} antwortet nicht (Zeitüberschreitung).`
      : `${serviceName} ist nicht erreichbar. Internetverbindung prüfen.`;
    throw new ApiError(msg, { url, cause });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* egal */ }
    const hint = res.status === 429 ? ' (zu viele Anfragen – bitte kurz warten)' : '';
    throw new ApiError(`${serviceName}: Fehler ${res.status}${hint}${detail ? ` – ${detail}` : ''}`, { status: res.status, url });
  }
  return res.json();
}

const qs = (params) =>
  new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();

/**
 * Transitous-Client.
 * @param {{baseUrl: string, maxParallel?: number, fetchImpl?: typeof fetch}} opts
 */
export function createTransitousClient({ baseUrl, maxParallel = 4, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  const limit = createLimiter(maxParallel);
  const call = (path, params) => limit(() => getJson(fetchImpl, `${baseUrl}${path}?${qs(params)}`, 'Transitous'));

  return {
    /**
     * Haltestellensuche. Liefert Match[] (type, name, id, lat, lon, areas, modes …).
     * @param {string} text
     */
    geocode(text) {
      return call('/api/v1/geocode', { text, type: 'STOP', language: 'de' });
    },

    /**
     * Verbindungssuche. fromPlace/toPlace = Stop-ID oder "lat,lon".
     * via: max. 2 Stop-IDs, die die Verbindung passieren muss (MOTIS-Feature).
     * viaMinimumStay: Mindestaufenthalt je Via-Halt in Minuten (0 = Durchfahren reicht, ≥1 = aussteigen).
     * @param {PlanQuery & {numItineraries?: number, viaMinimumStay?: number[]}} q
     * @returns {Promise<{itineraries: any[]}>}
     */
    plan(q) {
      return call('/api/v6/plan', {
        fromPlace: q.fromPlace,
        toPlace: q.toPlace,
        via: q.via?.length ? q.via.join(',') : undefined,
        viaMinimumStay: q.via?.length ? q.via.map((_, i) => q.viaMinimumStay?.[i] ?? 0).join(',') : undefined,
        time: new Date(q.time).toISOString(),
        numItineraries: q.numItineraries ?? 3,
        maxPreTransitTime: q.maxPreTransitTime,
        detailedTransfers: false,
        language: 'de',
      });
    },

    /**
     * Eine konkrete Fahrt mit allen Halten und Echtzeit (für "Ich sitze gerade in …").
     * @param {string} tripId
     */
    trip(tripId) {
      return call('/api/v6/trip', { tripId, language: 'de' });
    },
  };
}

/**
 * Wetter von Open-Meteo (ohne API-Key): aktuell + stündliche Vorhersage.
 * Zeiten als Unix-ms, damit logic.js ohne Zeitzonen-Rechnerei die passende Stunde findet.
 * @param {{baseUrl: string, lat: number, lon: number, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<WeatherData>}
 */
export async function fetchWeather({ baseUrl, lat, lon, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  const vars = 'temperature_2m,precipitation,wind_speed_10m';
  const url = `${baseUrl}/v1/forecast?${qs({
    latitude: lat, longitude: lon, current: vars, hourly: vars,
    timeformat: 'unixtime', timezone: 'GMT', forecast_days: 2, wind_speed_unit: 'kmh',
  })}`;
  const d = await getJson(fetchImpl, url, 'Open-Meteo');
  const point = (time, i, src) => ({
    time: time * 1000,
    temperature: i == null ? src.temperature_2m : src.temperature_2m[i],
    precipitation: i == null ? src.precipitation : src.precipitation[i],
    wind: i == null ? src.wind_speed_10m : src.wind_speed_10m[i],
  });
  return {
    current: point(d.current.time, null, d.current),
    hourly: d.hourly.time.map((t, i) => point(t, i, d.hourly)),
  };
}
