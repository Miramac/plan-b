# plan-b

Prototyp einer Web-App, die meine Pendel-Varianten zwischen Linkenheim-Hochstetten und Walldorf vergleicht und die voraussichtlich schnellste empfiehlt.
Daten: [Transitous](https://transitous.org) (MOTIS-API, Echtzeit) und [Open-Meteo](https://open-meteo.com) (Wetter).

Reines HTML/CSS/JavaScript mit ES-Modulen, kein Framework, kein Build-Schritt.

## Starten

ES-Module brauchen einen Webserver (`file://` geht nicht):

```bash
npm start          # = python3 -m http.server 8080 → http://localhost:8080
npm test           # Logik-Tests mit Node ≥ 18, ohne Netzwerk
```

Für GPS (Unterwegs-Modus) muss die Seite über HTTPS (oder localhost) laufen.

## Dateien

| Datei | Aufgabe |
|---|---|
| `config.js` | Haltestellen, Varianten (Hin-/Rückweg), feste Zeiten, Regeln, Wetter-Schwellenwerte |
| `api.js` | Alle HTTP-Abfragen: Transitous `geocode`, `plan`, `trip`; Open-Meteo `forecast` |
| `logic.js` | Reine Funktionen: Haltestellen-Abgleich, Kombinationen, Auswertung, Umstiegsrisiko, Sortierung, Wetterbewertung |
| `planner.js` | Ablauf: Haltestellen auflösen → Kombinationen parallel abfragen → auswerten (kein DOM) |
| `ui.js`, `index.html`, `style.css` | Anzeige und Bedienung, Geolocation, Auto-Update, localStorage |
| `test/` | Node-Tests mit Fake-API |

## So funktioniert der Vergleich

1. **Kombinationen:** Jede Option aus Etappe 1 wird mit jeder Option aus Etappe 2 kombiniert (Hinweg: Bus/Rad × A1/A2/A3/B = 8).
2. **Abfrage:** Pro Kombination ein `GET /api/v6/plan` je Start-/Ziel-Haltestelle, mit `via` (z. B. Graben-Neudorf + Hockenheim). Feste Anteile (Rad, Fußweg) werden nicht geroutet: Die Suche startet am Bahnhof zur Zeit *jetzt + feste Dauer*.
3. **Auswertung:** Die nächsten 3 Verbindungen je Kombination. Ankunft inklusive Echtzeit, festen Anteilen und gegebenenfalls der 15-Minuten-Schätzung bei Weg B. Puffer je Umstieg, unter 5 Minuten „knapp“. An stündlichen Bus-Umstiegen gilt das als kritisch.
4. **Rangliste:** Alle Verbindungen werden gemeinsam nach Ankunft sortiert. Die beste wird hervorgehoben.

## Haltestellen

Die Transitous-IDs sind fest in `config.js → STOPS` eingetragen, ermittelt per Geocoding und mit Live-Abfragen geprüft. Setzt du bei einer Haltestelle `id: null`, sucht die App sie bei der nächsten Abfrage selbst über `name` und `place`. Die Seite zeigt unter **„Haltestellen“** eine Kontroll-Tabelle und eine Kopiervorlage. Bei mehrdeutigen Treffern wird nicht geraten: Du wählst den richtigen Halt aus.

## Besonderheiten der MOTIS-API

- **Via-Halte:** Ohne Mindestaufenthalt zählt auch ein Zug, der nur durchfährt. Deshalb setzt die App `viaMinimumStay = 1` (`RULES.viaMinimumStayMinutes`) und erzwingt so das Aussteigen.
- **Varianten A1–A3:** Zusätzlich prüft die App, dass am Bahnhof wirklich zwischen Bus und Bahn umgestiegen wird (`busTransferAt`). Sonst wird die Verbindung verworfen.
- **Echtzeit:** Gibt es erst kurz vor der Fahrt. Abfragen für spätere Tage zeigen daher „keine Echtzeitdaten“.

## Nutzungsregeln Transitous

Abfragen laufen nur auf Knopfdruck oder im Unterwegs-Modus (Auto-Update alle 3 Minuten, nur bei sichtbarer Seite). Maximal 4 Requests laufen parallel.
