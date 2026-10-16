// plan-b – Anzeige und Bedienung. Einziger Teil mit DOM, Geolocation, localStorage, Timern.
// Später: Vue-Komponenten; die Abläufe dahinter liefert dann ein NestJS-Backend.

import { STOPS, OUTBOUND, RETURN, RULES, WEATHER, API, TIME } from './config.js';
import { createTransitousClient, fetchWeather } from './api.js';
import { resolveStops, planJourney, locateInConnection, choiceSignature } from './planner.js';
import { nextStep, recommendationChanged, recommendationKey, nextOccurrence, weatherAt } from './logic.js';

const $ = (sel) => document.querySelector(sel);
const JOURNEYS = { outbound: OUTBOUND, return: RETURN };
const client = createTransitousClient({ baseUrl: API.transitousBase, maxParallel: RULES.maxParallelRequests });

// --- Browser-Speicher (nur Komfort: Haltestellen-Cache, Nutzer-Auswahl bei Mehrdeutigkeit) ---
const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(`plan-b:${key}`)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`plan-b:${key}`, JSON.stringify(value)); } catch { /* privat-Modus */ } },
};

/** "HH:MM" oder null */
function validTime(v) {
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null;
}

/** Zustand der Seite */
const state = {
  busy: false,
  journeyKey: 'outbound',
  stops: null,
  connections: [],
  results: [],
  lastBest: null, // recommendationKey der letzten Empfehlung – für "Neue Empfehlung"
  timeMode: store.get('timeMode') ?? 'now', // 'now' | 'usual' | 'custom'
  customTime: validTime(store.get('customTime')) ?? '07:30',
  enRoute: { active: false, start: null, mode: null, tripConnection: null, timer: null, lastRun: 0 },
};

