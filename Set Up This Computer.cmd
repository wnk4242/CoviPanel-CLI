@echo off
setlocal
title Set up CoviPanel on this computer
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.13 or newer, then run this file again.
  pause
  exit /b 1
)
pushd "%~dp0"
call npm.cmd --prefix Setups ci
if errorlevel 1 goto failed
call npm.cmd --prefix Setups exec -- playwright install chromium
if errorlevel 1 goto failed
call npm.cmd --prefix Setups run setup
if errorlevel 1 goto failed
echo Setup complete. Your saved projects and screening history are preserved.
echo Open Start CoviPanel.cmd and log in to Covidence if requested.
popd
pause
exit /b 0
:failed
echo Setup failed. See the error above; saved project records were not replaced.
popd
pause
exit /b 1
