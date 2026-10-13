"""Download a GitHub-published agent bundle and replace the per-user runtime."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

import requests

REPOSITORY = 'SathishMalisetti/trackline'
LATEST_RELEASE_URL = f'https://api.github.com/repos/{REPOSITORY}/releases/latest'
ASSET_NAME = 'TracklineAgentModule.zip'
CHECK_INTERVAL = 6 * 60 * 60
MAX_ARCHIVE_SIZE = 120 * 1024 * 1024


def version_tuple(value):
    parts = re.fullmatch(r'v?(\d+(?:\.\d+){1,3})', str(value or '').strip(), re.I)
    if not parts:
        raise ValueError('Invalid update version')
    return tuple(int(part) for part in parts.group(1).split('.'))


def _app_data():
    base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA') or str(Path.home())
    return Path(base) / 'TracklineAgent'


def runtime_directory():
    return _app_data() / 'runtime' / 'TracklineAgent'


def _installed_version(runtime):
    try:
        value = json.loads((runtime / 'agent-version.json').read_text(encoding='utf-8'))
        return str(value['version'])
    except (OSError, ValueError, KeyError, TypeError):
        return '0.0'


def _checked_response(response):
    response.raise_for_status()
    return response


def _safe_extract(bundle, staging):
    total = 0
    with zipfile.ZipFile(bundle) as archive:
        for item in archive.infolist():
            name = Path(item.filename)
            if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != 'TracklineAgent':
                raise ValueError('Update archive contains an unsafe path')
            total += item.file_size
            if total > MAX_ARCHIVE_SIZE:
                raise ValueError('Update archive is too large')
        archive.extractall(staging)
    candidate = staging / 'TracklineAgent'
    if not (candidate / 'TracklineAgent.exe').is_file():
        raise ValueError('Update archive is missing TracklineAgent.exe')
    manifest = json.loads((candidate / 'agent-version.json').read_text(encoding='utf-8'))
    version_tuple(manifest.get('version'))
    return candidate, str(manifest['version'])


# Pin the existing Trackline Family Tools signing certificate. A GitHub
# checksum alone cannot distinguish our release from a compromised release.
PUBLISHER_THUMBPRINT = '297D507182D51329D8E40BEF20E709060D806D53'
SIGNATURE_ASSET_NAME = ASSET_NAME + '.p7s'

def _verify_bundle_signature(bundle, signature):
    paths = base64.b64encode(json.dumps([str(bundle), str(signature)]).encode()).decode()
    command = f"""$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$paths=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{paths}')))
