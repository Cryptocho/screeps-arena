#!/bin/sh
# M2/S0+S5 冒烟：真实 main.mjs 起服 → HTTP 面 → 建局/settle（journal 无残留）→
# 预置 journal 重启 → interrupted 恢复闭环（journal-restored=1 + 相位还原）。
# 说明：start 门槛 = 全席位提交过代码（Agent 工具面，无 HTTP 提交端点——公平边界），
# 冒烟无 Agent，故 started 相位由单测覆盖（journal.test.ts），此处验证 settle/恢复两路径。
DATA=/tmp/m2-smoke-data
LOG=/tmp/m2-main.log
cd /home/cryptocho/workspace/screeps-arena || exit 1
rm -rf "$DATA" "$LOG"

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
sleep 1
LEFT=$(ls "$DATA/journal/matches" 2>/dev/null | wc -l)
[ "$LEFT" = "0" ] && echo 'PASS: journal lifecycle clean (no residue after settle)' || { echo "FAIL: journal left=$LEFT"; exit 1; }

pkill -f "main.mjs --port 8899"
sleep 3

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

fnm exec --using=22 -- node dist/server/main.mjs --port 8899 --data-dir "$DATA" > "$LOG.2" 2>&1 &
MAIN_PID=$!
i=0
while [ $i -lt 120 ]; do
  grep -q 'journal-restored=' "$LOG.2" 2>/dev/null && break
  kill -0 $MAIN_PID 2>/dev/null || { echo 'FAIL: main died on restore'; tail -20 "$LOG.2"; exit 1; }
  sleep 2
  i=$((i+1))
done
grep -q 'journal-restored=1' "$LOG.2" && echo 'PASS: journal-restored=1' || { echo 'FAIL: not restored'; tail -30 "$LOG.2"; exit 1; }
grep -q 'restored match minterrupted at phase roundBreak round 2' "$LOG.2" && echo 'PASS: restored at roundBreak round 2' || { echo 'FAIL: wrong restore point'; grep journal "$LOG.2"; exit 1; }

V=$(curl -sf "http://127.0.0.1:8899/api/matches/minterrupted")
printf '%s' "$V" | grep -q '"phase":"roundBreak"' && echo 'PASS: HTTP sees restored match' || { echo "FAIL: bad view: $V"; exit 1; }
printf '%s' "$V" | grep -q '"roundIndex":2' && echo 'PASS: roundIndex preserved' || { echo "FAIL: roundIndex lost: $V"; exit 1; }

pkill -f "main.mjs --port 8899" 2>/dev/null
echo 'SMOKE DONE'
