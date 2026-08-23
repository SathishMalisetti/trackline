
pip install pyinstaller requests tzlocal

pyinstaller --onedir --windowed --name TracklineSetup trackline_setup_gui.py
pyinstaller --onedir --windowed --name TracklineAgent trackline_agent.py
pyinstaller --onedir --windowed --icon=trackline_icon.ico --name TracklineConfigManager trackline_config_manager.py


signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a "TracklineAgentSetup.exe"

