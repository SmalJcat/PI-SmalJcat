$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tauri-task-wait.ps1')

function New-Snapshot([int]$State, [bool]$Started = $false, $ExitCode = $null, [long]$Result = 0) {
  [pscustomobject]@{ State = $State; Started = $Started; ExitCode = $ExitCode; Result = $Result }
}
function Test-WaitCase([string]$Name, [object[]]$Snapshots, [string]$ExpectedError = '', [int]$ExpectedPolls = -1) {
  $script:waitTest = @{ Tick = 0; Polls = 0; Snapshots = $Snapshots }
  $failure = $null
  try {
    Wait-PiScheduledTest -ReadSnapshot {
      $script:waitTest.Polls++
      $index = [Math]::Min($script:waitTest.Tick, $script:waitTest.Snapshots.Count - 1)
      $script:waitTest.Snapshots[$index]
    } -Now { [datetime]'2026-01-01T00:00:00Z' + [timespan]::FromSeconds($script:waitTest.Tick) } `
      -Sleep { $script:waitTest.Tick++ } -TimeoutSeconds 6 -StartupTimeoutSeconds 3 -ReceiptGraceSeconds 2
  } catch { $failure = $_.Exception.Message }
  if ($ExpectedError) {
    if ($null -eq $failure -or $failure -notmatch $ExpectedError) {
      throw "$Name expected '$ExpectedError', got '$failure'."
    }
  } elseif ($null -ne $failure) { throw "$Name failed: $failure" }
  if ($ExpectedPolls -ge 0 -and $script:waitTest.Polls -ne $ExpectedPolls) {
    throw "$Name returned after $($script:waitTest.Polls) polls instead of $ExpectedPolls."
  }
  Write-Output "PASS $Name"
}

Test-WaitCase 'Ready before start and queued are not completion' @(
  (New-Snapshot 3), (New-Snapshot 2), (New-Snapshot 4 $true), (New-Snapshot 3 $true 0)
) '' 4
Test-WaitCase 'Fast completion before the first poll' @((New-Snapshot 3 $true 0)) '' 1
Test-WaitCase 'Receipt while action still running must wait' @(
  (New-Snapshot 4 $true 0), (New-Snapshot 3 $true 0)
) '' 2
Test-WaitCase 'Nonzero child exit is failure' @((New-Snapshot 3 $true 1)) 'child exit 1'
Test-WaitCase 'Nonzero scheduler result is failure' @((New-Snapshot 3 $true 0 1)) 'Task Scheduler result 1'
Test-WaitCase 'Ready with stale zero result never falsely passes' @((New-Snapshot 3)) 'did not start'
Test-WaitCase 'Queue without startup times out' @((New-Snapshot 2)) 'did not start'
Test-WaitCase 'Running action has a bounded timeout' @((New-Snapshot 4 $true)) 'timed out'
Test-WaitCase 'Stopped action without receipt fails' @(
  (New-Snapshot 4 $true), (New-Snapshot 3 $true)
) 'without a valid completion receipt'
Write-Output '9 scheduler polling lifecycle checks passed.'