// ---------------------------------------------------------------------------
// Formatierung
// ---------------------------------------------------------------------------
const fmtTime = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TIME.timeZone });
const fmtDay = (t) => new Date(t).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TIME.timeZone });
const fmtWhen = (t, now) => (fmtDay(t) === fmtDay(now) ? `heute ${fmtTime(t)}` : `${fmtDay(t)} ${fmtTime(t)}`);
const fmtDur = (msDiff) => {
  const m = Math.round(msDiff / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} Min.`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const delayText = (min) => (min > 0 ? `+${min}` : min < 0 ? `${min}` : '±0');
const modeIcon = (leg) => {
  if (leg.kind === 'bike') return '🚲';
  if (leg.kind === 'walk') return '🚶';
  if (leg.kind === 'estimate') return '🚌';
  if (leg.mode === 'BUS' || leg.mode === 'COACH') return '🚌';
  if (leg.mode === 'TRAM') return '🚊';
  return '🚆';
};

// ---------------------------------------------------------------------------
// Meldungen
// ---------------------------------------------------------------------------
function message(kind, html) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.innerHTML = html;
  $('#messages').append(div);
}
const clearMessages = () => { $('#messages').innerHTML = ''; };

// ---------------------------------------------------------------------------
// Abfahrtszeit: jetzt, gewohnte Zeit (nächster Werktag) oder eigene Uhrzeit
// ---------------------------------------------------------------------------
/** @param {'outbound'|'return'} journeyKey */
function searchTimeFor(journeyKey, now) {
  // Kulanz: bis 30 Min. nach der Uhrzeit gilt noch "heute" (dann ab jetzt), danach der nächste Tag
  const graceMinutes = 30;
  if (state.timeMode === 'usual') {
    return nextOccurrence(now, JOURNEYS[journeyKey].usualTime, { timeZone: TIME.timeZone, weekdays: TIME.workdays, graceMinutes });
  }
  if (state.timeMode === 'custom') {
    return nextOccurrence(now, state.customTime, { timeZone: TIME.timeZone, graceMinutes });
  }
  return now;
}

function renderTimeHint() {
  const now = Date.now();
  const hint = $('#time-hint');
  $('#time-custom').hidden = state.timeMode !== 'custom';
  if (state.timeMode === 'now') hint.textContent = 'Verbindungen ab jetzt, mit Echtzeit.';
  else if (state.timeMode === 'usual') {
    hint.textContent = `Zur Arbeit ${fmtWhen(searchTimeFor('outbound', now), now)} · Nach Hause ${fmtWhen(searchTimeFor('return', now), now)}`;
  } else hint.textContent = `Ab ${fmtWhen(searchTimeFor('outbound', now), now)}`;
}

// ---------------------------------------------------------------------------
// Hauptablauf: Abfrage starten (normal oder unterwegs)
// ---------------------------------------------------------------------------
/**
 * @param {'outbound'|'return'} journeyKey
 * @param {import('./planner.js').EnRouteStart} [start]
 */
async function run(journeyKey, start) {
  if (state.busy) return;
  state.busy = true;
  state.journeyKey = journeyKey;
  const journey = JOURNEYS[journeyKey];
  setBusy(true);
  clearMessages();
  $('#results').innerHTML = `<li class="loading"><span class="spinner"></span>Frage Verbindungen ab …</li>`;
  $('#summary').textContent = '';

  renderTimeHint();
  try {
    const realNow = Date.now();
    // Unterwegs immer ab jetzt; sonst je nach Auswahl jetzt / gewohnte Zeit / eigene Uhrzeit
    const now = start ? realNow : searchTimeFor(journeyKey, realNow);
    const planned = now > realNow + 30 * 60_000;
    // 1) Haltestellen auflösen (gecacht) und Wetter parallel holen
    const [stops, weather] = await Promise.all([
      resolveStops(client, STOPS, { cache: store, choices: store.get('choices') ?? {} }),
      fetchWeather({ baseUrl: API.openMeteoBase, lat: WEATHER.lat, lon: WEATHER.lon }).catch((e) => {
        message('warn', `Wetter nicht verfügbar: ${esc(e.message)}`);
        return null;
      }),
    ]);
    state.stops = stops;
    renderStops(stops);
    renderWeather(weather, now, realNow);
    const unresolved = Object.values(stops).filter((s) => s.status !== 'ok');
    if (unresolved.length) {
      message('warn', `⚠️ ${unresolved.length} Haltestelle(n) nicht eindeutig gefunden: ${unresolved.map((s) => esc(s.expected)).join(', ')}.
        Betroffene Varianten fehlen. Bitte unten unter „Haltestellen“ auswählen oder die ID in <code>config.js</code> eintragen.`);
      $('#stops-panel').open = true;
    }

    // 2) Alle Kombinationen parallel abfragen und gemeinsam sortieren
    const { connections, results } = await planJourney({
      client, journey, stops, rules: RULES, now, realNow, start, weather, weatherThresholds: WEATHER.goodBikeWeather,
    });
    state.connections = connections;
    state.results = results;

    // 3) Unterwegs: Empfehlungswechsel deutlich anzeigen
    const best = connections.find((c) => c.best);
    if (start && recommendationChanged(state.lastBest, best, realNow)) {
      message('change', `🔀 Neue Empfehlung: ${esc(describeStep(best, realNow))}`);
      try { navigator.vibrate?.(200); } catch { /* egal */ }
    }
    // Vergleichsbasis für "Neue Empfehlung" nur aus aktuellen (nicht geplanten) Abfragen
    state.lastBest = best && !planned ? recommendationKey(best) : null;
    if (planned) message('info', `🗓️ Geplante Fahrt ab ${esc(fmtWhen(now, realNow))} – Echtzeit-Verspätungen gibt es erst kurz vor Abfahrt.`);

    // Ungeklärte Haltestellen wurden oben schon gemeldet → hier nur echte API-Fehler
    const failed = results.filter((r) => r.status === 'error');
    const apiFailed = failed.filter((r) => !r.error.startsWith('Haltestelle nicht geklärt'));
    if (failed.length === results.length && results.length) {
      message('error', `❌ Keine Abfrage erfolgreich. ${esc(failed[0].error)}`);
    } else if (apiFailed.length) {
      message('warn', `Einige Varianten konnten nicht abgefragt werden: ${apiFailed.map((r) => esc(r.combo.name)).join(', ')} – ${esc(apiFailed[0].error)}`);
    }

    renderResults(connections, results, !!start, realNow);
    const from = start ? ` · ab ${start.type === 'gps' ? 'Standort' : start.label}` : ` · ab ${fmtWhen(now, realNow)}`;
    $('#summary').textContent = `${journey.label}${from} · Stand ${fmtTime(realNow)} · ${connections.length} Verbindungen aus ${results.length} Varianten`;
    fillTripSelect();
  } catch (e) {
    $('#results').innerHTML = '';
    message('error', `❌ ${esc(e.message || String(e))}`);
  } finally {
    state.busy = false;
    state.enRoute.lastRun = Date.now();
    setBusy(false);
  }
}

/** Satz für "Neue Empfehlung: …" */
function describeStep(conn, now) {
  const s = nextStep(conn, now);
  const line = s.line ? `${s.line}${s.headsign ? ` Richtung ${s.headsign}` : ''}` : '';
  if (s.type === 'change') return `in ${s.stop} aussteigen und ${line} um ${fmtTime(s.time)} nehmen (${conn.name}).`;
  if (s.type === 'arrive') return `sitzen bleiben bis ${s.stop} (${conn.name}).`;
  return `${line} um ${fmtTime(s.time)} ab ${s.stop} nehmen (${conn.name}).`;
}

function setBusy(on) {
  for (const id of ['#btn-outbound', '#btn-return', '#btn-gps', '#btn-refresh']) {
    const b = $(id);
    b.classList.toggle('busy', on);
    if (on) b.disabled = true;
  }
  if (!on) {
    $('#btn-outbound').disabled = false;
    $('#btn-return').disabled = false;
    $('#btn-gps').disabled = false;
    $('#btn-refresh').disabled = !state.enRoute.start;
  }
}

// ---------------------------------------------------------------------------
// Rendering: Ergebnisse
// ---------------------------------------------------------------------------
function renderResults(connections, results, enRoute, now) {
  const list = $('#results');
  list.innerHTML = '';
  connections.forEach((c, i) => list.append(connectionCard(c, i + 1, now)));

  // Varianten ohne Ergebnis: ausgegraut statt ausgeblendet
  for (const r of results.filter((x) => x.status !== 'ok')) {
    const li = document.createElement('li');
    li.className = 'conn dim';
    let why = r.status === 'error' ? esc(r.error) : enRoute ? 'nicht mehr erreichbar' : 'keine passende Verbindung gefunden';
    if (r.dropped?.buffer) why += ` · ${r.dropped.buffer} wegen zu knappem Umstieg (unter ${RULES.minBufferMinutes} Min. Puffer) verworfen`;
    li.innerHTML = `<div class="conn-head"><span class="variant">${esc(r.combo.name)}</span></div><p class="meta">${why}</p>`;
    list.append(li);
  }
  if (!list.children.length) list.innerHTML = '<li class="loading">Keine Verbindungen gefunden.</li>';
}

/** @param {import('./logic.js').Connection} c */
function connectionCard(c, rank, now) {
  const li = document.createElement('li');
  const broken = c.cancelled || c.riskLevel === 'missed';
  li.className = `conn risk-${c.riskLevel}${c.best ? ' best' : ''}${broken || c.departure < now - 60_000 ? ' dim' : ''}`;

  const badges = [];
  if (c.cancelled) badges.push('<span class="badge critical">Fahrt fällt aus</span>');
  for (const r of c.risks.filter((x) => x.level !== 'ok')) {
    const cls = r.level === 'missed' || r.critical ? 'critical' : 'tight';
    const txt = r.level === 'missed'
      ? `Anschluss in ${r.atName} weg`
      : `knapp: ${r.bufferMin} Min. in ${r.atName}${r.critical ? ' – Bus nur stündlich!' : ''}`;
    badges.push(`<span class="badge ${cls}">${esc(txt)}</span>`);
  }
  if (c.arrDelayMin >= 2 || c.depDelayMin >= 2) badges.push(`<span class="badge late">Verspätung ${delayText(Math.max(c.depDelayMin, c.arrDelayMin))} Min.</span>`);
  const soon = c.departure < now + 60 * 60_000; // Echtzeit gibt es erst kurz vor Abfahrt
  if (c.realtime === 'none' && soon) badges.push('<span class="badge info">keine Echtzeitdaten</span>');
  else if (c.realtime === 'partial' && soon) badges.push('<span class="badge info">Echtzeit nur teilweise</span>');
  if (c.estimated) badges.push('<span class="badge info">Ankunft geschätzt</span>');
  if (c.usesBike) {
    const w = c.weather;
    badges.push(w
      ? `<span class="badge ${w.good ? 'good' : 'bad'}">${w.good ? '🚲 Gutes Radwetter' : `🚲 ${esc(w.reasons.join(', '))}`} · ${Math.round(w.temperature)} °C · ${w.precipitation.toFixed(1)} mm · ${Math.round(w.wind)} km/h</span>`
      : '<span class="badge">🚲 Wetter unbekannt</span>');
  }

  const transitStart = c.legs.find((l) => l.kind === 'transit');
  const depLate = transitStart && transitStart.delayStartMin !== 0;
  li.innerHTML = `
    ${c.best ? '<span class="best-tag">★ Empfehlung</span>' : ''}
    <div class="conn-head">
      <span class="variant">${esc(c.name)}</span>
      <span class="rank">#${rank}</span>
    </div>
    <div class="times">
      <span class="t-big">${fmtTime(c.departure)}</span>
      <span class="arrow">→</span>
      <span class="t-big">${fmtTime(c.arrival)}</span>
      ${c.arrival !== c.scheduledArrival ? `<span class="sched">${fmtTime(c.scheduledArrival)}</span>` : ''}
    </div>
    <div class="meta">
      ${fmtDur(c.arrival - c.departure)} · ${c.transfers} Umstieg${c.transfers === 1 ? '' : 'e'}
      ${transitStart ? ` · ${esc(transitStart.line)} ab ${fmtTime(transitStart.start)}${depLate ? ` <span class="late">(${delayText(transitStart.delayStartMin)})</span>` : transitStart.realTime ? ' <span class="ontime">pünktlich</span>' : ''}` : ''}
    </div>
    <div class="badges">${badges.join('')}</div>
    <details>
      <summary>Verlauf &amp; Umstiege</summary>
      <ul class="legs">${legsHtml(c, now)}</ul>
    </details>`;
  return li;
}

function legsHtml(c, now) {
  const out = [];
  let riskIdx = 0;
  let seenTransit = false;
  for (const l of c.legs) {
    if (l.kind === 'transit') {
      // Umstieg (Zeit, Fußweg, Puffer) direkt vor der Anschlussfahrt; sitzen bleiben ist kein Umstieg
      const risk = seenTransit && !l.interline ? c.risks[riskIdx++] : null;
      if (risk) {
        const cls = risk.level === 'missed' ? 'missed' : risk.level === 'tight' ? (risk.critical ? 'critical' : 'tight') : '';
        const walk = risk.walkMin > 0 ? ` (${risk.walkMin} Min. Fußweg)` : '';
        out.push(`<li class="xfer ${cls}">↳ Umstieg ${esc(risk.atName)}: ${risk.transferMin} Min.${walk} · ${risk.bufferMin} Min. Puffer${risk.critical ? ' · Bus stündlich' : ''}</li>`);
      }
      seenTransit = true;
      const late = l.delayStartMin !== 0 ? ` <span class="late">${delayText(l.delayStartMin)}</span>` : '';
      const lateEnd = l.delayEndMin !== 0 ? ` <span class="late">${delayText(l.delayEndMin)}</span>` : '';
      const noRt = !l.realTime && l.start < now + 60 * 60_000 ? ' · ohne Echtzeit' : ''; // bei geplanten Fahrten normal
      out.push(`<li class="leg"><span class="lt">${fmtTime(l.start)}</span><span>${modeIcon(l)}</span>
        <span class="ld"><span class="line">${esc(l.line)}</span>${esc(l.fromName)}${late}
        <small>${l.headsign ? `Richtung ${esc(l.headsign)} · ` : ''}an ${esc(l.toName)} ${fmtTime(l.end)}${lateEnd}${noRt}${l.cancelled ? ' · <b>fällt aus</b>' : ''}</small></span></li>`);
    } else if (l.label) {
      out.push(`<li class="leg"><span class="lt">${fmtTime(l.start)}</span><span>${modeIcon(l)}</span><span class="ld">${esc(l.label)}<small>bis ${fmtTime(l.end)}</small></span></li>`);
    } else if (l.end - l.start >= 60_000) {
      out.push(`<li class="leg"><span class="lt">${fmtTime(l.start)}</span><span>${modeIcon(l)}</span><span class="ld">Fußweg ${fmtDur(l.end - l.start)}${l.toName ? ` zu ${esc(l.toName)}` : ''}</span></li>`);
    }
  }
  return out.join('');
}

function renderWeather(w, time, realNow) {
  const el = $('#weather');
  const c = weatherAt(w, time, WEATHER.goodBikeWeather);
  if (!c) { el.innerHTML = ''; return; }
  const when = time > realNow + 60 * 60_000 ? `Vorhersage ${fmtWhen(time, realNow)}` : 'jetzt';
  el.innerHTML = `<div class="weather card">
    <span class="badge ${c.good ? 'good' : 'bad'}">${c.good ? '🚲 Gutes Fahrradwetter' : `🌧️ Kein Fahrradwetter (${esc(c.reasons.join(', '))})`}</span>
    <span>🌡️ ${Math.round(c.temperature)} °C</span><span>💧 ${c.precipitation.toFixed(1)} mm</span><span>💨 ${Math.round(c.wind)} km/h</span>
    <span class="meta">${when}, Linkenheim-Hochstetten</span></div>`;
}

// ---------------------------------------------------------------------------
// Rendering: Haltestellen-Kontrolle (mit Auswahl bei Mehrdeutigkeit statt Raten)
// ---------------------------------------------------------------------------
function renderStops(stops) {
  const rows = Object.values(stops).map((s) => {
    let status;
    if (s.status === 'ok') status = `<span class="st-ok">✓ ${s.source === 'config' ? 'config.js' : s.source === 'choice' ? 'ausgewählt' : 'gefunden'}</span>`;
    else if (s.status === 'ambiguous') status = '<span class="st-bad">mehrdeutig – bitte wählen:</span>';
    else if (s.status === 'notFound') status = '<span class="st-bad">nicht gefunden</span>';
    else status = `<span class="st-bad">Fehler: ${esc(s.error)}</span>`;
    const choices = s.status === 'ambiguous' || s.status === 'notFound'
      ? (s.candidates ?? []).map((c, i) => `<button type="button" class="choice" data-key="${esc(s.key)}" data-idx="${i}">${esc(c.name)} · ${esc(c.area)}<br><code>${esc(c.id)}</code></button>`).join('')
      : '';
    return `<tr><td><b>${esc(s.expected)}</b><br><span class="meta">${esc(s.place)}</span></td>
      <td>${s.status === 'ok' ? `${esc(s.name)}${s.area ? `<br><span class="meta">${esc(s.area)}</span>` : ''}` : ''}${status}${choices}</td>
      <td><code>${esc(s.id ?? '–')}</code></td></tr>`;
  }).join('');

  // Kopiervorlage für config.js: so werden die IDs fest eingetragen (kein Geocoding mehr nötig)
  const q = (v) => `'${String(v).replace(/'/g, "\\'")}'`;
  const snippet = Object.values(stops)
    .filter((s) => s.status === 'ok')
    .map((s) => {
      const cfg = STOPS[s.key];
      const extra = `${cfg.query ? `, query: ${q(cfg.query)}` : ''}${cfg.rail ? ', rail: true' : ''}`;
      return `  ${s.key}: { name: ${q(cfg.name)}, place: ${q(cfg.place)}${extra}, id: ${q(s.id)}, lat: ${s.lat ?? 'null'}, lon: ${s.lon ?? 'null'} }, // ${s.name}`;
    })
    .join('\n');

  $('#stops').innerHTML = `
    <table class="stops-table"><thead><tr><th>Config</th><th>Gefunden (Name, Ort)</th><th>ID</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">Stimmen alle Treffer, diese Zeilen in <code>config.js</code> in <code>STOPS</code> übernehmen – dann entfällt das Geocoding:</p>
    <textarea class="snippet" readonly>${esc(snippet)}</textarea>`;

  // Auswahl bei Mehrdeutigkeit merken (localStorage), dann neu abfragen
  $('#stops').querySelectorAll('button.choice').forEach((btn) => btn.addEventListener('click', () => {
    const s = stops[btn.dataset.key];
    const c = s.candidates[Number(btn.dataset.idx)];
    const choices = store.get('choices') ?? {};
    choices[s.key] = { sig: choiceSignature(STOPS[s.key]), stop: { id: c.id, name: c.name, area: c.area, lat: c.lat, lon: c.lon } };
    store.set('choices', choices);
    run(state.journeyKey, state.enRoute.start ?? undefined);
  }));
}

