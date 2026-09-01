$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:3000"
$ready = $false
$lastError = ""
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  Start-Sleep -Milliseconds 500
  try {
    $initial = Invoke-RestMethod "$baseUrl/api/workspace" -TimeoutSec 5
    $ready = $true
    break
  } catch {
    $lastError = $_.Exception.Message
    if ($_.Exception.Response) {
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $lastError = $reader.ReadToEnd()
    }
  }
}
if (-not $ready) { throw "Local server did not become ready: $lastError" }

$customer = $initial.customers |
  Where-Object { $_.customer_code } |
  Select-Object -First 1
if (-not $customer) { throw "No coded customer is available for order testing." }

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$headers = @{ "content-type" = "application/json" }
$orderNo = "P4-$stamp"

$created = Invoke-RestMethod "$baseUrl/api/orders" -Method Post -Headers $headers -Body (@{
  action = "save"
  confirmFinancialRisk = $true
  customerCode = $customer.customer_code
  orderNo = $orderNo
  piNo = "PI-$stamp"
  orderDate = "2026-07-23"
  model = "ADV"
  quantity = 12
  originalCurrency = "USD"
  originalAmount = 10000
  fixedExchangeRateToCny = 7.2
  otherCosts = 800
  paymentStatus = "deposit_received"
  depositAmount = 3000
  depositDate = "2026-07-23"
  balanceAmount = 7000
  balanceExpectedDate = "2026-08-20"
  productionStatus = "production_started"
  shipmentStatus = "not_shipped"
  containerNumber = "TEST$stamp"
  documents = "PI,Invoice"
} | ConvertTo-Json)

Invoke-RestMethod "$baseUrl/api/orders" -Method Post -Headers $headers -Body (@{
  action = "save"
  id = $created.id
  confirmFinancialRisk = $true
  customerCode = $customer.customer_code
  orderNo = $orderNo
  piNo = "PI-$stamp"
  orderDate = "2026-07-23"
  model = "ADV"
  quantity = 12
  originalCurrency = "USD"
  originalAmount = 10000
  fixedExchangeRateToCny = 7.2
  otherCosts = 800
  paymentStatus = "balance_pending"
  depositAmount = 3000
  depositDate = "2026-07-23"
  balanceAmount = 7000
  balanceExpectedDate = "2026-08-20"
  productionStatus = "production_completed"
  shipmentStatus = "shipped"
  containerNumber = "TEST$stamp"
  blNumber = "BL$stamp"
  documents = "PI,Invoice,BL"
} | ConvertTo-Json) | Out-Null

$previewRows = @(
  @{
    rowNumber = 2
    orderNo = "IMP-$stamp"
    piNo = "IP-$stamp"
    customerCode = $customer.customer_code
    model = "ADV"
    quantity = 5
    originalCurrency = "USD"
    originalAmount = 5000
    fixedExchangeRateToCny = 7.1
  },
  @{
    rowNumber = 3
    orderNo = "UNKNOWN-$stamp"
    customerCode = "UNKNOWN$stamp"
    originalCurrency = "USD"
    originalAmount = 100
    fixedExchangeRateToCny = 7.1
  },
  @{
    rowNumber = 4
    orderNo = "RATE-$stamp"
    customerCode = $customer.customer_code
    originalCurrency = "USD"
    originalAmount = 100
  }
)

$preview = Invoke-RestMethod "$baseUrl/api/orders/import" -Method Post -Headers $headers -Body (@{
  action = "preview"
  rows = $previewRows
} | ConvertTo-Json -Depth 8)
if ($preview.summary.ready -ne 1 -or $preview.summary.needsReview -ne 2) {
  throw "Order import preview classification failed."
}

$confirmed = Invoke-RestMethod "$baseUrl/api/orders/import" -Method Post -Headers $headers -Body (@{
  action = "confirm"
  rows = $previewRows
} | ConvertTo-Json -Depth 8)
if ($confirmed.imported -ne 1 -or $confirmed.skipped -ne 2) {
  throw "Order import confirmation failed."
}

$final = Invoke-RestMethod "$baseUrl/api/workspace" -TimeoutSec 10
$saved = $final.orders | Where-Object id -eq $created.id
$imported = $final.orders | Where-Object order_no -eq "IMP-$stamp"
if (-not $saved -or -not $imported) {
  throw "Saved or imported order was not returned."
}
if ($saved.customer_id -ne $customer.id) {
  throw "Customer code association failed."
}
if ([math]::Abs([double]$saved.cny_amount - 72000) -gt 0.01) {
  throw "CNY amount calculation failed."
}
if (
  $saved.payment_status -ne "balance_pending" -or
  $saved.production_status -ne "production_completed" -or
  $saved.shipment_status -ne "shipped"
) {
  throw "Independent order statuses were not preserved."
}

[pscustomobject]@{
  initialOrders = $initial.orders.Count
  backupOrders = $final.integrity.phase4_backup_orders
  currentOrders = $final.integrity.phase4_current_orders
  customerLinked = $saved.customer_id -eq $customer.id
  cnyCalculated = [math]::Abs([double]$saved.cny_amount - 72000) -le 0.01
  editable = $saved.bl_number -eq "BL$stamp"
  paymentStatus = $saved.payment_status
  productionStatus = $saved.production_status
  shipmentStatus = $saved.shipment_status
  previewReady = $preview.summary.ready
  previewNeedsReview = $preview.summary.needsReview
  imported = $confirmed.imported
  skipped = $confirmed.skipped
} | ConvertTo-Json -Compress
