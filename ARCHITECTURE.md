# Restaurant POS / KOT — Offline-First Sync Engine
**Production-level rebuild. Core hook: real-time order sync with genuine offline-first support and hand-rolled conflict resolution.**

---

## 1. What this project actually demonstrates

Not "another CRUD POS app." The interview story is: **distributed state across unreliable mobile clients, reconciled deterministically, with destructive conflicts never silently resolved.**

Three things a reviewer should walk away believing:
1. You understand why offline-first is hard (it's not "cache and retry," it's "two truths exist simultaneously and you have to pick one without losing data").
2. You designed a conflict model yourself instead of reaching for Yjs/Automerge — and can explain *why* a general CRDT library is overkill for this domain (the operations aren't free-form text edits; they're a small, known set of business actions with real-world stakes, so a domain-specific classifier beats a generic merge algorithm).
3. You can demo it failing safely — i.e., the system *refuses* to auto-resolve a conflict that could lose money or send wrong food, and instead surfaces it for a human decision, with full audit trail.

---

## 2. Key Design Decisions

### 2.1 Why Postgres *and* Mongo, not just one
- **Postgres = current truth.** Orders, line items, tables, menu, users. Anything the app queries to render "what does Table 5 look like right now" needs relational integrity (foreign keys between orders → tables → restaurants, line items → menu items) and fast point reads. This is what the kitchen display and waiter app read on the happy path.
- **Mongo = append-only event log.** Every state-changing action — online or offline — is written here first, immutably, before Postgres is touched. This isn't a logging nicety; it **is** the sync mechanism. When a client reconnects, the question "what happened on this order while I was offline, and does my queued edit still make sense?" is answered by replaying/comparing events, not by diffing Postgres snapshots. Snapshots lose intent (you can see *that* qty changed, not *why* or *in what order relative to other edits*). An event log preserves intent, which is exactly what the conflict classifier needs.
- Defensible one-liner if asked "why not just one DB": *"Postgres answers 'what is true now', Mongo answers 'what happened and in what order' — sync needs the second question answered, not just the first."*

### 2.2 Why hand-roll conflict resolution instead of a CRDT library
A general CRDT (Automerge, Yjs) is built for arbitrary structured/text data where *any* concurrent edit should mathematically converge. Restaurant orders aren't that — the operations are a small closed set (add item, remove item, change qty, change item status, cancel order) and **some pairs of concurrent operations are not safe to auto-merge**, no matter how clever the merge function, because they represent conflicting real-world business intent (cancel vs. add). A CRDT would silently pick a winner. That's worse than not having offline support, because it fails silently with money/food on the line. Rolling the classifier by hand means the system can say "I don't know which of these is right, ask a human" — which is the actually-correct behavior for this domain. Same philosophy as hand-rolling the circuit breaker in the gateway project: a library would hide the exact decision point that makes the interview story interesting.

### 2.3 Why Socket.io is separate from the offline sync path
Socket.io handles the **happy path only**: an online waiter taps "send to kitchen," the kitchen display updates within ~200ms. This is a live broadcast channel, not a durability mechanism — if the socket drops, nothing is lost, because every action is written to SQLite locally *before* the socket emit is attempted (write-local-first, sync-best-effort). The offline queue is the durability and reconciliation layer; Socket.io is just the low-latency notification layer on top of it once both sides agree on state. Keeping these separate means you can explain the system in two clean halves instead of one tangled one: "fast broadcast" vs "guaranteed-eventually-consistent."

### 2.4 Why SQLite as a queue, not a cache
`expo-sqlite` is used purely as a durable FIFO queue of pending events plus a local mirror of the current order/table state for offline rendering. It is **not** reimplementing Postgres on-device — no joins, no relational integrity enforcement client-side. Two tables only: `pending_events` (the queue) and `local_order_state` (a denormalized read model rebuilt by replaying applied + pending events, so the waiter app can render something sensible while offline). This keeps the on-device logic thin and the source of truth unambiguous (Postgres, always).

