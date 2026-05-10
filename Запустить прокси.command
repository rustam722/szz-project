#!/bin/zsh
# Двойной клик → запускает прокси + локальный сайт
# Открой в браузере: http://localhost:8080

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_DIR="/Users/rustam/Downloads/сзз выгрузка"
VENV="$PROXY_DIR/.venv/bin/activate"

clear
echo "================================================"
echo "  СЗЗ Инструмент — запускаем..."
echo "================================================"
echo ""

# Проверяем venv
if [[ ! -f "$VENV" ]]; then
  echo "  ОШИБКА: .venv не найден в папке 'сзз выгрузка'"
  echo "  Убедись что папка 'сзз выгрузка' лежит в Downloads"
  echo ""
  read "?  Нажми Enter для закрытия..."
  exit 1
fi

# Останавливаем старый прокси если был
lsof -ti tcp:8767 | xargs kill -9 2>/dev/null || true
sleep 0.5

# Запускаем прокси с теми же настройками что работают
source "$VENV"
env PORT=8767 \
    USE_PYNSPD=1 \
    PYNSPD_FALLBACK_UPSTREAM=0 \
    NSPD_SSL_VERIFY=0 \
    PYNSPD_SRC_PATH="/Users/rustam/Downloads/pynspd-main/src" \
    python "$PROXY_DIR/proxy_final.py" &
PROXY_PID=$!
echo "  [✓] Прокси запущен на порту 8767 (PID $PROXY_PID)"

# Запускаем HTTP-сервер для сайта
python3 -m http.server 8080 --directory "$SCRIPT_DIR/public" &
SERVER_PID=$!
echo "  [✓] Сайт запущен"
echo ""
echo "================================================"
echo "  Открой в браузере:"
echo "  http://localhost:8080"
echo "================================================"
echo ""

# Открываем браузер
sleep 1
open "http://localhost:8080"

echo "  Закрой это окно чтобы остановить."
echo ""

trap "kill $PROXY_PID $SERVER_PID 2>/dev/null; echo 'Остановлено.'" EXIT
wait $PROXY_PID
