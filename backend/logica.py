import re
import os
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from supabase import create_client, Client

# --- CONFIGURAZIONE ---
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


load_local_env_from_launcher()


def required_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Variabile ambiente mancante: {name}")
    return value


URL_SB = required_env("SUPABASE_URL")
KEY_SB = required_env("SUPABASE_KEY")

supabase: Client = create_client(URL_SB, KEY_SB)
ROME_TZ = ZoneInfo("Europe/Rome")

# --- UTILITY ---
def local_now():
    return datetime.now(ROME_TZ)


def get_today_name():
    """Restituisce il nome del giorno in italiano."""
    giorni = ["Lunedi", "Martedi", "Mercoledi", "Giovedi", "Venerdi", "Sabato", "Domenica"]
    return giorni[local_now().weekday()]


def get_sync_key(user_id):
    return f"last_sync:{user_id}"


def get_pause_key(user_id):
    return f"auto_sync_paused:{user_id}"


def is_auto_sync_paused(user_id):
    try:
        res = supabase.table("config").select("valore")\
            .eq("chiave", get_pause_key(user_id))\
            .eq("user_id", user_id)\
            .execute()
        valore = res.data[0]["valore"] if res.data else ""
        return str(valore).lower() in ("1", "true", "si", "paused")
    except Exception as e:
        print(f"Errore lettura pausa scarico: {e}")
        return False


def set_auto_sync_paused(user_id, paused):
    pause_key = get_pause_key(user_id)
    try:
        res = supabase.table("config").select("chiave")\
            .eq("chiave", pause_key)\
            .eq("user_id", user_id)\
            .execute()
        valore = "true" if paused else "false"
        if res.data:
            supabase.table("config").update({"valore": valore})\
                .eq("chiave", pause_key)\
                .eq("user_id", user_id)\
                .execute()
        else:
            supabase.table("config").insert({
                "chiave": pause_key,
                "valore": valore,
                "user_id": user_id
            }).execute()
        return True
    except Exception as e:
        print(f"Errore salvataggio pausa scarico: {e}")
        return False


def ensure_sync_config(user_id):
    """Crea la configurazione sync per l'utente se non esiste ancora."""
    sync_key = get_sync_key(user_id)
    try:
        res = supabase.table("config").select("chiave")\
            .eq("chiave", sync_key)\
            .execute()
        if not res.data:
            supabase.table("config").insert({
                "chiave": sync_key,
                "valore": "",
                "user_id": user_id
            }).execute()
    except Exception as e:
        print(f"Errore ensure_sync_config: {e}")


# --- DATABASE OPERATIONS ---
def update_item_qty_db(nome, nuova_qta, user_id):
    """Aggiorna la quantità di un articolo su Supabase."""
    try:
        supabase.table("inventario")\
            .update({"confezioni_attuali": nuova_qta})\
            .eq("nome", nome)\
            .eq("user_id", user_id)\
            .execute()
    except Exception as e:
        print(f"Errore update_item_qty_db: {e}")


# --- GESTIONE LOG ---
def aggiungi_al_log(azione, dettagli, user_id):
    try:
        supabase.table("logs").insert({
            "azione": azione,
            "dettagli": dettagli,
            "user_id": user_id
        }).execute()
        print(f"Log inserito: {azione}")
    except Exception as e:
        print(f"Errore scrittura log: {e}")


def get_log(user_id):
    try:
        res = supabase.table("logs").select("*")\
            .eq("user_id", user_id)\
            .order("id", desc=True)\
            .limit(30)\
            .execute()

        if not res.data:
            return []

        log_formattato = []
        for l in res.data:
            raw_date = str(l.get('created_at', ''))
            try:
                dt_obj = datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
                if dt_obj.tzinfo is None:
                    dt_obj = dt_obj.replace(tzinfo=timezone.utc)
                data_it = dt_obj.astimezone(ROME_TZ).strftime("%d/%m/%Y %H:%M:%S")
            except:
                data_it = raw_date

            log_formattato.append({
                "id": l.get('id'),
                "data": data_it,
                "azione": str(l.get('azione', 'Azione')),
                "dettagli": str(l.get('dettagli', ''))
            })
        return log_formattato
    except Exception as e:
        print(f"ERRORE LETTURA LOG: {e}")
        return []


