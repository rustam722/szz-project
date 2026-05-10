#!/usr/bin/env python3
"""СЗЗ Прокси — GUI для Windows"""
import subprocess, threading, os, sys, tkinter as tk
from tkinter import scrolledtext
from pathlib import Path

SCRIPT_DIR = Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent
PORT = 8767

# Пути для Windows
PROXY_FILE = SCRIPT_DIR / "proxy_final.py"
PYTHON     = sys.executable  # При сборке PyInstaller — встроенный Python

ENV = {
    **os.environ,
    "PORT": str(PORT),
    "USE_PYNSPD": "1",
    "PYNSPD_FALLBACK_UPSTREAM": "0",
    "NSPD_SSL_VERIFY": "0",
    "PYNSPD_SRC_PATH": str(SCRIPT_DIR / "pynspd" / "src"),
}

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("СЗЗ Прокси")
        self.resizable(False, False)
        self.configure(bg="#1e1e2e")
        self.proc = None
        self._build()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _build(self):
        top = tk.Frame(self, bg="#1e1e2e")
        top.pack(fill="x", padx=16, pady=8)
        self.dot = tk.Label(top, text="●", font=("Segoe UI", 22), fg="#f38ba8", bg="#1e1e2e")
        self.dot.pack(side="left")
        self.lbl = tk.Label(top, text="Прокси остановлен", font=("Segoe UI", 13, "bold"), fg="#cdd6f4", bg="#1e1e2e")
        self.lbl.pack(side="left", padx=10)

        self.btn = tk.Button(self, text="▶  Запустить",
                             font=("Segoe UI", 12, "bold"),
                             bg="#a6e3a1", fg="#1e1e2e",
                             activebackground="#94e2d5",
                             relief="flat", bd=0, padx=20, pady=8,
                             cursor="hand2", command=self._toggle)
        self.btn.pack(padx=16, pady=4, fill="x")

        tk.Label(self, text="Лог запросов:", font=("Segoe UI", 10),
                 fg="#6c7086", bg="#1e1e2e", anchor="w").pack(fill="x", padx=16)

        self.log = scrolledtext.ScrolledText(self, width=64, height=18,
                                             font=("Consolas", 10),
                                             bg="#181825", fg="#cdd6f4",
                                             relief="flat", bd=0, state="disabled")
        self.log.pack(padx=16, pady=(0, 16))
        self.log.tag_config("ok",    foreground="#a6e3a1")
        self.log.tag_config("feat",  foreground="#89dceb")
        self.log.tag_config("err",   foreground="#f38ba8")
        self.log.tag_config("muted", foreground="#6c7086")

    def _toggle(self):
        if self.proc and self.proc.poll() is None:
            self._stop()
        else:
            self._start()

    def _start(self):
        # Убиваем старый процесс на порту (Windows)
        subprocess.run(f'for /f "tokens=5" %a in (\'netstat -aon ^| find ":{PORT}"\') do taskkill /F /PID %a',
                       shell=True, capture_output=True)
        try:
            self.proc = subprocess.Popen(
                [PYTHON, str(PROXY_FILE)],
                env=ENV,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True, bufsize=1,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        except Exception as e:
            self._append(f"Ошибка: {e}\n", "err"); return

        self.dot.config(fg="#a6e3a1")
        self.lbl.config(text=f"Прокси работает — порт {PORT}")
        self.btn.config(text="■  Остановить", bg="#f38ba8")
        self._append(f"Прокси запущен (PID {self.proc.pid})\n", "ok")
        threading.Thread(target=self._read_log, daemon=True).start()

    def _stop(self):
        if self.proc:
            self.proc.terminate(); self.proc = None
        self.dot.config(fg="#f38ba8")
        self.lbl.config(text="Прокси остановлен")
        self.btn.config(text="▶  Запустить", bg="#a6e3a1")
        self._append("Прокси остановлен\n", "err")

    def _read_log(self):
        for line in self.proc.stdout:
            line = line.rstrip()
            if "features=" in line:
                n = line.split("features=")[-1].split()[0]
                self._append(line + "\n", "feat" if int(n) > 0 else "muted")
            elif "error" in line.lower():
                self._append(line + "\n", "err")
            elif "/ping" in line:
                self._append(line + "\n", "muted")
            else:
                self._append(line + "\n", "ok")

    def _append(self, text, tag="ok"):
        self.log.config(state="normal")
        self.log.insert("end", text, tag)
        self.log.see("end")
        self.log.config(state="disabled")

    def _on_close(self):
        self._stop(); self.destroy()

if __name__ == "__main__":
    App().mainloop()
