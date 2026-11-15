@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   whiteboard relay server
echo   ----------------------------------------
node "relay-server.js" --port 8787 --dir "%~dp0rooms"
echo.
echo   server stopped.
pause
