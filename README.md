# PetroFlow Lubricant ERP — separated Frontend + Backend

```
petroflow/
├── backend/    Node.js + Express + MongoDB (Mongoose) — plain JavaScript
└── frontend/   React + Vite + Tailwind + Zustand (same UI as before)
```

## 1. Backend

```bash
cd backend
cp .env.example .env        # set MONGODB_URI and JWT_SECRET
npm install
npm run dev                 # http://localhost:5000
```

- First start on an empty database loads the demo data automatically (`AUTO_SEED=true`).
- `npm run seed:reset` — wipe everything and reload demo data.
- `npm run migrate:sqlite -- /path/to/data/lubricant_erp.db --force` — import your OLD SQLite data
  (same ids, order numbers, payments). Needs Node 22.5+ (or `npm i better-sqlite3`).

Demo logins: `superadmin@lubricantdemo.com / Admin@123`, `admin@… / Admin@123`,
`accounts@… / Accounts@123`, `akash@… / Sales@123`, `production@… / Production@123`,
`dispatch@… / Dispatch@123`.

### Structure
```
backend/
├── server.js               start: connect DB -> bootstrap -> listen
└── src/
    ├── app.js              express app (cors, helmet, json, routes, errors)
    ├── config/db.js        mongoose connection
    ├── models/             one file per collection (numeric auto-increment `id`)
    ├── middleware/         auth (JWT + permissions), error handler
    ├── controllers/        auth, dashboard, order, packing, dispatch, payment, bill, ...
    ├── routes/index.js     every /api route in one place
    ├── utils/              helpers, audit log / notifications, query helpers
    ├── seed/               demo data, permission matrix, bootstrap
    └── scripts/            seed.js, migrate-sqlite.js
```

### Production
- Set a long random `JWT_SECRET`, `CORS_ORIGIN=https://your-frontend-domain`, `ALLOW_DEMO_RESET=false`, `AUTO_SEED=false`.
- `npm start` (or `pm2 start server.js --name petroflow-api`).

## 2. Frontend

```bash
cd frontend
cp .env.example .env        # VITE_API_URL=http://localhost:5000
npm install
npm run dev                 # http://localhost:5173
npm run build               # static files in dist/
```

- `src/store/authStore.ts` — Zustand auth store (login, logout, permissions). `useAuth()` works as before.
- `src/store/uiStore.ts` — Zustand navigation / sidebar state.
- `src/lib/api.ts` — `apiFetch()` adds the backend URL + token to every request.
- `VITE_DEMO_AUTO_LOGIN=true` brings back the old "auto login as Super Admin" demo behaviour.

## 3. Notes
- Every API URL and JSON response is the same as the old single-server app.
- Sales Persons page: totals are now the real sums (the old SQL multiplied them by the number of parties).
- Old login sessions are not valid after the switch — log in once again.
