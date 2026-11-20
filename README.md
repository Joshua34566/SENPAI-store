SENPAI POSTER STORE
===================

A static storefront and Node.js API for the anime and car poster catalogue.

Backend routes:
- GET /api/products returns the public catalogue.
- POST /api/products, PATCH /api/products/:id, and DELETE /api/products/:id require Authorization: Bearer ADMIN_PASSWORD.
- GET /api/admin/check validates the seller password.
- GET /api/health checks the API and PostgreSQL connection.

Set DATABASE_URL, ADMIN_PASSWORD, and CORS_ORIGINS in the backend host. Keep secrets out of GitHub. The API creates its PostgreSQL table and starter products when the catalogue is empty.
