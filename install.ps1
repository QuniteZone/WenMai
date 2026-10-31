# WenMai local installer.
# Usage: powershell -ExecutionPolicy Bypass -File .\install.ps1
# This copies the extension into %USERPROFILE%\.vscode\extensions so VS Code
# can load it without packaging a vsix.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgPath = Join-Path $root 'package.json'
if (-not (Test-Path $pkgPath)) {
    throw "package.json not found: $pkgPath"
}

$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$extRoot = Join-Path $env:USERPROFILE '.vscode\extensions'
$destName = "$($pkg.publisher).$($pkg.name)-$($pkg.version)"
$dest = Join-Path $extRoot $destName

if (-not (Test-Path $extRoot)) {
    New-Item -ItemType Directory -Path $extRoot -Force | Out-Null
}

# Remove older copies of this extension only. Keep the plain dev folder
# (extensions\wenmai) untouched and warn about it instead.
Get-ChildItem $extRoot -Directory -Filter "$($pkg.publisher).$($pkg.name)-*" -ErrorAction SilentlyContinue |
    ForEach-Object {
        if ($_.FullName -ne $dest) {
            Remove-Item $_.FullName -Recurse -Force -Confirm:$false
            Write-Host "removed old copy: $($_.Name)"
        }
    }

$devCopy = Join-Path $extRoot $pkg.name
if (Test-Path $devCopy) {
    Write-Host "WARNING: found a development copy at: $devCopy" -ForegroundColor Yellow
    Write-Host "         VS Code will load both copies and send duplicate requests." -ForegroundColor Yellow
    Write-Host "         Remove it before reloading the window." -ForegroundColor Yellow
}

New-Item -ItemType Directory -Path $dest -Force | Out-Null
Copy-Item (Join-Path $root 'package.json') $dest -Force
Copy-Item (Join-Path $root 'extension.js') $dest -Force
Copy-Item (Join-Path $root 'README.md') $dest -Force
if (Test-Path (Join-Path $root 'LICENSE')) {
    Copy-Item (Join-Path $root 'LICENSE') $dest -Force
}
Copy-Item (Join-Path $root 'src') $dest -Recurse -Force

Write-Host ""
Write-Host "installed to: $dest" -ForegroundColor Green
Write-Host "run 'Developer: Reload Window' in VS Code to activate." -ForegroundColor Green
Write-Host ""
Get-ChildItem $dest -Recurse -File | Select-Object FullName, Length | Format-Table -AutoSize
