# Use the application's existing environment even if another venv is activated.
$trafficPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $trafficPython)) {
    throw 'Project .venv is missing. Follow the environment setup in README.md.'
}
& $trafficPython (Join-Path $PSScriptRoot 'main.py') @args
exit $LASTEXITCODE