# --- GESTIONE SYNC GIORNALIERO ---
def check_daily_update(user_id, force=False):
    oggi_str = local_now().strftime("%Y-%m-%d")

    try:
        if not force and is_auto_sync_paused(user_id):
            return False
        ensure_sync_config(user_id)
        sync_key = get_sync_key(user_id)
        res_sync = supabase.table("config").select("valore")\
            .eq("chiave", sync_key)\
            .execute()
        contenuto = res_sync.data[0]["valore"] if res_sync.data else ""

        if not force and (contenuto == oggi_str or contenuto == f"{oggi_str}_annullato"):
            return False

        res = supabase.table("piani_settimanali").select("dati")\
            .lte("inizio", oggi_str)\
            .gte("fine", oggi_str)\
            .eq("user_id", user_id)\
            .execute()

        modificato = False
        if res.data:
            piano = res.data[0]["dati"]
            modificato = scarica_ingredienti(piano, user_id)
        supabase.table("config")\
            .update({"valore": oggi_str})\
            .eq("chiave", sync_key)\
            .execute()
        return modificato
    except Exception as e:
        print(f"Errore check_daily_update: {e}")
    return False


def reset_sync_today(user_id):
    """Resetta il sync giornaliero sul database."""
    try:
        ensure_sync_config(user_id)
        supabase.table("config")\
            .update({"valore": "reset"})\
            .eq("chiave", get_sync_key(user_id))\
            .execute()
        return True
    except Exception as e:
        print(f"Errore reset: {e}")
        return False


# --- LOGICA CORE ---
def scarica_ingredienti(piano, user_id):
    """Sottrae dall'inventario gli ingredienti previsti per oggi."""
    try:
        res = supabase.table("inventario").select("*")\
            .eq("user_id", user_id)\
            .execute()
        inventario = {item["nome"]: item for item in res.data}

        oggi_nome = get_today_name()
        pasti_oggi = [p for p in piano["pasti"] if p["giorno"] == oggi_nome]

        if not pasti_oggi:
            return False

        modificato = False
        for pasto in pasti_oggi:
            for piatto in pasto["piatti"]:
                for ing in piatto["ingredienti"]:
                    nome_chiave = re.sub(r'\s+', '_', ing["nome"].lower().strip())
                    if nome_chiave in inventario:
                        item = inventario[nome_chiave]
                        fattore = float(item.get("valore_per_confezione") or 1)
                        consumo = float(ing["qta"]) / fattore
                        nuova_qta = round(max(0, float(item["confezioni_attuali"]) - consumo), 3)
                        update_item_qty_db(nome_chiave, nuova_qta, user_id)
                        modificato = True

        if modificato:
            aggiungi_al_log("SCARICO", f"Scarico automatico ingredienti per {oggi_nome}", user_id)
        return modificato
    except Exception as e:
        print(f"Errore scarica_ingredienti: {e}")
        return False


