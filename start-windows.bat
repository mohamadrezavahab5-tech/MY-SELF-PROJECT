@echo off
rem Runs the site on this Windows PC: double-click this file.
rem Demo login: 09120000000 / demo1234 (also the site owner).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from nodejs.org, then run this file again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing, please wait...
  call npm install
)
set ADMIN_PHONES=09120000000
call npm run seed
echo.
echo Opening http://localhost:3000 ... keep this window open while you use the site.
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
call npm start
pause
