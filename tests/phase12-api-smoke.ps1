$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:3000"
$ready = $false
for ($attempt = 0; $attempt -lt 15; $attempt += 1) {
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
  kind = "customer"
  company = "Phase12 Test $stamp"
  lifecycle = "potential_customer"
  customerCode = "T$stamp"
  country = "Test"
  city = "Hangzhou"
  source = "phase12_local_test"
} | ConvertTo-Json)
$customerId = $created.id

Invoke-RestMethod "$baseUrl/api/customers" -Method Post -Headers $headers -Body (@{
  action = "update_profile"
  customerId = $customerId
  customerCode = "T$stamp"
  company = "Phase12 Test $stamp"
  lifecycle = "potential_customer"
  country = "Test"
  city = "Hangzhou"
  address = "Local verification"
  customerType = "Distributor"
  source = "phase12_local_test"
  profile = "editable"
  companyBackgroundNotes = "Local verification"
} | ConvertTo-Json) | Out-Null

Invoke-RestMethod "$baseUrl/api/customers" -Method Post -Headers $headers -Body (@{
  action = "record_follow_up"
  customerId = $customerId
  followUpAt = "2026-08-19T10:00"
  content = "Local verification follow-up"
  nextFollowUpDate = "2026-08-26"
} | ConvertTo-Json) | Out-Null

Invoke-RestMethod "$baseUrl/api/customers" -Method Post -Headers $headers -Body (@{
  action = "save_contact"
  customerId = $customerId
  name = "Test Contact"
  position = "Buyer"
  email = "test@example.com"
  whatsapp = "+100000"
  linkedin = "https://linkedin.com/in/test"
  notes = "Local only"
  isPrimary = $true
} | ConvertTo-Json) | Out-Null

$task = Invoke-RestMethod "$baseUrl/api/workspace" -Method Post -Headers $headers -Body (@{
  kind = "task"
  title = "Phase12 Task $stamp"
  priority = "High"
  reminderDate = "2026-07-24"
  recurrenceRule = "weekly"
  nextAction = "Verify task workflow"
} | ConvertTo-Json)
$taskId = $task.id

Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "status"
  id = $taskId
  status = "snoozed"
  snoozedUntil = "2026-07-26"
} | ConvertTo-Json) | Out-Null

Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "status"
  id = $taskId
  status = "pending"
} | ConvertTo-Json) | Out-Null

Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "status"
  id = $taskId
  status = "completed"
} | ConvertTo-Json) | Out-Null

Invoke-RestMethod "$baseUrl/api/tasks" -Method Post -Headers $headers -Body (@{
  action = "archive"
  id = $taskId
} | ConvertTo-Json) | Out-Null

$final = Invoke-RestMethod "$baseUrl/api/workspace" -TimeoutSec 10
$savedCustomer = $final.customers | Where-Object id -eq $customerId
$savedContact = $final.contacts | Where-Object customer_id -eq $customerId
$savedFollowUp = (Invoke-RestMethod "$baseUrl/api/customers?customerId=$customerId").followUps | Select-Object -First 1
$savedTask = $final.tasks | Where-Object id -eq $taskId

if (-not $savedCustomer -or -not $savedContact -or -not $savedFollowUp -or -not $savedTask) {
  throw "Phase 1/2 persistence assertion failed."
}

[pscustomobject]@{
  initialCustomers = $initial.customers.Count
  finalCustomers = $final.customers.Count
  initialTasks = $initial.tasks.Count
  finalTasks = $final.tasks.Count
  backupCustomers = $final.integrity.phase12_backup_customers
  currentCustomers = $final.integrity.phase12_current_customers
  backupTasks = $final.integrity.phase12_backup_tasks
  currentTasks = $final.integrity.phase12_current_tasks
  customerEditable = $savedCustomer.city -eq "Hangzhou"
  contactStored = [bool]$savedContact
  memoryStored = $savedMemory.relationship_notes -eq "Verified"
  customFieldStored = $savedField.label -eq "Preferred Port"
  taskStatus = $savedTask.status
  taskArchived = [bool]$savedTask.archived_at
} | ConvertTo-Json -Compress