def modifica_scarico_ingredienti(ingredienti, azione, user_id):
    """Aggiunge o sottrae scorte per una selezione del menu di oggi."""
    try:
        if azione not in ("annulla", "ripristina"):
            return False

        res = supabase.table("inventario").select("*")\
            .eq("user_id", user_id)\
            .execute()
        inventario = {item["nome"]: item for item in res.data}

        modificati = 0
        for ing in ingredienti or []:
            nome_k = re.sub(r'\s+', '_', str(ing.get("nome", "")).lower().strip())
            if not nome_k or nome_k not in inventario:
                continue

            try:
                qta = float(ing.get("qta") or 0)
            except (TypeError, ValueError):
                qta = 0
            if qta <= 0:
                continue

            item = inventario[nome_k]
            fattore = float(item.get("valore_per_confezione") or 1)
            delta = qta / fattore
            attuale = float(item.get("confezioni_attuali") or 0)
            nuova_qta = attuale + delta if azione == "annulla" else max(0, attuale - delta)
            nuova_qta = round(nuova_qta, 3)

            update_item_qty_db(nome_k, nuova_qta, user_id)
            inventario[nome_k]["confezioni_attuali"] = nuova_qta
            modificati += 1

        if modificati:
            label = "ANNULLAMENTO" if azione == "annulla" else "SCARICO"
            aggiungi_al_log(label, f"{azione.capitalize()} scarico parziale menu ({modificati} ingredienti).", user_id)
            return True
        return False
    except Exception as e:
        print(f"Errore modifica_scarico_ingredienti: {e}")
        return False


def undo_daily_update(user_id):
    """Annulla lo scarico di oggi restituendo le quantità al database."""
    oggi_str = local_now().strftime("%Y-%m-%d")
    try:
        ensure_sync_config(user_id)
        sync_key = get_sync_key(user_id)
        res_sync = supabase.table("config").select("valore")\
            .eq("chiave", sync_key)\
            .execute()
        ultimo_stato = res_sync.data[0]["valore"] if res_sync.data else ""

        if ultimo_stato != oggi_str:
            return False

        res_p = supabase.table("piani_settimanali").select("dati")\
            .lte("inizio", oggi_str)\
            .gte("fine", oggi_str)\
            .eq("user_id", user_id)\
            .execute()

        if res_p.data:
            piano_attivo = res_p.data[0]["dati"]
            res_inv = supabase.table("inventario").select("*")\
                .eq("user_id", user_id)\
                .execute()
            inventario = {item["nome"]: item for item in res_inv.data}

            pasti_oggi = [p for p in piano_attivo["pasti"] if p["giorno"] == get_today_name()]
            for pasto in pasti_oggi:
                for piatto in pasto["piatti"]:
                    for ing in piatto["ingredienti"]:
                        nome_k = re.sub(r'\s+', '_', ing["nome"].lower().strip())
                        if nome_k in inventario:
                            item = inventario[nome_k]
                            fattore = float(item.get("valore_per_confezione") or 1)
                            rimborso = float(ing["qta"]) / fattore
                            nuova_qta = round(float(item["confezioni_attuali"]) + rimborso, 3)
                            update_item_qty_db(nome_k, nuova_qta, user_id)

            supabase.table("config")\
                .update({"valore": f"{oggi_str}_annullato"})\
                .eq("chiave", sync_key)\
                .execute()
            aggiungi_al_log("ANNULLAMENTO", "Ripristinate scorte nel Database.", user_id)
            return True
    except Exception as e:
        print(f"Errore undo: {e}")
    return False


def aggiorna_dopo_acquisto(lista_acquisti, user_id):
    try:
        res = supabase.table("inventario").select("*")\
            .eq("user_id", user_id)\
            .execute()
        inventario = {item["nome"]: item for item in res.data}

        for acq in lista_acquisti:
            nome_originale = acq["nome"]
            if nome_originale in inventario:
                item_db = inventario[nome_originale]
                q_attuale = float(item_db.get("confezioni_attuali") or 0)
                q_da_aggiungere = float(acq.get("quantita", 0))
                nuova_qta = round(q_attuale + q_da_aggiungere, 3)
                update_item_qty_db(nome_originale, nuova_qta, user_id)
                aggiungi_al_log("ACQUISTO", f"Caricato {q_da_aggiungere} conf. di {nome_originale}", user_id)
            else:
                print(f"ERRORE: Prodotto '{nome_originale}' non trovato nel database!")

        return True
    except Exception as e:
        print(f"Errore acquisto: {e}")
        return False
