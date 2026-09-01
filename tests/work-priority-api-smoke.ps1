$ErrorActionPreference = "Stop"

$base = "http://localhost:3000"
$workspace = $null
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  try {
    $workspace = Invoke-RestMethod -Uri "$base/api/workspace" -TimeoutSec 3
    break
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
if (-not $workspace) { throw "Local server did not become ready." }

$today = (Get-Date).ToString("yyyy-MM-dd")

function Get-TaskDate($task) {
  foreach ($field in @("reminder_date", "next_action_date", "due_date")) {
    $value = [string]$task.$field
    if ($value) { return $value.Substring(0, [Math]::Min(10, $value.Length)) }
  }
  return ""
}

function Get-TodayIds($value) {
  @(
    $value.tasks |
      Where-Object {
        -not $_.deleted_at -and
        -not $_.archived_at -and
        @("pending", "in_progress", "snoozed") -contains [string]$_.status -and
        ((Get-TaskDate $_) -eq "" -or (Get-TaskDate $_) -le $today)
      } |
      Select-Object -ExpandProperty id
  )
}

$initialIds = Get-TodayIds $workspace
$manualOrderSaved = $true
$refreshDidNotReorder = $true

if ($initialIds.Count -gt 1) {
  $reversed = @($initialIds)
  [array]::Reverse($reversed)
  $reorderBody = @{
    kind = "tasks"
    section = "today"
    ids = $reversed
  } | ConvertTo-Json -Depth 5
  Invoke-RestMethod `
    -Method Post `
    -Uri "$base/api/work-priority" `
    -ContentType "application/json" `
    -Body $reorderBody | Out-Null

  $afterManual = Invoke-RestMethod -Uri "$base/api/workspace"
  $savedIds = Get-TodayIds $afterManual
  $manualOrderSaved = (($savedIds -join "|") -eq ($reversed -join "|"))

  $afterRefresh = Invoke-RestMethod -Uri "$base/api/workspace"
  $refreshedIds = Get-TodayIds $afterRefresh
  $refreshDidNotReorder = (($savedIds -join "|") -eq ($refreshedIds -join "|"))
}

$testTitle = "TEST PRIORITY urgent payment delay confirm today $([guid]::NewGuid().ToString('N'))"
$createBody = @{
  kind = "task"
  title = $testTitle
  priority = "urgent"
  reminderDate = $today
  notes = "unpaid balance and shipment delay"
} | ConvertTo-Json
$created = Invoke-RestMethod `
  -Method Post `
  -Uri "$base/api/workspace" `
  -ContentType "application/json" `
  -Body $createBody

$afterCreate = Invoke-RestMethod -Uri "$base/api/workspace"
$createdRow = $afterCreate.tasks | Where-Object id -eq $created.id | Select-Object -First 1

[ordered]@{
  manualOrderSaved = $manualOrderSaved
  refreshDidNotReorder = $refreshDidNotReorder
  creationTriggeredRanking = [bool]$created.prioritySorting
  newTaskPrioritySource = $createdRow.priority_source
  newTaskHasSortOrder = ([int]$createdRow.work_sort_order -gt 0)
  taskCountPreserved = ($afterCreate.tasks.Count -ge $workspace.tasks.Count)
} | ConvertTo-Json -Compress
