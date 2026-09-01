$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:3000"
$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  Start-Sleep -Milliseconds 500
  try {
    $initial = Invoke-RestMethod "$baseUrl/api/workspace" -TimeoutSec 5
    $ready = $true
    break
  } catch {
    # The local worker can take a few seconds to initialize D1.
  }
}

if (-not $ready) {
  throw "Local Joyce Workspace server did not become ready."
}

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$headers = @{ "content-type" = "application/json" }
$created = Invoke-RestMethod "$baseUrl/api/workspace" -Method Post -Headers $headers -Body (@{
  kind = "task"
  title = "Task lifecycle test $stamp"
  priority = "medium"
  nextAction = "Verify four task outcomes"
} | ConvertTo-Json)
$taskId = $created.id

$missingDateRejected = $false
try {
  Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
    action = "status"
    id = $taskId
    status = "snoozed"
  } | ConvertTo-Json) | Out-Null
} catch {
  $missingDateRejected = $true
}
if (-not $missingDateRejected) {
  throw "Snooze without a Reminder Date was accepted."
}

Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "status"
  id = $taskId
  status = "snoozed"
  reminderDate = "2026-08-09"
} | ConvertTo-Json) | Out-Null

$afterSnooze = Invoke-RestMethod "$baseUrl/api/workspace"
$snoozed = $afterSnooze.tasks | Where-Object id -eq $taskId
if ($snoozed.status -ne "snoozed" -or $snoozed.reminder_date -ne "2026-08-09") {
  throw "Snooze reminder date was not persisted."
}

Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "status"
  id = $taskId
  status = "completed"
} | ConvertTo-Json) | Out-Null

Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "archive"
  id = $taskId
} | ConvertTo-Json) | Out-Null

$deleted = Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "delete"
  id = $taskId
} | ConvertTo-Json)

$inTrashData = Invoke-RestMethod "$baseUrl/api/workspace"
$inTrash = $inTrashData.tasks | Where-Object id -eq $taskId
if (-not $inTrash.deleted_at -or -not $inTrash.purge_after) {
  throw "Deleted task did not enter the recoverable Trash."
}

Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "restore_trash"
  id = $taskId
} | ConvertTo-Json) | Out-Null

$restoredData = Invoke-RestMethod "$baseUrl/api/workspace"
$restored = $restoredData.tasks | Where-Object id -eq $taskId
if ($restored.deleted_at -or -not $restored.archived_at -or -not $restored.completed_at) {
  throw "Trash restore did not preserve completed/archive history."
}

Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "delete"
  id = $taskId
} | ConvertTo-Json) | Out-Null

[pscustomobject]@{
  missingDateRejected = $missingDateRejected
  snoozedDate = $snoozed.next_action_date
  completedHistoryPreserved = [bool]$restored.completed_at
  archiveHistoryPreserved = [bool]$restored.archived_at
  recoverableUntil = $deleted.purgeAfter
  cleanupBackupTasks = $restoredData.integrity.task_cleanup_backup_tasks
  cleanupCurrentTasks = $restoredData.integrity.task_cleanup_current_tasks
  trashCount = $restoredData.integrity.task_trash_count
} | ConvertTo-Json -Compress
