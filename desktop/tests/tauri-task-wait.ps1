function Wait-PiScheduledTest {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$ReadSnapshot,
    [scriptblock]$Now = { Get-Date },
    [scriptblock]$Sleep = { Start-Sleep -Milliseconds 300 },
    [int]$TimeoutSeconds = 420,
    [int]$StartupTimeoutSeconds = 45,
    [int]$ReceiptGraceSeconds = 10
  )
  $startedAt = & $Now
  $seenStarted = $false
  $inactiveSince = $null
  while ($true) {
    # ReadSnapshot must fetch a fresh IRegisteredTask, not cached IRunningTask.State.
    $snapshot = & $ReadSnapshot
    $nowValue = & $Now
    $elapsed = ($nowValue - $startedAt).TotalSeconds
    $active = $snapshot.State -eq 2 -or $snapshot.State -eq 4
    $seenStarted = $seenStarted -or $snapshot.Started -or $snapshot.State -eq 4
    if ($snapshot.State -eq 3 -and $null -ne $snapshot.ExitCode) {
      if ($snapshot.ExitCode -ne 0 -or $snapshot.Result -ne 0) {
        throw "Medium-integrity UI test failed (child exit $($snapshot.ExitCode), Task Scheduler result $($snapshot.Result))."
      }
      return
    }
    if ($elapsed -ge $TimeoutSeconds) {
      throw "Medium-integrity UI test timed out (state $($snapshot.State), result $($snapshot.Result))."
    }
    if (-not $seenStarted -and $elapsed -ge $StartupTimeoutSeconds) {
      throw "Medium-integrity UI test did not start (state $($snapshot.State), result $($snapshot.Result))."
    }
    if ($seenStarted -and -not $active) {
      if ($null -eq $inactiveSince) { $inactiveSince = $nowValue }
      if (($nowValue - $inactiveSince).TotalSeconds -ge $ReceiptGraceSeconds) {
        throw "Medium-integrity UI test stopped without a valid completion receipt (state $($snapshot.State), result $($snapshot.Result))."
      }
    } else {
      $inactiveSince = $null
    }
    & $Sleep
  }
}
