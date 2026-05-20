// Set env vars before any application module gets imported.
// lib/auth.ts reads these at module-load time into module-scoped consts,
// so they must exist by the time the test file imports the route handler.
process.env.API_TOKEN = "test-api-token";
process.env.PROVIDER_WEBHOOK_SECRET = "test-webhook-secret";
process.env.DATABASE_URL = "file:./test.db"; // never actually used (Prisma is mocked)
