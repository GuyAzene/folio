# Opens the packaged Folio built for others on an empty home and asks it to close, as closing its
# window would, which it must then do on its own. That build has the inspector off, so the
# real-window checks cannot drive it.
$ErrorActionPreference = "Stop"
$folioHome = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP ([guid]::NewGuid()))
$connection = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP ([guid]::NewGuid()))
$env:FOLIO_HOME = $folioHome.FullName
$env:FOLIO_CONNECTION_HOME = $connection.FullName
$folio = Start-Process -FilePath "release\win-unpacked\Folio.exe" -PassThru
Start-Sleep -Seconds 10
if ($folio.HasExited) { throw "Folio quit before it was asked to, with code $($folio.ExitCode)" }
# Without /F, taskkill asks the window to close instead of ending the process.
taskkill /PID $folio.Id | Out-Null
if (-not $folio.WaitForExit(30000)) { throw "Folio did not quit within 30 seconds" }
