# Hive install for Windows (PowerShell 5.1+)
#
# Fresh instance:   .\scripts\install.ps1
# Join existing:    .\scripts\install.ps1 -Connect -Url wss://URL -Token TOKEN
# Non-interactive:  .\scripts\install.ps1 -Fresh

param(
  [switch]$Connect,
  [switch]$Fresh,
  [string]$Url = "",
  [string]$Token = ""
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

$HiveDir = Join-Path $env:USERPROFILE ".hive"

function Install-Dependencies {
  $logFile = [System.IO.Path]::GetTempFileName()
  try {
    & npm install --silent *> $logFile
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    Remove-Item $logFile -ErrorAction SilentlyContinue
  } catch {
    Write-Host ""
    Write-Host "  X Dependency install failed. Last 50 lines:"
    Get-Content $logFile -Tail 50 | ForEach-Object { Write-Host "    $_" }
    Remove-Item $logFile -ErrorAction SilentlyContinue
    exit 1
  }
}

function Stop-HiveSatellite {
  # Stop scheduled task
  $task = Get-ScheduledTask -TaskName "HiveSatellite" -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName "HiveSatellite" -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "HiveSatellite" -Confirm:$false -ErrorAction SilentlyContinue
  }

  # Kill any running satellite processes
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '--satellite' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  $runtimeDir = Join-Path $HiveDir "runtime"
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  Remove-Item (Join-Path $runtimeDir "satellite.json") -ErrorAction SilentlyContinue
}

function Test-Port3001 {
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", 3001)
    $tcp.Close()
    return $true
  } catch {
    return $false
  }
}

# -- Parse mode --

$SatelliteMode = $false

if ($Connect) {
  $SatelliteMode = $true
  if (-not $Url -or -not $Token) {
    Write-Host ""
    Write-Host "  Usage: .\scripts\install.ps1 -Connect -Url wss://... -Token TOKEN"
    Write-Host ""
    Write-Host "  Get these from your primary Hive dashboard."
    Write-Host ""
    exit 1
  }
  $Url = $Url -replace "^https://", "wss://"
}
elseif (-not $Fresh) {
  # Interactive mode
  Write-Host ""
  Write-Host "  +-------------------------------------------+"
  Write-Host "  |             Hive Setup                     |"
  Write-Host "  |                                            |"
  Write-Host "  |  1) New environment                        |"
  Write-Host "  |     Start fresh with your own dashboard    |"
  Write-Host "  |                                            |"
  Write-Host "  |  2) Join a Hive network                    |"
  Write-Host "  |     Connect this PC's terminals to an      |"
  Write-Host "  |     existing Hive running on another       |"
  Write-Host "  |     computer                               |"
  Write-Host "  |                                            |"
  Write-Host "  +-------------------------------------------+"
  Write-Host ""
  $choice = Read-Host "  Choose (1 or 2)"

  if ($choice -eq "2") {
    $SatelliteMode = $true
    Write-Host ""
    $Url = Read-Host "  Tunnel URL (wss://... from primary dashboard)"
    $Token = Read-Host "  Token (from primary dashboard)"

    if (-not $Url -or -not $Token) {
      Write-Host "  Both URL and token are required."
      exit 1
    }
    $Url = $Url -replace "^https://", "wss://"
  }
}

Write-Host ""
if ($SatelliteMode) {
  Write-Host "  Connecting to Hive network..."
} else {
  Write-Host "  Installing Hive..."
}
Write-Host ""

# -- 1. Setup --

