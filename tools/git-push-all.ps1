# Полный пуш всех трёх ремоутов по docs/GIT-PUSH-PULL.md
# Использование: powershell -ExecutionPolicy Bypass -File tools/git-push-all.ps1 "15.08: суть"
param([string]$Msg = "")
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not $Msg) {
    $d = Get-Date -Format "dd.MM"
    $Msg = Read-Host "Commit message (e.g. '$d': суть)"
    if (-not $Msg) { $Msg = "$d: git-push-all" }
}

Write-Host "== status (до) =="
git status --short
Write-Host "== проверка секретов (должно быть пусто) =="
git status --short | Select-String "github_pat|xxx0"

git add -A
git commit -m $Msg

git push origin HEAD:fixture-profiles-patch
git push github HEAD:master
git push gitflic HEAD:master

Write-Host "== контроль: status (пусто) и три ремоута на одном коммите =="
git status --short
git ls-remote origin fixture-profiles-patch
git ls-remote github master
git ls-remote gitflic master
Write-Host "== OK =="
