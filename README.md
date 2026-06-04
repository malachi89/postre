# Postre

Postre is a local, personal Postman-like HTTP client. It runs on localhost, stores data in SQLite, and executes HTTP requests from the local Next.js backend so browser CORS does not block personal API work.

## Stack

- Next.js App Router, React, TypeScript
- Tailwind CSS
- SQLite with Prisma
- Vitest for unit tests

## Local Setup

```bash
npm install
npm run db:push
npm run db:seed
npm run dev
```

Open http://localhost:5500.

## Scripts

```bash
npm run dev      # local app on port 5500
npm run build    # Prisma client generation + production build
npm run start    # production app on port 5500
npm run lint     # ESLint
npm run test     # unit tests
npm run db:push  # sync SQLite schema
npm run db:seed  # optional demo data
```

## MVP Scope

Implemented in the first MVP:

- Create collections and requests.
- Edit method, URL, headers, query params, and raw body.
- Global variables and environment variables with `{{variable}}` syntax.
- Active environment selector.
- Execute requests from the local backend.
- View status, timing, size, headers, and response body.
- Save execution history with large response truncation.
- Import basic Postman Collection v2.1 and Postman Environment JSON.
- Preserve original imported JSON and unsupported fields as metadata.

## Next Steps

- Multipart with files.
- OAuth2.
- Pre-request and test scripts.
- More complete tests and browser-level UI checks.
- Export back to Postman format.
- Electron or Tauri packaging.
- Windows autostart.
