# RoutineOS

RoutineOS is a personal routine, menu planning, inventory, shopping and notes app.

## Structure

- `backend/`: FastAPI backend for auth, Supabase access, routines, inventory and menu operations.
- `frontend/`: static frontend deployable on Netlify.
- `Dockerfile`: backend container for Render.
- `render.yaml`: Render blueprint for the backend service.
- `netlify.toml`: Netlify static site configuration.

## Required backend environment variables

Set these on Render, never commit real values:

- `SUPABASE_URL`
- `SUPABASE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CORS_ORIGINS`

## Frontend API URL

Set `window.ROUTINEOS_CONFIG.API_URL` in `frontend/config.js` to the deployed Render backend URL.
