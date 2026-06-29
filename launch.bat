@echo off
cd /d "%~dp0"

REM ── Kill any process already listening on port 3000 ─────────────────────
REM Without this, a previous "npm start" left running in the background
REM (e.g. you closed the Chrome window but not its terminal) keeps serving
REM old code and old sessions, even after this script starts a "new" server.
for /f "tokens=5" %%P in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%P >nul 2>&1
)

start cmd /k "npm start"
timeout /t 2 >nul

REM ── Open in incognito so no stale session_token cookie is ever carried in ─
REM Even if someone logged in yesterday and never clicked Logout, incognito
REM starts with a clean cookie jar. Combined with the server-side session wipe
REM on startup (in server.js), this guarantees a fresh login is always required.
start chrome --incognito --app=http://localhost:3000/login.html