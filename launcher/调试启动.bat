@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul && (python app.py & goto :eof)
where py >nul 2>nul && (py app.py & goto :eof)
echo 没找到 Python，请先安装 Python 3.10+ 并勾选 Add to PATH
pause