// ---------------------------------------------------------------------------
// Unterwegs-Modus
// ---------------------------------------------------------------------------
function selectedDirection() {
  return document.querySelector('input[name="dir"]:checked').value;
}

function setEnRoute(active) {
  state.enRoute.active = active;
  $('#enroute-body').hidden = !active;
  $('#enroute').classList.toggle('active', active);
  $('#btn-enroute').hidden = active;
  if (active) {
    document.querySelector(`input[name="dir"][value="${state.journeyKey}"]`).checked = true;
  } else {
    state.enRoute.start = null;
    state.enRoute.tripConnection = null;
    $('#chk-auto').checked = false;
    stopAuto();
    $('#enroute-status').textContent = '';
    $('#btn-refresh').disabled = true;
  }
}

function fillTripSelect() {
  const sel = $('#sel-trip');
  const now = Date.now();
  // Nur Verbindungen, die gerade laufen oder in den nächsten 30 Min. starten (nicht die geplanten von morgen)
  const options = state.connections.filter((c) => c.legs.some((l) => l.kind === 'transit' && l.end > now && l.start <= now + 30 * 60_000));
  sel.innerHTML = options.length
    ? '<option value="">– Verbindung wählen –</option>' + options.map((c) => {
      const t = c.legs.filter((l) => l.kind === 'transit').map((l) => l.line).join(' → ');
      return `<option value="${esc(c.id)}">${fmtTime(c.departure)} ${esc(c.name)} (${esc(t)})</option>`;
    }).join('')
    : '<option value="">– keine laufenden Verbindungen –</option>';
  $('#btn-trip').disabled = true;
}

