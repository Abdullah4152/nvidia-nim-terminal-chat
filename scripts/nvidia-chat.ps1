[CmdletBinding()]
param(
    [string]$ApiKey,
    [string]$Model,
    [string]$BaseUrl = 'https://integrate.api.nvidia.com/v1',
    [switch]$Local,
    [string]$LocalUrl = 'http://localhost:11434/v1',
    [double]$Temperature = 0.7,
    [int]$MaxTokens = 2048
)

# --- preflight -------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error 'Node.js not found on PATH. Install Node 18+ from https://nodejs.org and reopen the terminal.'
    exit 1
}
$nodeMajor = [int]((& node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) {
    Write-Error "Node $((& node -v)) is too old. nvchat needs Node 18+ (built-in fetch)."
    exit 1
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $projectRoot 'src\nvchat.js'
if (-not (Test-Path $script)) {
    Write-Error "nvchat.js not found next to this launcher ($script)."
    exit 1
}
if (-not (Test-Path (Join-Path $projectRoot 'node_modules\blessed'))) {
    Write-Host 'Installing dependencies (first run)...' -ForegroundColor DarkGray
    Push-Location $projectRoot
    npm install --no-audit --no-fund | Out-Null
    Pop-Location
}

# --- credentials -----------------------------------------------------------
if (-not $ApiKey -and $env:NVIDIA_API_KEY) { $ApiKey = $env:NVIDIA_API_KEY }
if (-not $ApiKey -and -not $Local) {
    $secure = Read-Host 'NVIDIA API key' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
if (-not $ApiKey) { $ApiKey = 'local' }

if (-not $Model) {
    $Model = Read-Host 'Model ID []'
    if (-not $Model) { $Model = 'meta/llama-3.3-70b-instruct' }
}

# --- launch ----------------------------------------------------------------
# The key is passed via environment, never argv (argv is visible in process
# lists and PowerShell history/transcripts).
$argsForApp = @($script, '--model', $Model,
    '--temperature', $Temperature, '--max-tokens', $MaxTokens)
if ($Local) { $argsForApp += @('--local', '--local-url', $LocalUrl) }
else        { $argsForApp += @('--base-url', $BaseUrl) }

$previousKey = $env:NVIDIA_API_KEY
try {
    $env:NVIDIA_API_KEY = $ApiKey
    & node @argsForApp
}
finally {
    $env:NVIDIA_API_KEY = $previousKey
}
