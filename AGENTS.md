# PostRE — AGENTS.md

- Dev server on **port 5500**: `npm run dev`
- DB setup order: `npm run db:push` then `npm run db:seed`
- Build includes `prisma generate` (don't forget after schema changes)
- Prisma: SQLite at `prisma/dev.db`, single `DATABASE_URL="file:./dev.db"` in `.env`
- Tests: `npm test` (Vitest), only `src/**/*.test.ts`, **node** environment (no jsdom)
- Path alias `@/*` → `./src/*`
- API routes are all `force-dynamic` (prevents static render)
- Single huge client component: `src/components/PostreApp.tsx` (~2800 lines, `"use client"`)
- Four variable scopes resolved server-side in order: request > collection > environment > global
- ESLint: `no-explicit-any` off, unused vars warn with `_` prefix ignore
- cURL ↔ request roundtrip: `curl.ts` (parse & generate)
- Postman import: v2.1 collections and environments via `postman-importer.ts`
- Schema models: Collection, Folder, Request, Environment, Variable, HistoryEntry, ImportRecord
