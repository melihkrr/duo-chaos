$ErrorActionPreference = 'Continue'
Get-Content .env.local | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    $k = $matches[1]
    $v = $matches[2].Trim('"')
    Set-Item -Path "Env:$k" -Value $v
  }
}
$env:SUPABASE_DB_USER = 'postgres.fanrtyidfhdhlaskwrid'

$tests = @(
  'test-collect-gate',
  'test-collect-pending-visual',
  'test-collect-latency',
  'test-objective-progress-loss',
  'test-objective-action-order',
  'test-objective-counting',
  'test-objective-future-progress',
  'test-objective-owner-authority',
  'test-progress-monotonic',
  'test-results-score-authority',
  'test-multiplayer-desync',
  'test-player-name-resolution',
  'test-chaos-events',
  'test-retry-recovery',
  'test-dynamic-joystick',
  'test-input-reset',
  'test-steal-authority',
  'test-collect-loss',
  'test-collect-concurrency'
)

foreach ($t in $tests) {
  Write-Host "===== $t ====="
  $out = & node "scripts/$t.mjs" 2>&1
  $code = $LASTEXITCODE
  $out | Select-Object -Last 8
  Write-Host "----- exit=$code -----"
}
