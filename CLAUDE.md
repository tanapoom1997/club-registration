# CLAUDE.md

ระบบลงทะเบียนชุมนุมโรงเรียน (นักเรียน ~2,500 คน, รอบละ ~450 concurrent) แผนเต็ม สถาปัตยกรรม data model และ roadmap อยู่ใน [README.md](README.md) อ่านก่อนเริ่มงานทุกครั้ง ไฟล์นี้เก็บเฉพาะกติกาการทำงานที่ต้องไม่หลุด

**สถานะ:** Phase 1 ข้อ 1 (Auth + role guard) และข้อ 3 (admin จัดการรอบ: `apps/api/src/routes/admin-rounds.ts` + `services/rounds.ts`, หน้า `/admin/rounds` และดู/แก้ชุมนุมรายรอบ: `routes/admin-clubs.ts` + `services/clubs.ts`, หน้า `/admin/clubs`) เสร็จแล้ว ข้อ 2 (import Excel: dry run + ยืนยัน, `routes/admin-import.ts`, `import/`, `services/import-plan.ts`, `services/import-commit.ts`, หน้า `/admin/import`) เสร็จแล้ว รวมขั้นออกรหัสผ่านเริ่มต้น (`routes/admin-students.ts`, `services/initial-passwords.ts`, หน้า `/admin/initial-passwords`) และขั้นยืนยัน import ถือ round lock ทุกรอบของภาคเรียน (I1, เทสต์ `apps/api/test/import-commit-round-locks.test.ts`) ข้อ 7 export รายชื่อเสร็จแล้วทั้ง Excel และ PDF (`routes/admin-export.ts`, `services/name-lists.ts`, `export/name-list-content.ts`, `export/name-list-workbook.ts`, `export/name-list-pdf.ts`, ฟอนต์ `apps/api/assets/fonts/`, หน้า `/admin/export`) ข้อ 4 ฝั่ง API ของนักเรียนเสร็จแล้วทั้งส่วนอ่าน (S1: `routes/student.ts` + `services/student-round.ts`, `GET /api/student/round` และ `GET /api/student/clubs` นักเรียนเห็นแค่ชื่อครู) และลง/ยกเลิก (S2: `POST /api/student/registration`, `POST /api/student/registration/cancel`, `services/registrations.ts` + `services/round-lock.ts`) schema ใน `packages/shared/src/student.ts` พร้อม concurrency test (`apps/api/test/registration-concurrency.test.ts`) และตัวตรวจ invariant (`apps/api/test/support/registration.ts`) ซึ่งครอบคลุมข้อ 5, 6, 9 และหน้าเว็บนักเรียนเสร็จแล้ว (S3: `apps/web/src/pages/student/`, หน้า `/student/clubs` ลงชุมนุม และ `/student/my-registration` ยกเลิก, key ใหม่ต่อการยืนยันและ retry ใช้ key เดิมเมื่อไม่รู้ผล) Phase 1 เหลือข้อ 8 Ops และ load test ต่อจาก scaffold (monorepo, migration แรกครบทุกตาราง, `GET /api/health`) มี login/เปลี่ยนรหัส/logout, `create-admin` และหน้า FE ตาม role

## กฎที่ห้ามละเมิด

