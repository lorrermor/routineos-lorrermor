import json
import os
from datetime import datetime
from pathlib import Path

from supabase import create_client


TABLES = [
    "inventario",
    "piani_settimanali",
    "routine_piani",
    "sottoroutine_piani",
    "completamenti",
    "config",
    "logs",
]


def load_local_env_from_launcher():
    root = Path(__file__).resolve().parents[1]
    files = [root / "pantrypro.local.env", root / "avvia-pantrypro.bat"]
    for file in files:
        if not file.exists():
            continue
        for line in file.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            if line.lower().startswith('set "'):
                key_value = line[5:-1] if line.endswith('"') else line[5:]
            else:
                key_value = line
            key, value = key_value.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def backup_table(client, table):
    response = client.table(table).select("*").execute()
    return response.data or []


def main():
    load_local_env_from_launcher()
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
    if not url or not key:
        print("Backup saltato: variabili Supabase mancanti.")
        return

    preferred_dir = Path(__file__).resolve().parents[1] / "backups"
    fallback_dir = Path(os.environ.get("PANTRYPRO_BACKUP_DIR") or (Path.home() / "Documents" / "Codex" / "PantryPro Backups"))
    try:
        preferred_dir.mkdir(exist_ok=True)
        backup_dir = preferred_dir
    except PermissionError:
        fallback_dir.mkdir(exist_ok=True)
        backup_dir = fallback_dir
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    output = backup_dir / f"pantrypro_backup_{stamp}.json"

    client = create_client(url, key)
    data = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "project_url": url,
        "tables": {},
    }

    for table in TABLES:
        try:
            data["tables"][table] = backup_table(client, table)
        except Exception as exc:
            data["tables"][table] = {"backup_error": str(exc)}

    output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Backup creato: {output}")


if __name__ == "__main__":
    main()
