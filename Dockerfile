FROM python:3.11-slim

WORKDIR /app

# Copia i requirements e installa le dipendenze
COPY backend/requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# Copia il backend (inclusi i file JSON)
COPY backend/ .

# Crea un utente non-root e assegna i permessi (gira tutto come appuser)
RUN adduser --disabled-password --gecos '' appuser \
    && chown -R appuser:appuser /app

USER appuser

# Espone una porta di default (documentativa). Render fornisce $PORT.
EXPOSE 10000

# Avvia uvicorn usando la PORT passata dall'ambiente (se non presente usa 10000)
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-10000}"]