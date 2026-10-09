"""Build the Windows installer locally; never installs or runs Trackline."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / 'local-build'


def run(*args):
    subprocess.run([str(arg) for arg in args], cwd=ROOT, check=True)


def find_compiler(explicit):
    if explicit:
        candidate = Path(explicit)
        if candidate.is_file():
            return candidate.resolve()
        raise RuntimeError('The supplied Inno Setup compiler path does not exist.')
    candidates = []
    found = shutil.which('ISCC.exe')
    if found:
        candidates.append(Path(found))
    for variable in ('ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'):
        base = os.environ.get(variable)
        if base:
            candidates.extend([Path(base) / 'Inno Setup 6' / 'ISCC.exe',
                               Path(base) / 'Programs' / 'Inno Setup 6' / 'ISCC.exe'])
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError('Install Inno Setup 6 from https://jrsoftware.org/isdl.php, then run this build again.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inno-compiler', help='Optional full path to ISCC.exe')
    args = parser.parse_args()
    if sys.platform != 'win32':
        raise RuntimeError('This build must run on Windows.')
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError('Use Python 3.12: py -3.12 build_installer.py')
    compiler = find_compiler(args.inno_compiler)
    for name in ('trackline_agent.py', 'activitywatch_recovery.py', 'upload_schedule.py', 'account_auth.py',
                 'trackline_setup_gui.py', 'trackline_config_manager.py',
                 'trackline_icon.ico', 'TracklineAgentSetup.iss'):
        if not (ROOT / name).is_file():
            raise RuntimeError(f'Missing {name}. Extract the complete repository ZIP before building.')
    BUILD.mkdir(exist_ok=True)
    venv = BUILD / 'venv'
    if not (venv / 'Scripts' / 'python.exe').is_file():
        run(sys.executable, '-m', 'venv', venv)
    python = venv / 'Scripts' / 'python.exe'
    run(python, '-m', 'pip', 'install', 'pyinstaller==6.16.0', 'requests==2.32.5',
        'tzlocal==5.3.1', 'tzdata==2025.2')
    run(python, '-m', 'unittest', 'discover', '-s', 'tests', '-v')
    package = BUILD / 'package'
    # Only clear this script's generated package; retain existing pairing and builds.
    if package.exists():
        shutil.rmtree(package)
    specs = BUILD / 'specs'
    specs.mkdir(exist_ok=True)
    for name, source in [('TracklineAgent', 'trackline_agent.py'),
                         ('TracklineSetup', 'trackline_setup_gui.py'),
                         ('TracklineConfigManager', 'trackline_config_manager.py')]:
        run(python, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--windowed',
            '--distpath', package, '--workpath', BUILD / 'pyinstaller', '--specpath', specs,
            '--icon', ROOT / 'trackline_icon.ico', '--name', name, ROOT / source)
    for name in ('TracklineAgentSetup.iss', 'trackline_icon.ico'):
        shutil.copy2(ROOT / name, package / name)
    run(compiler, package / 'TracklineAgentSetup.iss')
    installer = package / 'installer_output' / 'TracklineAgentSetup.exe'
    if not installer.is_file():
        raise RuntimeError('Compiler completed without producing the expected installer.')
    digest = hashlib.sha256(installer.read_bytes()).hexdigest()
    (installer.parent / 'SHA256.txt').write_text(f'{digest}  {installer.name}\n', encoding='utf-8')
    print(f'\nBUILD COMPLETE\nInstaller: {installer}\nSHA256: {digest}')
    print('The installer has not been installed or executed. It remains unsigned.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        print(f'\nBUILD FAILED: {exc}', file=sys.stderr)
        sys.exit(1)