### 2.5 Causality tracking: why not vector clocks
Vector clocks are the textbook answer but they're overkill here — a restaurant order is touched by at most a handful of devices (2-3 waiters, 1 kitchen display) over a short lifetime (an order lives minutes to an hour, not indefinitely like a doc). Instead, every event carries:
- `event_id` (client-generated UUID)
- `based_on_event_id` — the event_id of the last event this client *knew about* for this order before making the edit (null if the client created the order, or the last event it pulled during its most recent sync)
- `hlc` — a hybrid logical clock string (`{client_wall_ms}-{counter}-{device_id}`) used only as a tie-breaker for ordering, never as the source of conflict truth

The actual conflict detection question is simple and cheap: **"does `based_on_event_id` match the order's current head event on the server?"** If yes, the client had full information and there's no conflict — fast-forward apply. If no, the order moved on without this client's knowledge, and the classifier runs (§3.2). This is causal-history tracking via parent pointers, not full vector clocks — easier to implement correctly, easier to explain on a whiteboard, and sufficient for orders with a tiny, short-lived device set.

### 2.6 Why provisional resolution for soft conflicts instead of always blocking
Blocking every divergence would make the app unusable (every double-edit halts the waiter). The line is drawn at *destructiveness*: same-item qty edits, or duplicate forward status progressions, are auto-resolved provisionally (HLC order wins, both events kept in the log, UI shows a small "this was edited concurrently" flag) because the worst case is a quantity being slightly wrong for a few seconds until someone notices the flag. Cancel-vs-add, or two different terminal statuses (CANCELLED vs SENT_TO_KITCHEN) on the same item, can't be undone once the kitchen acts on them — those always block.

### 2.7 Auth / multi-tenancy
Reuses the JWT pattern from the API Gateway project: `restaurant_id` and `role` (waiter/kitchen/manager/admin) embedded in the token, validated on every REST call and Socket.io connection handshake. One real restaurant = one tenant for the demo; the schema is multi-tenant-ready (every table has `restaurant_id`) so it doesn't look like a toy.

---

## 3. Data Model

### 3.1 PostgreSQL (current state)

```sql
restaurants(id, name, created_at)

tables(id, restaurant_id, number, status ENUM('available','occupied','needs_cleaning'))

menu_items(id, restaurant_id, name, price_cents, category, is_available)

users(id, restaurant_id, name, role ENUM('waiter','kitchen','manager','admin'), pin_hash)

orders(
  id, restaurant_id, table_id,
  status ENUM('open','sent','preparing','ready','served','paid','cancelled'),
  created_by, created_at, updated_at,
  head_event_id   -- the most recent applied event_id for this order; this IS the causal head
)

order_items(
  id, order_id, menu_item_id, qty,
  status ENUM('pending','sent_to_kitchen','preparing','ready','served','cancelled'),
  notes, created_by, updated_at
)
```

`head_event_id` on `orders` is the load-bearing column for sync — it's what an incoming event's `based_on_event_id` gets compared against.

### 3.2 MongoDB (event log — append-only, never mutated except to attach resolution metadata)

```js
{
  event_id: "uuid",            // client-generated
  restaurant_id, order_id, table_id,
  device_id, user_id,
  action: "CREATE_ORDER" | "ADD_ITEM" | "UPDATE_ITEM_QTY" |
          "UPDATE_ITEM_STATUS" | "REMOVE_ITEM" | "CANCEL_ORDER",
  payload: { ... },            // action-specific
  based_on_event_id: "uuid" | null,
  client_created_at: ISODate,  // device wall clock, untrusted
  hlc: "1719820000123-4-deviceA",
  server_received_at: ISODate,
  sync_status: "applied" | "soft_conflict" | "hard_conflict" | "rejected",
  conflict_with: ["event_id", ...],   // populated if a conflict was detected
  resolution: {
    type: "auto_merge" | "provisional_lww" | "manual",
    resolved_by: "user_id" | "system",
    resolved_at: ISODate,
    chosen_event_id: "uuid"
  } | null
}
```

