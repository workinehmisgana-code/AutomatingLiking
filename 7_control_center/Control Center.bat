@echo off
rem Starts the Control Center with no console window behind it.
rem pythonw is python without a terminal; the window is the app.
cd /d "%~dp0"
start "" pythonw app.py