$content=New-Object System.Security.Cryptography.Pkcs.ContentInfo -ArgumentList (,[IO.File]::ReadAllBytes($paths[0]))
$cms=New-Object System.Security.Cryptography.Pkcs.SignedCms -ArgumentList $content,$true
$cms.Decode([IO.File]::ReadAllBytes($paths[1]))
$cms.CheckSignature($true)
if ($cms.SignerInfos.Count -ne 1 -or $cms.SignerInfos[0].Certificate.Thumbprint -ne '{PUBLISHER_THUMBPRINT}') {{throw 'Unexpected update publisher'}}
"""
    encoded=base64.b64encode(command.encode('utf-16le')).decode()
    result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',encoded],
                          capture_output=True, timeout=60, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if result.returncode != 0:
        raise ValueError('Update package publisher signature did not verify')


def _schedule_swap(staging_agent, target, process_id):
    updates = _app_data() / 'updates'
    updates.mkdir(parents=True, exist_ok=True)
    script = updates / f'apply-{int(time.time())}.ps1'
    def quote(path):
        return "'" + str(path).replace("'", "''") + "'"
    backup = target.with_name(target.name + '.previous')
    script.write_text(f'''$ErrorActionPreference = 'Stop'
$pidToWait = {int(process_id)}
for ($i = 0; $i -lt 120 -and (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue); $i++) {{ Start-Sleep -Seconds 1 }}
if (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) {{ exit 2 }}
$stage = {quote(staging_agent)}
$target = {quote(target)}
$backup = {quote(backup)}
try {{
    if (Test-Path $backup) {{ Remove-Item $backup -Recurse -Force }}
    if (Test-Path $target) {{ Move-Item $target $backup }}
    Move-Item $stage $target
    if (Test-Path $backup) {{ Remove-Item $backup -Recurse -Force }}
}} catch {{
    if ((Test-Path $backup) -and -not (Test-Path $target)) {{ Move-Item $backup $target }}
    exit 3
}} finally {{ Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item $PSCommandPath -Force -ErrorAction SilentlyContinue }}
''', encoding='utf-8')
    creationflags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    subprocess.Popen(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(script)],
                     close_fds=True, creationflags=creationflags, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def check_for_update(logger=print, *, frozen=None, process_id=None, session=None, now=None):
    """Run after a sync. Checks at most daily; returns True if swap is queued."""
    frozen = getattr(sys, 'frozen', False) if frozen is None else frozen
    if not frozen:
        return False
    app = _app_data()
    runtime = runtime_directory()
    state_file = app / 'updates' / 'last-check.json'
    now = time.time() if now is None else now
    try:
        previous = json.loads(state_file.read_text(encoding='utf-8')).get('checked_at', 0)
        if now - float(previous) < CHECK_INTERVAL:
            return False
    except (OSError, ValueError, TypeError):
        pass
    http = session or requests
    try:
        release = _checked_response(http.get(LATEST_RELEASE_URL, timeout=15, headers={'Accept':'application/vnd.github+json','User-Agent':'Trackline-Agent-Updater'})).json()
        # Only throttle after GitHub answered successfully. A transient outage
        # should retry at the next scheduled sync instead of waiting six hours.
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps({'checked_at': now}), encoding='utf-8')
        asset = next((item for item in release.get('assets', []) if item.get('name') == ASSET_NAME), None)
        if not asset or not asset.get('browser_download_url'):
            return False
        signature_asset = next((item for item in release.get('assets',[]) if item.get('name') == SIGNATURE_ASSET_NAME), None)
        if not signature_asset or not signature_asset.get('browser_download_url'):
            logger('Trackline update skipped: publisher signature is missing.')
            return False
        expected = asset.get('digest') or ''
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', expected):
            logger('Trackline update skipped: release asset has no SHA-256 digest.')
            return False
        current_version = _installed_version(runtime)
        if not release.get('tag_name'):
            return False
        response = _checked_response(http.get(asset['browser_download_url'], timeout=60, stream=True, headers={'User-Agent':'Trackline-Agent-Updater'}))
        updates = app / 'updates'
        with tempfile.TemporaryDirectory(prefix='trackline-update-', dir=updates) as temp:
            temp_dir = Path(temp)
            archive_path = temp_dir / 'module.zip'
            hasher = hashlib.sha256()
            size = 0
            with archive_path.open('wb') as output:
                for chunk in response.iter_content(1024 * 256):
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > MAX_ARCHIVE_SIZE:
                        raise ValueError('Update download is too large')
                    hasher.update(chunk); output.write(chunk)
            if f"sha256:{hasher.hexdigest()}" != expected:
                raise ValueError('Update package SHA-256 did not match GitHub release metadata')
            signature_response = _checked_response(http.get(signature_asset['browser_download_url'], timeout=30, stream=True))
            signature_path = temp_dir / 'module.zip.p7s'
            signature_bytes = bytearray()
            for chunk in signature_response.iter_content(64 * 1024):
                signature_bytes.extend(chunk)
                if len(signature_bytes) > 1024 * 1024:
                    raise ValueError('Update signature is too large')
            signature_path.write_bytes(signature_bytes)
            _verify_bundle_signature(archive_path, signature_path)
            stage_root = temp_dir / 'staged'
            stage_root.mkdir()
            staged_agent, package_version = _safe_extract(archive_path, stage_root)
            if version_tuple(package_version) <= version_tuple(current_version):
                return False
            persistent_stage = updates / f'agent-{package_version}-{int(now)}'
            shutil.move(str(staged_agent), str(persistent_stage))
        _schedule_swap(persistent_stage, runtime, process_id or os.getpid())
        logger(f'Trackline agent update {package_version} is ready; it will finish after this sync exits.')
        return True
    except Exception as error:
        logger(f'Trackline automatic update check failed: {type(error).__name__}. It will retry later.')
        return False

