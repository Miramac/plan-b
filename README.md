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

## Bedienung

- **Zur Arbeit / Nach Hause:** fragt alle Varianten der Richtung ab.
- **Abfahrt:** *Jetzt* (mit Echtzeit), *Gewohnt* (nächster Werktag 7:30 bzw. 17:00, in `config.js` → `usualTime`) oder eigene *Uhrzeit*.
- **Unterwegs → „Ich sitze in …“:** Bahnhof wählen (oder 📍 nächster Bahnhof per GPS), dann deinen Zug aus den Abfahrten der letzten Stunde antippen. Die App fragt die Fahrt live ab (Verspätung, entfallende Halte, vorzeitiges Ende) und zeigt **„Wo aussteigen?“**: je möglichem Ausstieg die beste Weiterfahrt mit Ankunft und Umstiegspuffer. Kommt der Zug erst noch, gibt es zusätzlich „Nicht einsteigen – stattdessen …“.
- **Neu prüfen / Auto alle 3 Min.:** aktualisiert mit frischen Verspätungen; ändert sich die Empfehlung, erscheint „🔀 Neue Empfehlung“. Nach dem empfohlenen Ausstieg stoppt das Auto-Update und fragt nach dem neuen Zug.
- **Ab Standort:** alternativ ab GPS-Position planen (im Zug oft ungenau).

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
- **Umstiegsregel:** Umstiege mit weniger als 3 Min. Puffer (Umstiegszeit minus Fußweg, laut Fahrplan) werden nie genutzt. Ausnahme: Bruchsal → Graben-Neudorf mit 2 Min. (`RULES.minBufferMinutes`, `minBufferAt` mit `towards`). Umsetzung:
  - `additionalTransferTime` lässt den Router nur Umstiege mit genug Luft planen. So findet er auch „gleicher Zug, nächster Bus“, statt nur die zu knappe Verbindung zu liefern.
  - An Via-Halten addiert MOTIS den Mindestaufenthalt dazu, deshalb gilt dort Reserve = Mindestpuffer − 1.
  - MOTIS rechnet die Reserve in die Fußwege ein; die App zieht sie für die Anzeige wieder ab.
  - Fällt trotzdem etwas wegen zu knapper Umstiege weg (Umstieg außerhalb der Via-Halte), folgt eine zweite Abfrage mit voller Reserve.
- **Verspätungen:** Bei „Jetzt“ und unterwegs fragt die App zusätzlich mit `realtimeMode=REALTIME_ANNOTATION_ONLY` ab (Routing nach Fahrplan, Echtzeit nur als Info). Eine Verspätung lässt eine Verbindung so nicht verschwinden, sondern markiert sie als „knapp“.
- **Unterwegs:** Auch der Umstieg am nächsten Halt der aktuellen Fahrt wird gegen den Mindestpuffer geprüft; sitzen bleiben ist immer erlaubt. Haltestellen werden über die Stationsnummer der DHID verglichen (`de:08215:32585`), damit z. B. „Graben-Neudorf Nord“ nicht als „Graben-Neudorf“ gilt.
- **Rufbus:** On-Demand-Fahrten (`ODM`/`FLEX`) werden als Fahrt angezeigt und markiert („evtl. vorher anmelden“).
- **Echtzeit:** Gibt es erst kurz vor der Fahrt. Abfragen für spätere Tage zeigen daher „keine Echtzeitdaten“.

## Nutzungsregeln Transitous

Abfragen laufen nur auf Knopfdruck oder im Unterwegs-Modus (Auto-Update alle 3 Minuten, nur bei sichtbarer Seite). Maximal 4 Requests laufen parallel.
