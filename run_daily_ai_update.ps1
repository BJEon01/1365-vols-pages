$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $RepoRoot "backend"
$ModelName = "gemma3:4b-it-qat"
$EnvName = "1365-backend"

function Get-OllamaExecutable {
  $command = Get-Command ollama -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"),
    "C:\Program Files\Ollama\ollama.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }
  return $null
}

function Get-CondaPython {
  $candidates = @(
    (Join-Path $env:USERPROFILE "anaconda3\envs\$EnvName\python.exe"),
    (Join-Path $env:USERPROFILE "miniconda3\envs\$EnvName\python.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }
  return $null
}

function Invoke-GitChecked {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  & git @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

Write-Host "[1/6] Checking local workspace..."
Push-Location $RepoRoot
try {
  $status = git status --porcelain
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to read git status"
  }
  if ($status) {
    throw "Working tree is not clean. Commit or stash your changes first."
  }

  $ollamaExe = Get-OllamaExecutable
  if (-not $ollamaExe) {
    throw "Ollama is not installed or not on PATH."
  }

  $pythonExe = Get-CondaPython
  if (-not $pythonExe) {
    throw "Could not find the Python executable for conda env '$EnvName'."
  }

  Write-Host "[2/6] Checking Ollama model..."
  $ollamaList = & $ollamaExe list
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to query Ollama. Make sure Ollama is running."
  }
  $ollamaListText = ($ollamaList | Out-String)
  if (-not ($ollamaListText -match "(?m)^\s*$([regex]::Escape($ModelName))\s")) {
    throw "Ollama model '$ModelName' is missing. Run: ollama pull $ModelName"
  }

  Write-Host "[3/6] Pulling latest main..."
  Invoke-GitChecked -Arguments @("pull", "--rebase", "origin", "main")

  Write-Host "[4/6] Generating summary/tags with Ollama..."
  Push-Location $BackendDir
  try {
    $env:AI_PROVIDER = "ollama"
    $env:OLLAMA_MODEL = $ModelName
    $env:AI_CONCURRENCY = "1"
    Remove-Item Env:AI_BATCH_LIMIT -ErrorAction SilentlyContinue
    Remove-Item Env:AI_FORCE_REGENERATE -ErrorAction SilentlyContinue
    Remove-Item Env:AI_OUTPUT_JSON_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:AI_OUTPUT_ONLY_TARGETS -ErrorAction SilentlyContinue

    & $pythonExe "scripts/enrich_ai_fields.py"
    if ($LASTEXITCODE -ne 0) {
      throw "AI enrichment failed with exit code $LASTEXITCODE"
    }
  }
  finally {
    Pop-Location
  }

  Write-Host "[5/6] Checking for JSON changes..."
  Invoke-GitChecked -Arguments @("add", "docs/data/volunteer_posts.json")
  & git diff --cached --quiet -- "docs/data/volunteer_posts.json"
  if ($LASTEXITCODE -eq 0) {
    Write-Host "No summary/tag changes to commit."
    return
  }
  if ($LASTEXITCODE -ne 1) {
    throw "Failed to check staged diff"
  }

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
  Write-Host "[6/6] Committing and pushing..."
  Invoke-GitChecked -Arguments @("commit", "-m", "chore: update ai summaries and tags ($timestamp)")
  Invoke-GitChecked -Arguments @("push", "origin", "main")

  Write-Host "Daily AI update completed."
}
finally {
  Pop-Location
}
