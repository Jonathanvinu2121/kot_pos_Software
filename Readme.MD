# Restaurant POS / KOT — Offline-First Sync Engine

A production-style restaurant point-of-sale and kitchen order ticket (KOT) system, built to demonstrate **real offline-first architecture with hand-rolled conflict resolution** — not a generic CRUD app.

## The core idea

Restaurant orders touched by multiple offline devices create genuine conflicts: what happens when one waiter adds an item to a table's order while another cancels it, and neither knew about the other's change? This project answers that with a deterministic, from-scratch conflict classifier — no CRDT library, because the operations here are a small, known set of business actions (not free-form data), so a domain-specific classifier can safely tell the difference between "these can auto-merge," "these need a lightweight flag," and "this must never be silently resolved."

**Why Postgres *and* MongoDB:** Postgres answers "what is true right now." MongoDB holds an append-only event log answering "what happened and in what order" — that log *is* the sync mechanism, not just an audit nicety.

Full design rationale, data model, and sync protocol are documented in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Stack

Node.js, Express, TypeScript, Prisma (PostgreSQL), MongoDB (native driver), Socket.io, Docker Compose.

## Running locally

```bash
# 1. Start Postgres + MongoDB
docker compose up -d

# 2. Install dependencies
npm install

# 3. Run migrations
npx prisma migrate dev

# 4. Seed demo data (restaurant, tables, menu, staff)
npx prisma db seed

# 5. Start the server
npm run dev
```

Server runs on `http://localhost:3000`.

## What's implemented

- Full REST API for orders/items with event-sourced writes (every state change is logged to MongoDB before Postgres is touched)
- Live Socket.io updates to table and kitchen displays
- `/sync/pull` and `/sync/push` for offline-device reconciliation
- A deterministic conflict classifier: **AUTO_MERGE** (different items, safely concurrent), **SOFT_CONFLICT** (same item, non-destructive — resolved by last-write-wins with both events kept in the log), **HARD_CONFLICT** (destructive/terminal actions colliding — blocked until a human resolves it via `/sync/resolve`)
- Full audit trail via `GET /events/order/:id` — nothing is ever deleted from the event log, including rejected events
