#!/bin/zsh
SITE_DIR="$(cd "$(dirname "$0")" && pwd)/public"
PROXY_DIR="/Users/rustam/Downloads/сзз выгрузка"

clear
echo "=== СЗЗ Инструмент ==="
echo ""

# Останавливаем что было
lsof -ti tcp:8767,8080 | xargs kill -9 2>/dev/null; sleep 0.3

# Запускаем прокси через рабочий venv
source "$PROXY_DIR/.venv/bin/activate"
PORT=8767 USE_PYNSPD=1 PYNSPD_FALLBACK_UPSTREAM=0 NSPD_SSL_VERIFY=0 \
  PYNSPD_SRC_PATH="/Users/rustam/Downloads/pynspd-main/src" \
  python "$PROXY_DIR/proxy_final.py" >> "$PROXY_DIR/proxy_final.log" 2>&1 &
PROXY_PID=$!

# Ждём пока прокси поднимется
sleep 2
if curl -s --max-time 2 http://127.0.0.1:8767/ping | grep -q '"ok"'; then
  echo "[✓] Прокси запущен"
else
  echo "[!] Прокси не отвечает, смотри лог: $PROXY_DIR/proxy_final.log"
fi

# Запускаем сайт
python3 -m http.server 8080 --directory "$SITE_DIR" &>/dev/null &
SERVER_PID=$!
sleep 0.5

echo "[✓] Сайт: http://localhost:8080"
open "http://localhost:8080"

echo ""
echo "Закрой окно чтобы остановить всё."
trap "kill $PROXY_PID $SERVER_PID 2>/dev/null" EXIT
wait
