#!/bin/sh
# M2/S0+S5 冒烟：真实 main.mjs 起服 → HTTP 面 → 建局/settle（journal 无残留）→
# 预置 journal 重启 → interrupted 恢复闭环（journal-restored=1 + 相位还原）。
# 说明：start 门槛 = 全席位提交过代码（Agent 工具面，无 HTTP 提交端点——公平边界），
# 冒烟无 Agent，故 started 相位由单测覆盖（journal.test.ts），此处验证 settle/恢复两路径。
#
# 私服复用（M6 后补）：冷装私服要 npm install + native 编译（isolated-vm 等）≈13 分钟，
# 超过本脚本 10 分钟就绪窗口 → 每次必挂。安装器本身有指纹门（serverDir/node_modules/
# .screeps-arena-server.json 与 {screepsVersion,simplebot,nodeVersion} 匹配即 skip npm
# install；runtime 侧 .screeps-arena-ok marker 幂等），故此处把「预装模板」reflink 克隆
# 进 $DATA：btrfs CoW 秒级（实测 412MB/0.9s），且写入不回污染模板。模板缺失则自愈
# （--install-only 冷装一次）。注意 $DATA 必须在支持 reflink 的 fs 上（/tmp 是 tmpfs——
# 既不支持 reflink 又随重启丢失，正是原先每次重装的原因）；不支持 reflink 时 cp 自动
# 退化为全量复制（仍只需数秒）。db.json 必须不在模板里——installer 会从
# @screeps/storage/db.original.json 重新播种干净世界。
DATA=${SMOKE_DATA:-$HOME/.cache/screeps-arena-smoke/data}
TPL=${SMOKE_TEMPLATE:-$HOME/.cache/screeps-arena-smoke/template}
LOG=/tmp/m2-main.log
cd /home/cryptocho/workspace/screeps-arena || exit 1
rm -rf "$DATA" "$LOG"

if [ ! -f "$TPL/server/node_modules/.screeps-arena-server.json" ]; then
  echo "smoke: template missing at $TPL — provisioning (one-off, ≈13min)"
  rm -rf "$TPL"
  fnm exec --using=22 -- node dist/server/main.mjs --install-only --data-dir "$TPL" || exit 1
  rm -f "$TPL/server/db.json" # 世界库不入模板：每 run 重新播种干净世界
fi
mkdir -p "$DATA"
cp -a --reflink=auto "$TPL/server" "$DATA/server"
cp -a --reflink=auto "$TPL/runtime" "$DATA/runtime"

fnm exec --using=22 -- node dist/server/main.mjs --port 8899 --data-dir "$DATA" > "$LOG" 2>&1 &
MAIN_PID=$!
trap 'pkill -f "main.mjs --port 8899" 2>/dev/null' EXIT

i=0
while [ $i -lt 120 ]; do
  grep -q 'server ready' "$LOG" 2>/dev/null && break
  kill -0 $MAIN_PID 2>/dev/null || { echo 'FAIL: main died'; tail -20 "$LOG"; exit 1; }
  sleep 5
  i=$((i+1))
done
grep -q 'server ready' "$LOG" || { echo 'FAIL: server not ready in 10min'; tail -20 "$LOG"; exit 1; }
echo 'PASS: server ready'

curl -sf http://127.0.0.1:8899/api/world > /dev/null && echo 'PASS: GET /api/world'

M=$(curl -sf -X POST http://127.0.0.1:8899/api/matches -H 'content-type: application/json' \
  -d '{"players":[{"seatId":"sa","username":"sa"},{"seatId":"sb","username":"sb"}]}') || { echo 'FAIL: create'; exit 1; }
ID=$(printf '%s' "$M" | fnm exec --using=22 -- node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).id))')
echo "PASS: match created id=$ID"

curl -sf -X POST "http://127.0.0.1:8899/api/matches/$ID/settle" > /dev/null && echo 'PASS: settle (creating→settled)'
# M3：teardown 异步执行（prepare 先生成房间 + restart，给足窗口）
sleep 20
LEFT=$(ls "$DATA/journal/matches" 2>/dev/null | wc -l)
[ "$LEFT" = "0" ] && echo 'PASS: journal lifecycle clean (no residue after settle)' || { echo "FAIL: journal left=$LEFT"; exit 1; }
H=$(curl -sf http://127.0.0.1:8899/api/history)
printf '%s' "$H" | grep -q "\"id\":\"$ID\"" && printf '%s' "$H" | grep -q '"teardown":"done"' \
  && echo 'PASS: history recorded + teardown done' || { echo "FAIL: history bad: $H"; exit 1; }

# M3/D4：settle 拆解后换席位再建局成功（M2 边界消除的端到端证明）
M2=$(curl -sf -X POST http://127.0.0.1:8899/api/matches -H 'content-type: application/json' \
  -d '{"players":[{"seatId":"sc","username":"sc"},{"seatId":"sd","username":"sd"}]}') || { echo 'FAIL: create after settle (pool not released)'; exit 1; }
ID2=$(printf '%s' "$M2" | fnm exec --using=22 -- node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).id))')
echo "PASS: match re-created with new seats after teardown id=$ID2"
sleep 20
curl -sf -X POST "http://127.0.0.1:8899/api/matches/$ID2/settle" > /dev/null && echo 'PASS: settle #2'
sleep 3

