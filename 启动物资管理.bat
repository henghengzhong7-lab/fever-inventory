@echo off
chcp 65001 >nul
title FEver 战队物资管理
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js，无法启动。
  echo   请先安装 Node.js 后重试： https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动 FEver 战队物资管理...
echo   浏览器会自动打开。请不要关闭本窗口，用完再关。
echo.

node "v1\server.js"

echo.
echo   服务已停止。按任意键关闭本窗口。
pause >nul
