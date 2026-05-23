import os
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
BACKEND_DIR = ROOT / "backend"
FRONTEND_DIR = ROOT / "frontend"
BACKEND_PORT = 8765
FRONTEND_PORT = 8766


def load_env():
    env_file = ROOT / "pantrypro.local.env"
    if not env_file.exists():
        print("File pantrypro.local.env mancante.")
        print("Serve per avviare Supabase in locale.")
        return False

    for line in env_file.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ[key.strip()] = value.strip()
    return True


def port_is_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.35)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def start_backend():
    if port_is_open(BACKEND_PORT):
        print(f"Backend gia attivo: http://127.0.0.1:{BACKEND_PORT}")
        return

    out = open(BACKEND_DIR / "uvicorn.out.log", "w", encoding="utf-8")
    err = open(BACKEND_DIR / "uvicorn.err.log", "w", encoding="utf-8")
    subprocess.Popen(
        [str(PYTHON), "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(BACKEND_PORT)],
        cwd=str(BACKEND_DIR),
        stdout=out,
        stderr=err,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS,
    )
    print(f"Backend avviato: http://127.0.0.1:{BACKEND_PORT}")


def start_frontend():
    if port_is_open(FRONTEND_PORT):
        print(f"Frontend gia attivo: http://127.0.0.1:{FRONTEND_PORT}")
        return

    subprocess.Popen(
        [str(PYTHON), "-m", "http.server", str(FRONTEND_PORT), "--bind", "127.0.0.1", "--directory", str(FRONTEND_DIR)],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS,
    )
    print(f"Frontend avviato: http://127.0.0.1:{FRONTEND_PORT}")


def run_backup():
    backup_script = BACKEND_DIR / "backup_pantrypro.py"
    if not backup_script.exists():
        return
    try:
        subprocess.run([str(PYTHON), str(backup_script)], cwd=str(ROOT), timeout=45)
    except Exception as exc:
        print(f"Backup saltato: {exc}")


def main():
    if not PYTHON.exists():
        print(f"Python virtualenv non trovato: {PYTHON}")
        return 1
    if not load_env():
        return 1

    run_backup()
    start_backend()
    start_frontend()

    time.sleep(2)
    url = f"http://127.0.0.1:{FRONTEND_PORT}/login.html"
    webbrowser.open(url)
    print("PantryPro pronto.")
    print(f"Apri: {url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