1. **Invariant ต้อง enforce ที่ DB** (UNIQUE, CHECK, `UPDATE ... WHERE registered < capacity`) ห้ามพึ่งการเช็คใน app อย่างเดียว
2. **ใช้ SQL ตรงๆ ผ่าน `pg`** ไม่เพิ่ม ORM, Redis หรือ dependency ใหญ่ โดยไม่ถามก่อน (เหตุผลอยู่ใน README หัวข้อ Tech Stack)
3. **ทุก write transaction ในรอบเริ่มด้วย `pg_advisory_xact_lock(round_id)`** (ตั้งแต่ Phase 1: ลง/ยกเลิก และ admin แก้ชุมนุม ใช้ `lockRound`/`lockRoundOfClub` ใน `apps/api/src/services/round-lock.ts` ส่วนยืนยัน import ใช้ `lockRoundsOfTerm` ล็อกทุกรอบของภาคเรียนเรียง id จากน้อยไปมากต่อจาก import lock) ก่อนอ่านอะไรที่ใช้ตัดสินผล มีแค่ import ที่ถือหลาย round lock และต้องได้ครบก่อนแตะแถวใด ถ้าเพิ่ม writer ที่ถือหลายรอบต้องล็อกเรียง id แบบเดียวกัน (เหตุผลเรื่อง deadlock อยู่ใน `round-lock.ts`)
4. **ห้าม mock Postgres ในเทสต์** ใช้ Testcontainers เสมอ การเปลี่ยนแปลงที่แตะ logic ลง/ยกเลิก/เปลี่ยน/waitlist ต้องมี concurrency test และ invariant check คู่กัน
5. **ไม่เชื่อ role หรือ `student_id` จาก client** ใช้ค่าจาก JWT เท่านั้น
6. **`apps/web` กับ `apps/api` ห้าม import กัน** คุยผ่าน HTTP และ `packages/shared` เท่านั้น
7. **ทุก endpoint เขียนต้อง idempotent** รับ `idempotency_key` และเขียน `registration_events`
8. **Export Excel ต้อง escape** ค่าที่ขึ้นต้นด้วย `=`, `+`, `-`, `@` (ใช้ `escapeCellText` ใน `apps/api/src/export/escape-cell.ts` ที่เดียว) และ export รายห้องต้องมีนักเรียนทุกคนในห้อง รวมคนที่ยังไม่ลง (สเปกเต็มดู README หัวข้อ Export รายชื่อ)
9. **ห้ามใส่ข้อมูลจริงใน repo**: ไฟล์ .xlsx ของนักเรียน, `.env*`, `*.dump`, รหัสผ่าน, secret ข้อมูลทดสอบใช้ข้อมูลสมมติเท่านั้น (`templates/` เก็บได้เฉพาะไฟล์เปล่า)
10. **ห้ามใส่ secret/PII ใน log**
11. **ห้าม `dangerouslySetInnerHTML`** กับข้อความที่ admin กรอก
12. **repo นี้เป็น Public** ห้าม commit อะไรที่ระบุตัวโรงเรียน นักเรียน หรือครูจริง รวมถึง domain, IP, ชื่อ bucket และข้อมูลทดสอบที่ลอกจากของจริง ตัวอย่างและ seed data ใช้ข้อมูลสมมติเท่านั้น ถ้าไม่แน่ใจว่าไฟล์ปลอดภัยพอจะ commit ไหม ให้ถามก่อน

## Tech Stack

ล็อกแล้ว ห้ามเปลี่ยนหรือเพิ่มของใหญ่โดยไม่ถามก่อน เหตุผลของแต่ละตัวดู README ตอน scaffold ให้ pin เวอร์ชันใน `package.json` และ `engines.node`

| ชั้น | ใช้ | หมายเหตุ |
|---|---|---|
| Runtime | Node.js 24 LTS (≥ 24.7) | ใช้ ESM ล้วน (`"type": "module"`) ต้อง ≥ 24.7 เพราะใช้ `crypto.argon2` |
| ภาษา | TypeScript (`strict: true`) | target ES2023, module `NodeNext` (`apps/web` ใช้ `Bundler`) pin 6.0.x เพราะ `typescript-eslint` ยังไม่รองรับ 7 |
| Package manager | pnpm workspaces | monorepo เดียว: `apps/api`, `apps/web`, `packages/shared` |
| Backend | Fastify + `fastify-type-provider-zod` | validation และ type มาจาก Zod schema เดียว |
| Validation | Zod | นิยามไว้ใน `packages/shared` ที่เดียว |
| Database | PostgreSQL + `pg` | SQL ตรงๆ ใช้ parameterized query (`$1, $2`) เสมอ ห้ามต่อ string |
| Migration | `node-pg-migrate` | migration เป็น SQL ไฟล์ แยกจาก app |
| Auth | `@fastify/jwt` (HS256) + `@fastify/cookie`, argon2id จาก `node:crypto` | session cookie + `session_version` ดู README หัวข้อ Security |
| Router (FE) | `react-router` (SPA mode) | route ทั้งหมดอยู่ที่ `apps/web/src/routes.tsx` |
| Frontend | Vite + React + Tailwind + shadcn/ui | SPA ไม่ใช้ SSR |
| Data fetching | TanStack Query | polling คิว/สถานะ |
| Excel | `exceljs` | import/export .xlsx |
| PDF | `pdfkit` + ฟอนต์ Sarabun (SIL OFL 1.1) | export รายชื่อ ฟอนต์อยู่ที่ `apps/api/assets/fonts/` (มี `OFL.txt` คู่กัน) และต้องไปกับ `dist/` ตอน deploy ห้ามเปลี่ยนฟอนต์โดยไม่ลองชื่อที่มีสระบน/ล่างและวรรณยุกต์ก่อน (README หัวข้อ Export รายชื่อ) |
| Test | Vitest + Testcontainers | Postgres จริง ไม่ mock |
| Deploy | Docker image เดียว + Docker Compose + Caddy | เครื่องเดียวบน EC2 |

