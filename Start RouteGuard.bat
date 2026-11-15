@echo off
setlocal

set "PORT="

for %%p in (3004 3002 3005 3006 3007 3008 3009 3010) do (
    curl.exe --fail --silent "http://localhost:%%p/api/health" 2>nul | findstr /c:"RouteGuard API" >nul
    if not errorlevel 1 (
        set "PORT=%%p"
        goto server_ready
    )
)

for %%p in (3004 3002 3005 3006 3007 3008 3009 3010) do (
    powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %%p -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }" >nul 2>&1
    if not errorlevel 1 (
        set "PORT=%%p"
        goto start_server
    )
)

echo No available RouteGuard port found between 3002 and 3010.
pause
exit /b 1

:start_server
set "HEALTH_URL=http://localhost:%PORT%/api/health"
start "RouteGuard server" /min cmd /k "cd /d ""%~dp0backend"" && set PORT=%PORT% && npm run server"

for /L %%i in (1,1,30) do (
    curl.exe --fail --silent "%HEALTH_URL%" 2>nul | findstr /c:"RouteGuard API" >nul
    if not errorlevel 1 goto server_ready
    ping -n 2 127.0.0.1 >nul
)

echo RouteGuard did not start on port %PORT%. Check the minimized server window for errors.
pause
exit /b 1

:server_ready
set "APP_URL=http://localhost:%PORT%/"
set "ADMIN_URL=http://localhost:%PORT%/admin"
echo RouteGuard is ready at %APP_URL%
start "" "%APP_URL%"
start "" "%ADMIN_URL%"
endlocal