$tokenFile = Join-Path $HiveDir "token"
if (-not (Test-Path $tokenFile)) {
  # Try bash setup if available (Git Bash on Windows)
  $hasBash = $null -ne (Get-Command bash -ErrorAction SilentlyContinue)
  if ($hasBash) {
    & bash (Join-Path $Root "setup.sh") 2>$null
  }
  if (-not $hasBash -or $LASTEXITCODE -ne 0) {
    # setup.sh may fail on Windows - run essential steps manually
    Write-Host "  Running Windows setup..."

    # Check Node.js
    $nodeVersion = & node -v 2>$null
    if (-not $nodeVersion) {
      Write-Host "  X Node.js not found. Install it: https://nodejs.org (v20+)"
      exit 1
    }
    $nodeMajor = [int]($nodeVersion -replace "v(\d+)\..*", '$1')
    if ($nodeMajor -lt 20) {
      Write-Host "  X Node.js $nodeMajor found, need 20+."
      exit 1
    }
    Write-Host "  OK Node.js $nodeVersion"

    # Check for AI CLIs
    $hasClaude = $null -ne (Get-Command claude -ErrorAction SilentlyContinue)
    $hasCodex = $null -ne (Get-Command codex -ErrorAction SilentlyContinue)
    if ($hasClaude) { Write-Host "  OK Claude Code" }
    if ($hasCodex) { Write-Host "  OK Codex" }
    if (-not $hasClaude -and -not $hasCodex) {
      Write-Host "  No AI CLI found. Install at least one:"
      Write-Host "    npm install -g @anthropic-ai/claude-code"
      Write-Host "    npm install -g @openai/codex"
    }

    # Install dependencies
    Write-Host "  Installing dependencies..."
    Install-Dependencies
    Write-Host "  OK Dependencies installed"

    # Generate token
    New-Item -ItemType Directory -Path $HiveDir -Force | Out-Null
    $tokenBytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($tokenBytes)
    $newToken = ($tokenBytes | ForEach-Object { $_.ToString("x2") }) -join ""
    Set-Content -Path $tokenFile -Value $newToken -NoNewline

    # Create viewer token
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $viewerBytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("${newToken}:viewer"))
    $viewerToken = ($viewerBytes | ForEach-Object { $_.ToString("x2") }) -join ""
    Set-Content -Path (Join-Path $HiveDir "viewer-token") -Value $viewerToken -NoNewline

    Write-Host "  OK Token ready"

    # Create .env
    if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
      Copy-Item ".env.example" ".env"
      Write-Host "  OK .env created"
    }
  }
} else {
  Write-Host "  OK Already set up"
  Write-Host "  Installing dependencies..."
  Install-Dependencies
  Write-Host "  OK Dependencies up to date"
}

# -- Satellite mode --

