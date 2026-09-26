# Career Companion Backend

This is the backend repository for Career Companion.

## Foundation

- Node.js
- Express
- TypeScript
- Zod
- PostgreSQL
- Prisma

## Setup

1. Make sure Node.js and Docker are installed.
2. Run `npm install` to install dependencies.
3. Ensure `.env` is created based on `.env.example`.

## Database Workflow (COM-12)

This project uses PostgreSQL via Docker Compose for local development.

**Start the database:**
```bash
npm run db:up
```

**Run migrations (creates tables):**
```bash
npm run db:migrate
```

**Generate Prisma Client (run after migrations or schema changes):**
```bash
npm run db:generate
```

**Run Development Seed (idempotent user creation):**
```bash
npm run db:seed
```

**Stop the database:**
```bash
npm run db:down
```

**Reset the database (drops all data and reapplies migrations):**
```bash
npm run db:reset
```

## Running the Server

Run `npm run dev` to start the development server.

## Scripts

- `npm run dev` - Start dev server with nodemon/ts-node-dev
- `npm run build` - Build for production using tsc
- `npm run lint` - Run ESLint
- `npm run format` - Run Prettier
- `npm run test` - Run Vitest (requires PostgreSQL to be running)

## Shared Contracts

The `src/contracts` directory contains Zod schemas and types that are shared with the frontend. The frontend repository pulls these files using its own sync script. Do not introduce breaking changes to these contracts without coordinating with the frontend.

## Stabilization and verification

See [STABILIZATION.md](STABILIZATION.md) for migration preflight, production configuration, recovery boundaries, and release verification. The stabilization API changes require the matching frontend release: Gmail sync returns `202 { accepted: true }`; application events and actions return paginated envelopes. All public lists default to and cap at 20 items.

Tests require a **separate local test database**, never the development database. Create an empty database named `career_companion_test` (or `career_companion_*test`). In ignored `.env.test`, set `DATABASE_URL` and `TEST_DATABASE_URL` to the exact same explicit URL for that database, plus development authentication and fixture-only signing/encryption secrets. The guard rejects remote hosts, development database names, URL overrides, and missing/mismatched test URLs before tests touch data. The suite deletes fixture data, so do not put real user records in this database.

To migrate the dedicated test database, explicitly export its URL as `TEST_DATABASE_URL`, then run:

```bash
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
npx prisma generate
npm run typecheck
npm run lint
npm test
npm run build
```

Vitest loads `.env.test` with override enabled; confirm it contains that same test URL. Do not use `db:reset` for verification. The frontend smoke script also enforces this database guard and requires both repositories to be built.

## Application API & Development Authentication (COM-13)

For Sprint 1 local development, this repository uses a **Development-Only Authentication Boundary**. 
This is a fallback for local testing. Google OAuth is the primary and fully-implemented mechanism for authentication.

### Making Authenticated Requests
To authenticate as the development user, you must include the `X-Development-User` header with the user's email (default seeded user: `dev@career-companion.local`) in your requests. Also ensure `ENABLE_DEV_AUTH=true` is set in your `.env`.

#### Example POST Request
```bash
curl -X POST http://localhost:3000/api/applications \
  -H "Content-Type: application/json" \
  -H "X-Development-User: dev@career-companion.local" \
  -d '{"companyName": "Acme Corp", "jobTitle": "Software Engineer"}'
```

#### Example GET Request
```bash
curl -X GET http://localhost:3000/api/applications \
  -H "X-Development-User: dev@career-companion.local"
```

### Error Response Shape
All API errors follow a consistent, typed shape to make it easier for clients to consume:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": [...]
  }
}
```
Standard error codes include `VALIDATION_ERROR`, `UNAUTHORIZED`, and `INTERNAL_SERVER_ERROR`.
