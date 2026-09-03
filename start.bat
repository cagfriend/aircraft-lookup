@echo off
chcp 65001 >nul
rem 一键启动脚本（Windows CMD），自动把 Node 目录加入 PATH
set "PATH=D:\新建文件夹 (4);%PATH%"
cd /d "%~dp0"
echo ✈ 正在启动服务器：http://127.0.0.1:3000
echo   停止：关闭本窗口或按 Ctrl + C
node server.js
pause