/** GPS-Standort holen (nur im UI-Teil; logic.js bekommt nur Koordinaten). */
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Standortbestimmung wird vom Browser nicht unterstützt.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? 'Standortfreigabe verweigert.' : 'Standort konnte nicht bestimmt werden.')),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  });
}

async function planFromGps() {
  try {
    $('#enroute-status').textContent = 'Bestimme Standort …';
    const pos = await getPosition();
    state.enRoute.mode = 'gps';
    state.enRoute.start = { type: 'gps', lat: pos.lat, lon: pos.lon };
    $('#enroute-status').textContent = `Standort ±${Math.round(pos.accuracy)} m · im Zug ungenau? Dann „Ich sitze gerade in …“ nutzen.`;
    await run(selectedDirection(), state.enRoute.start);
  } catch (e) {
    clearMessages();
    message('error', `📍 ${esc(e.message)}`);
    $('#enroute-status').textContent = '';
  }
}

async function planFromTrip(conn) {
  try {
    $('#enroute-status').textContent = 'Frage aktuelle Fahrt ab …';
    const start = await locateInConnection(client, conn, Date.now());
    state.enRoute.mode = 'trip';
    state.enRoute.tripConnection = conn;
    state.enRoute.start = start;
    $('#enroute-status').textContent = `In ${start.label} (ab ${fmtTime(start.time)})`;
    await run(selectedDirection(), start);
  } catch (e) {
    clearMessages();
    message('error', `🚆 ${esc(e.message)}`);
    $('#enroute-status').textContent = '';
  }
}

