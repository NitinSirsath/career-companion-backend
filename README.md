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
