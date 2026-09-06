# Career Companion Backend

This is the backend repository for Career Companion.

## Foundation

- Node.js
- Express
- TypeScript
- Zod

## Setup

1. Make sure Node.js is installed.
2. Run `npm install` to install dependencies.
3. Ensure `.env` is created based on `.env.example`.
4. Run `npm run dev` to start the development server.

## Scripts

- `npm run dev` - Start dev server with nodemon/ts-node-dev
- `npm run build` - Build for production using tsc
- `npm run lint` - Run ESLint
- `npm run format` - Run Prettier
- `npm run test` - Run Vitest

## Shared Contracts

The `src/contracts` directory contains Zod schemas and types that are shared with the frontend. The frontend repository pulls these files using its own sync script. Do not introduce breaking changes to these contracts without coordinating with the frontend.
