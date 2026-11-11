# Run from a separate source directory or Git worktree, never over the user's working tree.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
New-Item -ItemType Directory -Force artifacts | Out-Null
$log = Join-Path (Get-Location) ('artifacts/scout-acceptance-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
Start-Transcript -Path $log
try {
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
  foreach ($script in @('build', 'test', 'test:rust')) {
    & npm.cmd run $script
    if ($LASTEXITCODE -ne 0) { throw "$script failed" }
  }
  & node scripts/native.mjs cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
  if ($LASTEXITCODE -ne 0) { throw 'Rust format check failed' }
  & node scripts/native.mjs cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features test-fixture -- -D warnings
  if ($LASTEXITCODE -ne 0) { throw 'Clippy failed' }
  & npm.cmd run test:ui
  if ($LASTEXITCODE -ne 0) { throw 'Native WebView2 acceptance failed' }
  Write-Host 'Acceptance passed. Review artifacts/ screenshots before release.'
} finally {
  Stop-Transcript
}