/** "Neu prüfen": gleicher Modus, frische Daten (GPS neu bzw. Fahrt neu abfragen). */
function refresh() {
  if (state.busy) return;
  if (state.enRoute.mode === 'gps') return planFromGps();
  if (state.enRoute.mode === 'trip' && state.enRoute.tripConnection) return planFromTrip(state.enRoute.tripConnection);
}

// Auto-Update: nur solange Modus aktiv UND Seite sichtbar (schont Akku und Transitous).
function startAuto() {
  stopAuto();
  state.enRoute.timer = setInterval(() => {
    if (document.visibilityState === 'visible' && state.enRoute.active && state.enRoute.start) refresh();
  }, RULES.autoRefreshMinutes * 60_000);
}
function stopAuto() {
  clearInterval(state.enRoute.timer);
  state.enRoute.timer = null;
}
document.addEventListener('visibilitychange', () => {
  // Zurück auf der Seite und Prüfung überfällig → sofort aktualisieren
  if (document.visibilityState === 'visible' && state.enRoute.timer && state.enRoute.start &&
      Date.now() - state.enRoute.lastRun > RULES.autoRefreshMinutes * 60_000) refresh();
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
$('#btn-outbound').addEventListener('click', () => { if (state.enRoute.active) setEnRoute(false); run('outbound'); });
$('#btn-return').addEventListener('click', () => { if (state.enRoute.active) setEnRoute(false); run('return'); });
$('#btn-enroute').addEventListener('click', () => setEnRoute(true));
$('#btn-enroute-stop').addEventListener('click', () => setEnRoute(false));
$('#btn-gps').addEventListener('click', planFromGps);
$('#btn-refresh').addEventListener('click', refresh);
$('#sel-trip').addEventListener('change', (e) => { $('#btn-trip').disabled = !e.target.value; });
$('#btn-trip').addEventListener('click', () => {
  const conn = state.connections.find((c) => c.id === $('#sel-trip').value);
  if (conn) planFromTrip(conn);
});
$('#chk-auto').addEventListener('change', (e) => (e.target.checked ? startAuto() : stopAuto()));

// Zeitwahl (Auswahl wird im Browser gemerkt)
document.querySelectorAll('input[name="tmode"]').forEach((r) => {
  r.checked = r.value === state.timeMode;
  r.addEventListener('change', () => { state.timeMode = r.value; store.set('timeMode', r.value); renderTimeHint(); });
});
$('#time-custom').value = state.customTime;
$('#time-custom').addEventListener('change', (e) => {
  const v = validTime(e.target.value);
  if (!v) { e.target.value = state.customTime; return; } // leeres Feld nicht übernehmen
  state.customTime = v;
  store.set('customTime', v);
  renderTimeHint();
});
renderTimeHint();
setInterval(() => { if (document.visibilityState === 'visible') renderTimeHint(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') renderTimeHint(); });
