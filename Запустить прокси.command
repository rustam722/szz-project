#!/bin/zsh
# 1. Сначала запусти прокси: "сзз выгрузка/start_proxy.command"
# 2. Потом двойной клик на этот файл — откроет сайт

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

clear
echo "================================================"
echo "  СЗЗ Инструмент"
echo "================================================"
echo ""

# Запускаем HTTP-сервер для сайта
python3 -m http.server 8080 --directory "$SCRIPT_DIR/public" &
SERVER_PID=$!
echo "  [✓] Сайт запущен на http://localhost:8080"
echo ""

# Проверяем прокси
if curl -s --max-time 2 http://127.0.0.1:8767/ping | grep -q '"ok"'; then
  echo "  [✓] Прокси найден на порту 8767"
else
  echo "  [!] Прокси не запущен!"
  echo "      Запусти: сзз выгрузка/start_proxy.command"
fi

echo ""
echo "  Открываем браузер..."
sleep 1
open "http://localhost:8080"

echo ""
echo "  Закрой это окно чтобы остановить сайт."
trap "kill $SERVER_PID 2>/dev/null" EXIT
wait $SERVER_PID