**ไม่ใช้:** Next.js, Redis, ORM (Prisma/Drizzle), serverless, แยก repo FE/BE

**เครื่องมือคุณภาพโค้ด:** ESLint (flat config) + Prettier, `tsc --noEmit` เป็น typecheck

## Commands

ตั้งค่าครั้งแรก (ต้องมี Docker และ Node 24 ส่วน pnpm มาจาก Corepack)

```bash
corepack enable
pnpm install
cp .env.example .env
echo "JWT_SECRET=$(openssl rand -base64 48)" >> .env
docker compose up -d --wait   # หรือเปิด Postgres ของตัวเองที่ DATABASE_URL ชี้อยู่
```

ใช้งานประจำ

```bash
pnpm dev                # migrate → seed บัญชี demo → api (:3000) + web (:5173) ใน terminal เดียว
pnpm --filter api seed-dev --reset   # สุ่มรหัสบัญชี demo ใหม่ (ลืมรหัส/ไฟล์หาย)
pnpm --filter api create-admin <login_id>   # admin จริง แสดงรหัสครั้งเดียว บังคับเปลี่ยนตอน login แรก
pnpm --filter api generate-template   # สร้าง templates/import-template.xlsx ใหม่หลังแก้คอลัมน์ใน packages/shared
pnpm typecheck
pnpm lint
pnpm format
pnpm test               # Vitest + Testcontainers (ต้องเปิด Docker)
pnpm build
```

บัญชี demo (`demo-admin`, `demo1001`, `demo1002`, `demo2001`) เป็นข้อมูลสมมติ ไม่บังคับเปลี่ยนรหัส รหัสสุ่มตอนสร้างครั้งแรกแล้วเก็บใน `.dev-credentials.txt` (gitignored, 600) รัน `pnpm dev` ซ้ำไม่เปลี่ยนรหัส `seed-dev` ไม่ยอมรันเมื่อ `NODE_ENV=production` ส่วน production สร้าง admin ด้วย `node dist/create-admin.js <login_id>` หลัง `pnpm build`

`packages/shared` ไม่ต้อง build ตอน dev และ test เพราะ export condition `@club-registration/source` ชี้ไปที่ `src/` (Vitest ของ api ใช้ alias แทน) ส่วน production ใช้ `dist/` จาก `pnpm build`

## การทำงาน

- ทำทีละ Phase ตาม README อย่าข้ามไปทำของ Phase หลัง ยกเว้น migration แรกที่สร้างตารางครบทุก phase ไว้ก่อน
- ตัวเลข performance ใน README เป็นการประเมิน ห้ามอ้างเป็นข้อเท็จจริงจนกว่าจะ load test
- ก่อนบอกว่างานเสร็จ ต้องรัน typecheck และ test จริง แล้วรายงานผลตามที่เห็น
- ถ้าต้องตัดสินใจที่ขัดกับ README (เปลี่ยน stack, เปลี่ยนกติกาธุรกิจ) ให้ถามก่อนและอัปเดต README ในงานเดียวกัน

## ภาษาและสไตล์

- คุยและเขียนเอกสารเป็นภาษาไทย ส่วนโค้ด ชื่อตัวแปร ชื่อตาราง และ commit message เป็นภาษาอังกฤษ
- Schema ของ request/response นิยามเป็น Zod ใน `packages/shared` ที่เดียว

### Code style (ES6+ / modern TypeScript)

**โมดูล**
- ใช้ ES Modules (`import`/`export`) เท่านั้น ห้าม `require` / `module.exports`
- import ไฟล์ในโปรเจกต์ต้องมีนามสกุล `.js` (ข้อกำหนดของ `NodeNext`) เช่น `import { db } from './db.js'`
- ใช้ `import type { ... }` สำหรับ import ที่เป็น type อย่างเดียว
- ใช้ named export เป็นหลัก ใช้ `export default` เฉพาะที่ framework บังคับ (เช่น component ที่ lazy load)

