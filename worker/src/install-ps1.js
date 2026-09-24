// Template served at GET /install.ps1. The worker fills the three
// __SWORM_*__ placeholders before serving. Keep install/install.ps1 in
// sync with this file.
//
// The script must stay free of backticks and ${...} so it can live
// inside this javascript template literal. PowerShell string escapes
// use backticks, so this script avoids them on purpose.

export const INSTALL_PS1 = `# sworm installer for windows.
#
# This script is served by your own sworm worker. It is plain text on
# purpose: read it before you run it. It does exactly five things:
#
#   1. Checks for node.js 18 or newer.
#   2. Creates the directory %USERPROFILE%\\.sworm.
#   3. Downloads the sworm agent into that directory.
#   4. Writes config.json (worker url and bootstrap token).
#   5. Starts the agent in the background.
#
# The agent then enrolls this machine and creates a scheduled task
# named SwormAgent so it starts at logon.
#
# Remove everything at any time:
#   node $env:USERPROFILE\\.sworm\\agent.js --uninstall

$ErrorActionPreference = "Stop"

$WorkerUrl = "__SWORM_WORKER_URL__"
$BootstrapToken = "__SWORM_BOOTSTRAP_TOKEN__"
$AgentUrl = "__SWORM_AGENT_URL__"
$SwormDir = Join-Path $env:USERPROFILE ".sworm"

Write-Host "sworm installer"
Write-Host "worker: $WorkerUrl"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "error: node.js is not installed. install node 18 or newer, then rerun this script."
  exit 1
}
$nodeVersion = (node -e "console.log(process.version)")
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 18) {
  Write-Host "error: node 18 or newer is required."
  exit 1
}

Write-Host "creating $SwormDir"
New-Item -ItemType Directory -Force -Path $SwormDir | Out-Null

Write-Host "downloading the agent"
$agentFile = Join-Path $SwormDir "agent.js"
$downloaded = $false
if ($AgentUrl -ne "") {
  try {
    Invoke-WebRequest -Uri $AgentUrl -OutFile $agentFile -UseBasicParsing
    $downloaded = $true
  } catch {
    Write-Host "direct download failed, trying the worker route"
  }
}
if (-not $downloaded) {
  Invoke-WebRequest -Uri "$WorkerUrl/v1/agent" -OutFile $agentFile -UseBasicParsing -Headers @{ Authorization = "Bearer $BootstrapToken" }
}

Write-Host "writing config"
$config = @{ workerUrl = $WorkerUrl; bootstrapToken = $BootstrapToken } | ConvertTo-Json
Set-Content -Path (Join-Path $SwormDir "config.json") -Value $config

Write-Host "starting the agent"
# Start in the background without opening a console window. The process
# shows up in task manager as node, running the visible agent.js file.
Start-Process -FilePath "node" -ArgumentList ('"' + $agentFile + '"') -WindowStyle Hidden -WorkingDirectory $SwormDir

Write-Host "sworm agent installed"
Write-Host "state dir: $SwormDir"
Write-Host "uninstall: node $SwormDir\\agent.js --uninstall"
`;