if ($SatelliteMode) {
  # Store primary connection
  New-Item -ItemType Directory -Path $HiveDir -Force | Out-Null
  Set-Content -Path (Join-Path $HiveDir "primary-url") -Value $Url -NoNewline
  Set-Content -Path (Join-Path $HiveDir "primary-token") -Value $Token -NoNewline

  # Maintain URL rotation file
  $urlsFile = Join-Path $HiveDir "primary-urls.txt"
  $urls = @($Url)
  if (Test-Path $urlsFile) {
    $existing = Get-Content $urlsFile | Where-Object { $_ -and $_ -ne $Url }
    $urls += $existing
  }
  Set-Content -Path $urlsFile -Value ($urls | Select-Object -First 5)

  Write-Host "  OK Primary connection stored"

  # Stop existing satellite
  Write-Host "  Cleaning existing Hive satellite runtime..."
  Stop-HiveSatellite

  # Stop anything on port 3001
  if (Test-Port3001) {
    Write-Host "  Stopping existing daemon on :3001..."
    $listeners = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue
    foreach ($l in $listeners) {
      Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
  }

  # Find npx path
  $npxPath = (Get-Command npx -ErrorAction SilentlyContinue).Source
  if (-not $npxPath) { $npxPath = "npx" }
  $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $nodePath) { $nodePath = "node" }

  $logsDir = Join-Path $HiveDir "logs"
  New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

  # Write a batch file for the satellite with an infinite restart loop.
  # Task Scheduler's RestartOnFailure only fires on non-zero exit codes,
  # but satellite may exit cleanly during self-heal. The loop ensures the
  # process always comes back regardless of exit code.
  $batFile = Join-Path $HiveDir "satellite.bat"
  $batContent = @"
@echo off
cd /d "$Root"
:loop
"$npxPath" tsx apps/daemon/src/index.ts --satellite >> "$logsDir\satellite.stdout.log" 2>> "$logsDir\satellite.stderr.log"
echo [%date% %time%] Satellite exited with code %ERRORLEVEL%, restarting in 5s... >> "$logsDir\satellite.stderr.log"
timeout /t 5 /nobreak >nul
goto loop
"@
  [System.IO.File]::WriteAllText($batFile, $batContent, [System.Text.Encoding]::ASCII)

  # Install as Windows Task Scheduler task.
  # Try elevated (AtStartup + AtLogOn + RunLevel Highest) first. If that fails
  # (non-admin shell), fall back to user-level (AtLogOn only, no elevation).
  $action = New-ScheduledTaskAction `
    -Execute $batFile `
    -WorkingDirectory $Root

  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365) `
    -StartWhenAvailable

  $registered = $false

  # Attempt 1: elevated with AtStartup (survives reboot without login)
  try {
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $triggerStartup = New-ScheduledTaskTrigger -AtStartup
    Register-ScheduledTask `
      -TaskName 'HiveSatellite' `
      -Action $action `
      -Trigger @($triggerLogon, $triggerStartup) `
      -Settings $settings `
      -Description 'Hive Satellite Daemon - connects to primary Hive network' `
      -RunLevel Highest `
      -Force | Out-Null
    $registered = $true
    Write-Host "  OK Satellite service installed (Task Scheduler, elevated)"
  } catch {
    # Attempt 2: user-level (no admin needed, AtLogOn only)
    try {
      $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
      Register-ScheduledTask `
        -TaskName 'HiveSatellite' `
        -Action $action `
        -Trigger $triggerLogon `
        -Settings $settings `
        -Description 'Hive Satellite Daemon - connects to primary Hive network' `
        -Force | Out-Null
      $registered = $true
      Write-Host "  OK Satellite service installed (Task Scheduler, user-level)"
    } catch {
      Write-Host "  ! Task Scheduler registration failed: $_"
    }
  }

  if (-not $registered) {
    # Attempt 3: Startup folder fallback (always works, no admin needed)
    $startupDir = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
    if (Test-Path $startupDir) {
      Copy-Item $batFile (Join-Path $startupDir "hive-satellite.bat") -Force
      Write-Host "  OK Auto-start via Startup folder (fallback)"
    }
  }

  # Start the task now (or start directly if no task)
  if ($registered) {
    Start-ScheduledTask -TaskName 'HiveSatellite'
    Write-Host "  OK Satellite service started"
  } else {
    Start-Process -FilePath $batFile -WorkingDirectory $Root -WindowStyle Hidden
    Write-Host "  OK Satellite started directly"
  }

  # Wait for satellite to start
  $satOk = $false
  for ($i = 0; $i -lt 20; $i++) {
    if (Test-Port3001) {
      $satOk = $true
      break
    }
    Start-Sleep -Seconds 1
  }

  if ($satOk) {
    Write-Host "  OK Satellite daemon running"
  } else {
    Write-Host "  X Satellite daemon failed to start via Task Scheduler."
    Write-Host "    Falling back to direct start..."
    # Fallback: start directly (works reliably, just no auto-restart)
    Start-Process -FilePath $npxPath -ArgumentList "tsx apps/daemon/src/index.ts --satellite" `
      -WorkingDirectory $Root -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logsDir "satellite.stdout.log") `
      -RedirectStandardError (Join-Path $logsDir "satellite.stderr.log")
    Start-Sleep -Seconds 5
    if (Test-Port3001) {
      Write-Host "  OK Satellite daemon running (direct start)"
    } else {
      Write-Host "  X Satellite still failed. Check logs:"
      Write-Host "    Get-Content $logsDir\satellite.stderr.log"
      $stderrLog = Join-Path $logsDir "satellite.stderr.log"
      if (Test-Path $stderrLog) {
        Get-Content $stderrLog -Tail 10 | ForEach-Object { Write-Host "    $_" }
      }
      exit 1
    }
  }

  # GPU detection
  $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if ($nvidiaSmi) {
    $gpuName = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1
    $gpuVram = & nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    if ($gpuName) {
      $vramDisplay = "$gpuVram" + "MB"
      Write-Host "  OK GPU detected: $gpuName ($vramDisplay)"
    }
  }

  Write-Host ""
  Write-Host "  ------------------------------------------------"
  Write-Host ""
  Write-Host "  Connected to Hive network."
  Write-Host ""
  Write-Host "  Primary: $Url"
  Write-Host ""
  Write-Host "  Open terminal windows and run 'claude', 'codex',"
  Write-Host "  or any agent. The primary dashboard sees them."
  Write-Host ""
  Write-Host "  The satellite runs as a scheduled task."
  Write-Host "  It survives sleep, reboot, and terminal close."
  Write-Host "  Agents disappear from the dashboard when this"
  Write-Host "  computer is off and reappear when it wakes."
  Write-Host ""
  Write-Host "  Log:   Get-Content ~\.hive\logs\satellite.stderr.log"
  Write-Host "  Stop:  Unregister-ScheduledTask -TaskName HiveSatellite"
  Write-Host ""
  Write-Host "  ------------------------------------------------"
  Write-Host ""
  exit 0
}