**ตัวแปรและฟังก์ชัน**
- `const` เป็นค่าเริ่มต้น ใช้ `let` เมื่อต้อง reassign จริง ห้าม `var`
- ใช้ arrow function สำหรับ callback และฟังก์ชันสั้นๆ ฟังก์ชันระดับ module ที่ export ใช้ `const name = (...) => {}` หรือ `function` ก็ได้ แต่ให้สม่ำเสมอทั้งไฟล์
- ใช้ default parameter, destructuring, spread/rest, template literal แทนการต่อ string
- ใช้ optional chaining (`?.`) และ nullish coalescing (`??`) แทน `&&` / `||` ที่ใช้เช็ค null/undefined
- ใช้ `===` / `!==` เสมอ

**Async**
- ใช้ `async`/`await` ห้าม `.then()` chain และห้าม callback style
- ทุก Promise ต้องถูก `await` หรือจัดการ error ชัดเจน (เปิด rule `no-floating-promises`)
- งานที่ไม่พึ่งกันใช้ `Promise.all` ส่วน query ใน transaction เดียวต้องรันต่อกันทีละอัน

**Data และ collection**
- ใช้ `map` / `filter` / `reduce` / `find` / `some` / `every` แทน `for` ที่ไว้แค่แปลงข้อมูล ใช้ `for...of` เมื่อมี `await` หรือต้อง break
- ห้าม mutate argument หรือ state ที่ส่งเข้ามา คืนค่าใหม่แทน
- ใช้ `Map` / `Set` เมื่อต้อง key lookup หรือกันซ้ำ
- ใช้ `Object.freeze` / `as const` กับค่าคงที่และ enum-like value แทน TypeScript `enum`

**TypeScript**
- `strict: true` ห้าม `any` ใช้ `unknown` แล้ว narrow (หรือ parse ด้วย Zod) ห้าม `@ts-ignore` ยกเว้นมีคอมเมนต์อธิบายเหตุผล
- type ของข้อมูลจาก API ให้ `z.infer<typeof schema>` ไม่เขียนซ้ำด้วยมือ
- ใช้ `type` สำหรับ union/ข้อมูล ใช้ `interface` เฉพาะที่ต้อง extend
- ห้าม non-null assertion (`!`) นอกเทสต์

**โครงสร้างโค้ด**
- เน้น function ธรรมดาและ pure function ใช้ `class` เฉพาะเมื่อมี state ที่ต้องสืบทอดจริง
- 1 ฟังก์ชันทำ 1 เรื่อง logic ธุรกิจ (ลง/ยกเลิก/promote) แยกเป็นฟังก์ชันที่รับ DB client เป็น argument เพื่อทดสอบและรันใน transaction เดียวกันได้
- Error ธุรกิจ (`club_full`, `already_registered`) ใช้ error class/code ที่นิยามไว้ที่เดียว แล้วแปลงเป็น HTTP status ที่ชั้น route

**การตั้งชื่อ**
- ตัวแปร/ฟังก์ชัน `camelCase`, type/component `PascalCase`, ค่าคงที่ระดับ module `UPPER_SNAKE_CASE`
- ไฟล์ `kebab-case.ts` (React component ใช้ `PascalCase.tsx`)
- ตาราง/คอลัมน์ใน DB เป็น `snake_case` แปลงเป็น `camelCase` ที่ชั้น data access ที่เดียว

**Format**
- 2 spaces, single quote, semicolon, trailing comma แบบ `all`, ความยาวบรรทัด 100 (ให้ Prettier จัดการ ไม่ถกเรื่อง style ในรีวิว)
- คอมเมนต์เขียนเฉพาะ "ทำไม" ไม่เขียน "ทำอะไร" ที่โค้ดบอกอยู่แล้ว

## Best practice

> ข้อที่ระบุ (เสนอ) เป็นข้อเสนอเพิ่มจาก README ยืนยันตอน scaffold

### TypeScript / Lint
- `tsconfig`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`
- ESLint เปิดอย่างน้อย: `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `no-explicit-any`, `consistent-type-imports`, `eqeqeq`, `no-restricted-imports` (กัน web↔api import กัน)
- CI/ก่อน commit ต้องผ่าน `typecheck` + `lint` + `test` ห้าม merge ถ้าแดง CI อยู่ที่ `.github/workflows/ci.yml` (format:check, typecheck, lint, test, build) รันทุก PR และทุก push เข้า `main` action pin ด้วย commit SHA ถ้าเพิ่มขั้นตอนให้รันซ้ำในเครื่องได้ด้วยคำสั่ง `pnpm` เดียวกัน

