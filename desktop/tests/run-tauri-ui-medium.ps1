param(
  [ValidateSet('ui','real','release')][string]$Mode = 'ui',
  [switch]$Child,
  [string]$LogPath
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ($Child) {
  $exitCode = 1
  try {
    Set-Content -LiteralPath $LogPath -Value ('CHILD START ' + (Get-Date).ToString('o')) -Encoding UTF8
    Add-Content -LiteralPath $LogPath -Value (whoami /groups | Out-String)
    Set-Location -LiteralPath $root
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $nodeArgs = @('tests/tauri-smoke.mjs')
    if ($Mode -eq 'real') { $nodeArgs += '--real' }
    if ($Mode -eq 'release') { $nodeArgs += '--release' }
    $stdout = $LogPath + '.out'
    $stderr = $LogPath + '.err'
    $process = Start-Process -FilePath $node -ArgumentList $nodeArgs -WorkingDirectory $root -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Add-Content -LiteralPath $LogPath -Value ('NODE EXIT ' + $process.ExitCode)
    if (Test-Path $stdout) { Get-Content $stdout | Add-Content -LiteralPath $LogPath }
    if (Test-Path $stderr) { Get-Content $stderr | Add-Content -LiteralPath $LogPath }
    $exitCode = $process.ExitCode
  } catch {
    Add-Content -LiteralPath $LogPath -Value ($_ | Out-String)
  } finally {
    # Atomic receipt distinguishes a completed run from Ready-before-start or
    # stale LastTaskResult=0. The log name is unique to this invocation.
    $receipt = $LogPath + '.exit.json'
    @{ exitCode = $exitCode } | ConvertTo-Json -Compress | Set-Content -LiteralPath ($receipt + '.tmp') -Encoding UTF8
    Move-Item -LiteralPath ($receipt + '.tmp') -Destination $receipt -Force
  }
  exit $exitCode
}
. (Join-Path $PSScriptRoot 'tauri-task-wait.ps1')
$taskName = 'PiDesktop-WebView2-' + [guid]::NewGuid().ToString('N')
$log = Join-Path $env:TEMP ($taskName + '.log')
$scriptPath = $PSCommandPath
$testShell = (Get-Command pwsh.exe -ErrorAction Stop).Source
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder([string][char]92)
$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = 'Temporary medium-integrity Pi Desktop WebView2 UI automation'
$definition.Principal.UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$definition.Settings.ExecutionTimeLimit = 'PT8M'
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$action = $definition.Actions.Create(0)
$action.Path = $testShell
$action.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '" -Child -Mode ' + $Mode + ' -LogPath "' + $log + '"'
$registered = $false
$completed = $false
try {
  $folder.RegisterTaskDefinition($taskName, $definition, 6, $null, $null, 3, $null) | Out-Null
  $registered = $true
  $folder.GetTask($taskName).Run($null) | Out-Null
  Wait-PiScheduledTest -ReadSnapshot {
    # COM running-task objects cache State unless Refresh is called. Fetch the
    # registered task anew, including queued/startup states, on every poll.
    $task = $folder.GetTask($taskName)
    $receiptPath = $log + '.exit.json'
    $childExit = $null
    if (Test-Path -LiteralPath $receiptPath) {
      $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
      if ($null -eq $receipt.exitCode -or ($receipt.exitCode -isnot [int] -and $receipt.exitCode -isnot [long])) {
        throw "Invalid UI completion receipt: $receiptPath"
      }
      $childExit = $receipt.exitCode
    }
    [pscustomobject]@{
      State = [int]$task.State
      Result = $task.LastTaskResult
      Started = Test-Path -LiteralPath $log
      ExitCode = $childExit
    }
  }
  $completed = $true
} finally {
  $cleanupError = $null
  if ($registered) {
    if (-not $completed) {
      try {
        # Stop only this unique temporary task. Deleting a running task alone
        # does not reliably stop its action.
        $folder.GetTask($taskName).Stop(0)
      } catch { Write-Warning "Could not stop temporary task $taskName : $_" }
    }
    try { $folder.DeleteTask($taskName, 0) } catch {
      $cleanupError = $_
      Write-Warning "Could not delete temporary task $taskName : $_"
    }
  }
  if (Test-Path -LiteralPath $log) {
    try { Get-Content -LiteralPath $log | Write-Output } catch { Write-Warning "Could not read UI log $log : $_" }
  }
  if (-not $completed) { Write-Warning "UI test diagnostics retained at $log" }
  if ($completed -and $null -ne $cleanupError) { throw $cleanupError }
}
# Retain all diagnostics on failure, remove the complete set only on success.
foreach ($file in @($log, ($log + '.out'), ($log + '.err'), ($log + '.exit.json'), ($log + '.exit.json.tmp'))) {
  if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
}