---

## 4. Sync Protocol

### 4.1 Online happy path (no offline queue involved)
1. Waiter app emits `order:action` over Socket.io.
2. Server validates against current Postgres state, writes the Mongo event (`sync_status: applied`, `based_on_event_id` = current head), applies to Postgres, updates `head_event_id`.
3. Server broadcasts `order:updated` to the room for that table (kitchen display + other waiters watching that table).

### 4.2 Offline path
1. Waiter performs an action while offline. Client writes the event to local SQLite `pending_events` immediately (with locally generated `event_id`, `hlc`, and `based_on_event_id` = the last head it knew, from its local mirror), and optimistically updates `local_order_state` so the UI reflects it instantly.
2. On reconnect: client first calls `GET /sync/pull?order_id=...&since=<last_known_event_id>` to fetch anything it missed (**pull-before-push** — this minimizes false conflicts by giving the client the freshest picture before it pushes its own queued edits).
3. Client then calls `POST /sync/push` with its ordered `pending_events` array.
4. Server processes each event in order:
   - `based_on_event_id == order.head_event_id` → **fast-forward apply**: write event (`applied`), update Postgres, advance head, broadcast live update, ack to client (client dequeues).
   - mismatch → **run the conflict classifier** (§4.3).

### 4.3 Conflict classifier (server-side, deterministic, no ML/heuristics)

```
on mismatch between incoming event E and current head event H:

  if E.action targets a different order_item than the events between
  based_on_event_id and H:
      → AUTO_MERGE: apply E on top of H, advance head, broadcast.
        (different line items, genuinely concurrent, no conflict.)

  else if E and the intervening event(s) target the same item AND
  both are non-destructive (qty change, forward status progression,
  duplicate status) AND neither is CANCEL_ORDER / REMOVE_ITEM /
  a terminal-state conflict:
      → SOFT_CONFLICT: resolve provisionally by HLC order (later wins),
        mark both events with sync_status=soft_conflict and
        conflict_with pointing at each other, set resolution.type=
        provisional_lww. Broadcast 'order:soft_conflict' flag to UI
        (non-blocking banner). Advance head to the HLC-later event.

  else (one side is destructive/terminal and the other is additive
  or a different terminal state on the same item or order):
      → HARD_CONFLICT: do NOT apply. Mark both events
        sync_status=hard_conflict, conflict_with each other,
        resolution=null. Do NOT advance head. Push
        'order:hard_conflict' to both originating devices AND the
        manager dashboard with both event payloads. Require an
        explicit manual resolution call
        (POST /sync/resolve {event_id, action: accept|reject})
        before either client's queue can drain further for this order.
```

Every event keeps its full payload regardless of outcome — nothing is ever deleted from the Mongo log, including rejected hard-conflict events. That log *is* the audit trail and the demo proof.

