#!/usr/bin/env bash
# M0 spike 可复现脚本：从零装一个 Screeps 私服并跑通 arena 全链路。
# 产物：~/screeps-worlds/dev-world（数据目录）、21099(HTTP)/21100(CLI) 上的私服。
# 用法：bash scripts/m0-spike.sh   （幂等：已安装则跳过安装，已播种则跳过播种）
set -euo pipefail

WORLD="${HOME}/screeps-worlds/dev-world"
NODE24="${HOME}/screeps-worlds/node24"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT=21099 CLI_PORT=21100

echo "== [0/6] node 24 便携运行时（仅私服用；系统 node 26 无法编译 pinned isolated-vm）=="
if [ ! -x "${NODE24}/bin/node" ]; then
  mkdir -p "${HOME}/screeps-worlds"
  curl -fsSLO https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz
  tar -xf node-v24.20.0-linux-x64.tar.xz -C "${HOME}/screeps-worlds"
  mv "${HOME}/screeps-worlds/node-v24.20.0-linux-x64" "${NODE24}"
  rm -f node-v24.20.0-linux-x64.tar.xz
fi
export PATH="${NODE24}/bin:${PATH}"

echo "== [1/6] world 目录 =="
mkdir -p "${WORLD}/logs"
[ -f "${WORLD}/package.json" ] || echo '{"name":"dsh-screeps-dev-world","version":"0.0.1","private":true}' > "${WORLD}/package.json"
cd "${WORLD}"

echo "== [2/6] 安装 screeps@4.3.0（C++ 编译约 2-8 分钟；npm 门禁：--allow-git + install-scripts approve）=="
if [ ! -d node_modules/@screeps/driver ]; then
  npm install screeps@4.3.0 --allow-git=all --loglevel=warn
  npm install-scripts approve screeps @screeps/driver isolated-vm uglifyjs-webpack-plugin es5-ext
  npm rebuild
fi

echo "== [3/6] arena mod + mods.json =="
cp "${REPO}/screeps-mod/arena.js" "${WORLD}/arena.js"
cat > "${WORLD}/mods.json" <<'EOF'
{ "mods": ["arena.js"] }
EOF

echo "== [4/6] 世界播种（首启必需：全新 db.json 会让 storage 崩溃，resetAllData 的 loadJSON 是唯一播种路径）=="
if [ ! -s db.json ]; then
  node -e "
    const loki=require('lokijs'), fs=require('fs');
    const db=new loki(process.env.HOME+'/screeps-worlds/dev-world/db.json',{autosave:false});
    db.loadJSON(fs.readFileSync('node_modules/@screeps/storage/db.original.json','utf8'));
    db.save(); console.log('seeded');
  "
fi

echo "== [5/6] 启动（前台运行；Ctrl-C 停止）=="
echo "   HTTP http://127.0.0.1:${PORT}/api/game/time ; CLI telnet 127.0.0.1 ${CLI_PORT}"
exec ./node_modules/.bin/screeps start \
  --port ${PORT} --host 127.0.0.1 \
  --cli_port ${CLI_PORT} --cli_host 127.0.0.1 \
  --db "${WORLD}/db.json" --logdir "${WORLD}/logs" \
  --modfile mods.json \
  --assetdir node_modules/@screeps/launcher/init_dist/assets \
  --runner_threads 2 --processors_cnt 1 --log_console
