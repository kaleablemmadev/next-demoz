# Bot subject matching

Agency offers now store all selected subjects in `TutoringOffer.subjects` (PostgreSQL `text[]`).
The old `TutoringOffer.subject` column remains as a compatibility field containing the first subject.

Tutor matching is case-insensitive exact-token overlap. If an offer or a tutor has no subject metadata,
the subject constraint is treated as unspecified so older records and tutors who skipped subject setup
remain eligible. New agency offers require at least one subject.

The Prisma migration `20261118170000_add_tutoring_offer_subjects` adds the array, backfills it from
the legacy column, and creates a GIN index. Apply migrations using the direct (non-pooled) Neon URL.

Note: the existing production bot tables were originally provisioned outside the recorded Prisma
migration history. This migration records the new subject change; it does not retroactively recreate
or baseline every historical bot table. Do not use `prisma migrate reset` on production.
