@echo off
setlocal EnableExtensions
cd /d "%~dp0" || exit /b 1
set "GIT_TERMINAL_PROMPT=0"

if not exist ".git" (
  git init -b master || goto fail
)
git symbolic-ref --quiet HEAD >nul 2>&1 || goto fail
for /f "delims=" %%G in ('git rev-parse --absolute-git-dir') do set "BACKUP_GIT_DIR=%%G"
for %%S in (MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply) do if exist "%BACKUP_GIT_DIR%\%%S" (
  echo ERROR: Finish the existing Git operation before backing up.
  goto fail
)
for /f "delims=" %%B in ('git branch --show-current') do set "BACKUP_BRANCH=%%B"
if not defined BACKUP_BRANCH goto fail

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  git remote add origin "git@gitee.com:mmsan/fast-vscode.git" || goto fail
)
git fetch --prune --no-tags origin || goto fail

git add -A || goto fail
git diff --cached --quiet
if errorlevel 2 goto fail
if errorlevel 1 (
  git commit -m "backup" || goto fail
)
git rev-parse --verify HEAD >nul 2>&1 || goto fail

rem Preserve both histories; a real content conflict requires review.
git show-ref --verify --quiet "refs/remotes/origin/%BACKUP_BRANCH%"
if errorlevel 2 goto fail
if not errorlevel 1 (
  git merge --no-edit "refs/remotes/origin/%BACKUP_BRANCH%" || goto mergeFailed
)
git push -u origin "HEAD:%BACKUP_BRANCH%" || goto fail
echo Backup completed.
exit /b 0

:mergeFailed
git merge --abort >nul 2>&1
echo ERROR: Remote changes conflict with this backup. Local commits are preserved.
:fail
echo ERROR: Backup failed in %CD%. Review the Git error above and rerun.
exit /b 1
