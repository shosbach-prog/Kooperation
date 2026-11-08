# Erweiterungen

Jede Datei `*.js` in diesem Ordner exportiert eine Funktion `(app, ctx) => {}` und wird beim Start
automatisch geladen (alphabetisch). `ctx` enthält Datenbank, Rechteprüfung (`auth`, `manager`),
Hilfsfunktionen und `ctx.hooks.notify(...)` für Benachrichtigungen.
