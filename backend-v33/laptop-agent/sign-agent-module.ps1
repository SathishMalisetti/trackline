param([Parameter(Mandatory=$true)][string]$Bundle)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$thumbprint='297D507182D51329D8E40BEF20E709060D806D53'
$cert=Get-Item "Cert:\CurrentUser\My\$thumbprint" -ErrorAction SilentlyContinue
if (!$cert) {$cert=Get-Item "Cert:\LocalMachine\My\$thumbprint" -ErrorAction SilentlyContinue}
if (!$cert -or !$cert.HasPrivateKey) {throw 'The Trackline signing certificate and private key are required.'}
$path=(Resolve-Path $Bundle).Path
$content=New-Object System.Security.Cryptography.Pkcs.ContentInfo -ArgumentList (,[IO.File]::ReadAllBytes($path))
$cms=New-Object System.Security.Cryptography.Pkcs.SignedCms -ArgumentList $content,$true
$signer=New-Object System.Security.Cryptography.Pkcs.CmsSigner -ArgumentList $cert
$signer.DigestAlgorithm=New-Object System.Security.Cryptography.Oid -ArgumentList '2.16.840.1.101.3.4.2.1'
$signer.IncludeOption=[System.Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
$cms.ComputeSignature($signer)
[IO.File]::WriteAllBytes("$path.p7s",$cms.Encode())
Write-Host "Upload both $path and $path.p7s to the same GitHub release."
