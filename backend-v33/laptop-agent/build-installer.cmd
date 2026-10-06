@echo off
py -3.12 "%~dp0build_installer.py" %*
set "TRACKLINE_BUILD_RESULT=%errorlevel%"
if not "%TRACKLINE_BUILD_RESULT%"=="0" echo Build failed. See the message above. Python 3.12 and Inno Setup 6 are required.
pause
exit /b %TRACKLINE_BUILD_RESULT%
