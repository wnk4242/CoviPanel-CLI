@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.13 or newer, then follow README.md.
  pause
  exit /b 1
)
node.exe "%~dp0Code\Application\launcher.js"
set "COVIPANEL_EXIT=%ERRORLEVEL%"
if "%COVIPANEL_EXIT%"=="0" exit /b 0
echo CoviPanel stopped. See the error above and README.md.
pause
exit /b %COVIPANEL_EXIT%
