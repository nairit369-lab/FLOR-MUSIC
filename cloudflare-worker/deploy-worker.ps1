# Деплой Cloudflare Worker для FLOR MUSIC
# 1) Создайте токен: https://dash.cloudflare.com/profile/api-tokens
#    Шаблон: Edit Cloudflare Workers → Create Token
# 2) Вставьте токен в файл .cf-token (в этой же папке, одна строка)
# 3) Запустите: powershell -ExecutionPolicy Bypass -File deploy-worker.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$tokenFile = Join-Path $PSScriptRoot '.cf-token'
if (-not (Test-Path $tokenFile)) {
    @'
Вставьте API-токен Cloudflare в этот файл (одна строка, без кавычек).
Создать токен: https://dash.cloudflare.com/profile/api-tokens
Шаблон: Edit Cloudflare Workers → Create Token
'@ | Set-Content -Path $tokenFile -Encoding UTF8
    Write-Host ''
    Write-Host 'Создан файл .cf-token — вставьте туда токен и запустите скрипт снова.' -ForegroundColor Yellow
    notepad $tokenFile
    exit 1
}

$token = (Get-Content $tokenFile -Raw).Trim()
if ($token.Length -lt 20 -or $token -match 'вставьте|insert|token') {
    Write-Host 'Откройте .cf-token и вставьте настоящий токен Cloudflare.' -ForegroundColor Yellow
    notepad $tokenFile
    exit 1
}

$env:CLOUDFLARE_API_TOKEN = $token
Write-Host 'Деплой Worker...' -ForegroundColor Cyan
npx --yes wrangler deploy
if ($LASTEXITCODE -eq 0) {
    Write-Host ''
    Write-Host 'Готово! Worker: https://cool-flower-6004.nairit369.workers.dev' -ForegroundColor Green
    Write-Host 'На VDS: cd /root/FLOR-MUSIC && git pull && pm2 restart flor-music'
}
