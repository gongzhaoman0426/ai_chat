# Temporary repair for the Windows upgrade-state path bug in JuDesk 0.1.7-0.1.9.
# Changes only the backup metadata path, after validating the existing archive.
# Does not open, modify, move, or delete any live SQLite database/WAL/SHM file.
param(
  [string]$DataDirectory = (Join-Path $env:APPDATA 'judesk\judesk-data')
)

$ErrorActionPreference = 'Stop'
if (Get-Process -Name 'judesk' -ErrorAction SilentlyContinue) {
  throw 'Exit JuDesk from its system tray menu, then run this script again.'
}

$statePath = Join-Path $DataDirectory 'backups\upgrade-state.json'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
  throw 'Upgrade state was not found. No files were changed.'
}
$stateText = [System.IO.File]::ReadAllText($statePath)
$state = $stateText | ConvertFrom-Json
$relativePath = ([string]$state.file).Replace('\', '/')
if ($relativePath -notmatch '^backups/upgrades/upgrade-[0-9]+-[0-9a-f-]+\.zip$') {
  throw 'Unexpected backup path. No files were changed.'
}
$archivePath = Join-Path $DataDirectory $relativePath
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
  throw 'The recorded backup archive is missing. No files were changed.'
}
if ([string]$state.archiveHash -notmatch '^[0-9a-f]{64}$' -or
    (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $state.archiveHash) {
  throw 'The backup archive checksum does not match. No files were changed.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($entryName in @('backup.json', 'db/judesk.db', 'db/mastra.db')) {
    if ($null -eq $archive.GetEntry($entryName)) {
      throw "The backup archive is incomplete ($entryName). No files were changed."
    }
  }
  $reader = [System.IO.StreamReader]::new($archive.GetEntry('backup.json').Open())
  try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json }
  finally { $reader.Dispose() }
  if ($manifest.kind -ne 'upgrade' -or
      -not $state.appVersion -or $manifest.appVersion -ne $state.appVersion -or
      -not $state.migrationFingerprint -or
      $manifest.source.migrationFingerprint -ne $state.migrationFingerprint) {
    throw 'The backup does not match the upgrade state. No files were changed.'
  }
} finally {
  $archive.Dispose()
}

if ([string]$state.file -eq $relativePath) {
  Write-Host 'The backup path is already correct. No files were changed.'
  Write-Host 'If startup still fails, this particular workaround does not apply.'
  exit 0
}

$backupPath = "$statePath.before-path-repair-$([Guid]::NewGuid().ToString('N')).bak"
$temporaryPath = "$statePath.$([Guid]::NewGuid().ToString('N')).tmp"
try {
  if ((Get-Process -Name 'judesk' -ErrorAction SilentlyContinue) -or
      [System.IO.File]::ReadAllText($statePath) -cne $stateText) {
    throw 'JuDesk started or the upgrade state changed. No files were changed.'
  }
  $state.file = $relativePath
  # Windows PowerShell's Set-Content -Encoding UTF8 adds a BOM that JSON.parse rejects.
  [System.IO.File]::WriteAllText(
    $temporaryPath,
    ($state | ConvertTo-Json -Depth 20),
    [System.Text.UTF8Encoding]::new($false)
  )
  # Replace atomically and preserve the exact original metadata for rollback.
  [System.IO.File]::Replace($temporaryPath, $statePath, $backupPath)
} finally {
  if (Test-Path -LiteralPath $temporaryPath) {
    Remove-Item -LiteralPath $temporaryPath
  }
}
Write-Host 'Repaired the upgrade-state path. You can now start JuDesk again.'
Write-Host "Original metadata backup: $backupPath"
