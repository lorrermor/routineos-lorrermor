import os
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, Header, Body, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import httpx
from supabase import create_client, Client

import logica

# --- CONFIGURAZIONE ---
# Le credenziali vengono lette dalle variabili d'ambiente (sicuro per produzione)
# Su Render: Settings → Environment Variables
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


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Variabile ambiente mancante: {name}")
    return value


URL_SB = required_env("SUPABASE_URL")
KEY_SB = required_env("SUPABASE_KEY")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY", "")
CORS_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("CORS_ORIGINS", "http://127.0.0.1:8766,http://localhost:8766,http://127.0.0.1:5500,http://localhost:5500").split(",")
    if origin.strip()
]

supabase: Client = create_client(URL_SB, KEY_SB)
logica.supabase = supabase

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return response

stato_operazioni = {
    "data": "",
    "scarico_annullato": False
}

auth_rate_limits = {}


@app.middleware("http")
async def auth_rate_limit_middleware(request: Request, call_next):
    if request.method == "POST" and request.url.path in {"/auth/login", "/auth/register", "/auth/reset-password"}:
        now_ts = datetime.now().timestamp()
        client_ip = request.client.host if request.client else "unknown"
        key = f"{client_ip}:{request.url.path}"
        attempts = [ts for ts in auth_rate_limits.get(key, []) if now_ts - ts < 60]
        if len(attempts) >= 20:
            return JSONResponse(status_code=429, content={"detail": "Troppi tentativi. Aspetta un minuto e riprova."})
        attempts.append(now_ts)
        auth_rate_limits[key] = attempts
    return await call_next(request)

# -------------------------------------------------------
# UTILITY AUTH
# -------------------------------------------------------

def get_user_id(authorization: str = Header(None)) -> str:
    """
    Estrae e verifica il JWT dal header Authorization.
    Restituisce lo user_id (UUID) dell'utente autenticato.
    Lancia HTTPException 401 se il token è assente o non valido.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Token mancante o non valido.")
    
    token = authorization.split(" ")[1]
    
    try:
        # Supabase verifica il JWT e restituisce i dati utente
        user_response = supabase.auth.get_user(token)
        if not user_response or not user_response.user:
            raise HTTPException(status_code=401, detail="Token non valido.")
        return str(user_response.user.id)
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Autenticazione fallita: {str(e)}")


def get_supabase_for_user(authorization: str = Header(None)) -> Client:
    """
    Restituisce un client Supabase con il JWT dell'utente impostato.
    Questo permette a RLS di funzionare correttamente sulle tabelle protette.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Token mancante.")
    
    token = authorization.split(" ")[1]
    client = create_client(URL_SB, KEY_SB)
    client.postgrest.auth(token)
    return client


