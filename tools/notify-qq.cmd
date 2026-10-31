@echo off
rem Generic QQ notifier wrapper. Usage:
rem   D:/AstrBot\notify-qq.cmd "task finished: xxx"
rem   D:/AstrBot\notify-qq.cmd --title "build done" "3 artifacts"
rem   D:/AstrBot\notify-qq.cmd --group 2000002 --at-all "ping group"
setlocal
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "C:\Users\ruanr\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=C:\Users\ruanr\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE (
  echo [notify-qq] node.exe not found
  exit /b 1
)
"%NODE_EXE%" "%~dp0notify-qq.mjs" %*
exit /b %ERRORLEVEL%
