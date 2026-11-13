# Migrations

No SQL migration is committed yet: the Prisma CLI could not be run when this project was generated.
Create the initial migration once, from `backend/`, against an empty database:

```bash
npx prisma migrate dev --name init   # writes prisma/migrations/<timestamp>_init/migration.sql
git add prisma/migrations            # commit it
```

After that, production uses `npx prisma migrate deploy` (the Docker image does this automatically).