# ==================================================================
# Primary mode - start daemon + tunnel
# ==================================================================

# -- Check tunnel tools --

$hasNgrok = $null -ne (Get-Command ngrok -ErrorAction SilentlyContinue)
$hasCloudflared = $null -ne (Get-Command cloudflared -ErrorAction SilentlyContinue)

if ($hasNgrok) { Write-Host "  OK ngrok" }
if ($hasCloudflared) { Write-Host "  OK cloudflared" }

if (-not $hasNgrok -and -not $hasCloudflared) {
  # Try winget install
  $hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
  if ($hasWinget) {
    Write-Host "  Installing cloudflared via winget..."
    & winget install --id Cloudflare.cloudflared --accept-package-agreements --accept-source-agreements 2>$null
    $hasCloudflared = $null -ne (Get-Command cloudflared -ErrorAction SilentlyContinue)
  }

  if (-not $hasNgrok -and -not $hasCloudflared) {
    Write-Host "  X No public tunnel tool found."
    Write-Host "    Install ngrok: winget install ngrok.ngrok"
    Write-Host "    Or cloudflared: winget install Cloudflare.cloudflared"
    exit 1
  }
}

# -- Start daemon --

if (Test-Port3001) {
  Write-Host "  OK Daemon already running on :3001"
} else {
  Write-Host ""
  Write-Host "  Starting daemon + tunnel..."
  Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$Root`" && npm start" -WindowStyle Normal
  Write-Host "  OK Daemon started in a new window"
}

# -- Wait for tunnel URL --

Write-Host "  Waiting for tunnel..."
$tunnelFile = Join-Path $HiveDir "tunnel-url.txt"
$tunnelUrl = ""

for ($i = 0; $i -lt 90; $i++) {
  if (Test-Path $tunnelFile) {
    $content = Get-Content $tunnelFile -Raw
    $match = [regex]::Match($content, "https://[^\s]+")
    if ($match.Success) {
      $tunnelUrl = $match.Value
      break
    }
  }
  Start-Sleep -Seconds 1
}

if (-not $tunnelUrl) {
  Write-Host "  X Timed out waiting for tunnel."
  Write-Host "    Check the daemon window for output."
  exit 1
}
Write-Host "  OK Tunnel ready"

# -- Deploy dashboard --

Write-Host ""
Write-Host "  Deploying dashboard to Vercel..."
& npm run deploy:dashboard

# -- Done --

$hiveToken = Get-Content $tokenFile -Raw
$dashboardFile = Join-Path $HiveDir "dashboard-url.txt"
$dashboardUrl = "(check deploy output)"
if (Test-Path $dashboardFile) {
  $content = Get-Content $dashboardFile -Raw
  $match = [regex]::Match($content, "https://[\w.-]+\.vercel\.app")
  if ($match.Success) { $dashboardUrl = $match.Value }
}
$wsUrl = $tunnelUrl -replace "^https://", "wss://"

Write-Host ""
Write-Host "  ------------------------------------------------"
Write-Host ""
Write-Host "  Hive is installed and running."
Write-Host ""
Write-Host "  Dashboard: $dashboardUrl"
Write-Host "  Token:     $hiveToken"
Write-Host ""
Write-Host "  Open the dashboard, paste your token, and start"
Write-Host "  running agents in terminal windows."
Write-Host ""
Write-Host "  -- Connect another machine --"
Write-Host ""
Write-Host "  On the other computer, clone Hive and run:"
Write-Host ""
Write-Host "  git clone https://github.com/RohitMangtani/hive.git"
Write-Host "  cd hive"
Write-Host ""
Write-Host "  Windows (PowerShell):"
Write-Host "  .\scripts\install.ps1 -Connect -Url $wsUrl -Token $hiveToken"
Write-Host ""
Write-Host "  macOS / Linux (bash):"
Write-Host "  bash scripts/install.sh --connect $wsUrl $hiveToken"
Write-Host ""
Write-Host "  Connection is permanent. The satellite runs as a"
Write-Host "  background service and survives sleep and reboot."
Write-Host ""
Write-Host "  To get this invite again later: npm run invite"
Write-Host ""
Write-Host "  ------------------------------------------------"
Write-Host ""
