import os
import base64
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import agent_updates

class Response:
    def raise_for_status(self): pass
    def json(self):
        return {'tag_name':'v9.0','assets':[{'name':agent_updates.ASSET_NAME,
          'browser_download_url':'https://github.com/example/module.zip','digest':'sha256:'+'a'*64}]}

class UpdateSecurityTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'win32', 'requires Windows CMS implementation')
    def test_real_detached_signature_rejects_tampering(self):
        with tempfile.TemporaryDirectory() as temp:
            bundle=Path(temp)/'bundle.zip';signature=Path(temp)/'bundle.zip.p7s'
            bundle.write_bytes(b'whole bundle including runtime dependencies')
            paths=base64.b64encode(json.dumps([str(bundle),str(signature)]).encode()).decode()
            command=f"""$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$paths=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{paths}')))
$cert=New-SelfSignedCertificate -Subject 'CN=Trackline Test Only' -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyUsage DigitalSignature
try {{
$content=New-Object System.Security.Cryptography.Pkcs.ContentInfo -ArgumentList (,[IO.File]::ReadAllBytes($paths[0]))
$cms=New-Object System.Security.Cryptography.Pkcs.SignedCms -ArgumentList $content,$true
$signer=New-Object System.Security.Cryptography.Pkcs.CmsSigner -ArgumentList $cert
$cms.ComputeSignature($signer)
[IO.File]::WriteAllBytes($paths[1],$cms.Encode())
Write-Output $cert.Thumbprint
}} finally {{ Remove-Item ('Cert:\\CurrentUser\\My\\'+$cert.Thumbprint) }}
"""
            encoded=base64.b64encode(command.encode('utf-16le')).decode()
            result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',encoded],capture_output=True,text=True,check=True)
            with patch.object(agent_updates,'PUBLISHER_THUMBPRINT',result.stdout.strip()):
                agent_updates._verify_bundle_signature(bundle,signature)
                bundle.write_bytes(b'tampered runtime')
                with self.assertRaises(ValueError):
                    agent_updates._verify_bundle_signature(bundle,signature)
    def test_unsigned_release_never_downloads_or_swaps(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ,{'LOCALAPPDATA':temp}), \
             patch.object(agent_updates.requests,'get',return_value=Response()) as get, \
             patch.object(agent_updates,'_schedule_swap') as swap:
            self.assertFalse(agent_updates.check_for_update(frozen=True,now=100))
            self.assertEqual(get.call_count,1)
            swap.assert_not_called()

    def test_failed_signature_check_rejects_bundle(self):
        with patch.object(agent_updates.subprocess,'run') as run:
            run.return_value.returncode=1
            with self.assertRaisesRegex(ValueError,'publisher signature'):
                agent_updates._verify_bundle_signature(Path('module.zip'),Path('module.zip.p7s'))
            self.assertIn('-EncodedCommand',run.call_args.args[0])

    def test_valid_signature_check_returns(self):
        with patch.object(agent_updates.subprocess,'run') as run:
            run.return_value.returncode=0
            agent_updates._verify_bundle_signature(Path('module.zip'),Path('module.zip.p7s'))
