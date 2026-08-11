@echo off
setlocal EnableExtensions

cd /d "%~dp0" || exit /b 1
set "REPO_URL=https://gitee.com/mmsan/fast-vscode.git"

git init || exit /b 1
git add . || exit /b 1

git diff --cached --quiet
if errorlevel 2 exit /b 1
if errorlevel 1 (
    git commit -m "backup" || exit /b 1
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
    git remote add origin "%REPO_URL%" || exit /b 1
) else (
    git remote set-url origin "%REPO_URL%" || exit /b 1
    git remote set-url --push origin "%REPO_URL%" >nul 2>&1
    if errorlevel 1 git remote set-url --add --push origin "%REPO_URL%" || exit /b 1
)

set "BRANCH="
for /f "delims=" %%B in ('git branch --show-current') do set "BRANCH=%%B"
if not defined BRANCH set "BRANCH=master"

git push -u origin "%BRANCH%" || exit /b 1
endlocal
exit /b 0
