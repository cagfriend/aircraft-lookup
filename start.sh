#!/usr/bin/env bash
# 一键启动脚本（Git Bash / Linux / macOS）
# 本机 Node 装在非 PATH 目录，这里手动加入后启动项目
export PATH="D:/新建文件夹 (4):$PATH"
cd "$(dirname "$0")"
echo "✈ 正在启动服务器：http://127.0.0.1:3000"
echo "   停止：按 Ctrl + C"
node server.js
