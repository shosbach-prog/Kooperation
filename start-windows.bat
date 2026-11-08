@echo off
chcp 65001 >nul
title Personaleinsatzplanung (Test)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js ist nicht installiert.
  echo Bitte die Version "LTS" von https://nodejs.org/de herunterladen und installieren,
  echo danach diese Datei erneut doppelklicken.
  start "" https://nodejs.org/de
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo.
  echo Die installierte Node.js-Version ist zu alt. Benoetigt wird mindestens 22.13.
  echo Bitte die aktuelle LTS-Version von https://nodejs.org/de installieren.
  start "" https://nodejs.org/de
  pause
  exit /b 1
)
if not exist node_modules (
  echo Erster Start: benoetigte Pakete werden geladen ...
  call npm install --omit=dev
)
echo.
echo Der Dienstplan startet. Der Browser oeffnet sich gleich mit http://localhost:3000
echo Zum Beenden dieses Fenster schliessen.
echo.
start "" http://localhost:3000
node server.js
pause
