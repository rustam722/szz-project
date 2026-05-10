#!/bin/bash
# Двойной клик → запускает локальный прокси для СЗЗ-инструмента
# Требования: Python 3 (встроен в macOS 12+)

cd "$(dirname "$0")"

clear
echo "================================================"
echo "  СЗЗ Прокси — запускаем..."
echo "================================================"

if ! command -v python3 &>/dev/null; then
  echo ""
  echo "  ОШИБКА: python3 не найден."
  echo "  Скачай с https://python.org"
  echo ""
  read -p "  Нажми Enter для закрытия..."
  exit 1
fi

echo "  Python: $(python3 --version)"
echo ""

python3 proxy.py

echo ""
read -p "  Прокси остановлен. Нажми Enter для закрытия..."
