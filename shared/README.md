# shared/

Pure business rules and types shared by the backend, the web and mobile app,
and the NextDemoz demo. Nothing in this folder may import Prisma, Express,
Expo, React Native, or any database or network client.

- `rules/`: pure functions, such as phone-number checks.
- `types/`: data shapes used by the demo and, later, the backend.

The backend still has its own copy of `rules/phone-number.ts`. Keep the two
identical until the backend imports from here.