def get_auth_token(authorization: str = Header(None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Token mancante.")
    return authorization.split(" ")[1]


def rest_headers_for_user(token: str):
    return {
        "apikey": KEY_SB,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
    }


def rest_delete_user_row(table: str, nome: str, user_id: str, token: str):
    url = f"{URL_SB}/rest/v1/{table}"
    params = {
        "nome": f"eq.{nome}",
        "user_id": f"eq.{user_id}"
    }
    response = httpx.delete(url, params=params, headers=rest_headers_for_user(token), timeout=20)
    if response.status_code >= 400:
        raise HTTPException(status_code=500, detail=response.text)


def rest_delete_rows(table: str, filters: dict, token: str):
    url = f"{URL_SB}/rest/v1/{table}"
    params = {key: f"eq.{value}" for key, value in filters.items()}
    response = httpx.delete(url, params=params, headers=rest_headers_for_user(token), timeout=20)
    if response.status_code >= 400:
        raise HTTPException(status_code=500, detail=response.text)


def rest_insert_user_row(table: str, payload: dict, token: str):
    url = f"{URL_SB}/rest/v1/{table}"
    response = httpx.post(url, json=payload, headers=rest_headers_for_user(token), timeout=20)
    if response.status_code >= 400:
        raise HTTPException(status_code=500, detail=response.text)


def rest_select_user_rows(table: str, user_id: str, token: str, select: str = "*", extra_params: Optional[dict] = None):
    url = f"{URL_SB}/rest/v1/{table}"
    params = {
        "select": select,
        "user_id": f"eq.{user_id}"
    }
    if extra_params:
        params.update(extra_params)
    response = httpx.get(url, params=params, headers=rest_headers_for_user(token), timeout=20)
    if response.status_code >= 400:
        raise HTTPException(status_code=500, detail=response.text)
    return response.json()


def profile_config_key(user_id: str) -> str:
    return f"profile:{user_id}"


ALLOWED_USER_CONFIG_KEYS = {
    "dashboard_comments",
    "dashboard_notes",
    "sheets",
    "extra_shopping",
    "extra_shopping_columns",
    "stats",
    "justifications",
    "pending_tasks",
}


def user_config_key(user_id: str, key: str) -> str:
    if key not in ALLOWED_USER_CONFIG_KEYS:
        raise HTTPException(status_code=400, detail="Chiave configurazione non valida.")
    return f"user:{user_id}:{key}"


def load_profile_data(user_id: str, token: str) -> dict:
    rows = rest_select_user_rows(
        "config",
        user_id,
        token,
        "valore",
        {"chiave": f"eq.{profile_config_key(user_id)}"}
    )
    if not rows:
        return {}
    try:
        return json.loads(rows[0].get("valore") or "{}")
    except Exception:
        return {}


def load_user_metadata_profile(user) -> dict:
    metadata = getattr(user, "user_metadata", None) or {}
    if not isinstance(metadata, dict):
        return {}
    profile = metadata.get("pantrypro_profile") or {}
    return profile if isinstance(profile, dict) else {}


def save_profile_data(user_id: str, token: str, profile_data: dict):
    key = profile_config_key(user_id)
    rest_delete_rows("config", {"chiave": key, "user_id": user_id}, token)
    rest_insert_user_row("config", {
        "chiave": key,
        "valore": json.dumps(profile_data),
        "user_id": user_id
    }, token)


def update_supabase_user(token: str, payload: dict):
    response = httpx.put(
        f"{URL_SB}/auth/v1/user",
        json=payload,
        headers={
            "apikey": KEY_SB,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        timeout=20
    )
    if response.status_code >= 400:
        try:
            detail = response.json().get("msg") or response.json().get("message") or response.json().get("error_description") or response.text
        except Exception:
            detail = response.text
        raise HTTPException(status_code=400, detail=detail)
    return response.json()


def friendly_auth_error(error: Exception) -> str:
    raw = str(error)
    low = raw.lower()
    if "rate limit" in low:
        return "Troppi tentativi in poco tempo. Aspetta qualche minuto e riprova."
    if "invalid" in low and "email" in low:
        return "Email non valida o non accettata da Supabase."
    if "redirect" in low or "not allowed" in low:
        return "Supabase non consente ancora il link di recupero verso questa app. Aggiungi http://127.0.0.1:8766/reset-password.html tra i Redirect URLs del progetto Supabase."
    return raw


# -------------------------------------------------------
# MIDDLEWARE
# -------------------------------------------------------

@app.middleware("http")
async def db_session_middleware(request: Request, call_next):
    if request.method == "GET" and request.url.path == "/system/info":
        try:
            authorization = request.headers.get("authorization")
            if authorization and authorization.startswith("Bearer "):
                user_id = get_user_id(authorization)
                logica.check_daily_update(user_id)
        except Exception as e:
            print(f"Errore scarico automatico: {e}")
    response = await call_next(request)
    return response


# -------------------------------------------------------
# AUTH — Login e Registrazione
# -------------------------------------------------------

@app.post("/auth/register")
async def register(data: dict):
    """Registra un nuovo utente con email e password."""
    email = data.get("email")
    password = data.get("password")
    
    if not email or not password:
        raise HTTPException(status_code=400, detail="Email e password obbligatorie.")
    
    try:
        response = supabase.auth.sign_up({"email": email, "password": password})
        if response.user:
            # Crea la riga config per il nuovo utente
            logica.ensure_sync_config(str(response.user.id))
            return {
                "status": "success",
                "message": "Registrazione completata.",
                "user_id": str(response.user.id)
            }
        raise HTTPException(status_code=400, detail="Registrazione fallita.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/auth/login")
async def login(data: dict):
    """Autentica un utente e restituisce il token JWT."""
    email = data.get("email")
    password = data.get("password")
    
    if not email or not password:
        raise HTTPException(status_code=400, detail="Email e password obbligatorie.")
    
    try:
        response = supabase.auth.sign_in_with_password({"email": email, "password": password})
        if response.session:
            return {
                "status": "success",
                "access_token": response.session.access_token,
                "refresh_token": response.session.refresh_token,
                "user_id": str(response.user.id),
                "email": response.user.email
            }
        raise HTTPException(status_code=401, detail="Credenziali non valide.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/auth/refresh")
async def refresh_auth(data: dict):
    """Rinnova la sessione usando il refresh token Supabase."""
    refresh_token = (data.get("refresh_token") or "").strip()
    if not refresh_token:
        raise HTTPException(status_code=400, detail="Refresh token mancante.")

    try:
        response = supabase.auth.refresh_session(refresh_token)
        if response.session:
            return {
                "status": "success",
                "access_token": response.session.access_token,
                "refresh_token": response.session.refresh_token,
                "user_id": str(response.user.id),
                "email": response.user.email
            }
        raise HTTPException(status_code=401, detail="Sessione scaduta. Accedi di nuovo.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/auth/logout")
async def logout(authorization: str = Header(None)):
    """Invalida il token corrente."""
    try:
        supabase.auth.sign_out()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/auth/reset-password")
async def reset_password(data: dict):
    """Invia l'email Supabase per impostare una nuova password."""
    email = (data.get("email") or "").strip()
    redirect_to = (data.get("redirect_to") or "").strip()

    if not email:
        raise HTTPException(status_code=400, detail="Email obbligatoria.")

    try:
        if redirect_to:
            supabase.auth.reset_password_email(email, {"redirect_to": redirect_to})
        else:
            supabase.auth.reset_password_email(email)
        return {
            "status": "success",
            "message": "Email di recupero inviata. Se l'account esiste, apri il link ricevuto e imposta la nuova password dall'app."
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=friendly_auth_error(e))


@app.get("/profile")
async def get_profile(authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    token = get_auth_token(authorization)
    try:
        user_response = supabase.auth.get_user(token)
        user = user_response.user
        social = load_user_metadata_profile(user)
        if not social:
            social = load_profile_data(user_id, token)
        return {
            "user_id": user_id,
            "email": user.email if user else "",
            "created_at": str(getattr(user, "created_at", "") or ""),
            "user_code": f"PP-{user_id[:8].upper()}",
            "social": social
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/profile/social")
async def update_profile_social(data: dict, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    token = get_auth_token(authorization)
    profile_data = data.get("social", data)

    allowed = {
        "nickname", "bio", "location", "avatar", "cover_color",
        "visibility", "status", "links", "connections", "share_menu",
        "share_routines", "share_sottoroutines"
    }
    cleaned = {key: profile_data.get(key) for key in allowed if key in profile_data}

    if isinstance(cleaned.get("avatar"), str) and len(cleaned["avatar"]) > 350000:
        raise HTTPException(status_code=400, detail="Foto troppo grande. Scegli un'immagine piu leggera.")

    try:
        update_supabase_user(token, {"data": {"pantrypro_profile": cleaned}})
    except Exception:
        save_profile_data(user_id, token, cleaned)
    return {"status": "success", "social": cleaned}


@app.put("/profile/email")
async def update_profile_email(data: dict, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    token = get_auth_token(authorization)
    new_email = (data.get("email") or "").strip()
    if not new_email or "@" not in new_email:
        raise HTTPException(status_code=400, detail="Email non valida.")
    try:
        update_supabase_user(token, {"email": new_email})
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=400, detail=friendly_auth_error(e))
    return {
        "status": "success",
        "message": "Richiesta di cambio email inviata. Se Supabase richiede conferma, controlla la nuova casella email."
    }


@app.put("/profile/password")
async def update_profile_password(data: dict, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    token = get_auth_token(authorization)
    password = data.get("password") or ""
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="La password deve avere almeno 6 caratteri.")
    try:
        update_supabase_user(token, {"password": password})
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=400, detail=friendly_auth_error(e))
    return {"status": "success", "message": "Password aggiornata correttamente. La prossima volta potrai accedere con quella nuova."}


@app.get("/config/item/{key}")
async def get_user_config_item(key: str, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    token = get_auth_token(authorization)
    storage_key = user_config_key(user_id, key)
    rows = rest_select_user_rows(
        "config",
        user_id,
        token,
        "valore",
        {"chiave": f"eq.{storage_key}"}
    )
    if not rows:
        return {"status": "success", "key": key, "value": None}
    raw = rows[0].get("valore")
    try:
        value = json.loads(raw or "null")
    except Exception:
        value = raw
    return {"status": "success", "key": key, "value": value}


@app.put("/config/item/{key}")
async def save_user_config_item(key: str, data: dict, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    token = get_auth_token(authorization)
    storage_key = user_config_key(user_id, key)
    value = data.get("value")
    rest_delete_rows("config", {"chiave": storage_key, "user_id": user_id}, token)
    rest_insert_user_row("config", {
        "chiave": storage_key,
        "valore": json.dumps(value),
        "user_id": user_id
    }, token)
    return {"status": "success", "key": key}


@app.delete("/config/item/{key}")
async def delete_user_config_item(key: str, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    token = get_auth_token(authorization)
    storage_key = user_config_key(user_id, key)
    rest_delete_rows("config", {"chiave": storage_key, "user_id": user_id}, token)
    return {"status": "success", "key": key}


@app.delete("/profile/delete-account")
async def delete_account(user_id: str = Depends(get_user_id)):
    """Cancella i dati PantryPro dell'utente e, se possibile, anche l'utente Auth."""
    tables = [
        "completamenti",
        "logs",
        "inventario",
        "piani_settimanali",
        "routine_piani",
        "sottoroutine_piani",
        "config",
    ]

    errors = []
    for table in tables:
        try:
            supabase.table(table).delete().eq("user_id", user_id).execute()
        except Exception as e:
            errors.append(f"{table}: {str(e)}")

    auth_deleted = False
    if SERVICE_ROLE_KEY:
        try:
            admin_client = create_client(URL_SB, SERVICE_ROLE_KEY)
            admin_client.auth.admin.delete_user(user_id)
            auth_deleted = True
        except Exception as e:
            errors.append(f"auth: {str(e)}")

    status = "success" if auth_deleted and not errors else "partial"
    if not SERVICE_ROLE_KEY:
        errors.append("auth: SUPABASE_SERVICE_ROLE_KEY non configurata. L'utente Auth e l'email non possono essere eliminati dal backend.")

    return {
        "status": status,
        "auth_deleted": auth_deleted,
        "message": "Account eliminato completamente, inclusi login Supabase e dati PantryPro." if auth_deleted else "Dati PantryPro cancellati, ma il login Supabase non e stato eliminato. L'email resta occupata finche non configuri SUPABASE_SERVICE_ROLE_KEY e ripeti l'eliminazione.",
        "errors": errors
    }


# -------------------------------------------------------
# INVENTARIO
# -------------------------------------------------------

@app.get("/get-inventario")
def get_inventario(user_id: str = Depends(get_user_id)):
    risposta = supabase.table("inventario").select("*").eq("user_id", user_id).execute()
    inventario_formattato = {item["nome"]: item for item in risposta.data}
    return inventario_formattato


@app.post("/inventario/save")
async def save_inventario(data: dict, user_id: str = Depends(get_user_id)):
    lista_payload = data.get("inventario", [])
    if not isinstance(lista_payload, list):
        raise HTTPException(status_code=400, detail="Formato inventario non valido.")
    try:
        cleaned_items = []
        rename_pairs = []
        for raw_item in lista_payload:
            if not isinstance(raw_item, dict):
                continue
            nome = str(raw_item.get("nome") or "").strip().lower().replace(" ", "_")
            if not nome:
                continue
            original_nome = str(raw_item.get("original_nome") or "").strip().lower().replace(" ", "_")
            item = dict(raw_item)
            item.pop("id", None)
            item.pop("user_id", None)
            item.pop("original_nome", None)
            item["nome"] = nome
            item["user_id"] = user_id
            cleaned_items.append(item)
            if original_nome and original_nome != nome:
                rename_pairs.append((original_nome, nome))

        nomi_da_mantenere = [item["nome"] for item in cleaned_items]
        for old_name, _new_name in rename_pairs:
            supabase.table("inventario").delete()\
                .eq("user_id", user_id)\
                .eq("nome", old_name)\
                .execute()

        if data.get("delete_missing") is True:
            existing = supabase.table("inventario").select("nome")\
                .eq("user_id", user_id)\
                .execute()
            keep = set(nomi_da_mantenere)
            for row in existing.data or []:
                old_name = row.get("nome")
                if old_name and old_name not in keep:
                    supabase.table("inventario").delete()\
                        .eq("user_id", user_id)\
                        .eq("nome", old_name)\
                        .execute()
        if cleaned_items:
            for item in cleaned_items:
                esistente = supabase.table("inventario").select("nome")\
                    .eq("user_id", user_id)\
                    .eq("nome", item["nome"])\
                    .execute()
                if esistente.data:
                    supabase.table("inventario").update(item)\
                        .eq("user_id", user_id)\
                        .eq("nome", item["nome"])\
                        .execute()
                else:
                    supabase.table("inventario").insert(item).execute()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/inventario/delete/{nome}")
async def delete_ingrediente(nome: str, user_id: str = Depends(get_user_id)):
    try:
        supabase.table("inventario").delete().eq("nome", nome).eq("user_id", user_id).execute()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/inventario/acquista")
async def acquista_articoli(data: dict, user_id: str = Depends(get_user_id)):
    lista = data.get("acquisti", [])
    if logica.aggiorna_dopo_acquisto(lista, user_id):
        return {"status": "success"}
    raise HTTPException(status_code=500, detail="Errore durante l'aggiornamento acquisti")


# -------------------------------------------------------
# MENU (Piani Settimanali)
# -------------------------------------------------------

@app.get("/menu/list")
def list_plans(user_id: str = Depends(get_user_id)):
    risposta = supabase.table("piani_settimanali").select("nome").eq("user_id", user_id).execute()
    return [item["nome"] for item in risposta.data]


@app.get("/menu/{filename}")
def get_plan(filename: str, user_id: str = Depends(get_user_id)):
    risposta = supabase.table("piani_settimanali").select("dati")\
        .eq("nome", filename).eq("user_id", user_id).execute()
    if not risposta.data:
        raise HTTPException(status_code=404, detail="Piano non trovato.")
    return risposta.data[0]["dati"]


@app.delete("/menu/{filename}")
def delete_plan(filename: str, user_id: str = Depends(get_user_id)):
    try:
        supabase.table("piani_settimanali").delete()\
            .eq("nome", filename).eq("user_id", user_id).execute()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/menu/save")
async def save_plan(data: dict, user_id: str = Depends(get_user_id)):
    nome_piano = str(data.get("filename") or "").strip()
    menu_nuovo = data.get("menu", {})
    nuovo_inizio = menu_nuovo.get("inizio") or data.get("inizio")
    nuovo_fine = menu_nuovo.get("fine") or data.get("fine")

    if not nome_piano:
        raise HTTPException(status_code=400, detail="Nome piano mancante.")
    if not isinstance(menu_nuovo, dict):
        raise HTTPException(status_code=400, detail="Formato menu non valido.")
    if not nuovo_inizio or not nuovo_fine:
        raise HTTPException(status_code=400, detail="Date mancanti.")

    payload = {
        "nome": nome_piano,
        "inizio": nuovo_inizio,
        "fine": nuovo_fine,
        "dati": menu_nuovo,
        "user_id": user_id
    }
    try:
        esistente = supabase.table("piani_settimanali").select("id")\
            .eq("nome", nome_piano)\
            .eq("user_id", user_id)\
            .execute()
        if esistente.data:
            supabase.table("piani_settimanali").update(payload)\
                .eq("nome", nome_piano)\
                .eq("user_id", user_id)\
                .execute()
        else:
            supabase.table("piani_settimanali").insert(payload).execute()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def clean_json_text(text: str) -> str:
    value = (text or "").strip()
    if value.startswith("```"):
        value = value.strip("`")
        if value.lower().startswith("json"):
            value = value[4:].strip()
    start = value.find("{")
    end = value.rfind("}")
    if start >= 0 and end >= start:
        return value[start:end + 1]
    return value


def fallback_ai_menu_plan(request_text: str, inventario: dict, start_date: str, days: int, plan_count: int):
    ingredienti = list((inventario or {}).keys())
    base = [nome.replace("_", " ") for nome in ingredienti[:12]]
    if not base:
        base = ["riso", "pasta", "uova", "pollo", "legumi", "verdure", "frutta", "yogurt", "pane integrale"]

    try:
        start = datetime.strptime(start_date, "%Y-%m-%d").date()
    except Exception:
        start = datetime.now().date()
        start_date = start.isoformat()
    plan_count = max(1, min(int(plan_count or 1), 4))
    days = max(1, min(int(days or 7), 31))
    nomi_giorni = ["Lunedi", "Martedi", "Mercoledi", "Giovedi", "Venerdi", "Sabato", "Domenica"]
    meal_names = ["Colazione", "Pranzo", "Cena"]
    plans = []

    for p_idx in range(plan_count):
        pasti = []
        for offset in range(days):
            day = start + timedelta(days=offset)
            giorno = nomi_giorni[day.weekday()]
            for meal_idx, meal in enumerate(meal_names):
                ing_a = base[(offset + meal_idx + p_idx) % len(base)]
                ing_b = base[(offset + meal_idx + p_idx + 3) % len(base)]
                pasti.append({
                    "giorno": giorno,
                    "nome": meal,
                    "piatti": [{
                        "nome": f"{meal} bilanciata con {ing_a}",
                        "ingredienti": [
                            {"nome": ing_a.replace(" ", "_"), "qta": 120 if meal != "Colazione" else 60, "unita": "g"},
                            {"nome": ing_b.replace(" ", "_"), "qta": 80 if meal != "Colazione" else 40, "unita": "g"}
                        ]
                    }]
                })
        plans.append({
            "nome": f"Piano AI bozza {p_idx + 1}",
            "inizio": start_date,
            "fine": (start + timedelta(days=days - 1)).isoformat(),
            "pasti": pasti
        })

    missing = [] if inventario else [
        {"nome": item.replace(" ", "_"), "unita_misura": "g", "confezioni_attuali": 0, "confezioni_massime": 2, "alert": 1, "valore_per_confezione": 500}
        for item in base[:8]
    ]
    return {
        "status": "success",
        "source": "fallback",
        "message": "OPENAI_API_KEY non configurata: ho creato una bozza automatica modificabile.",
        "plans": plans,
        "inventory_suggestions": missing,
        "notes": [
            "Bozza generata senza modello AI esterno.",
            "Puoi salvarla e rifinirla nel planner menu."
        ]
    }


@app.post("/ai/menu-plan")
async def ai_menu_plan(data: dict, user_id: str = Depends(get_user_id)):
    request_text = (data.get("request") or "").strip()
    if not request_text:
        raise HTTPException(status_code=400, detail="Scrivi una richiesta per l'AI.")

    start_date = data.get("start_date") or datetime.now().strftime("%Y-%m-%d")
    try:
        datetime.strptime(start_date, "%Y-%m-%d")
    except Exception:
        start_date = datetime.now().strftime("%Y-%m-%d")
    days = max(1, min(int(data.get("days") or 7), 31))
    plan_count = max(1, min(int(data.get("plan_count") or 1), 4))
    use_inventory = data.get("use_inventory", True)

    inv_res = supabase.table("inventario").select("*").eq("user_id", user_id).execute()
    inventario = {item["nome"]: item for item in inv_res.data} if use_inventory else {}

    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        return fallback_ai_menu_plan(request_text, inventario, start_date, days, plan_count)

    schema_hint = {
        "status": "success",
        "source": "openai",
        "message": "breve messaggio in italiano",
        "plans": [{
            "nome": "Nome piano",
            "inizio": start_date,
            "fine": "YYYY-MM-DD",
            "pasti": [{
                "giorno": "Lunedi",
                "nome": "Colazione",
                "piatti": [{
                    "nome": "Nome piatto",
                    "ingredienti": [{"nome": "nome_ingrediente", "qta": 100, "unita": "g"}]
                }]
            }]
        }],
        "inventory_suggestions": [{
            "nome": "nome_ingrediente",
            "unita_misura": "g",
            "confezioni_attuali": 0,
            "confezioni_massime": 2,
            "alert": 1,
            "valore_per_confezione": 500
        }],
        "notes": ["note operative"]
    }

    prompt = f"""
Sei l'assistente AI di PantryPro. Genera piani menu in italiano seguendo la richiesta utente.
Devi rispondere SOLO con JSON valido, senza markdown.

Richiesta utente:
{request_text}

Parametri:
- data inizio: {start_date}
- giorni: {days}
- numero piani: {plan_count}
- usa inventario: {bool(use_inventory)}

Inventario disponibile, formato JSON:
{json.dumps(inventario, ensure_ascii=False)}

Regole:
- Se l'inventario e vuoto o insufficiente, proponi anche inventory_suggestions.
- Usa nomi ingredienti normalizzati con underscore nel campo nome.
- I piani devono essere compatibili con PantryPro: nome, inizio, fine, pasti, piatti, ingredienti.
- Rispetta diete, stagionalita, esclusioni e preferenze indicate dall'utente.
- Se la richiesta e mensile o stagionale, genera il numero di giorni richiesto fino al limite dato.
- Non dare consigli medici: se serve, aggiungi una nota prudente.

Schema atteso:
{json.dumps(schema_hint, ensure_ascii=False)}
"""

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                "https://api.openai.com/v1/responses",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": os.environ.get("OPENAI_MODEL", "gpt-5.4"),
                    "input": prompt,
                    "max_output_tokens": 9000
                }
            )
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail=response.text)
        payload = response.json()
        text = payload.get("output_text", "")
        if not text:
            for item in payload.get("output", []):
                for content in item.get("content", []):
                    if content.get("type") in ("output_text", "text"):
                        text += content.get("text", "")
        parsed = json.loads(clean_json_text(text))
        parsed.setdefault("status", "success")
        parsed.setdefault("source", "openai")
        parsed.setdefault("plans", [])
        parsed.setdefault("inventory_suggestions", [])
        parsed.setdefault("notes", [])
        return parsed
    except HTTPException:
        raise
    except Exception as e:
        fallback = fallback_ai_menu_plan(request_text, inventario, start_date, days, plan_count)
        fallback["message"] = f"AI esterna non disponibile o risposta non leggibile: {str(e)}. Ho creato una bozza automatica."
        return fallback


# -------------------------------------------------------
# ROUTINE
# -------------------------------------------------------

@app.get("/routine/list")
def list_routine(authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    righe = rest_select_user_rows(
        "routine_piani",
        user_id,
        get_auth_token(authorization),
        "nome,frequenza"
    )
    return [item["nome"] for item in righe]


@app.get("/routine/{nome}")
def get_routine(nome: str, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    righe = rest_select_user_rows(
        "routine_piani",
        user_id,
        get_auth_token(authorization),
        "dati",
        {"nome": f"eq.{nome}"}
    )
    if not righe:
        raise HTTPException(status_code=404, detail="Routine non trovata.")
    return righe[0]["dati"]


@app.post("/routine/save")
async def save_routine(data: dict, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    token = get_auth_token(authorization)
    nome = data.get("filename")
    original_filename = data.get("original_filename") or nome
    dati = data.get("routine", {})
    inizio = dati.get("inizio") or data.get("inizio")
    fine = dati.get("fine") or data.get("fine")
    frequenza = dati.get("frequenza", "giornaliera")

    if not inizio or not fine:
        raise HTTPException(status_code=400, detail="Date mancanti.")

    payload = {
        "nome": nome,
        "frequenza": frequenza,
        "inizio": inizio,
        "fine": fine,
        "dati": dati,
        "user_id": user_id
    }
    try:
        rest_delete_user_row("routine_piani", original_filename, user_id, token)
        rest_insert_user_row("routine_piani", payload, token)
        return {"status": "success"}
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/routine/{nome}")
def delete_routine(nome: str, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    try:
        rest_delete_user_row("routine_piani", nome, user_id, get_auth_token(authorization))
        return {"status": "success"}
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=str(e))


# -------------------------------------------------------
# SOTTOROUTINE
# -------------------------------------------------------

@app.get("/sottoroutine/list")
def list_sottoroutine(authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    return rest_select_user_rows(
        "sottoroutine_piani",
        user_id,
        get_auth_token(authorization),
        "nome,routine_parent"
    )


@app.get("/sottoroutine/{nome}")
def get_sottoroutine(nome: str, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    righe = rest_select_user_rows(
        "sottoroutine_piani",
        user_id,
        get_auth_token(authorization),
        "dati",
        {"nome": f"eq.{nome}"}
    )
    if not righe:
        raise HTTPException(status_code=404, detail="Sottoroutine non trovata.")
    return righe[0]["dati"]


@app.post("/sottoroutine/save")
async def save_sottoroutine(data: dict, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    token = get_auth_token(authorization)
    nome = data.get("filename")
    original_filename = data.get("original_filename") or nome
    dati = data.get("sottoroutine", {})
    inizio = dati.get("inizio") or data.get("inizio")
    fine = dati.get("fine") or data.get("fine")
    frequenza = dati.get("frequenza", "settimanale")
    routine_parent = dati.get("routine_parent", None)

    if not inizio or not fine:
        raise HTTPException(status_code=400, detail="Date mancanti.")

    payload = {
        "nome": nome,
        "routine_parent": routine_parent,
        "frequenza": frequenza,
        "inizio": inizio,
        "fine": fine,
        "dati": dati,
        "user_id": user_id
    }
    try:
        rest_delete_user_row("sottoroutine_piani", original_filename, user_id, token)
        rest_insert_user_row("sottoroutine_piani", payload, token)
        return {"status": "success"}
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/sottoroutine/{nome}")
def delete_sottoroutine(nome: str, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    try:
        rest_delete_user_row("sottoroutine_piani", nome, user_id, get_auth_token(authorization))
        return {"status": "success"}
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=str(e))


# -------------------------------------------------------
# COMPLETAMENTI (Dashboard spunte)
# -------------------------------------------------------

@app.get("/completamenti/oggi")
def get_completamenti_oggi(authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    """Restituisce tutti i completamenti dell'utente per oggi."""
    oggi = datetime.now().strftime("%Y-%m-%d")
    return rest_select_user_rows(
        "completamenti",
        user_id,
        get_auth_token(authorization),
        "*",
        {"data": f"eq.{oggi}"}
    )


@app.post("/completamenti/toggle")
async def toggle_completamento(data: dict, authorization: str = Header(None), user_id: str = Depends(get_user_id)):
    """
    Crea o aggiorna una spunta per un task.
    Payload: { tipo, piano_nome, item_id, completato }
    """
    oggi = datetime.now().strftime("%Y-%m-%d")
    payload = {
        "user_id": user_id,
        "data": oggi,
        "tipo": data.get("tipo"),
        "piano_nome": data.get("piano_nome"),
        "item_id": data.get("item_id"),
        "completato": data.get("completato", True)
    }
    try:
        token = get_auth_token(authorization)
        rest_delete_rows("completamenti", {
            "user_id": user_id,
            "data": oggi,
            "tipo": payload["tipo"],
            "piano_nome": payload["piano_nome"],
            "item_id": payload["item_id"],
        }, token)
        rest_insert_user_row("completamenti", payload, token)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# -------------------------------------------------------
# SYSTEM
# -------------------------------------------------------

@app.get("/system/log")
async def get_system_log(user_id: str = Depends(get_user_id)):
    try:
        return logica.get_log(user_id)
    except Exception as e:
        return []


@app.get("/system/info")
def get_info():
    now = datetime.now()
    mese = now.month
    mesi = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"]
    if mese in [12, 1, 2]:   stag = "Inverno"
    elif mese in [3, 4, 5]:  stag = "Primavera"
    elif mese in [6, 7, 8]:  stag = "Estate"
    else:                    stag = "Autunno"
    return {
        "stagione": stag,
        "data": f"{now.day} {mesi[mese - 1]} {now.year}",
        "giorno": logica.get_today_name()
    }


@app.get("/system/status-oggi")
async def get_status_oggi(user_id: str = Depends(get_user_id)):
    oggi = datetime.now().strftime("%Y-%m-%d")
    try:
        logica.ensure_sync_config(user_id)
        res = supabase.table("config").select("valore")\
            .eq("chiave", logica.get_sync_key(user_id)).execute()
        valore_db = res.data[0]["valore"] if res.data else ""
        annullato = (valore_db == f"{oggi}_annullato")
        return {"data": oggi, "scarico_annullato": annullato}
    except Exception:
        return {"data": oggi, "scarico_annullato": False}


@app.post("/system/rollback-today")
async def rollback_today(user_id: str = Depends(get_user_id)):
    try:
        if logica.undo_daily_update(user_id):
            return {"status": "success", "message": "Inventario ripristinato"}
        return {"status": "error", "message": "Nulla da annullare oggi"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/system/adjust-scarico")
async def adjust_scarico(data: dict, user_id: str = Depends(get_user_id)):
    azione = data.get("azione")
    ingredienti = data.get("ingredienti", [])
    if logica.modifica_scarico_ingredienti(ingredienti, azione, user_id):
        return {"status": "success"}
    raise HTTPException(status_code=400, detail="Nessun ingrediente valido da aggiornare.")


@app.post("/system/reset-sync")
async def reset_sync(user_id: str = Depends(get_user_id)):
    if logica.reset_sync_today(user_id):
        logica.check_daily_update(user_id, force=True)
        logica.aggiungi_al_log("RIPRISTINO SCARICO", "Scarico ricalcolato manualmente.", user_id)
        return {"status": "success"}
    return {"status": "error", "message": "Impossibile resettare lo scarico."}
