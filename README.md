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

## Application API & Development Authentication (COM-13)

For Sprint 1 local development, this repository uses a **Development-Only Authentication Boundary**. 
This is an architectural placeholder for Google OAuth and MUST NEVER be enabled in production environments.

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