### Security
- Password hash ด้วย **argon2id** (`crypto.argon2` ของ Node, เก็บเป็น PHC string) ห้าม MD5/SHA ธรรมดา เทียบด้วย `timingSafeEqual`
- JWT: อายุสั้น, ระบุ algorithm ตอน verify, ห้ามใส่ข้อมูลอ่อนไหวใน payload, เก็บฝั่ง client เป็น `HttpOnly; Secure; SameSite` cookie ถ้าทำได้ แทน `localStorage`
- เปิด `@fastify/helmet` และ `@fastify/rate-limit` (`global: false` เลือกเปิดราย route ด้วย `app.createRateLimit()`) body limit 64 KiB (route อัปโหลดตั้งเอง)
- Route ที่ต้อง login ใช้ `guard()` จาก `createAuthGuard` (`apps/api/src/auth/session.ts`) ระบุ `roles` เมื่อจำกัด role
- Route เขียนที่ไม่ได้รับ JSON (เช่น multipart อัปโหลด ซึ่ง form ข้ามเว็บส่งได้โดยไม่มี preflight) ต้องเรียก `assertSameOrigin` (`apps/api/src/http/same-origin.ts`) ใน preHandler
- Validate input ทุกจุดด้วย Zod ที่ขอบระบบ (body, query, params, ไฟล์ที่อัปโหลด) ไม่เชื่อข้อมูลภายนอก
- Error response ไม่เปิดเผย stack trace หรือข้อความจาก DB ให้ client
- Dependency: ใช้ lockfile และ `pnpm install --frozen-lockfile` ใน CI/Docker, เปิด Dependabot/`pnpm audit` (เสนอ), Docker รันด้วย non-root user

### Database
- Timestamp ใช้ `timestamptz` เสมอ เก็บเป็น UTC แปลงเวลาไทยที่ชั้นแสดงผล
- Migration เป็น forward-only ห้ามแก้ migration ที่ commit/deploy แล้ว ให้เพิ่มไฟล์ใหม่
- ทุก transaction ต้อง `COMMIT` หรือ `ROLLBACK` เสมอ (ใช้ `try/finally` คืน client เข้า pool)
- ตั้ง `statement_timeout` และ `idle_in_transaction_session_timeout` กัน query ค้าง
- Index ทุก foreign key และคอลัมน์ที่ใช้ filter บ่อย ตรวจ query หนักด้วย `EXPLAIN`
- ไม่ใช้ `SELECT *` ใน query ของ app ระบุคอลัมน์

### API
- Error ใช้รูปแบบเดียวทั้งระบบ (เช่น `{ code, message }`) และ HTTP status ที่ถูกความหมาย (`400` validation, `401`, `403`, `404`, `409` ชน rule/ซ้ำ)
- Endpoint เขียนรับ `idempotency_key` Endpoint อ่านต้องไม่มี side effect
- Log แบบ structured JSON (pino ของ Fastify) มี request id ไม่ log secret/PII
- Config ทั้งหมดอ่านจาก env แล้ว validate ด้วย Zod ตอน boot ถ้าขาดให้ล้มทันที (fail fast)

### Testing
- โครง Arrange–Act–Assert เทสต์ 1 ตัวพิสูจน์ 1 เรื่อง ชื่อเทสต์บอกพฤติกรรม
- เทสต์ต้องไม่พึ่งลำดับกันและไม่แชร์ข้อมูลข้ามเทสต์ (แยก DB/transaction ต่อเทสต์หรือต่อ suite)
- Bug ที่แก้ต้องมีเทสต์ที่ fail ก่อนแก้ แล้วผ่านหลังแก้
- Frontend: เทสต์พฤติกรรมที่ผู้ใช้เห็น (Testing Library) ไม่เทสต์ implementation

### Git / ทำงานร่วมกัน
- Commit ตาม Conventional Commits (เสนอ) เช่น `feat(api): add register endpoint`, `fix(db): ...`, `test: ...`, `docs: ...`
- ทำงานบน feature branch แล้วเปิด PR เข้า `main` ไม่ push งานโค้ดตรงเข้า `main` (เอกสารตั้งต้นช่วงแรก commit ตรงมาแล้ว)
- 1 PR = 1 เรื่อง เล็กพอรีวิวได้ มีคำอธิบายว่าเปลี่ยนอะไรและทดสอบอย่างไร
- ห้าม force push `main` ห้าม commit secret ถ้าเผลอ commit ต้อง rotate secret นั้นทันที (ลบจาก history ไม่พอ)