### 4.4 The demoable scenario (build this as an actual test fixture, not just a hopeful manual click-through)
- Waiter A and Waiter B both have Table 5's order open, both go offline (airplane mode in the simulator/two Expo Go instances).
- Waiter A adds 2x Paneer Tikka.
- Waiter B cancels the entire order (table walked out, in B's understanding).
- Both reconnect. A syncs first, fast-forwards cleanly (head moves to A's ADD_ITEM event). B syncs next — B's `based_on_event_id` no longer matches head → mismatch → CANCEL_ORDER vs ADD_ITEM on the same order → **HARD_CONFLICT**.
- Both apps show a blocking conflict card with both versions; the manager dashboard shows the same with an "Accept cancellation / Keep order open" decision.
- Resolving it writes a final resolution event; both devices' queues drain after.
- Script this as `demo/conflict-scenario.md` with exact steps + a `scripts/seed-conflict-demo.ts` that can replay it deterministically for a recording, plus a `GET /events/order/:id` endpoint that dumps the raw event log so the audit trail is visibly inspectable on camera.

---

## 5. Build Order

1. Postgres schema, migrations, seed data
2. Mongo event-writer service + event schema — every state-changing write goes through it (no sync logic yet)
3. REST API: auth (JWT, reused gateway pattern), CRUD for tables/menu/orders/items — **online-only**, verify with curl
4. Socket.io live broadcast layer (happy path) — kitchen display updates in real time
5. Waiter app (React Native) — online mode only first
6. Kitchen display app (React Native) consuming socket events
7. Offline queue: `expo-sqlite` schema (`pending_events`, `local_order_state`) + write-local-first pattern in the waiter app
8. Sync engine, fast-forward path only: `/sync/pull`, `/sync/push`, `based_on_event_id` head-matching, no conflict classifier yet — verify with two devices editing **sequentially** offline (no overlap)
9. Conflict classifier: AUTO_MERGE / SOFT_CONFLICT / HARD_CONFLICT logic server-side
10. Conflict resolution UI: soft-conflict banner (waiter app) + hard-conflict resolution screen (waiter app + manager dashboard)
11. The demoable scenario as a scripted, repeatable fixture + event-log inspection endpoint
12. Polish: full table-status lifecycle, error states, seed demo data, README finalize, record the demo

---

## 6. Step-by-Step Antigravity Prompts (with mandatory self-verification gates)

> Rule carried over from the gateway project: **never accept "done" from the agent without independently checking.** Every step below ends with a concrete check Jonathan runs himself — curl, a direct DB query, or opening the actual app — before moving to the next step.

### Step 1 — Postgres schema
**Prompt:**
> "Set up a Node.js project with a PostgreSQL connection (use `pg` or Prisma — pick one and justify it in a comment). Create migrations for the `restaurants`, `tables`, `menu_items`, `users`, `orders`, `order_items` tables exactly as specified in ARCHITECTURE.md §3.1, including the `head_event_id` column on `orders`. Add a seed script that creates one restaurant, 5 tables, 10 menu items, and 3 users (2 waiters, 1 kitchen role)."

**Verification gate:**
```bash
psql -d restaurant_pos -c "\dt"
psql -d restaurant_pos -c "SELECT name, role FROM users;"
psql -d restaurant_pos -c "SELECT number, status FROM tables;"
```
Confirm all 6 tables exist with correct columns (`\d orders` — check `head_event_id` is present) and seed data is actually there, not just "migration ran without error."

---

### Step 2 — Mongo event-writer service
**Prompt:**
> "Add a MongoDB connection and an `events` collection matching the schema in ARCHITECTURE.md §3.2. Build a single `writeEvent(eventData)` service function that all future write paths will call — it should validate required fields, set `server_received_at`, default `sync_status: 'applied'`, and insert. Do not wire it into any routes yet — just the service function and a small test script that writes 3 sample events and reads them back."

**Verification gate:**
```bash
node test-event-write.js
mongosh restaurant_pos --eval "db.events.find().pretty()"
```
Confirm 3 documents exist with correct shape — actually read the output, don't trust a "3 events written" console log from the script itself.

---

### Step 3 — REST API (online-only)
**Prompt:**
> "Build REST endpoints: POST /auth/login (PIN-based, returns JWT with restaurant_id + role + user_id), POST /orders, POST /orders/:id/items, PATCH /orders/:id/items/:itemId (qty or status), POST /orders/:id/cancel. Every write endpoint must call writeEvent() BEFORE writing to Postgres, with based_on_event_id set to the order's current head_event_id, and must update head_event_id after writing. Auth middleware validates JWT and restaurant_id on every protected route."

**Verification gate:**
```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login -d '{"pin":"1234"}' -H 'Content-Type: application/json' | jq -r .token)
curl -X POST localhost:3000/orders -H "Authorization: Bearer $TOKEN" -d '{"table_id":1}' -H 'Content-Type: application/json'
psql -d restaurant_pos -c "SELECT id, head_event_id FROM orders ORDER BY id DESC LIMIT 1;"
mongosh restaurant_pos --eval "db.events.find().sort({server_received_at:-1}).limit(1).pretty()"
```
Confirm the order row's `head_event_id` actually matches the `event_id` just written in Mongo — this is the column that everything else depends on, verify the link manually, don't assume the code did it right.

---

### Step 4 — Socket.io broadcast layer
**Prompt:**
> "Add Socket.io. On connection, validate the JWT from the handshake and join the client to a room named `table:{table_id}` for whatever table they're viewing. After every successful write in the REST handlers from Step 3, broadcast `order:updated` with the new order state to that table's room."

**Verification gate:** Open two terminal `socket.io-client` test scripts (or a tiny HTML page) connected to the same table room — fire a curl PATCH from Step 3 and confirm both connected clients receive the `order:updated` event with correct payload, watched live, not just "no errors in server logs."

---

### Step 5 — Waiter app (online mode)
**Prompt:**
> "Build a React Native (Expo) waiter app: table list screen, order screen for a selected table showing line items with qty/status, add-item flow from the menu, send-to-kitchen action. Talk directly to the REST API from Step 3 and listen on the table's socket room from Step 4 for live updates."

**Verification gate:** Run on two simulators/devices logged in as two different waiters, both viewing Table 5. Add an item on device A, confirm it appears on device B within ~1 second without refreshing. Actually watch it happen on both screens side by side.

---

### Step 6 — Kitchen display app
**Prompt:**
> "Build a kitchen display screen (RN) showing all orders with status sent_to_kitchen or preparing across all tables, listening on a `kitchen` socket room. Kitchen can advance item status (sent_to_kitchen → preparing → ready)."

**Verification gate:** Send an order to kitchen from the waiter app, confirm it appears on the kitchen display within ~1 second, advance its status from the kitchen app, confirm the waiter app updates live. Watch both screens.

---

### Step 7 — Offline queue (client-side, no server changes)
**Prompt:**
> "Add expo-sqlite to the waiter app. Create `pending_events` (queue) and `local_order_state` (denormalized mirror) tables. Rework every write action to: (1) write to pending_events with a client-generated event_id, hlc, and based_on_event_id from local_order_state, (2) optimistically update local_order_state, (3) update the UI from local_order_state instead of waiting on the network. Do NOT attempt to sync to the server yet — that's Step 8."

**Verification gate:**
```bash
# put the device/simulator in airplane mode first
```
Add 2 items and change a status while offline. Kill and reopen the app — confirm the state persists (read straight from local_order_state) and the UI still shows the offline edits correctly. Then directly inspect the SQLite file (`expo-sqlite` exposes a file you can pull and open with any sqlite browser) and confirm `pending_events` actually has 3 rows with sane `based_on_event_id` chaining (each new event's `based_on_event_id` should equal the prior pending event's `event_id`, not stale).

---

### Step 8 — Sync engine, fast-forward only
**Prompt:**
> "Add GET /sync/pull?order_id=&since= and POST /sync/push to the server. /sync/push processes events in order: if event.based_on_event_id === order.head_event_id, apply it (write Mongo event, update Postgres, advance head, broadcast), ack back to client. If it doesn't match, just mark sync_status='hard_conflict' for now and stop processing that order's queue (real conflict classifier logic comes in Step 9 — for now we just need fast-forward to work and mismatches to fail safely instead of corrupting state). Wire the client: on reconnect, call /sync/pull first, then /sync/push the local pending_events queue, dequeue on ack."

**Verification gate:** Two devices, Table 5, BOTH offline. Device A adds an item, goes back online and syncs (confirm via curl `GET /events/order/:id` that the event landed and head_event_id advanced). THEN device B (still offline this whole time, no overlap with A) goes offline→adds a different item→comes online and syncs. Confirm both items now show in Postgres and B's sync succeeded cleanly (sequential, not concurrent — this step proves fast-forward works before conflicts are introduced).

---

### Step 9 — Conflict classifier
**Prompt:**
> "Implement the AUTO_MERGE / SOFT_CONFLICT / HARD_CONFLICT classifier described in ARCHITECTURE.md §4.3 inside /sync/push, replacing the 'mark hard_conflict and stop' placeholder from Step 8. Add POST /sync/resolve for manually resolving HARD_CONFLICT events (accept or reject), which writes a resolution event and unblocks the order's head."

**Verification gate:** Three manual test cases run with curl directly against /sync/push (bypass the app, hit the API), each checked against Mongo:
1. Two events on *different* line items, same order, diverged head → confirm AUTO_MERGE, both applied, head advanced once with the later HLC.
2. Two qty-change events on the *same* item, diverged head → confirm SOFT_CONFLICT, both events tagged with `conflict_with`, one applied provisionally, banner-worthy flag present in the response.
3. One CANCEL_ORDER and one ADD_ITEM on the same order, diverged head → confirm HARD_CONFLICT, `resolution: null`, head_event_id unchanged in Postgres (run the `psql` query yourself), neither event applied to Postgres.

Do not move on until you've manually run all three and read the actual Mongo documents and Postgres rows after each — this is the core mechanism of the whole project, it has to be verified by hand, not trusted from a green test run.

---

### Step 10 — Conflict UI
**Prompt:**
> "Add a soft-conflict banner to the waiter app (non-blocking, dismissible, shows 'this item was edited on another device, latest change applied') triggered by sync_status=soft_conflict in a /sync/push response. Add a hard-conflict screen (blocking) showing both versions side-by-side with Accept/Reject buttons calling /sync/resolve, shown on both originating devices. Add a minimal manager view (web page or RN screen) listing all unresolved hard conflicts across the restaurant with the same resolve action."

**Verification gate:** Re-run the Step 9 hard-conflict test case but this time through the actual apps (two simulators offline, conflicting edits, reconnect) — confirm the blocking screen actually appears on both devices with correct data, tap Accept on one, confirm the manager view and the OTHER device both reflect the resolution without manual refresh (socket-pushed).

---

### Step 11 — Demoable scenario as a fixture
**Prompt:**
> "Write demo/conflict-scenario.md documenting the exact reproducible steps for the Table 5 cancel-vs-add conflict (ARCHITECTURE.md §4.4). Write scripts/seed-conflict-demo.ts that resets the demo restaurant to a clean state. Add GET /events/order/:id returning the full raw event log for an order, formatted readably, for use during the demo/recording to show the audit trail."

**Verification gate:** Run the fixture script, follow your own written steps exactly without improvising, confirm the conflict triggers identically every time (run it twice), and confirm `/events/order/:id` shows a complete, readable, honest log — including the rejected/superseded events, not just the final state. This is what you'll actually show in an interview, so it has to survive being run cold by someone else following the doc.

---

### Step 12 — Polish
**Prompt:**
> "Wire up the full table status lifecycle (available → occupied on order creation → needs_cleaning on payment → available on cleanup confirmation). Add basic error handling for sync failures (network errors during push should re-queue, not drop). Finalize seed data for a believable demo restaurant. Update ARCHITECTURE.md if any design decisions changed during build."

**Verification gate:** Full walkthrough from a cold seed: open table → order → send to kitchen → kitchen advances → serve → pay → table goes available again, watched live across waiter + kitchen apps, then run the Step 11 conflict demo one more time end to end as a dry run of the actual interview demo.

---

## 7. What NOT to build (scope guard, same as the gateway project)
- No payment processing — "paid" is a status flag, not a Stripe integration.
- No menu management UI beyond seed data — menu CRUD isn't the point.
- No push notifications — Socket.io for foreground live updates is enough.
- No multi-restaurant admin portal — multi-tenant schema is enough to prove the design works, doesn't need a UI for it.
- Resist adding a second conflict type for "fun" (e.g. table-merge conflicts) — one well-demoed conflict scenario beats three half-explained ones.
