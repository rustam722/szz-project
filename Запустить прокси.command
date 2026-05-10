#!/bin/bash
# Двойной клик → запускает прокси + локальный сайт
# Открой в браузере: http://localhost:8080

cd "$(dirname "$0")"

clear
echo "================================================"
echo "  СЗЗ Инструмент — запускаем..."
echo "================================================"
echo ""

if ! command -v python3 &>/dev/null; then
  echo "  ОШИБКА: python3 не найден."
  echo "  Скачай с https://python.org"
  echo ""
  read -p "  Нажми Enter для закрытия..."
  exit 1
fi

echo "  Python: $(python3 --version)"
echo ""

# Запускаем прокси в фоне
python3 proxy.py &
PROXY_PID=$!
echo "  [✓] Прокси запущен (PID $PROXY_PID)"

# Запускаем локальный HTTP-сервер для сайта
python3 -m http.server 8080 --directory public &
SERVER_PID=$!
echo "  [✓] Сайт запущен"
echo ""
echo "================================================"
echo "  Открой в браузере:"
echo "  http://localhost:8080"
echo "================================================"
echo ""

# Открываем браузер автоматически
sleep 1
open "http://localhost:8080" 2>/dev/null || true

echo "  Нажми Ctrl+C или закрой окно чтобы остановить."
echo ""

# Ждём и останавливаем оба процесса при выходе
trap "kill $PROXY_PID $SERVER_PID 2>/dev/null; echo ''; echo '  Остановлено.'" EXIT
wait $PROXY_PID