pkill -f "main.mjs --port 8899"
# 等旧进程真正退出再起第二个（SIGTERM 现在是优雅路径：pause → autosave 10.5s → SIGTERM
# 进程组 → 宽限，最长 ≈19s；固定 sleep 3 会让第二次启动撞 8899 端口 → main 早退）
wait_gone() {
  _i=0
  while [ $_i -lt 90 ]; do
    pgrep -f "main.mjs --port 8899" > /dev/null 2>&1 || return 0
    sleep 1
    _i=$((_i + 1))
  done
  return 1
}
wait_gone || { echo 'FAIL: old main still alive after 90s'; exit 1; }
sleep 1

# 预置 roundBreak 相位的 journal（模拟中断局），重启验证恢复闭环
mkdir -p "$DATA/journal/matches"
cat > "$DATA/journal/matches/minterrupted.json" <<'EOF'
{
  "id": "minterrupted",
  "config": { "seats": 2, "roundMs": 60000, "roundBreakTimeoutMs": 300000, "maxRounds": 8 },
  "players": [
    { "seatId": "sa", "username": "sa", "ready": false, "code": { "main": "module.exports.loop = function () {}" } },
    { "seatId": "sb", "username": "sb", "ready": false }
  ],
  "seatUsers": {},
  "rooms": { "sa": "E5N5", "sb": "E7N5" },
  "state": { "createdAt": 1, "phase": "roundBreak", "roundIndex": 2, "roundBreakSince": 100, "errors": [] }
}
EOF

# M3/D3：预置一条 teardown:pending 的 history（模拟「settle 落账后、拆解完成前崩溃」），
# 重启后应被幂等补拆解（teardown-recovered=1）
mkdir -p "$DATA/history"
cat > "$DATA/history/matches.jsonl" <<EOF
{"id":"mpending","config":{"seats":2,"roundMs":60000,"roundBreakTimeoutMs":300000,"maxRounds":8},"winner":null,"settleReason":"manual","scores":null,"roundIndex":0,"createdAt":1,"settledAt":2,"seatUsers":{"sz":"agent_ghost"},"rooms":{"sz":"E9N9"},"teardown":"pending"}
EOF

fnm exec --using=22 -- node dist/server/main.mjs --port 8899 --data-dir "$DATA" > "$LOG.2" 2>&1 &
MAIN_PID=$!
i=0
while [ $i -lt 120 ]; do
  grep -q 'teardown-recovered=' "$LOG.2" 2>/dev/null && break
  kill -0 $MAIN_PID 2>/dev/null || { echo 'FAIL: main died on restore'; tail -20 "$LOG.2"; exit 1; }
  sleep 2
  i=$((i+1))
done
grep -q 'teardown-recovered=1' "$LOG.2" && echo 'PASS: teardown-recovered=1 (pending replayed)' || { echo 'FAIL: teardown not recovered'; grep -i teardown "$LOG.2"; exit 1; }
i=0
while [ $i -lt 120 ]; do
  grep -q 'journal-restored=' "$LOG.2" 2>/dev/null && break
  sleep 2
  i=$((i+1))
done
grep -q 'journal-restored=1' "$LOG.2" && echo 'PASS: journal-restored=1' || { echo 'FAIL: not restored'; tail -30 "$LOG.2"; exit 1; }
grep -q 'restored match minterrupted at phase roundBreak round 2' "$LOG.2" && echo 'PASS: restored at roundBreak round 2' || { echo 'FAIL: wrong restore point'; grep journal "$LOG.2"; exit 1; }

V=$(curl -sf "http://127.0.0.1:8899/api/matches/minterrupted")
printf '%s' "$V" | grep -q '"phase":"roundBreak"' && echo 'PASS: HTTP sees restored match' || { echo "FAIL: bad view: $V"; exit 1; }
printf '%s' "$V" | grep -q '"roundIndex":2' && echo 'PASS: roundIndex preserved' || { echo "FAIL: roundIndex lost: $V"; exit 1; }

pkill -f "main.mjs --port 8899" 2>/dev/null
# 等优雅关停收尾（否则私服进程组会留成孤儿，脚本返回时端口仍被占）
wait_gone || echo 'WARN: main still alive after 90s (children may linger)'
echo 'SMOKE DONE'
