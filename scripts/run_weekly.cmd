@echo off
rem Weekly price update, run by Windows Task Scheduler ("Calgary grocery tracker - weekly prices").
rem Collects prices, exports web/data/site-data.json, commits and pushes it (GitHub Pages rebuilds).
rem Output goes to logs\weekly-YYYY-MM-DD.log. Double-click to run it by hand.

setlocal
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%d
set LOG=logs\weekly-%TODAY%.log
set PYTHONIOENCODING=utf-8

echo ===== %DATE% %TIME% start ===== >> "%LOG%"
"C:\Users\john2\anaconda3\python.exe" scripts\run_weekly.py >> "%LOG%" 2>&1
set RESULT=%ERRORLEVEL%
echo ===== %DATE% %TIME% end (exit %RESULT%) ===== >> "%LOG%"
exit /b %RESULT%
