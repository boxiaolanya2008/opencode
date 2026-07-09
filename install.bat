@echo off
setlocal EnableDelayedExpansion

echo ============================================
echo   opencode Global Installer
echo ============================================
echo.

where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] bun is not installed or not in PATH.
    echo         Install bun: https://bun.sh
    exit /b 1
)

set "INSTALL_DIR=%USERPROFILE%\.opencode\bin"
set "REPO_DIR=%~dp0"
set "BIN_NAME=opencode.exe"

echo [1/4] Building opencode (single binary)...
cd /d "%REPO_DIR%\packages\opencode"
set "OPENCODE_VERSION=2.0.0"
call bun run build --single
if %errorlevel% neq 0 (
    echo [ERROR] Build failed.
    exit /b 1
)

set "BIN_SRC=%REPO_DIR%\packages\opencode\dist\opencode-windows-x64\bin\%BIN_NAME%"
if not exist "%BIN_SRC%" (
    echo [ERROR] Built binary not found at: %BIN_SRC%
    exit /b 1
)

echo [2/4] Installing to %INSTALL_DIR%...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "%BIN_SRC%" "%INSTALL_DIR%\%BIN_NAME%" >nul
if %errorlevel% neq 0 (
    echo [ERROR] Failed to copy binary.
    exit /b 1
)

echo [3/4] Adding to PATH...
echo %PATH% | findstr /I /C:"%INSTALL_DIR%" >nul 2>&1
if %errorlevel% neq 0 (
    powershell -Command "$p=[Environment]::GetEnvironmentVariable('PATH','User'); if($p -notlike '*\.opencode\bin*'){[Environment]::SetEnvironmentVariable('PATH','$p;%INSTALL_DIR%','User'); echo Added to user PATH} else {echo Already in PATH}"
) else (
    echo        Already in PATH.
)

echo [4/4] Creating cmd wrapper...
(
    echo @echo off
    echo "%INSTALL_DIR%\%BIN_NAME%" %%*
) > "%INSTALL_DIR%\opencode.cmd"

echo.
echo ============================================
echo   Done! Restart your terminal, then run:
echo     opencode --version
echo ============================================
echo.
echo Install dir: %INSTALL_DIR%
echo.

endlocal
