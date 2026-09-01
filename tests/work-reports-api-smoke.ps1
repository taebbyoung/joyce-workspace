$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:3000"
$headers = @{ "content-type" = "application/json" }
$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-RestMethod "$baseUrl/api/workspace" -TimeoutSec 5 | Out-Null
    $ready = $true
    break
  } catch {
    # Local D1 initialization can take a few seconds.
  }
}
if (-not $ready) { throw "Local server did not become ready." }

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$code = "GT$stamp"
$startDate = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")
$endDate = (Get-Date).AddDays(1).ToString("yyyy-MM-dd")

$customer = Invoke-RestMethod "$baseUrl/api/workspace" -Method Post -Headers $headers -Body (@{
  kind = "customer"
  company = "Grounded Report Test $stamp"
  lifecycle = "existing"
  customerCode = $code
  country = "Test"
  source = "report_smoke"
} | ConvertTo-Json)

$taskIds = @()
for ($index = 1; $index -le 5; $index += 1) {
  $created = Invoke-RestMethod "$baseUrl/api/workspace" -Method Post -Headers $headers -Body (@{
    kind = "task"
    title = "Controller issue action $index"
    customerCode = $code
    notes = "Evidence item $index"
  } | ConvertTo-Json)
  $taskIds += $created.id
}

$deletedTask = Invoke-RestMethod "$baseUrl/api/workspace" -Method Post -Headers $headers -Body (@{
  kind = "task"
  title = "Controller duplicate test task"
  customerCode = $code
} | ConvertTo-Json)
Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "delete"
  id = $deletedTask.id
} | ConvertTo-Json) | Out-Null

$snoozedTask = Invoke-RestMethod "$baseUrl/api/workspace" -Method Post -Headers $headers -Body (@{
  kind = "task"
  title = "September customer follow up"
  customerCode = $code
} | ConvertTo-Json)
Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "status"
  id = $snoozedTask.id
  status = "snoozed"
  reminderDate = "2026-09-01"
} | ConvertTo-Json) | Out-Null

$internalTask = Invoke-RestMethod "$baseUrl/api/workspace" -Method Post -Headers $headers -Body (@{
  kind = "task"
  title = "Website internal test activity"
} | ConvertTo-Json)

$salesReport = Invoke-RestMethod "$baseUrl/api/reports" -Method Post -Headers $headers -Body (@{
  action = "generate"
  reportType = "custom"
  startDate = $startDate
  endDate = $endDate
  scopes = @("customer_followup")
} | ConvertTo-Json)

$controllerRows = @($salesReport.draft.items | Where-Object {
  $_.target -eq $code -and $_.content -match "Controller|controller"
})
if ($controllerRows.Count -ne 1) {
  throw "Five same-topic customer actions were not merged into one row: $($salesReport.draft.items | ConvertTo-Json -Compress)"
}
if ($salesReport.draft.items.content -match "duplicate test") {
  throw "Deleted task polluted report generation."
}
if ($salesReport.draft.items.content -match "Website internal") {
  throw "Excluded internal work polluted report generation."
}

$followRow = $salesReport.draft.items | Where-Object {
  $_.target -eq $code -and $_.content -match "September"
}
if (-not $followRow -or $followRow.remark -notmatch "2026-09-01") {
  throw "Snoozed task was not represented as future follow-up."
}

$saved = Invoke-RestMethod "$baseUrl/api/reports" -Method Post -Headers $headers -Body (@{
  action = "save"
  reportType = $salesReport.draft.reportType
  title = $salesReport.draft.title
  startDate = $salesReport.draft.startDate
  endDate = $salesReport.draft.endDate
  scopes = $salesReport.draft.scopes
  items = $salesReport.draft.items
  sourceSummary = $salesReport.draft.sourceSummary
  sourceDetails = $salesReport.draft.sourceDetails
} | ConvertTo-Json -Depth 20)

$snapshotBefore = (Invoke-RestMethod "$baseUrl/api/reports").reports |
  Where-Object id -eq $saved.id

Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "update"
  id = $taskIds[0]
  title = "Changed after report confirmation"
  priority = "medium"
  recurrenceRule = "none"
} | ConvertTo-Json) | Out-Null

$snapshotAfter = (Invoke-RestMethod "$baseUrl/api/reports").reports |
  Where-Object id -eq $saved.id
if ($snapshotBefore.items -ne $snapshotAfter.items) {
  throw "Confirmed report snapshot changed after task edit."
}

[pscustomobject]@{
  mergedControllerRows = $controllerRows.Count
  deletedTaskExcluded = $true
  snoozedStatus = $followRow.status
  internalScopeExcluded = $true
  snapshotImmutable = $snapshotBefore.items -eq $snapshotAfter.items
  sourceActivities = $salesReport.draft.sourceSummary.activityCount
  savedReportId = $saved.id
} | ConvertTo-Json -Compress
