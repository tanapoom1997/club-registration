# club-registration

ระบบลงทะเบียนชุมนุมของโรงเรียน สำหรับนักเรียน ~2,500 คน แบ่งรอบตามชั้น ม.1–ม.6 รอบละ ~400–450 คน

> **สถานะ:** Phase 1 ทำ Auth + role guard เสร็จแล้ว (login, บังคับเปลี่ยนรหัสครั้งแรก, logout, `create-admin`, หน้า FE ตาม role) admin จัดการรอบลงทะเบียนได้แล้ว (`/api/admin/rounds` + หน้า `/admin/rounds`) นำเข้า Excel ได้แล้วทั้งขั้นตรวจ (dry run) และขั้นยืนยัน (`/api/admin/import/preview`, `/api/admin/import/commit` + หน้า `/admin/import`) ออกรหัสผ่านเริ่มต้นให้นักเรียนเป็นไฟล์ Excel ได้แล้ว (`/api/admin/students/password-status`, `/api/admin/students/initial-passwords` + หน้า `/admin/initial-passwords`) ดู/แก้ชุมนุมรายรอบได้แล้ว (`/api/admin/rounds/:roundId/clubs`, `/api/admin/clubs/:id` + หน้า `/admin/clubs`) ส่งออกรายชื่อรายชุมนุม/รายห้องเป็น Excel และ PDF ได้แล้ว (`/api/admin/rounds/:roundId/export` + หน้า `/admin/export`) นักเรียนอ่านรอบกับรายการชุมนุมของชั้นตัวเองผ่าน API ได้แล้ว (`/api/student/round`, `/api/student/clubs`) และ**ลง/ยกเลิกชุมนุมผ่าน API ได้แล้ว** (`POST /api/student/registration`, `POST /api/student/registration/cancel`) พร้อม concurrency test 500 request กับ Postgres จริง และ**มีหน้าเว็บนักเรียนแล้ว** (`/student/clubs` ดูชุมนุมและลง, `/student/my-registration` ดูผลและยกเลิก) งาน Ops เริ่มแล้ว: **มี production Docker image แล้ว** (O1: `api` และ `web` จาก `Dockerfile` ที่ root พร้อม `scripts/smoke-images.sh` ใน CI) และ**มี Compose ของ production แล้ว** (O2: `compose.prod.yml` + `deploy/production.env.example` HTTPS อัตโนมัติด้วย Caddy เมื่อมี domain พร้อม `scripts/smoke-compose.sh` ใน CI) ดูหัวข้อ [Infra และ Deployment](#infra-และ-deployment) ต่อจาก monorepo, migration แรก และ `GET /api/health` เอกสารนี้คือแผนและข้อกำหนดของโปรเจกต์
>
> **หมายเหตุ:** ตัวเลข performance ทั้งหมดเป็นการประเมินจากหลักการ ยังไม่ได้วัดจริง ต้อง load test ก่อนใช้งาน

## จุดเด่นทางเทคนิค (ที่ออกแบบไว้)

โจทย์ที่ดูง่ายอย่าง "ลงชื่อเข้าชุมนุม" ยากตรงที่ทุกคนกดพร้อมกัน ระบบนี้จึงออกแบบโดยเน้นความถูกต้องภายใต้ concurrency:

- **กันลงเกินจำนวนที่ระดับ DB** ใช้ `CHECK` constraint และ `UPDATE ... WHERE registered < capacity` ไม่ได้พึ่งการเช็คใน app ต่อให้มีหลาย request ชนกันก็เกิน capacity ไม่ได้
- **Idempotent ทุก endpoint เขียน** client retry ซ้ำได้โดยไม่เกิดผลซ้ำ
- **เปลี่ยนชุมนุมแบบ atomic** ถ้าที่ใหม่เต็มก็ไม่เสียที่เดิม
- **Waitlist ที่ promote อัตโนมัติ** เรียงตามลำดับเข้าคิว รองรับการ promote เป็นทอด
- **Concurrency test กับ Postgres จริง** (Testcontainers) ยิง 500 request แย่ง 1 ชุมนุมแล้วตรวจ invariant ว่าไม่เกิน capacity และไม่มีลงซ้ำ
- **Event log แบบ append-only** ตรวจย้อนหลังได้ว่าใครทำอะไรเมื่อไร
- **ดูแลง่าย ต้นทุนต่ำ** Docker image 2 ตัว (api และ Caddy ที่มีหน้าเว็บอยู่ข้างใน) บน EC2 เครื่องเดียว คาดว่าไม่เกิน ~$40 ต่อปี (ประเมิน ยังไม่ได้ตรวจราคาจริง)

> การกันลงเกินที่ระดับ DB, idempotency, concurrency test และ event log ทำแล้วสำหรับการลง/ยกเลิก (Phase 1) ส่วนเปลี่ยนชุมนุมแบบ atomic และ waitlist ยังเป็นดีไซน์ตามแผน ดูความคืบหน้าที่หัวข้อ [Roadmap](#roadmap)

> **เกี่ยวกับ repo นี้:** เป็น Public เพื่อแสดงงาน จะไม่มีข้อมูลนักเรียน ครู หรือ secret จริงอยู่ใน repo เด็ดขาด ตัวอย่างและข้อมูลทดสอบทั้งหมดเป็นข้อมูลสมมติ

## เป้าหมาย

ให้นักเรียนลงทะเบียนชุมนุมออนไลน์ ถูกกติกา ไม่ลงเกินจำนวน ไม่ลงซ้ำ และให้ admin ได้รายชื่อไปใช้งาน

**รูปแบบการใช้งาน**

- ใช้ปีละ 2–4 ครั้ง ครั้งละไม่กี่วัน
- แบ่งรอบตามชั้น → peak จริง ~450 concurrent ต่อรอบ
- โปรเจกต์ส่วนตัว (greenfield) ดูแลโดยคนเดียวหรือทีมเล็ก

## กติกาธุรกิจ

1. นักเรียน 1 คน ลงได้ 1 ชุมนุมต่อรอบ ถ้ามีแล้วต้องยกเลิกก่อนถึงจะลงใหม่ได้
2. แต่ละชุมนุมจำกัดจำนวนรับ
3. ห้ามลงเกินจำนวนที่ตั้งไว้ (enforce ที่ระดับ DB)
4. จำกัดจำนวนคนที่เข้าเลือกพร้อมกัน ที่เหลือรอคิว (คล้ายระบบซื้อตั๋วคอนเสิร์ต)
5. มี waiting list เมื่อชุมนุมเต็ม
6. เปลี่ยนชุมนุมแบบ atomic (ไม่เสียที่เดิมถ้าที่ใหม่เต็ม)

## Role

| Role | ทำได้ |
|---|---|
| `student` | login, เข้าคิว, ดูชุมนุมในชั้นตัวเอง, ลง/ยกเลิก/เปลี่ยน, เข้า waitlist, ดูประวัติของตัวเอง |
| `admin` | import Excel, จัดการรอบ/ชุมนุม, export รายชื่อ (รายชุมนุม/รายห้อง เป็น Excel/PDF), เพิ่ม/ลบ/ย้ายนักเรียนแทน, ดู event log |

ครูไม่ login ข้อมูลครูเก็บไว้ในชุมนุม (ชื่อ, เบอร์, อีเมล, LINE ID เป็น optional) และ admin export รายชื่อให้ครูแทน นักเรียนเห็นแค่ชื่อครู ข้อมูลติดต่อเห็นเฉพาะ admin (ดูหัวข้อ [Security](#security))

## Tech Stack

| ชั้น | เลือก | เหตุผลสั้นๆ |
|---|---|---|
| ภาษา/Runtime | TypeScript (strict), Node.js 24 LTS (≥ 24.7) | type safety, กลับมาแก้ปีหน้าได้ง่าย |
| Backend | Fastify + Zod (`fastify-type-provider-zod`) | เร็ว, validation + type จาก schema เดียว |
| Database | PostgreSQL + `pg` + SQL ตรงๆ | logic หลักคือ transaction/advisory lock ORM ซ่อนจนอ่านยาก |
| Migration | `node-pg-migrate` | เบา ไม่ผูกกับ ORM |
| Auth | `@fastify/jwt` + `@fastify/cookie`, argon2id จาก `node:crypto` | argon2id มีใน Node 24.7+ แล้ว ไม่ต้องพึ่ง native addon |
| Frontend | Vite + React + Tailwind/shadcn/ui + `react-router` | SPA หลัง login ไม่ต้อง SSR |
| Data fetching | TanStack Query | polling คิว/สถานะทำง่าย |
| Excel | `exceljs` | อ่าน/เขียน .xlsx |
| PDF | `pdfkit` + ฟอนต์ Sarabun (SIL OFL 1.1) | สร้างฝั่ง server ไม่ต้องมี browser, spike แล้ววางสระบน/ล่างและวรรณยุกต์ไทยถูก (รายการที่ยังเปิดอยู่ข้อ 6) |
| Test | Vitest + Testcontainers | concurrency test ต้องใช้ Postgres จริง ห้าม mock |
| Repo | pnpm workspaces (monorepo เดียว) | แชร์ Zod/type, PR เดียวแก้ได้ทั้งระบบ |
| Deploy | Docker image 2 ตัว (`api` = Node, `web` = Caddy + ไฟล์ build ของ React) + Compose บน EC2 | เครื่องเดียว ดูแลง่าย Caddy เสิร์ฟไฟล์ static เก่งกว่าและทำ HTTPS อยู่แล้ว api จึงไม่ต้องเสิร์ฟหน้าเว็บ |

**ที่เลือกไม่ใช้**

- **Next.js:** ไม่มีหน้า public/SEO และผูก lifecycle ของ framework
- **Redis:** ที่ ~450 concurrent ต่อรอบ Postgres พอ (ต้องยืนยันด้วย load test)
- **ORM (Prisma/Drizzle):** logic หลักเป็น raw SQL อยู่แล้ว
- **Serverless:** ขัดกับเครื่องเดียว และ advisory lock/connection pool ยุ่งยาก
- **แยก repo FE/BE:** ไม่มีเหตุผลด้าน infra/ทีม

## โครงสร้างโปรเจกต์

```
club-registration/
├── apps/
│   ├── api/        # Fastify + pg + migrations (+ assets/fonts ฟอนต์ PDF, OFL)
│   └── web/        # Vite + React
├── packages/
│   └── shared/     # Zod schema + type ที่ใช้ร่วมกัน
├── deploy/         # production.env.example (template ของ env file production ไม่มีค่าจริง)
├── scripts/        # smoke-images.sh, smoke-compose.sh ทดสอบ image และ compose จริง (CI job images)
├── templates/      # Excel template เปล่า (ไม่มีข้อมูลจริง)
├── Dockerfile      # target api และ web
├── .dockerignore   # allowlist ของ build context
├── docker-compose.yml  # Postgres สำหรับ dev เท่านั้น
├── compose.prod.yml    # stack ของ production (postgres, migrate, api, web)
├── Caddyfile       # อยู่ใน image web
├── .env.example
└── pnpm-workspace.yaml
```

**หลักการ monorepo**

- FE กับ BE เปลี่ยนพร้อมกันเสมอ → repo เดียว commit เดียวคือสถานะที่ใช้ได้
- Same-origin (`/api/*` + SPA) → ไม่ต้องตั้ง CORS
- `apps/web` กับ `apps/api` **ห้าม import กันตรงๆ** คุยผ่าน HTTP และ `packages/shared` เท่านั้น (บังคับด้วย ESLint `no-restricted-imports`)
- ถ้าวันหนึ่งต้องแยกจริง (มี mobile app / ทีม FE แยก) ต้องทำเพิ่ม: จัดการ shared package, ตั้ง CORS/auth, ทำ pipeline host static ฝั่ง FE

## Data Model

```sql
users               -- นักเรียนและ admin (role: student | admin), password_hash, must_change_password, session_version, password_issued_at
student_profiles    -- grade (1-6), classroom, seat_no
rounds              -- 1 รอบต่อชั้นต่อเทอม: term, grade, opens_at, closes_at, max_active
clubs               -- club_code, name, description, capacity, registered, round_id
club_advisors       -- ครูของชุมนุม: full_name, phone, email, line_id (optional ทั้งหมด)
registrations       -- สถานะปัจจุบัน UNIQUE(round_id, student_id)
registration_events -- log append-only: register/cancel/change/admin_*/waitlist_*, actor_id, idempotency_key
waitlist_entries    -- UNIQUE(round_id, student_id), เรียงตาม created_at
queue_tickets       -- status: waiting | admitted | expired | done
password_issuances  -- บันทึกการออกรหัสผ่านเริ่มต้น: admin_id, ขอบเขต (ชั้น/ห้อง), จำนวน, idempotency_key (ไม่เก็บรหัสผ่าน)
```

**Constraint สำคัญ (enforce ที่ DB ไม่ใช่แค่ฝั่ง app)**

- `UNIQUE(round_id, student_id)` บน `registrations` → 1 คน 1 ชุมนุมต่อรอบ
- `CHECK (registered >= 0 AND registered <= capacity)` บน `clubs`
- `UNIQUE(round_id, club_code)` บน `clubs` → ใช้เป็น key ตอน upsert จาก Excel
- `UNIQUE(actor_id, idempotency_key)` บน `registration_events` → retry ไม่เกิดซ้ำ

**จุดวิกฤต: การจองที่นั่ง** (ทำแล้วใน `apps/api/src/services/registrations.ts` ทีละ statement ตามลำดับ ใน transaction สั้นๆ เดียว)

```sql
BEGIN;
SELECT round_id, pg_advisory_xact_lock(round_id::bigint) FROM clubs WHERE id = $club;  -- ไม่มี → 404
SELECT ... FROM registration_events WHERE actor_id = $student AND idempotency_key = $key;  -- เคยทำแล้ว → ตอบซ้ำ
SELECT grade FROM student_profiles WHERE user_id = $student FOR SHARE;
WITH target AS (  -- ชั้นตรงกับรอบ + เป็นรอบที่นักเรียนเห็น + อยู่ในช่วงเปิดตามนาฬิกา DB
  SELECT ... statement_timestamp() >= opens_at AND statement_timestamp() < closes_at AS is_open ...
), inserted AS (
  INSERT INTO registrations (round_id, student_id, club_id)
  SELECT ... FROM target WHERE is_open
  ON CONFLICT (round_id, student_id) DO NOTHING RETURNING created_at                  -- มีแล้ว → อ่านว่าชุมนุมไหน
) SELECT ...;
UPDATE clubs SET registered = registered + 1
WHERE id = $club AND round_id = $round AND registered < capacity;        -- 0 rows → ROLLBACK 409 club_full
INSERT INTO registration_events (..., 'register', actor_id = $student, idempotency_key = $key);
COMMIT;
```

- **Idempotent:** ส่ง key เดิมซ้ำ → ตอบ 200 ไม่เขียนซ้ำ ส่งลงชุมนุมเดิมซ้ำด้วย key ใหม่ (ชนกับ `UNIQUE(round_id, student_id)`) → 200 พร้อม registration เดิม ไม่เขียน event เพิ่ม
- ช่วงเปิดรอบ (`opens_at` ≤ เวลา < `closes_at`) และ `student.grade = round.grade` เป็นเงื่อนไขของ `INSERT ... SELECT` เอง ไม่ใช่การเช็คใน app ก่อนเขียน (รายละเอียดดู Phase 1 ข้อ 4)

## Roadmap

### Phase 1: ลงทะเบียนได้จริงและปลอดภัย

**เป้าหมาย:** admin เตรียมข้อมูล → นักเรียนลง/ยกเลิกถูกกติกา → admin ได้รายชื่อ

1. ~~**Auth:** login รหัสนักเรียน + รหัสเริ่มต้นสุ่มรายคน, บังคับเปลี่ยนรหัสครั้งแรก, role `student`/`admin` (JWT, secret จาก env)~~ เสร็จแล้ว
2. ~~**Admin import Excel:** students, clubs, advisors → dry run → ยืนยัน → upsert ใน transaction เดียว~~ เสร็จแล้ว รวมขั้นออกรหัสผ่านเริ่มต้นให้นักเรียนที่นำเข้า (ดูหัวข้อ [Security](#security)) ขั้นยืนยันถือ round lock ทุกรอบของภาคเรียน จึงไม่แข่งกับการลง/ยกเลิก (ดู [Excel Import/Export](#excel-importexport) ข้อ 3 และเทสต์ `apps/api/test/import-commit-round-locks.test.ts`)
3. ~~**Admin จัดการรอบ:** สร้างรอบต่อชั้น กำหนด `opens_at`/`closes_at`~~ เสร็จแล้ว (สร้างทีละชั้นหรือครบ ม.1–ม.6, แก้เวลา/`max_active`, ลบรอบที่ยังไม่มีชุมนุม, สถานะคำนวณตอนอ่าน) และ**หน้าชุมนุมรายรอบ**เสร็จแล้ว:
   - `GET /api/admin/rounds/:roundId/clubs` คืนรอบ (สถานะ + ยอดรวม) และชุมนุมเรียงตามรหัส: ชื่อ, รายละเอียด, จำนวนรับ, ลงแล้ว, เหลือ, ครู (รวมเบอร์/อีเมล/LINE เฉพาะ admin และไม่ log)
   - `PATCH /api/admin/clubs/:id` แก้ได้เฉพาะชื่อ รายละเอียด จำนวนรับ (รหัสชุมนุมและ `registered` แก้ไม่ได้) ลดจำนวนรับต่ำกว่าที่ลงแล้ว → `409 capacity_below_registered` ซึ่งมาจาก `CHECK` ของ DB ไม่ใช่การเช็คใน app (ใน transaction ที่เริ่มด้วย `pg_advisory_xact_lock(round_id)` ของรอบชุมนุมนั้นเหมือนการลง/ยกเลิก จึงรอการลงที่กำลังทำอยู่ให้ commit ก่อน แล้ว UPDATE เดียวที่ `CHECK` ตัดสินด้วยค่าล่าสุดเสมอ) เพิ่มจำนวนรับระหว่างรอบเปิดได้ (Phase 2 ต้อง promote waitlist ใน transaction เดียวกัน) ไม่รับ `idempotency_key` เหมือน endpoint ของรอบ เพราะส่งซ้ำได้ผลเดิม
   - หน้า `/admin/clubs` เลือกรอบ → ตาราง → แก้ในฟอร์มโดยส่งเฉพาะช่องที่เปลี่ยน poll ทุก 5 วินาทีเฉพาะรอบที่เปิดอยู่ (รอบที่เพิ่งเปิดระหว่างดูหน้าอยู่ต้องโหลดหน้าใหม่) รายละเอียดแสดงเป็นข้อความล้วน
4. ~~**นักเรียน:** ดูรายการชุมนุมในชั้นตัวเอง (ชื่อครู, ที่เหลือ), ลง, ยกเลิก, ดูผลของฉัน~~ เสร็จแล้ว ทั้ง API ส่วนอ่าน (S1), ลง/ยกเลิก (S2) และหน้าเว็บนักเรียน (S3):
   - `GET /api/student/round` คืน `{ round, registration }` โดย `round` มี id, ภาคเรียน, ชั้น, เวลาเปิด/ปิด และสถานะ (`upcoming`/`open`/`closed` คำนวณตอนอ่านแบบเดียวกับฝั่ง admin) ไม่มี `maxActive` และยอดรวมที่เป็นของ admin ส่วน `registration` คือชุมนุมที่ตัวเองลงในรอบนั้น (id, รหัส, ชื่อ, เวลาที่ลง) หรือ `null` ชั้นที่ไม่มีรอบเลย = `round: null` ไม่ใช่ error
   - `GET /api/student/clubs` คืน `{ round, registration, clubs }` ชุมนุมของรอบเดียวกันเรียงตามรหัส: ชื่อ, รายละเอียด (ข้อความล้วน), จำนวนรับ, ลงแล้ว, เหลือ และ**ชื่อครูเท่านั้น** (`advisorNames` ลำดับเดียวกับฝั่ง admin) แนบรอบและชุมนุมที่ลงมาด้วยเพื่อให้หน้าเว็บ poll endpoint เดียว ไม่มีรอบ = `clubs: []`
   - **เลือกรอบ:** จากรอบของชั้นตัวเองเท่านั้น เอารอบที่เปิดอยู่ตอนนี้ ถ้าไม่มีเอารอบที่ยังไม่เปิดที่จะเปิดเร็วสุด ถ้าไม่มีอีกเอารอบที่ปิดล่าสุด (ไว้ดูผลของตัวเอง) ได้รอบเดียวหรือไม่มีเลย ถ้า admin ตั้งช่วงเวลาของสองภาคเรียนทับกันจนเปิดพร้อมกัน เลือกรอบที่ปิดเร็วสุด เลือกด้วย `ORDER BY … LIMIT 1` โดยใช้เวลาเดียวกับที่คำนวณสถานะ
   - นักเรียน ชั้น และรอบมาจาก session เท่านั้น ไม่มีพารามิเตอร์ใน path และใส่ query ใดๆ = `400` (query เป็น strict เหมือน export) admin = `403`, ไม่มี session = `401`, ยังไม่เปลี่ยนรหัสครั้งแรก = `403 password_change_required` บัญชีนักเรียนที่ไม่มี `student_profiles` = `403 student_profile_missing` (import สร้างคู่กันเสมอ จึงเกิดได้แค่บัญชีที่สร้างทางอื่น ตอบแบบนี้แทน `round: null` เพื่อไม่ให้นักเรียนเข้าใจว่าชั้นตัวเองไม่มีรอบ และรู้ว่าต้องติดต่อ admin บัญชีแบบนี้ลงทะเบียนไม่ได้อยู่แล้วเพราะ `registrations` อ้าง `student_profiles`)
   - อ่านทั้งหมดใน read-only snapshot เดียวต่อ request รอบ ชุมนุมที่ลง และยอดของทุกชุมนุมจึงเป็นเวลาเดียวกัน ไม่มี side effect ไม่ log ชื่อนักเรียน ชุมนุม หรือครู
   - **ลง (S2):** `POST /api/student/registration` body `{ "clubId": 12, "idempotencyKey": "<16–128 ตัว A-Z a-z 0-9 _ ->" }` ตอบ `200 { "registration": { "club": { "id", "clubCode", "name" }, "registeredAt" } }` (รูปเดียวกับ S1) ลำดับใน transaction ดูหัวข้อ [จุดวิกฤต](#data-model) ชุมนุมที่ไม่มี ชุมนุมของชั้นอื่น และชุมนุมของรอบอื่นในชั้นตัวเองที่ไม่ใช่รอบที่นักเรียนเห็น (เลือกแบบเดียวกับ S1 ด้วยนาฬิกา DB ใน statement เดียวกับ INSERT) ตอบ `404 not_found` เหมือนกันหมด ไม่บอกว่ามีอยู่จริง
   - **ยกเลิก (S2):** `POST /api/student/registration/cancel` body `{ "idempotencyKey": "..." }` ยกเลิกชุมนุมของตัวเองในรอบที่นักเรียนเห็น (เลือกรอบแบบ S1 ด้วยนาฬิกา DB) → lock รอบ → idempotency → `DELETE` ที่มีเงื่อนไขช่วงเปิดรอบใน statement เดียวกัน → `registered = registered - 1` (`CHECK registered >= 0` กันติดลบ) → event `cancel` พร้อม `club_id` ตอบ `200 { "registration": null }`
   - **Error (409 ทั้งหมด):** `club_full` (UPDATE เงื่อนไข `registered < capacity` ได้ 0 แถว ROLLBACK ทั้งหมดรวมแถวที่เพิ่ง INSERT), `already_registered` (มีชุมนุมอื่นในรอบนี้แล้ว ต้องยกเลิกก่อน ตรวจก่อน `club_full`), `round_not_open` (ก่อนเปิด หลังปิด หรือชั้นนี้ไม่มีรอบเลย ตอนยกเลิก), `not_registered` (ยกเลิกทั้งที่ไม่มีชุมนุม), `idempotency_key_reused` ส่วน `404 not_found` ตามข้อบน, `400` body ไม่ตรง schema (strict: ใส่ `studentId`, `roundId` หรือ field อื่น = `400`, `clubId` ต้องเป็นตัวเลข JSON ไม่ใช่ข้อความ), `401` ไม่มี session, `403` admin / ยังไม่เปลี่ยนรหัสครั้งแรก / ไม่มี `student_profiles`, `415` ไม่ใช่ JSON, `429` เกิน rate limit
   - **Idempotency:** key อยู่ใน `registration_events` (`UNIQUE(actor_id, idempotency_key)`, actor = นักเรียนเอง) ส่ง key เดิมซ้ำเป็นคำขอเดียวกัน (ชนิดเดียวกัน และชุมนุมเดียวกันสำหรับการลง) → `200` ไม่เขียนอะไรเพิ่ม และตอบด้วย**สถานะปัจจุบัน**ของนักเรียนในรอบที่คำขอแรกทำ ไม่ใช่สำเนาคำตอบเดิม (เช่น ลงด้วย key A → ยกเลิก → ส่งการลงด้วย key A ซ้ำ ได้ `200 { "registration": null }`) ตอบซ้ำได้แม้รอบปิดไปแล้ว ใช้ key เดิมกับคำขออื่น (ชุมนุมอื่น หรือใช้ key ของการลงไปยกเลิก) → `409 idempotency_key_reused` คำขอที่ถูกปฏิเสธ (เช่น `club_full`) ไม่ทิ้ง event จึงส่ง key เดิมซ้ำทีหลังได้และจะถูกประมวลผลใหม่ key แยกต่อนักเรียน (คนละคนใช้ key ซ้ำกันได้) ส่งลงชุมนุมที่ถืออยู่แล้วด้วย key ใหม่ → `200` registration เดิม ไม่เขียน event (ตอบได้แม้รอบปิด เพราะไม่ได้เขียนอะไร)
   - **นาฬิกา:** การเขียนตัดสินช่วงเปิดด้วยนาฬิกา DB (`statement_timestamp()` ของ statement ที่เขียน ซึ่งรันหลังได้ lock แล้ว) request ที่รอ lock ข้าม `closes_at` จึงถูกปฏิเสธ และทุก process ใช้นาฬิกาเดียวกัน ส่วนสถานะที่ S1 แสดงคำนวณจากนาฬิกาของ app ซึ่งบนเครื่องเดียวที่ deploy คือนาฬิการะบบเดียวกัน ต่างกันแค่ช่วงเวลาระหว่างอ่านกับเขียน ถ้าหน้าเว็บเห็น "เปิด" อยู่เสี้ยววินาทีก่อนปิดแล้วได้ `round_not_open` ให้ถือผลของการเขียน
   - **Lock:** ทุก transaction ลง/ยกเลิกเริ่มด้วย `pg_advisory_xact_lock(round_id)` (แบบ bigint ตัวเดียว ซึ่งเป็นคนละ key space กับ `pg_advisory_xact_lock(1, 1)` แบบ int4 สองตัวของ import จึงไม่ชนกัน) ขั้นยืนยัน import ก็ถือ round lock ทุกรอบของภาคเรียนตัวเองด้วย (ดู [Excel Import/Export](#excel-importexport) ข้อ 3) การลงจึงเรียงกับ import ของภาคเรียนเดียวกันด้วย lock ของรอบ และล็อกแถว `student_profiles` ของตัวเองแบบ `FOR SHARE` ก่อน INSERT เพื่อไม่ให้ import ของภาคเรียนอื่นที่กำลังย้ายชั้นนักเรียนคนนั้นแทรกกลาง
   - **Rate limit:** 30 ครั้ง/นาที ต่อนักเรียน นับรวมการลงและยกเลิก (คลิกจริงไม่กี่ครั้งบวก retry อัตโนมัติ) store ใน memory ตามเครื่องเดียว นับเฉพาะ request ที่ผ่าน guard และ validation แล้ว
   - **Log:** เฉพาะ student id, round id, club id และผล (`registered`/`already_held`/`replayed`/`cancelled` หรือรหัส error) ไม่ log ชื่อนักเรียน ชุมนุม หรือครู
   - logic เป็นฟังก์ชันที่รับ DB client ของ transaction (`registerForClub`, `cancelRegistration`) route เป็นคนเปิด transaction Phase 2 จึงประกอบหลายขั้นใน transaction เดียวได้
   - **หน้าเว็บ (S3, `apps/web/src/pages/student/`):** `/student/clubs` มีหัวรอบ (ภาคเรียน ชั้น สถานะ เวลาเปิด/ปิดเป็นเวลาไทย) ชุมนุมที่ลงไว้แสดงเด่นด้านบนพร้อมลิงก์ไปหน้าผลของฉัน รายการเป็นการ์ดเรียงลงมา (นักเรียนส่วนใหญ่ใช้มือถือ) มีรหัส ชื่อ ชื่อครู ที่เหลือ/จำนวนรับ ป้าย "เต็ม" และรายละเอียดเป็นข้อความล้วนที่คงการขึ้นบรรทัด ปุ่มลงกดได้เฉพาะรอบเปิด ชุมนุมยังไม่เต็ม และยังไม่มีชุมนุม กดแล้วขึ้นกล่องยืนยันในการ์ดนั้นก่อนส่ง `/student/my-registration` แสดงชุมนุมที่ลงและเวลาที่ลง หรือ "ยังไม่ได้ลงชุมนุม" พร้อมลิงก์ไปหน้ารายการ ปุ่มยกเลิกมีเฉพาะตอนรอบเปิด และกล่องยืนยันเตือนว่าที่นั่งอาจมีคนอื่นลงแทน ทุก error code มีข้อความไทย (`club_full`, `already_registered`, `round_not_open`, `not_registered`, `idempotency_key_reused`, `rate_limited`, `not_found`, `student_profile_missing`)
   - **Idempotency ฝั่งเว็บ:** สร้าง key ใหม่ (`crypto.randomUUID()`) ทุกครั้งที่กดยืนยัน ถ้าไม่รู้ผล (ไม่ได้คำตอบจาก server เพราะเน็ตหลุด, ได้ 5xx หรือคำตอบอ่านไม่ได้) ปุ่ม "ลองอีกครั้ง" ส่งคำขอเดิมด้วย key เดิม server จึงตอบซ้ำแทนการทำสองครั้ง คำตอบ 4xx ถือว่าจบแล้ว กดใหม่ได้ key ใหม่ ปุ่มทั้งหมดปิดระหว่างรอคำตอบ และทุกคำตอบ (สำเร็จหรือไม่) โหลดข้อมูลทั้งสองหน้าใหม่
   - **Polling:** หน้ารายการ poll ทุก 5 วินาทีเฉพาะรอบเปิด รอบที่ยังไม่เปิดตั้งเวลาโหลดใหม่ตอนถึง `opens_at` ตามนาฬิกาเครื่อง (ห่างไม่เกิน 30 วินาทีเผื่อนาฬิกาช้า ไม่ถี่กว่า 2 วินาทีเผื่อนาฬิกาเร็ว และสุ่มเพิ่มไม่เกิน 1 วินาทีให้ทั้งชั้นไม่ยิงพร้อมกัน) หน้าจึงเปลี่ยนเป็นเปิดเองโดยไม่ต้องโหลดหน้าใหม่ รอบที่ปิดแล้วไม่ poll หน้าผลของฉันใช้ตัวตั้งเวลาเดียวกันทั้งตอนเปิดและปิดรอบ สถานะที่ใช้ตัดสินมาจาก server เสมอ
5. ~~**กติกาที่ DB:** 1 คน 1 ชุมนุม, ห้ามเกิน capacity, เฉพาะชั้นตัวเอง, เฉพาะช่วงเปิดรอบ~~ เสร็จแล้ว (S2): `UNIQUE(round_id, student_id)`, `CHECK` + `UPDATE ... WHERE registered < capacity`, ชั้นและช่วงเปิดเป็นเงื่อนไขของ `INSERT ... SELECT`/`DELETE` ตามนาฬิกา DB
6. ~~**Idempotency + event log**~~ เสร็จแล้ว (S2): ทุกการลง/ยกเลิกเขียน `registration_events` พร้อม `idempotency_key` ใน transaction เดียวกัน (ตาราง append-only ด้วย trigger)
7. **Admin export:** รายชื่อแบบ **รายชุมนุม** และ **รายห้อง** เลือกได้ทั้ง **Excel** และ **PDF** (รายละเอียดดูหัวข้อ [Export รายชื่อ](#export-รายชื่อ)) ทั้ง Excel (A6a) และ PDF (A6b) **เสร็จแล้ว**
8. **Ops:** Dockerfile, `docker-compose.yml`, Caddy HTTPS, `/api/health`, migration script แยก, graceful shutdown, backup `pg_dump` ไป S3, runbook (deploy/backup/restore/เปิด-ปิดเครื่อง) แบ่งเป็น O1 image → O2 compose production + Caddy HTTPS/limits → O3 backup/restore → O4 runbook EC2 → O5 load test
   - ~~**O1 image**~~ เสร็จแล้ว: `Dockerfile` (target `api`, `web`), `Caddyfile`, `.dockerignore`, `scripts/smoke-images.sh` และ CI job `images` รายละเอียดดู [Infra และ Deployment](#infra-และ-deployment)
   - ~~**O2 compose production**~~ เสร็จแล้ว: `compose.prod.yml` (postgres, migrate, api, web พร้อม healthcheck, memory limit, log rotation, network แยก), `deploy/production.env.example`, Caddy HTTPS + HSTS + จำกัดขนาด body, ตั้ง pool/timeout ของ DB ผ่าน env (`DB_*`), `scripts/smoke-compose.sh` ใน CI job `images` รายละเอียดดู [Compose ของ production (O2)](#compose-ของ-production-o2)
9. ~~**Test:** concurrency test + invariant `clubs.registered` = จำนวน registration จริง~~ เสร็จแล้ว (S2): `apps/api/test/registration-concurrency.test.ts` (500 นักเรียนแย่ง 30 ที่ → 200 พอดี 30 ที่เหลือ `club_full` 470, คนเดียวกดหลายชุมนุมพร้อมกันได้ชุมนุมเดียว, key เดียวกันพร้อมกันเกิดผลครั้งเดียว, ยกเลิกแข่งกับลง, ยกเลิกแล้วคนอื่นแย่งที่ว่าง) และตัวตรวจ invariant `registrationInvariantViolations` (`apps/api/test/support/registration.ts`: `registered` = จำนวนแถว, อยู่ใน 0..capacity, 1 คน 1 แถวต่อรอบ, ชั้นนักเรียน = ชั้นรอบ, ชุมนุมอยู่ในรอบเดียวกัน, register − cancel ตรงกับที่นั่งทั้งรายคนและรายชุมนุม, event ล่าสุดตรงกับชุมนุมที่ถือ) รันหลังทุกเทสต์ของไฟล์ลง/ยกเลิก
   - **วัดจริงในเทสต์** (เครื่องพัฒนา 4 vCPU ไม่ใช่สเปค production, pool 20, ผ่าน `app.inject` ใน process เดียว ไม่มี network, 4 รอบ): 500 request พร้อมกันจบทั้งหมดใน 2.4–2.6 วินาที (เฉลี่ย ~5 ms ต่อ request เพราะเรียงกันด้วย lock ของรอบ) ต้อง load test บนเครื่องจริง ข้อควรระวัง: ทุก transaction ในรอบเรียงกันด้วย lock และ request ที่รอ connection จาก pool เกิน 5 วินาที (`connectionTimeoutMillis`) จะได้ 500 ถ้าเครื่องจริงช้ากว่านี้หลายเท่า ต้องปรับ pool/timeout (ตั้งได้ด้วย env `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS` ฯลฯ ไม่ต้อง build ใหม่) หรือเปิด queue (Phase 3)

**ยังไม่อยู่ใน Phase 1:** queue, waitlist, เปลี่ยนชุมนุมแบบ atomic, admin เพิ่ม/ลบ/ย้ายนักเรียนแทน

> ถ้าต้องใช้จริงก่อนมี queue ให้เปิดรอบทีละชั้นและเหลื่อมเวลา เพื่อคุม load
>
> Migration แรกควรสร้างตารางของ phase หลัง (`waitlist_entries`, `queue_tickets`, event types ครบ) ไว้ก่อน แต่ยังไม่ต้องเขียน logic

### Phase 2: เปลี่ยนชุมนุม + Waitlist + Admin แก้แทน

**Locking:** ทุก write transaction ในรอบเริ่มด้วย `SELECT pg_advisory_xact_lock($round_id)` → serialize ต่อรอบ ไม่มี deadlock และ logic ง่าย (แลกกับการไม่ขนานข้ามชุมนุม ซึ่งที่ ~450 คนต่อรอบน่าจะรับได้ ต้อง load test) **ใช้ตั้งแต่ Phase 1 แล้ว** กับการลง/ยกเลิก admin แก้ชุมนุม และขั้นยืนยัน import (ถือทุกรอบของภาคเรียน เรียง id ต่อจาก import lock) (`apps/api/src/services/round-lock.ts`) endpoint ของ Phase 2 ต้องใช้ helper เดียวกัน ถ้าต้องถือหลายรอบต้องล็อกเรียง id และให้ได้ครบก่อนแตะแถวใด ไม่อย่างนั้นอาจเกิด deadlock กับ import

**เปลี่ยนชุมนุมแบบ atomic:** transaction เดียว: `+1` ที่ใหม่ (เงื่อนไข `registered < capacity`), `-1` ที่เดิม, อัปเดต registration, เขียน event ถ้าที่ใหม่เต็ม → ROLLBACK นักเรียนยังอยู่ที่เดิม

**กติกา waitlist**

1. ลงชุมนุมที่เต็ม → `409 club_full` + ให้เลือกเข้ารายชื่อรอ
2. ห้ามลงตรงถ้าชุมนุมมีคนรอ (กันแซงคิว)
3. เข้า waitlist ได้ 1 ชุมนุมต่อรอบ (เข้าใหม่ต้องออกจากอันเดิม = เสียลำดับ)
4. มีที่ว่าง (ยกเลิก/admin ลบ/เพิ่ม capacity/คนย้ายออก) → promote คนรอที่ `created_at` เก่าสุดอัตโนมัติ
5. คนที่ถูก promote ถ้ามีชุมนุมอยู่แล้ว = เปลี่ยนแบบ atomic (ที่เดิมว่างและ promote ต่อเป็นทอด) ถ้ายังไม่มี = ลงใหม่
6. ปิดรอบ → หยุด promote
7. ทุก join/leave/promote เขียนลง `registration_events`

**Promote loop:** ท้ายทุก endpoint ที่ทำให้เกิดที่ว่างใช้ฟังก์ชันเดียวกัน วนหาคนรอที่เก่าสุดในชุมนุมที่มีที่ว่างจนไม่มีใครถูก promote entry ถูกลบทันทีที่ promote จึงไม่วนไม่รู้จบ

**API เพิ่ม**

| Method | Path | ทำอะไร |
|---|---|---|
| PUT | `/registrations/me` | เปลี่ยนชุมนุมแบบ atomic |
| POST | `/waitlist` | เข้ารายชื่อรอ |
| DELETE | `/waitlist/me` | ออกจากรายชื่อรอ |
| GET | `/waitlist/me` | สถานะ + ลำดับที่ |
| GET | `/admin/clubs/:id/waitlist` | admin ดูรายชื่อรอ |

Admin เพิ่ม/ลบ/ย้ายนักเรียนแทน บันทึกเป็น `admin_assign`/`admin_remove` พร้อม `actor_id`

**Test ที่ต้องมี**

1. 500 request แย่ง 1 ชุมนุม capacity 30 → `registered = 30` พอดี
2. ที่เต็ม + 50 คนรอ ยกเลิกพร้อมกัน 10 คน → 10 คนแรกตามลำดับถูก promote ไม่ซ้ำ
3. promote เป็นทอด (B ว่าง → คนรอ B ย้ายมาจาก C → คนรอ C เข้า C)
4. ยิงคำสั่งซ้ำด้วย `idempotency_key` เดียวกัน → เกิดผลครั้งเดียว
5. Invariant: `clubs.registered` = จำนวน registration จริง, ไม่มีนักเรียนมี 2 registration

### Phase 3: Queue คุมจำนวนคนเข้า

- `POST /queue/join` → สร้าง ticket (idempotent) คืน position
- `GET /queue/status` (poll ทุก 3–5 วิ) อัปเดต `last_seen` และ admit ตาม `max_active`
- Ticket ที่ `last_seen` เกิน ~60 วิ → `expired` คืนที่ให้คนถัดไป
- `/clubs` และ `/registrations` ต้องมี ticket สถานะ `admitted`
- Admit ใช้ `FOR UPDATE SKIP LOCKED`
- **Load test จริง** ปรับ `max_active` (เริ่มที่ ~150) และ pool size

> **ข้อจำกัด:** queue/promote ยังไม่ได้ออกแบบสำหรับหลาย instance ยึดเครื่องเดียวไว้

### Phase 4: ปรับแต่ง

- หน้า "ประวัติของฉัน" (จาก `registration_events`)
- หน้า admin ดู event log
- แบนเนอร์ผลลัพธ์ (เช่น "คุณได้ชุมนุม B แล้ว ย้ายจาก C") เพราะไม่มีระบบแจ้งเตือน
- ปรับ UX, (ถ้าต้องการ) teacher login โดยเพิ่ม role `teacher` + `club_advisors.user_id`

## Excel Import/Export

**Template (3 sheet/ไฟล์)** — คอลัมน์เป็นการเดา ปรับตามไฟล์จริงของโรงเรียน ไฟล์เปล่าอยู่ที่ `templates/import-template.xlsx` (ดาวน์โหลดได้จาก `GET /api/admin/import/template`) สร้างจากนิยามคอลัมน์ใน `packages/shared/src/import.ts` ด้วย `pnpm --filter api generate-template`

| Template | คอลัมน์ |
|---|---|
| students | รหัสนักเรียน, ชื่อ-สกุล, ชั้น, ห้อง, เลขที่ |
| clubs | รหัสชุมนุม, ชื่อชุมนุม, ชั้นที่เปิดรับ, จำนวนรับ, รายละเอียด |
| advisors | รหัสชุมนุม, ชื่อครู, เบอร์โทร, อีเมล, LINE ID (1 แถวต่อครู 1 คน) |

**Flow**

1. Admin อัปโหลด → **dry run** ไม่เขียน DB
2. สรุป: เพิ่มกี่แถว / อัปเดตกี่แถว / error แถวไหนเพราะอะไร
3. ยืนยัน → ส่งไฟล์เดิมซ้ำพร้อม sha256 ที่ได้จากขั้นตรวจ (server ไม่เก็บไฟล์ไว้ระหว่างสองขั้น ถ้า hash ไม่ตรง = `409 import_file_mismatch`) → ตรวจและเทียบกับ DB ใหม่ แล้วเขียนทั้งหมดใน transaction เดียว (error แถวเดียว = `422 import_invalid` ไม่เขียนเลย) การยืนยันทำได้ทีละครั้งทั้งระบบ (`pg_advisory_xact_lock(1, 1)`) และต่อจากนั้นทันที ก่อนตรวจหรืออ่านอะไร จะถือ `pg_advisory_xact_lock(round_id)` ของ**ทุกรอบในภาคเรียนนั้น** เรียง id จากน้อยไปมาก (`lockRoundsOfTerm` ใน `apps/api/src/services/round-lock.ts`) ตามกฎข้อ 3 ของ CLAUDE.md เพราะ import แก้จำนวนรับของชุมนุมในรอบ และชั้นของนักเรียนตัดสินว่าลงรอบไหนได้
   - **ทำไมต้องล็อกรอบ:** ถ้าไม่ล็อก (READ COMMITTED) นักเรียนอาจลงชุมนุมและ commit ระหว่างที่ import อ่านว่าใครลงแล้วกับตอนที่ย้ายชั้น ผลคือนักเรียนถูกย้ายไปชั้นอื่นทั้งที่ยังถือที่นั่งในรอบของชั้นเดิม เมื่อล็อกแล้ว การลงในภาคเรียนนั้นจะ commit ก่อน import อ่าน (import จึงปฏิเสธการย้ายชั้นด้วย error ของแถวนั้น) หรือรอจน import commit (แล้วเจอนักเรียนในชั้นใหม่ ได้ `404 not_found` ตามกติกา S2) เท่านั้น
   - **ไม่มี deadlock:** ลง/ยกเลิก/admin แก้ชุมนุมถือ round lock แค่ตัวเดียว import เป็น writer เดียวที่ถือหลายตัว และได้ครบตามลำดับเดียว (import lock → รอบเรียง id) ก่อนแตะแถวใดๆ รอบที่สร้างในภาคเรียนหลังจาก import ล็อกไปแล้วไม่ต้องล็อก เพราะรอบใหม่ยังไม่มีชุมนุม และมีแค่ import (ซึ่งทำทีละครั้ง) ที่สร้างชุมนุมได้
   - **ผลต่อวันจริง:** ระหว่างยืนยัน import การลง/ยกเลิกของภาคเรียนนั้นจะรอจน import commit (ยังไม่ได้วัดว่านานเท่าไรกับไฟล์ 2,500 คน ต้องวัดตอน load test) ควรยืนยัน import ก่อนเปิดรอบ ส่วน dry run ไม่ถือ lock ใดๆ (อ่านใน snapshot READ ONLY) จึงไม่ทำให้ใครรอ
   - **การลงในภาคเรียนอื่น:** การตรวจ "ย้ายชั้นไม่ได้" ดูเฉพาะรอบของภาคเรียนที่ import เพราะที่นั่งในภาคเรียนก่อนเป็นประวัติ (ขึ้นชั้นทุกปี) ไม่ใช่เหตุให้ปฏิเสธ การลงในรอบของภาคเรียนอื่นที่แข่งกับ import ยังถูกเรียงด้วย `FOR SHARE` บนแถว `student_profiles` (ดู Phase 1 ข้อ 4) ข้อควรระวัง: ถ้ารอบของภาคเรียนก่อนยังเปิดอยู่ตอนยืนยัน import ภาคเรียนใหม่ที่ย้ายชั้น นักเรียนจะยังถือที่นั่งในรอบเก่านั้นและยกเลิกเองไม่ได้ (หน้าเว็บเลือกรอบตามชั้นใหม่) จึงควรปิดรอบของภาคเรียนก่อนให้หมดก่อน
4. **Upsert ตามรหัส** อัปโหลดซ้ำได้ไม่เกิดข้อมูลซ้ำ ครั้งที่สองรายงานว่าไม่เปลี่ยนทั้งหมด ไม่ลบนักเรียน/ชุมนุมที่ไม่มีในไฟล์ และไม่แตะ `registered`
5. Advisors **replace ทั้งชุดต่อชุมนุม** เพื่อให้ครูที่ถูกถอดหายจริง (ชุมนุมที่ไม่มีในชีต advisors คงครูเดิม)
6. นักเรียนใหม่ได้ `password_hash` เป็นค่าที่ login ไม่ได้ (`!unissued`) + `must_change_password` จนกว่า admin จะออกรหัสผ่านเริ่มต้น นักเรียนเดิมอัปเดตแค่ชื่อ/ชั้น/ห้อง/เลขที่ ไม่แตะรหัสผ่านหรือ session

**กติกาของไฟล์**

- มีชีตใดก็ได้จาก `students`, `clubs`, `advisors` ชีตที่ไม่มีในไฟล์ = ไม่แตะข้อมูลชนิดนั้น แถวแรกเป็นหัวตาราง จับคอลัมน์ตามชื่อ (ไม่สนลำดับ) คอลัมน์อื่นนอก template ไม่อ่าน ไม่เก็บ ไม่ log (PDPA)
- Admin เลือก **ภาคเรียน** ตอนอัปโหลด "ชั้นที่เปิดรับ" ของแต่ละแถวใน clubs เลือกรอบ (ภาคเรียน, ชั้น) ที่ต้องมีอยู่แล้ว ชุมนุมที่รับหลายชั้น = หลายแถวรหัสเดียวกันต่างชั้น (ที่นั่งแยกกันต่อชั้น)
- แถว advisors อ้างรหัสชุมนุม และใช้กับทุกรอบของภาคเรียนนั้นที่มีรหัสนี้ (ในไฟล์หรือใน DB)
- รหัสนักเรียน normalize แบบเดียวกับตอน login, รหัสชุมนุมเป็นตัวพิมพ์ใหญ่
- Error ที่ตรวจ (รายงานทุกจุดพร้อมชีต/แถว/คอลัมน์ ไม่หยุดที่จุดแรก): รูปแบบทุกเซลล์ตาม Zod, key ซ้ำในไฟล์, รหัสที่เป็นบัญชีที่ไม่ใช่นักเรียน, ไม่มีรอบของชั้นนั้น, จำนวนรับน้อยกว่าที่ลงแล้ว, ครูอ้างรหัสชุมนุมที่ไม่มีทั้งในไฟล์และ DB, เปลี่ยนชั้นนักเรียนที่ลงชุมนุมในรอบของภาคเรียนนี้แล้ว
- สูตรไม่ถูกคำนวณ ใช้ค่าที่ Excel เก็บไว้ ถ้าไม่มีค่าเป็น error เซลล์ที่ Excel แปลงเป็นวันที่เป็น error

**ข้อควรระวัง**

- ขนาดไฟล์ ≤ 5 MB (เฉพาะ route นี้), ชีตละ ≤ 5,000 แถว, ตรวจ extension `.xlsx` + magic bytes ของ zip ฝั่ง server (ไม่เชื่อ MIME จาก browser), จำกัดขนาดหลังแตก zip (กัน zip bomb), ประมวลผลใน memory ไม่เขียนลง disk, log แค่จำนวนแถวและ sha256
- Export escape ค่าที่ขึ้นต้นด้วย `=`, `+`, `-`, `@` กัน formula injection
- ขอเฉพาะคอลัมน์ที่จำเป็น (PDPA) ไม่รับเลขบัตรประชาชน/ที่อยู่

## Export รายชื่อ

Admin เลือก **รอบ** → เลือก **มุมมอง** (รายชุมนุม / รายห้อง) → เลือก **ขอบเขต** (ชุมนุมหรือห้องเดียว / ทั้งรอบ) → เลือก **รูปแบบ** (Excel / PDF)

| มุมมอง | ใช้ทำอะไร | หัวเอกสาร | คอลัมน์ | เรียงตาม |
|---|---|---|---|---|
| รายชุมนุม | ให้ครูที่ปรึกษาเช็คชื่อ | รหัส/ชื่อชุมนุม, ครูที่ปรึกษา, จำนวนลง/จำนวนรับ | ลำดับ, รหัสนักเรียน, ชื่อ-สกุล, ชั้น/ห้อง, เลขที่ | ชั้น → ห้อง → เลขที่ |
| รายห้อง | ให้ครูประจำชั้นตามคนที่ยังไม่ลง | ชั้น/ห้อง, จำนวนลงแล้ว/ทั้งห้อง | เลขที่, รหัสนักเรียน, ชื่อ-สกุล, ชุมนุม (ว่าง = **ยังไม่ลง**) | เลขที่ |

- **รายห้องต้องมีนักเรียนทุกคนในห้อง** รวมคนที่ยังไม่ลง ไม่ใช่แค่คนที่มี registration
- **ทั้งรอบ:** Excel = 1 sheet ต่อชุมนุม/ห้อง, PDF = ขึ้นหน้าใหม่ต่อชุมนุม/ห้อง
- **ข้อมูลติดต่อครู** (เบอร์, อีเมล, LINE) ไม่ใส่ใน export รายห้อง ใส่แค่ชื่อครูในรายชุมนุม
- **PDF:** ขนาด A4 แนวตั้ง ฝังฟอนต์ไทยที่ license อนุญาตให้แจกจ่าย (Sarabun, OFL) ท้ายหน้ามีวันเวลาที่ export (เวลาไทย) และเลขหน้า (รายละเอียดดู **รูปแบบ PDF** ข้างล่าง)
- **Excel:** escape ค่าที่ขึ้นต้นด้วย `=`, `+`, `-`, `@` (และ tab/CR) เหมือนข้อมูลอื่น ใช้ `escapeCellText` จาก `apps/api/src/export/escape-cell.ts` ตัวเดียวกับไฟล์รหัสผ่านเริ่มต้น
- ชื่อไฟล์ใช้แค่รหัสรอบ/ชุมนุม/ห้อง ไม่ใส่ชื่อนักเรียนหรือครู
- เป็น endpoint อ่าน ไม่มี side effect และต้องเป็น role `admin` เท่านั้น
- **API:** `GET /api/admin/rounds/:roundId/export?view=club|classroom&format=xlsx|pdf` เพิ่ม `clubId=<id>` (รายชุมนุม) หรือ `classroom=<ห้อง>` (รายห้อง) เพื่อเลือกชุมนุม/ห้องเดียว ไม่ใส่ = ทั้งรอบ query เป็น strict (ใส่ `clubId` คู่กับ `view=classroom` หรือพารามิเตอร์ที่ไม่รู้จัก = `400`) `format` เป็น enum (`xlsx`, `pdf`) ค่าอื่น = `400` ทั้งสองรูปแบบใช้ข้อมูลชุดเดียวกัน (service `name-lists.ts` และหัวเอกสาร/แถวจาก `export/name-list-content.ts`) ต่างกันแค่การวาง อ่านทั้งหมดใน read-only snapshot เดียว ตัวเลขบนหัวชีต/หัวหน้าจึงตรงกับแถวข้างล่างเสมอ (จำนวนลงนับจากแถวในชีต) รอบ/ชุมนุมที่ไม่มี (หรือชุมนุมของรอบอื่น) และห้องที่ไม่มีนักเรียนในชั้นของรอบ = `404 not_found` ทั้งรอบแต่ไม่มีชุมนุม/ไม่มีนักเรียนในชั้นเลย = `404 nothing_to_export` (Excel ต้องมีอย่างน้อย 1 ชีต) ชุมนุมเดียวที่ยังไม่มีคนลงได้ชีต/หน้าที่มีแต่หัวตาราง หน้า `/admin/export` ใช้ `GET /api/admin/rounds/:roundId/classrooms` (ห้องของชั้นนั้นพร้อมจำนวนลงแล้ว/ทั้งห้อง) เป็นตัวเลือกห้อง
- **รูปแบบชีต:** หัวชีตเป็นบรรทัดข้อความ (รหัส/ชื่อชุมนุม, ครูที่ปรึกษา, จำนวนลง/จำนวนรับ หรือ ชั้น/ห้อง, ลงแล้ว/ทั้งห้อง ตามด้วยรอบและเวลาที่ export เป็นเวลาไทย) เว้น 1 บรรทัดแล้วเป็นตาราง ชื่อชีต = รหัสชุมนุม หรือ `ม.<ชั้น>-<ห้อง>` A4 แนวตั้ง กว้างพอดี 1 หน้า หัวตารางพิมพ์ซ้ำทุกหน้า ท้ายหน้ามีเลขหน้า รายห้องเขียน **ยังไม่ลง** ในช่องชุมนุมของคนที่ยังไม่ลง
- **ชื่อไฟล์:** `club-list-round-<id>-grade-<ชั้น>[-<รหัสชุมนุม>].<xlsx|pdf>` / `classroom-list-round-<id>-grade-<ชั้น>[-room-<ห้อง>].<xlsx|pdf>` รหัส/ห้องที่เป็น ASCII เก็บแค่ตัวอักษร ตัวเลข `.` `_` `-` ที่มีอักษรอื่น (เช่น ไทย) ใช้ hex ของ UTF-8 แทน ตอบด้วย `Content-Type` ตามรูปแบบ (`application/pdf` สำหรับ PDF), `Content-Disposition: attachment` และ `Cache-Control: no-store` log แค่ admin id, รอบ, มุมมอง, รูปแบบ, ขอบเขต และจำนวน
- **รูปแบบ PDF** (`apps/api/src/export/name-list-pdf.ts`, สร้างทั้งไฟล์ใน memory แล้วตอบทีเดียวเหมือน Excel): หัวเอกสารและคอลัมน์ชุดเดียวกับ Excel ชื่อชุมนุม/ห้องตัวหนาเป็นบรรทัดแรก ตารางมีเส้นและหัวตารางพื้นเทา ตัวอักษร 11pt แถวละ 17pt (ห้อง 38–40 คนจบใน 1 หน้า) รายชื่อยาวต่อหน้าถัดไปโดยขึ้นบรรทัด "<ชื่อชุมนุม/ห้อง> (ต่อ)" และพิมพ์หัวตารางซ้ำ ท้ายทุกหน้ามี "ส่งออกเมื่อ <วันเวลาไทย> น." และ "หน้า n/N" (นับทั้งไฟล์)
  - **ข้อความไม่ล้นช่อง:** `pdfkit` ตัดบรรทัดได้แค่ที่ช่องว่าง ซึ่งชื่อไทยไม่มี จึงไม่พึ่งการตัดบรรทัด ทุกช่องเป็นบรรทัดเดียว ถ้ากว้างเกินช่องจะตัดท้ายแล้วใส่ "…" ตัดที่ขอบ grapheme (พยัญชนะไม่แยกจากสระบน/ล่างหรือวรรณยุกต์) และไม่จบด้วยสระหน้า (เ แ โ ใ ไ) เลือกตัดแทนการย่อตัวอักษรเพราะทุกแถวสูงเท่ากันและอ่านง่ายกว่า ชื่อที่ถูกตัดยังดูเต็มได้ในไฟล์ Excel บรรทัดหัวเอกสาร (เช่นรายชื่อครูหลายคน) ตัดบรรทัดที่ช่องว่างได้ไม่เกิน 3 บรรทัด (ชื่อชุมนุม 2 บรรทัด) แล้วตัดด้วย "…" แบบเดียวกัน
  - **ข้อความล้วน:** วาดเป็น glyph ไม่มีอะไรถูกตีความเป็น markup หรือสูตร (ไม่ต้อง escape แบบ Excel) ทุกข้อความอยู่ใน marked content `/Span` ที่มี `ActualText` เพื่อให้ copy/ค้นหาในโปรแกรมอ่าน PDF ได้ข้อความตรงตามที่เขียน (Sarabun วาด "ำ" เป็นนิคหิต + glyph สระอาที่ไม่มีรหัสอักษร ถ้าไม่มี `ActualText` ตัว "า" ทั้งไฟล์อาจ copy ออกมาหาย)
  - **ฟอนต์:** `apps/api/assets/fonts/Sarabun-Regular.ttf` และ `Sarabun-Bold.ttf` (SIL Open Font License 1.1, ข้อความ license อยู่ที่ `apps/api/assets/fonts/OFL.txt` ต้องแจกไปพร้อมฟอนต์) ฝังเฉพาะ glyph ที่ใช้ (subset) โมดูลหาฟอนต์จากตำแหน่งของตัวเอง (`import.meta.url` → `../../assets/fonts/`) จึงใช้ได้ทั้ง `src/` ตอน dev/test และ `dist/` หลัง `pnpm build` อ่านไฟล์ตอนโหลดโมดูล ถ้าหาไม่เจอ server ไม่ start (fail fast) Docker image `api` จึง copy `apps/api/assets/` ไปข้าง `dist/` (smoke script ตรวจทั้งไฟล์และว่า server start ได้)
  - **วัดจริงในเทสต์** (เครื่องพัฒนา 4 vCPU ไม่ใช่สเปค production, 4 รอบ): รายห้องทั้งรอบ 450 คน 12 ห้อง ได้ 12 หน้า ~99 KB ใช้ 195–300 ms ต่อ request (รวมอ่าน DB) ต้องวัดซ้ำบนเครื่องจริง
- **Spike PDF (ปิดรายการที่ยังเปิดอยู่ข้อ 6):** `pdfkit` 0.20.2 + Sarabun วางวรรณยุกต์ซ้อนบนสระบน, ป/ฝ/ฟ กับสระบน, ญ/ฐ กับสระล่าง และ "น้ำ" ถูกตำแหน่ง (ตรวจด้วยตาจากไฟล์ที่ render เป็นภาพ) จึงไม่ต้องถอยไปใช้หน้า print ของเบราว์เซอร์ ถ้าจะเปลี่ยนฟอนต์หรืออัปเกรด `pdfkit` ต้องลองกับชื่อสมมติแบบนี้ซ้ำ

## Security

- **รหัสผ่านเริ่มต้น:** สุ่มรายคน (10 ตัว ไม่มีตัวที่อ่านสับสน) ห้ามใช้เลขบัตร/วันเกิด ไม่มีที่ไหนเก็บรหัสจริง: admin เลือกชั้น (ห้องเดียวหรือทั้งชั้น ครั้งละไม่เกิน 1 ชั้น) แล้วกดออกรหัส server สุ่มและ hash (argon2id) แล้วตอบเป็นไฟล์ .xlsx ทันที (1 ชีตต่อห้อง, `Cache-Control: no-store`, ชื่อไฟล์มีแค่ชั้น/ห้อง) ไฟล์นั้นคือสำเนาเดียว ทำหาย = ออกใหม่ ซึ่งทำให้รหัสเดิมใช้ไม่ได้ทันทีและ bump `session_version` ออกให้ได้เฉพาะนักเรียนที่ `must_change_password` ยังเป็นจริง นักเรียนที่ตั้งรหัสเองแล้วจะไม่ถูกเขียนทับ (การรีเซ็ตรหัสที่ลืมของนักเรียนที่ใช้งานแล้วยังไม่มี) บังคับเปลี่ยนตอน login แรก
  - hash ก่อนเปิด transaction (จำกัดทำพร้อมกัน 2 งานทั้ง server ให้ login ยังได้ thread) แล้วใน transaction สั้นๆ lock แถวที่ยังมีสิทธิ์ด้วย `SELECT … FOR NO KEY UPDATE` เขียนเฉพาะแถวนั้น ไฟล์มีเฉพาะคนที่ถูกเขียนจริง นักเรียนที่เปลี่ยนรหัสระหว่างนั้นถูกข้าม admin สองคนออกขอบเขตเดียวกันพร้อมกัน → นักเรียนแต่ละคนมีรหัสที่ใช้ได้รหัสเดียว คือรหัสในไฟล์ของ request ที่ commit ทีหลัง
  - `idempotencyKey` ถูกเก็บใน `password_issuances` คู่กับการออก ส่ง key เดิมซ้ำ = `409 idempotency_key_reused` (ไม่ออกซ้ำ เพราะการออกซ้ำทำให้ไฟล์ที่อาจพิมพ์ไปแล้วใช้ไม่ได้) หน้าเว็บสร้าง key ใหม่ทุกครั้งที่กดยืนยัน
  - log เฉพาะ admin id, ขอบเขต, จำนวน และเวลา ไม่ log ชื่อ รหัสนักเรียน หรือรหัสผ่าน rate limit 20 ครั้ง/10 นาที ต่อ admin
  - วัดจริงในเทสต์ (เครื่องพัฒนา 4 vCPU ไม่ใช่สเปค production, 4 รอบ): ออกรหัส 450 คนใช้ 6.6–7.1 วินาทีต่อ request เกือบทั้งหมดคือ hash ส่วน transaction + สร้างไฟล์ใช้ไม่ถึง 0.1 วินาที ต้องวัดซ้ำบนเครื่องจริง
- **ตรวจสิทธิ์ที่ server ทุก endpoint** ไม่เชื่อ role/`student_id` จาก client ใช้ค่าจาก JWT เท่านั้น
- **Rate limit** ที่ `/auth/login` และ endpoint เขียน (ลง/ยกเลิกของนักเรียน 30 ครั้ง/นาที ต่อนักเรียน)
- **Session:** JWT (HS256, อายุ 2 ชม.) อยู่ใน cookie `HttpOnly; Secure; SameSite=Strict; Path=/api` ไม่เก็บใน `localStorage` ทุก request เช็ค `users.session_version` กับค่าใน token → logout หรือเปลี่ยนรหัส = token เก่าทุกเครื่องใช้ไม่ได้ทันที (สำคัญกับคอมห้องแล็บที่ใช้ร่วมกัน) และถ้า role ใน DB เปลี่ยน token เดิมก็ใช้ไม่ได้
- **บังคับเปลี่ยนรหัสครั้งแรก:** ถ้า `must_change_password` ทุก route ตอบ `403 password_change_required` ยกเว้น `/auth/me`, `/auth/change-password`, `/auth/logout`
- **CSRF:** `SameSite=Strict` + endpoint เขียนรับเฉพาะ JSON (form ข้ามเว็บส่ง `application/json` ไม่ได้ถ้าไม่ผ่าน CORS preflight ซึ่งเราไม่เปิด) ส่วน route อัปโหลด (multipart ซึ่ง form ข้ามเว็บส่งได้) ตรวจเพิ่มว่า `Sec-Fetch-Site` เป็น `same-origin`/`none` หรือถ้าไม่มี header นี้ `Origin` (ถ้าส่งมา) ต้องตรงกับ host (`apps/api/src/http/same-origin.ts`) ไม่ผ่าน = `403`
- **Rate limit login:** 10 ครั้ง/15 นาที ต่อ IP + รหัสผู้ใช้ (คนอื่นแกล้งล็อกบัญชีนักเรียนจากที่อื่นไม่ได้) และ 600 ครั้ง/นาที ต่อ IP ที่ตั้งสูงเพราะทั้งโรงเรียนอาจออก NAT IP เดียว **ต้องปรับตอน load test** store อยู่ใน memory ใช้ได้เพราะเป็นเครื่องเดียว และหลัง Caddy ต้องตั้ง `TRUST_PROXY=true` ไม่อย่างนั้นทุก request จะมี IP ของ Caddy และนับรวมเป็นก้อนเดียว
- **Login ที่ไม่มีผู้ใช้** ยังคำนวณ argon2 หนึ่งรอบ เวลาตอบจึงไม่บอกว่ารหัสนักเรียนไหนมีอยู่จริง
- **Admin คนแรก:** `pnpm --filter api create-admin <login_id>` สุ่มรหัส 16 ตัว แสดงครั้งเดียว เก็บแค่ hash และต้องเปลี่ยนตอน login แรก
- **Secret:** `JWT_SECRET`, DB password อยู่ใน env / SSM Parameter Store ห้ามอยู่ใน repo หรือ image บนเครื่องเก็บใน `deploy/production.env` (`chmod 600`, gitignored ด้วย `*.env`) ที่ทำจาก `deploy/production.env.example` ซึ่งไม่มีค่าจริง
- **ข้อมูลติดต่อครู** (เบอร์, อีเมล, LINE ID ทุกช่องเป็น optional): เห็นเฉพาะ admin (หน้า `/admin/clubs`) **นักเรียนเห็นแค่ชื่อครู** query ฝั่งนักเรียนไม่ SELECT คอลัมน์ติดต่อเลย (ใช้ `ADVISOR_NAMES_JOIN` ใน `services/clubs.ts` ตัวเดียวกับ export รายชุมนุม) และ response schema ของนักเรียนไม่มีช่องเหล่านี้ (serializer ตัดช่องที่ไม่อยู่ใน schema ทิ้งอีกชั้น) ถ้าวันหนึ่งจะให้นักเรียน ~2,500 คนเห็นช่องทางติดต่อ ต้องให้ครูยินยอมก่อน และใช้ช่องทางกลางของโรงเรียนถ้ามี
- **Frontend:** ห้าม `dangerouslySetInnerHTML` กับ `description` ที่ admin กรอก
- **Log:** ไม่ใส่ secret/PII พอสำหรับ debug
- **Repo เป็น Public:** ห้ามมีข้อมูลจริงทุกชนิด (นักเรียน ครู domain จริง IP ชื่อ bucket) เปิด secret scanning และ push protection แล้ว `.gitignore` กัน `*.xlsx` จริง / `.env*` / `*.dump` (เว้น `templates/`) ถ้าเผลอ push secret ต้อง rotate ทันที ลบจาก history ไม่พอ

## Infra และ Deployment

Docker image 2 ตัวจาก `Dockerfile` เดียวที่ root (multi-stage) ทั้งสอง target ใช้ขั้น `pnpm install` ร่วมกัน BuildKit จึงลงครั้งเดียวและ cache ให้ทั้งคู่ และ pin base image ไว้ที่เดียว

- **`api`** (Node): Fastify ตอบเฉพาะ `/api/*` ไม่เสิร์ฟหน้าเว็บ (ไม่ใช้ `@fastify/static`)
- **`web`** (Caddy): เสิร์ฟไฟล์ build ของ React (static + SPA fallback) และ reverse proxy `/api/*` ไปที่ api browser เห็น origin เดียว จึงไม่ต้องมี CORS

```
EC2 (t4g.small) ──► web: Caddy (HTTPS อัตโนมัติเมื่อมี domain)
                      ├─ ไฟล์ React ใน /srv + SPA fallback
                      └─► api: Fastify (/api/*) ──► postgres (container + volume)
```

### Image (O1)

| | `api` | `web` |
|---|---|---|
| Base | `node:24.22.3-slim` (Debian bookworm) | `caddy:2.11.9-alpine` |
| ข้างใน | `/app/apps/api/` = `dist/`, `migrations/`, `assets/fonts/` (Sarabun + `OFL.txt`), `package.json`, `node_modules` เฉพาะ production (จาก `pnpm --filter api deploy --prod` ซึ่งใส่ `dist/` ของ `packages/shared` มาเป็นโฟลเดอร์จริง) และ `/app/templates/import-template.xlsx` ไม่มี entry point ของ dev (`seed-dev`, `generate-template`, `dist/dev/`) ซึ่งถูกลบตอน build | ไฟล์ build ของ `apps/web` ใน `/srv` และ `Caddyfile` ใน `/etc/caddy/` (ตรวจด้วย `caddy validate` ตอน build ในโฟลเดอร์ชั่วคราว `/data` ของ image จึงว่างเสมอ ไม่มี CA หรือ key ติดไป) |
| User | `node` (uid 1000) ไฟล์ทั้งหมดเป็นของ root app แก้โค้ดตัวเองไม่ได้ | `caddy` (uid 1000) สร้างเองเพราะ image ทางการรันเป็น root ยัง bind พอร์ต 80/443 ได้เพราะ Docker ตั้ง `net.ipv4.ip_unprivileged_port_start=0` ให้ container |
| ขนาด (amd64, วัดจาก smoke) | 479 MB บนดิสก์ (base `node:24-slim` 333 MB) | 92.5 MB |

- **Pin ทั้ง tag และ digest** (`ARG NODE_IMAGE`, `ARG CADDY_IMAGE` บนสุดของ `Dockerfile`) digest เป็น index หลาย arch จึงใช้ได้ทั้ง amd64 และ arm64 อัปเกรดต้องเปลี่ยน tag กับ digest พร้อมกัน
- **pnpm:** `corepack install` ใช้เวอร์ชันจาก `packageManager` เหมือนเครื่องพัฒนา `pnpm fetch` ใช้แค่ lockfile (แก้โค้ดไม่ทำให้ต้องโหลดใหม่) แล้ว `pnpm install --frozen-lockfile --offline` ไม่มี flag หรือข้อยกเว้นที่ข้ามการตรวจ supply-chain policy ของ pnpm (เช่น `minimumReleaseAge`) store อยู่ใน cache mount ไม่อยู่ใน layer
- **โครงไดเรกทอรีเหมือน repo** (`/app/apps/api`) ไม่ใช่ `/app` เฉยๆ เพราะ `dist/import/template.js` หา template ที่ `../../../../templates/` จากตัวเอง เหมือนตอน dev
- **ไม่มี secret ใน image:** `.dockerignore` เป็น allowlist ส่งเข้า build เฉพาะ manifest, lockfile, `tsconfig.base.json`, `Caddyfile`, `apps/`, `packages/` และ template เปล่า แล้วตัด `node_modules`, `dist`, `.env*`, `.dev-credentials.txt`, `*.dump`, `*.xlsx` (ยกเว้น template) และเทสต์ออกอีกชั้น smoke script ตรวจว่าไม่มีไฟล์ `.env*`/`.dev-credentials.txt`/`*.dump` ทั้ง image
- **Build หลัง proxy ที่ดักถอด TLS:** ส่ง CA เป็น build secret `docker build --secret id=extra_ca,src=<pem> …` (ไม่ถูกเขียนลง layer) ปกติไม่ต้องใช้
- **api:** `CMD ["node", "dist/server.js"]` แบบ exec form node ได้ SIGTERM จาก `docker stop` เองแล้วปิด Fastify กับ pool ก่อนออก (smoke วัดได้ไม่ถึง 1 วินาที exit code 0) `HEALTHCHECK` ใช้ node ยิง `GET /api/health` (slim ไม่มี curl, DB ล่ม = 503 = unhealthy) ทุก 30 วินาที ช่วงเริ่มทุก 2 วินาที (`--start-interval` ต้องใช้ Docker Engine ≥ 25) migration และสร้าง admin เป็นคำสั่งแยกใน image เดียวกัน
- **web:** `Caddyfile` ที่ root อ่าน env 2 ตัว (ตารางข้างล่าง) cache: ไฟล์ใน `/assets/` มี hash ในชื่อ ได้ `Cache-Control: public, max-age=31536000, immutable` เฉพาะไฟล์ที่มีจริง (ไฟล์ที่ไม่มี = 404 ไม่ fallback เป็น `index.html`) ที่เหลือรวม `index.html` เป็น `no-cache` (revalidate ด้วย ETag deploy ใหม่จึงเห็นทันที) บีบอัด zstd/gzip ไม่เขียน access log (จะมี IP และ path ของนักเรียนทุกคน) Caddy เขียนทับ `X-Forwarded-For` ที่ client ส่งมาเอง api จึงตั้ง `TRUST_PROXY=true` ได้โดยปลอม IP ไม่ได้
- **Security headers ของหน้าเว็บ** (เฉพาะที่ไม่ใช่ `/api/*` ซึ่งใช้ของ `@fastify/helmet` ใน api อยู่แล้ว ไม่ซ้ำกัน): `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` (ไม่มี `'unsafe-inline'`/`'unsafe-eval'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` ปิดกล้อง ไมค์ ตำแหน่ง การจ่ายเงิน USB ตรวจใน Chromium จริงแล้วว่าไม่มี CSP violation (login, เปลี่ยนรหัส, หน้า admin, ดาวน์โหลด template และดาวน์โหลดแบบ blob) zod ทดสอบ eval ด้วย `new Function` ตอนสร้าง schema ซึ่ง CSP รายงานเป็น violation ทุกหน้า หน้าเว็บจึง import `@club-registration/shared/zod-jitless` เป็นอันแรกใน `main.tsx` เพื่อปิด JIT ของ zod ก่อน (api ไม่ import จึงยังใช้ JIT) HSTS ใส่เฉพาะตอนเป็น HTTPS (ดู [O2](#compose-ของ-production-o2)) ส่วน `upgrade-insecure-requests` ไม่ใส่ เพราะหน้าเว็บโหลดทุกอย่างแบบ relative จาก origin เดียวกันอยู่แล้ว
- **Multi-arch:** เครื่องจริงเป็น t4g (arm64) และ build บนเครื่องเองด้วย `docker compose build` ไม่มี registry ส่วน CI build แค่ amd64 เพื่อพิสูจน์ว่า Dockerfile ใช้ได้ **arm64 ยังไม่ได้ทดสอบ** (native binary ของ rolldown, lightningcss, Tailwind ที่ใช้ตอน build เว็บต้องมีของ arm64 ใน lockfile) ต้องรัน smoke script บนเครื่องจริงครั้งแรก
- **Smoke test:** `scripts/smoke-images.sh` (ต้องมีแค่ Docker และ curl) build ทั้งสอง image สร้าง network แล้วรัน postgres → `node dist/migrate.js` → `create-admin` → api → web บนพอร์ตว่าง แล้วตรวจผ่าน Caddy: `/api/health` 200 และ DB up, `/` เป็น SPA พร้อม security headers, deep link (`/student/clubs`) ได้ `index.html`, asset ที่มี hash ได้ 200 + immutable + บีบอัด, asset ที่ไม่มีได้ 404, `/api/nonexistent` ได้ JSON 404 ของ api, `/api/*` มี CSP ของ helmet ตัวเดียว, admin ที่สร้าง login ผ่าน Caddy ได้ (argon2id ใน image), ทั้งสอง container รันเป็น non-root, image api มีฟอนต์ OFL และ template ตรงที่ api หา ไม่มี `src`/เทสต์/dev dependency และ `docker stop` api จบเองภายใน 5 วินาทีด้วย exit code 0, ไม่มี entry point ของ dev ใน image api, `/data` กับ `/config` ของ image web ว่าง, ไม่มี HSTS บน HTTP ธรรมดา, health listener ของ Caddy ตอบใน container ลบ container/network เสมอด้วย `trap` secret ทุกตัวสุ่มต่อรอบและไม่พิมพ์ออกมา CI รันเป็น job `images` ทุก PR และทุก push เข้า `main`

image เดี่ยวๆ นอก compose (เช่นตอนแก้ `Dockerfile`):

```bash
docker build --target api -t club-registration-api .
docker build --target web -t club-registration-web .
docker run --rm -e DATABASE_URL club-registration-api node dist/migrate.js
docker run --rm -it -e DATABASE_URL club-registration-api node dist/create-admin.js <login_id>
```

### Compose ของ production (O2)

`compose.prod.yml` คือ stack ของเครื่องจริง ใช้คู่กับ env file ที่ทำจาก `deploy/production.env.example` เสมอ ส่วน `docker-compose.yml` เป็น Postgres ของ dev อย่างเดียว (ใช้กับ `pnpm dev`/เทสต์ ไม่เปลี่ยน) ไฟล์ production ตั้ง project name เป็น `club-registration-prod` container, volume และ network จึงไม่ชนกับของ dev

| Service | Image | ทำอะไร | Port บน host | Network | Restart | Memory limit |
|---|---|---|---|---|---|---|
| `postgres` | `postgres:18.7-alpine@sha256:…` (major เดียวกับเทสต์ pin tag + digest แบบหลาย arch) | DB + volume `postgres-data` healthcheck `pg_isready` ผ่าน TCP | ไม่มี | `backend` | `unless-stopped` | 512 MiB |
| `migrate` | image ของ `api` (ตัวเดียวกัน ไม่ build แยก) | `node dist/migrate.js` แล้วจบ | ไม่มี | `backend` | `"no"` | 192 MiB |
| `api` | build target `api` | Fastify รอ postgres healthy และ migrate จบด้วย 0 ก่อน start, `init: true`, `NODE_ENV=production`, `TRUST_PROXY=true`, healthcheck จาก image | ไม่มี | `backend` + `frontend` | `unless-stopped` | 512 MiB |
| `web` | build target `web` | Caddy (HTTPS, SPA, proxy `/api/*`) รอ api healthy | 80, 443, 443/udp (HTTP/3) | `frontend` | `unless-stopped` | 192 MiB |

- **Network:** `backend` เป็น `internal` (ไม่มีทางออก internet) Postgres จึงออกนอกเครื่องไม่ได้ และ Caddy อยู่แค่ `frontend` จึงไม่เห็น Postgres เลย มีแค่ `web` ที่เปิดพอร์ตบน host
- **Volume:** `postgres-data` (ข้อมูลทั้งหมด), `caddy-data` (`/data`: ใบรับรองและ ACME account) และ `caddy-config` (`/config`) อยู่ใน `/var/lib/docker/volumes/club-registration-prod_*` **ห้าม `down -v`** เป็นกิจวัตร: ลบ DB ทั้งก้อน และถ้าใบรับรองหายต้องขอใหม่ ขอใหม่ซ้ำหลายครั้งติด rate limit ของ Let's Encrypt (รอเป็นสัปดาห์) backup ของ DB เป็นงาน O3
- **Fail fast:** ตัวแปรที่จำเป็น (`SITE_ADDRESS`, `POSTGRES_*`, `DATABASE_URL`, `JWT_SECRET`) ใช้ `${VAR:?…}` ขาดตัวไหน compose ไม่ยอมรันและบอกชื่อ ส่วน `DB_*` ไม่ตั้งได้ (ค่าว่าง = default ของ api)
- **Log rotation:** ทุก service ใช้ `json-file` ไฟล์ละ 10 MB เก็บ 5 ไฟล์ (สูงสุด ~50 MB ต่อ container) วันที่คนเยอะดิสก์ไม่เต็มเพราะ log
- **Migrate:** รันทุกครั้งที่ `up` migration ที่ใช้แล้วถูกข้าม จึงไม่มีผลถ้าไม่มีของใหม่ ถ้า migrate ล้ม api ไม่ start (container เดิมของ api ยังรันต่อถ้ามี) ดูสาเหตุด้วย `logs migrate` ใช้ image เดียวกับ api เสมอ (`image: club-registration-prod-api`) build แค่ api ก็ไม่มีทางได้ migration เก่ากว่า server
- **หลัง reboot:** Docker start `postgres`, `api`, `web` เองตาม `unless-stopped` (ไม่ผ่าน compose จึงไม่รอกันตาม `depends_on`) ไม่เป็นไรเพราะ api ไม่ต่อ DB ตอน start: `/api/health` ตอบ 503 จน Postgres พร้อม แล้วกลับมาเอง `migrate` ไม่รันซ้ำ (ไม่จำเป็น เพราะ migration ทำไปแล้วตอน deploy)

**ตั้งค่าครั้งแรกบนเครื่อง** (การเตรียม EC2, DNS และ firewall อยู่ใน O4)

```bash
cp deploy/production.env.example deploy/production.env   # gitignored (*.env)
chmod 600 deploy/production.env
# แก้ไฟล์: SITE_ADDRESS=<domain จริง>, POSTGRES_PASSWORD=$(openssl rand -hex 24), JWT_SECRET=$(openssl rand -base64 48)
# เก็บสำเนา secret ไว้นอกเครื่องด้วย (เช่น password manager) ไม่มี POSTGRES_PASSWORD = เปิด DB ไม่ได้
alias dcp='docker compose -f compose.prod.yml --env-file deploy/production.env'
dcp build                       # build บนเครื่องเอง ไม่มี registry
dcp up -d --wait                # postgres → migrate → api → web รอจน healthy ทุกตัว
dcp run --rm --no-deps api node dist/create-admin.js <login_id>   # admin คนแรก แสดงรหัสครั้งเดียว
```

- password ของ DB ใช้ hex เพราะถูกใส่ลงใน `DATABASE_URL` (ตัวอย่างใน template ประกอบ URL จาก `POSTGRES_*` ให้เองด้วย `${…}` ของ env file) อักษรอย่าง `@ / : #` จะทำให้ URL เสีย
- `run --no-deps` สำคัญ: ไม่อย่างนั้น compose จะ start `migrate` ซ้ำก่อน
- ค่า `POSTGRES_*` มีผลแค่ตอนสร้าง volume ครั้งแรก เปลี่ยนใน env file ทีหลังไม่เปลี่ยนรหัสใน DB (ต้อง `ALTER ROLE` เองแล้วแก้ env file ให้ตรง)

**ใช้งานประจำ**

```bash
dcp ps                          # สถานะ + health (migrate ควรเป็น Exited (0))
dcp logs -f api                 # log JSON ของ api (ไม่มี secret/PII), web ไม่มี access log
dcp logs migrate
dcp restart api                 # ข้อมูลอยู่ใน postgres-data ไม่หาย
dcp stop                        # หยุดทั้งหมด ข้อมูลและใบรับรองอยู่ใน volume
dcp down                        # ลบ container/network แต่เก็บ volume (ไม่ใส่ -v)
```

**อัปเดต (deploy เวอร์ชันใหม่)**

```bash
git pull
dcp build
dcp up -d --wait                # สร้างเฉพาะ container ที่ image/ค่าเปลี่ยน, migrate รันก่อน api ใหม่
docker image prune -f           # ลบ image เก่าที่ไม่มี tag แล้ว (ดิสก์ EBS เล็ก)
```

ระหว่าง `up` api ถูกสร้างใหม่ หน้าเว็บสะดุดไม่กี่วินาที จึงควรอัปเดตตอนไม่มีรอบเปิด แก้ `Caddyfile` = build image `web` ใหม่แล้ว `up -d` (ไม่มี `caddy reload` เพราะปิด admin API ไว้ ดูข้างล่าง) แก้แค่ env file = `up -d` อย่างเดียว

**งบ memory (t4g.small 2 GiB ไม่มี swap)** เป็น limit ต่อ container ไม่ใช่ที่จองไว้ **ค่าประเมิน** ตัดสินด้วย `docker stats` ตอน load test (O5) ตอน idle วัดได้ web ~21 MiB, api ~80 MiB, postgres ~36 MiB

| Container | Limit | เหตุผล |
|---|---|---|
| `postgres` | 512 MiB | `shared_buffers` 128 MB + backend ~20 ตัวจาก pool + `work_mem` |
| `api` | 512 MiB | `NODE_OPTIONS=--max-old-space-size=320` (heap ล้นแล้วเห็น error ใน log แทนโดน kernel kill เงียบๆ) ที่เหลือคือโค้ด, buffer, argon2 (19 MiB ต่อ hash ทำพร้อมกันได้ไม่เกิน 4 ตาม thread pool ของ libuv), ไฟล์ import 5 MB และ export |
| `web` | 192 MiB | Caddy, `GOMEMLIMIT=160MiB` ให้ Go เก็บขยะก่อนชน limit |
| `migrate` | 192 MiB | เฉพาะตอน `up` แล้วจบ |
| **รวม** | 1216 MiB (1408 ตอน `up`) | เหลือ ~600 MiB ให้ kernel, dockerd/containerd, sshd และ page cache |

`docker compose build` ไม่อยู่ใน limit เหล่านี้ (vite/tsc ใช้หลายร้อย MB) ถ้า build ระหว่าง stack รันบนเครื่อง 2 GB อาจตึง O4 ต้องตัดสินว่าจะเปิด swap หรือ build ตอนไม่มีรอบเปิด

**ค่า Postgres** (ใน `command` ของ service ค่าประเมินจนกว่า O5): `shared_buffers=128MB` (DB ทั้งก้อนแค่หลักสิบ MB ใหญ่กว่านี้ไม่ได้อะไรแต่แย่ RAM จาก Node), `effective_cache_size=512MB` (แค่ hint ของ planner ไม่จอง memory), `max_connections=50` (pool 20 + create-admin/migrate + psql/`pg_dump` ของคนดูแล และเผื่อ O5 เพิ่ม pool ต้องสูงกว่า `DB_POOL_MAX` พอสมควรเสมอ), `work_mem=4MB` (export เรียงแค่หลักร้อยแถว), `maintenance_work_mem=64MB`, `shm_size: 128mb` (`/dev/shm` ของ Docker default 64 MB ที่ Postgres ใช้กับ parallel query), `stop_grace_period: 1m` (ให้ปิดแบบ fast shutdown + checkpoint จบ ไม่โดน SIGKILL ที่ 10 วินาทีจนต้อง crash recovery) และ log: `log_min_duration_statement=1000` (statement ช้ากว่า 1 วินาทีไว้ดูตอน load test) โดย `log_parameter_max_length=0` (ไม่ log ค่า parameter ซึ่งอาจเป็นรหัส/ชื่อนักเรียน) และ `log_error_verbosity=terse` (ไม่ log DETAIL ซึ่งอาจยกค่าในแถวมา)

**Caddy (O2)**

- **HTTPS:** `SITE_ADDRESS=<domain>` Caddy ขอใบรับรองจาก CA สาธารณะผ่าน ACME (ค่าเริ่มต้นคือ Let's Encrypt) และต่ออายุเอง (DNS ต้องชี้มาที่เครื่องและเปิด 80/443 ก่อน) HTTP ทุก path redirect เป็น HTTPS (308) อัตโนมัติ `SITE_ADDRESS=:80` เป็น HTTP ล้วนไม่มีใบรับรอง (ทดสอบในเครื่องเท่านั้น) และ `SITE_ADDRESS=localhost` ใช้ CA ภายในของ Caddy (smoke test)
- **HSTS:** `Strict-Transport-Security: max-age=31536000; includeSubDomains` เฉพาะ response ที่มาทาง HTTPS (matcher `@https protocol https`) บน `:80` ไม่มีเพราะไม่มีอะไรให้ pin (และ browser ไม่สน HSTS บน HTTP อยู่แล้ว) ค่าเดียวกับที่ helmet ส่งบน `/api/*` browser จึงได้ policy เดียวไม่ว่าจะเห็น response ไหนก่อน Caddy ไม่ใส่ซ้ำบน `/api/*` (header ซ้ำ) 1 ปีโดย**ไม่ใส่ `preload`** เพราะ preload list ฝังใน browser และถอนออกใช้เวลาหลายเดือน ถ้าวันหนึ่ง domain ต้องกลับไปเป็น HTTP จะเข้าไม่ได้
- **จำกัดขนาด body:** `/api/*` รับ body ไม่เกิน 6 MiB (`request_body max_size`) สูงกว่าที่ api รับมากสุดเล็กน้อย (ไฟล์ import 5 MiB + multipart) body ใหญ่กว่านั้นได้ 413 จาก Caddy ทันทีโดยไม่ส่งต่อให้ Node ส่วน route อื่นยังมี limit 64 KiB ของ api เอง request ปกติไม่เปลี่ยน
- **Admin API ปิด (`admin off`):** ปกติ Caddy เปิด admin endpoint ที่ `localhost:2019` ใน container ซึ่งแก้ config ที่รันอยู่ได้ เราไม่ได้ใช้ เพราะ config อยู่ใน image การเปลี่ยนคือ build ใหม่แล้ว `up -d` (สร้าง container ใหม่) หรือ restart container ซึ่งโหลด `Caddyfile` ใหม่อยู่แล้ว ปิดไว้จึงเหลือ listener น้อยลงหนึ่งตัว
- **Healthcheck:** Caddyfile มี site `http://127.0.0.1:2020` (`bind 127.0.0.1`) ที่ตอบ `/health` 200 healthcheck ของ compose ใช้ `wget` ใน container ยิงตัวนี้ จึงใช้ได้เหมือนกันไม่ว่า `SITE_ADDRESS` เป็น `:80` หรือ domain (ยิงหน้าเว็บจริงต้องรู้ชื่อ host และ TLS) และเพราะ bind แค่ loopback ของ container เอง และไม่ได้ publish พอร์ต host หรือ container อื่น (รวม api) จึงเรียกไม่ได้
- `skip_install_trust`: ไม่พยายามติดตั้ง root CA ภายในลง trust store ของ container (ใช้แค่กับ `localhost` ตอนทดสอบ ไม่มีผลกับ domain จริง)

**Smoke test ของ compose:** `scripts/smoke-compose.sh` (ต้องมี Docker + Compose v2 และ curl) สร้าง env file ชั่วคราวจาก `deploy/production.env.example` ด้วย secret สุ่ม (ไม่พิมพ์ออกมา) แล้ว `build` + `up -d --wait` ด้วย project name ไม่ซ้ำและ `SITE_ADDRESS=localhost` (CA ภายในของ Caddy ไม่ต้องใช้ internet) พอร์ต host 18080/18443 (ตั้งด้วย `SMOKE_HTTP_PORT`, `SMOKE_HTTPS_PORT`) curl เชื่อ CA ที่ copy ออกมาจาก container ด้วย `--cacert` แทนการปิดการตรวจ (`-k`) chain ที่เสียจึงยัง fail ตรวจ: ทุก service healthy, migrate จบด้วย 0 ครั้งเดียวและ restart policy `no`, HTTP → 308 ไป HTTPS path เดิมโดยไม่มี HSTS, HTTPS `/` เป็น SPA พร้อม HSTS + CSP, `/api/health` 200 พร้อม HSTS ตัวเดียว, postgres/api/migrate ไม่เปิดพอร์ต host, web ไปถึง api แต่ไม่ถึง postgres, api ไปถึง web:80 แต่ไม่ถึง health listener, ค่า `shared_buffers`/`max_connections` ที่ใช้จริง, heap limit ของ api, log rotation และ memory limit ทุก service, `create-admin` ผ่าน `run --rm --no-deps` แล้ว login ผ่าน HTTPS ได้ (ไม่ start migrate ซ้ำ), body 7 MiB ได้ 413 จาก Caddy (body ว่าง) ส่วน 100 KiB ยังถึง api (413 JSON ของ api), restart api แล้ว login ได้, `down` (ไม่มี `-v`) แล้ว `up` ใหม่: migrate รันซ้ำจบด้วย 0, login ได้ (volume DB อยู่), CA และใบรับรองของ site เป็นไฟล์เดิม (volume `/data` อยู่ ไม่ขอใหม่) ลบทุกอย่าง (`down -v` + image) ด้วย `trap` ไม่แตะ DB ของ dev CI รันต่อจาก `smoke-images.sh` ใน job `images` ถ้า build หลัง proxy ที่ดักถอด TLS ให้ตั้ง `EXTRA_CA_FILE=<pem>` script จะเพิ่ม build secret ผ่าน override ชั่วคราว (`compose.prod.yml` ไม่ต้องใช้)

**ยังไม่อยู่ใน O2:** เตรียม EC2/security group/DNS และเปิด-ปิดเครื่อง (O4), backup `pg_dump` ไป S3 และซ้อม restore (O3), ตัวเลข pool/memory/Postgres จริงจาก load test (O5) และ arm64 ยังไม่ได้รันจริง (ต้องรันทั้งสอง smoke script บนเครื่องจริงครั้งแรก)

### Environment variables

| Env | ใช้ที่ | ความหมาย |
|---|---|---|
| `DATABASE_URL` | api, migrate, create-admin | connection string (production ประกอบจาก `POSTGRES_*` ใน env file เอง) |
| `JWT_SECRET` | api | secret สำหรับ sign token (≥ 32 ตัวอักษร สร้างด้วย `openssl rand -base64 48`) ขาดหรือสั้นไป = server ไม่ start เปลี่ยน = ทุกคนหลุด login |
| `PORT` | api | default 3000 |
| `NODE_ENV` | api | `production` (ตั้งไว้ใน image แล้ว) |
| `TRUST_PROXY` | api | `true` เมื่ออยู่หลัง Caddy/LB (`compose.prod.yml` ตั้งให้แล้ว) |
| `DB_POOL_MAX` | api, create-admin, seed-dev | จำนวน connection สูงสุดของ pool default `20` (1–100) ต้องต่ำกว่า `max_connections` ของ Postgres (50 ใน `compose.prod.yml`) พอสมควร |
| `DB_CONNECTION_TIMEOUT_MS` | api, create-admin, seed-dev | รอ connection ว่างจาก pool นานสุด default `5000` เกิน = request นั้นได้ 500 |
| `DB_STATEMENT_TIMEOUT_MS` | api, create-admin, seed-dev | `statement_timeout` ต่อ statement default `10000` |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | api, create-admin, seed-dev | `idle_in_transaction_session_timeout` default `10000` |
| `SITE_ADDRESS` | web | site address ของ Caddy default `:80` (HTTP ไม่มี TLS) ตั้งเป็น domain แล้ว Caddy ขอและต่ออายุใบรับรองเอง ค่าจริงอยู่ใน env file ห้าม commit (`compose.prod.yml` บังคับให้ตั้ง) |
| `API_UPSTREAM` | web | `host:port` ของ api default `api:3000` |
| `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD` | postgres (compose) | สร้าง DB ครั้งแรกเท่านั้น (เปลี่ยนทีหลังไม่มีผลกับ volume ที่มีอยู่) password สร้างด้วย `openssl rand -hex 24` |
| `HTTP_PORT`, `HTTPS_PORT` | `compose.prod.yml` | พอร์ตบน host default 80/443 มีไว้ให้ smoke test รันข้างของที่จับ 80/443 อยู่ production ไม่ต้องตั้ง |

- `DB_*` ทั้ง 4 ตัว (O2) เป็นจำนวนเต็มบวก timeout ไม่เกิน 600000 (ไม่ยอม `0` ซึ่ง `pg` แปลว่าไม่จำกัด) ค่าว่างหรือไม่ตั้ง = default ซึ่งเท่ากับค่าเดิมก่อนตั้งได้ ค่าผิด = ไม่ start และบอกแค่ชื่อตัวแปร ตรวจด้วย Zod ใน `apps/api/src/config.ts` (`migrate` ไม่ใช้ pool จึงไม่สนตัวแปรเหล่านี้) **ค่า default ยังเป็นค่าประเมิน** ตัดสินด้วย load test (O5)
- `GOMEMLIMIT` (web) และ `NODE_OPTIONS` (api) ตั้งไว้ใน `compose.prod.yml` ให้ตรงกับ memory limit ไม่ได้อยู่ใน env file

**ออกแบบให้ portable:** migration เป็นคำสั่งแยก (`node dist/migrate.js`), `GET /api/health` เช็ค DB, graceful shutdown (SIGTERM), log JSON ออก stdout, ไม่เก็บ state บน disk ของ app

### Portability, ค่าใช้จ่าย และ runbook

ย้ายไปที่อื่น = เปลี่ยน 3 อย่าง: ใครให้ Postgres, ใครทำ HTTPS, ใครเก็บ env/secret

| Infra | วิธี |
|---|---|
| EC2 / VPS อื่น | Compose ไฟล์เดิม |
| PaaS (Render/Railway/Fly) | ชี้ Dockerfile (target `api`/`web`) + Postgres ของ platform (ไม่แนะนำสำหรับวันจริง) |
| ECS/App Runner | push image ไป ECR + RDS + ALB, `TRUST_PROXY=true` |

**ค่าใช้จ่าย (ประมาณ ต้องเช็คราคาจริง)**

| รายการ | ประมาณ |
|---|---|
| EC2 t4g.small ตอนเปิด | ~$0.02/ชม. |
| EBS 20 GB (คิดตลอดแม้ stop) | ~$1.5–2/เดือน |
| S3 backup | เศษเงิน |
| **รวมต่อปี** | **~$25–40** |

**กับดักค่าใช้จ่าย**

- **Elastic IP** คิดเงินตลอดแม้ stop (~$3.6/เดือน) → แนะนำอัปเดต DNS ตอน boot หรือใช้ Cloudflare Tunnel
- ลืมลบ EBS snapshot / ไฟล์ S3 เก่า → ตั้ง lifecycle
- ตั้ง **AWS Budget alert** (เช่น $5/เดือน)

**Runbook การใช้งาน**

1. 1–2 วันก่อนเปิดรอบ: start เครื่อง → `apt upgrade` + อัปเดตตาม [ขั้นตอนอัปเดต](#compose-ของ-production-o2) (`git pull` → `build` → `up -d --wait` build บนเครื่องเอง ไม่มี registry) → ลองเปิดเว็บและ login (ขั้นตอนเต็มบน EC2 อยู่ใน O4)
2. วันจริง: เฝ้า log/CPU/RAM
3. หลังปิดรอบ: export รายชื่อ → `pg_dump` ไป S3 → stop เครื่อง
4. Compose ตั้ง `restart: unless-stopped` (ยกเว้น `migrate` ที่รันครั้งเดียวต่อ `up`)

**ความเสี่ยงที่ยอมรับ:** เครื่องเดียว = single point of failure ต้องมี backup + runbook สั้นๆ pool ของ `pg` (default 20 ปรับด้วย `DB_POOL_MAX`) และ memory limit ใน `compose.prod.yml` ต้องเหมาะกับ RAM 2 GB ยังเป็นค่าประเมินจนกว่าจะ load test (O5)

## Testing

- **Vitest + Testcontainers** ใช้ Postgres จริง ห้าม mock
- **Concurrency test** (ตัวหลัก): 500 request แย่ง 1 ชุมนุม ต้องไม่เกิน capacity และไม่มีลงซ้ำ
- **Invariant check:** `clubs.registered` = จำนวน `registrations` จริง, ไม่มีนักเรียนมี 2 registration
- **Load test** บนสเปคเครื่องจริงก่อนวันใช้งาน (500 virtual users แย่งชุมนุมเดียว)
- **Dry run** กับข้อมูลจำลองก่อนใช้จริง และมีแผน rollback/fallback (เช่น ลงด้วยกระดาษถ้าระบบล่ม)

## รายการที่ยังเปิดอยู่

| # | เรื่อง | Default ถ้ายังไม่ตอบ |
|---|---|---|
| 1 | คนที่มีชุมนุมแล้วเข้า waitlist เพื่อย้ายได้ไหม | ได้ (ตามที่ออกแบบ Phase 2) |
| 2 | Excel template จริงของโรงเรียน | ใช้คอลัมน์ที่เดาไว้ แล้วปรับทีหลัง |
| 3 | Domain สำหรับ HTTPS | รับจาก env (`SITE_ADDRESS` ใน `deploy/production.env` ทำแล้วใน O2) ขั้นตอน DNS อยู่ใน O4 |
| 4 | Elastic IP vs อัปเดต DNS ตอน boot | อัปเดต DNS (ถ้ามี domain) |
| 5 | Queue อยู่ Phase 3 ไหม | Phase 3 (ย้ายขึ้นได้ถ้ากังวลวันจริง) |
| 6 | ~~สร้าง PDF ด้วยอะไร~~ | **ปิดแล้ว:** spike ผ่าน ใช้ `pdfkit` + ฟอนต์ Sarabun (OFL) ฝั่ง server (ดูหัวข้อ [Export รายชื่อ](#export-รายชื่อ)) |
| 7 | Export รายห้องต้องแยกตามรอบไหม | แยกตามรอบ (1 รอบ = 1 ชั้นอยู่แล้ว) |

## ขั้นตอนถัดไป

ทำต่อใน **Phase 1**: Ops ต่อจาก O2 (O3 backup/restore (`pg_dump` ไป S3 และซ้อม restore) → O4 runbook EC2 + DNS (รวม swap หรือเวลาที่ build บนเครื่อง 2 GB) → O5 load test บนสเปคเครื่องจริง ซึ่งตัดสิน pool, memory limit และค่า Postgres) (production image, compose production, scaffold, migration แรก, auth + role guard, จัดการรอบ, import Excel, รหัสผ่านเริ่มต้น, หน้าชุมนุม, export Excel/PDF, API อ่านของนักเรียน, API ลง/ยกเลิกพร้อม concurrency test และหน้าเว็บนักเรียน เสร็จแล้ว)
