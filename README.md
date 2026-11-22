# club-registration

ระบบลงทะเบียนชุมนุมของโรงเรียน สำหรับนักเรียน ~2,500 คน แบ่งรอบตามชั้น ม.1–ม.6 รอบละ ~400–450 คน

> **สถานะ:** Phase 1 ฟีเจอร์ครบแล้ว (admin: รอบ, import Excel, รหัสผ่านเริ่มต้น, ชุมนุม, export Excel/PDF; นักเรียน: ดูชุมนุม, ลง/ยกเลิก พร้อม concurrency test 500 request) งาน Ops ทำ image, compose production + HTTPS และ backup/restore เสร็จแล้ว เหลือ runbook EC2 + DNS แล้ว load test บนเครื่องจริง **Phase 2 เริ่มแล้ว:** API เปลี่ยนชุมนุมแบบ atomic (`PUT /api/student/registration`) API waitlist ของนักเรียน (เข้า/ออก + promote อัตโนมัติหลังยกเลิก เปลี่ยนชุมนุม admin เพิ่มจำนวนรับ และยืนยัน import) API ให้ admin ดูรายชื่อสมาชิก/เพิ่ม/ย้าย/ลบนักเรียนแทน (PR 3a) API ให้ admin ดู/ลบรายชื่อรอและดู event log (PR 3b) หน้าเว็บนักเรียนของการย้ายชุมนุมและรายชื่อรอ (PR 4) หน้าเว็บ admin ดู/แก้รายชื่อสมาชิกและรายชื่อรอแทนนักเรียน (PR 5a) หน้าเว็บ admin ดูประวัติการลงทะเบียน (event log) กรองด้วยรอบ ชุมนุม หรือรหัสนักเรียน (PR 5b) และเรื่องที่ค้างจาก PR 4 สองเรื่อง (PR 5c: ข้อความ "เข้ารายชื่อรอ… ลำดับที่" ไม่ค้างเหนือข้อความได้ที่แล้ว และ focus ไม่หลุดไป body เมื่อ poll ทำให้ปุ่มออกจากรายชื่อรอที่มี focus หายไป) เสร็จ งานหน้าเว็บของ Phase 2 ครบแล้ว **Phase 3 เริ่มแล้ว:** API ของคิว (Q1: `/api/student/queue` join/heartbeat/done/GET ยังไม่บังคับใช้กับ route อื่น) ต่อไปดู [ขั้นตอนถัดไป](#ขั้นตอนถัดไป) ความคืบหน้าดู [Roadmap](#roadmap) และ [รายการที่ยังเปิดอยู่](#รายการที่ยังเปิดอยู่)
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

> การกันลงเกินที่ระดับ DB, idempotency, concurrency test และ event log ทำแล้วสำหรับการลง/ยกเลิก (Phase 1) เปลี่ยนชุมนุมแบบ atomic และ API waitlist ของนักเรียนพร้อม promote เป็นทอด ทั้งหลังยกเลิก/เปลี่ยน และหลัง admin แก้ชุมนุม/ยืนยัน import/ย้ายหรือลบนักเรียนแทน และ event log ของ admin (Phase 2) ทั้ง API และหน้าเว็บของนักเรียน (ย้ายชุมนุม waitlist) และของ admin (แก้แทน ดูประวัติการลงทะเบียน) เสร็จแล้ว ดูความคืบหน้าที่หัวข้อ [Roadmap](#roadmap)

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

ครูไม่ login ข้อมูลครูเก็บไว้ในชุมนุม (ชื่อ, เบอร์, อีเมล, LINE ID เป็น optional) และ admin export รายชื่อให้ครูแทน นักเรียนเห็นแค่ชื่อครู ข้อมูลติดต่อเห็นเฉพาะ admin (ดูหัวข้อ [Security](docs/security.md#security))

## Tech Stack

| ชั้น | เลือก | เหตุผลสั้นๆ |
|---|---|---|
| ภาษา/Runtime | TypeScript (strict), Node.js 24 LTS (≥ 24.7) | type safety, กลับมาแก้ปีหน้าได้ง่าย |
| Backend | Fastify + Zod (`fastify-type-provider-zod`) | เร็ว, validation + type จาก schema เดียว |
| Database | PostgreSQL + `pg` + SQL ตรงๆ | logic หลักคือ transaction/advisory lock ORM ซ่อนจนอ่านยาก |
| Migration | `node-pg-migrate` | เบา ไม่ผูกกับ ORM |
| Auth | `@fastify/jwt` + `@fastify/cookie`, argon2id จาก `node:crypto` | argon2id มีใน Node 24.7+ แล้ว ไม่ต้องพึ่ง native addon |
| Frontend | Vite + React + Tailwind/shadcn/ui + `react-router` | SPA หลัง login ไม่ต้อง SSR |
| ธีมหน้าเว็บ | พื้นขาว โทน indigo/violet (light อย่างเดียว) + ฟอนต์ Anuphan (`@fontsource-variable/anuphan`, SIL OFL 1.1) | สีทั้งหมดเป็น token ใน `apps/web/src/index.css` ที่เดียว ฟอนต์ self-host ผ่าน bundle ของ Vite จึงผ่าน CSP `font-src 'self'` และไม่ส่ง IP นักเรียนไป CDN ถ้าเปลี่ยนฟอนต์ให้ลองชื่อที่มีสระบน/ล่างและวรรณยุกต์ก่อน (เช่น ปิ่นฟ้า ญาณฐิติกุล น้ำ ปู่ญ้อ) |
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
├── e2e/            # เทสต์บนเบราว์เซอร์ (Playwright) ของ web + api + Postgres ด้วยกัน (`pnpm e2e`)
├── docs/           # รายละเอียดเฉพาะเรื่อง: excel.md, security.md, operations.md (ดูหัวข้อเอกสารเพิ่มเติม)
├── deploy/         # production.env.example (template ของ env file production ไม่มีค่าจริง), ตัวอย่าง IAM policy และ lifecycle ของ S3
├── scripts/        # backup.sh, restore.sh (รันบน host), smoke-*.sh ทดสอบ image/compose/backup จริง (CI job images), lib/ ที่ใช้ร่วมกัน
├── templates/      # Excel template เปล่า (ไม่มีข้อมูลจริง)
├── samples/        # (gitignored ไม่ commit) ไฟล์ import สมมติจาก `pnpm --filter api generate-sample-import`
├── Dockerfile      # target api และ web
├── .dockerignore   # allowlist ของ build context
├── docker-compose.yml  # Postgres สำหรับ dev เท่านั้น
├── compose.prod.yml    # stack ของ production (postgres, migrate, api, web)
├── Caddyfile       # อยู่ใน image web
├── .env.example
├── LICENSE         # MIT (ฟอนต์ใช้ OFL ดูหัวข้อ License)
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
waitlist_entries    -- UNIQUE(round_id, student_id), เรียงตาม (created_at, id) โดย created_at = clock_timestamp() หลังได้ round lock
queue_tickets       -- status: waiting | admitted | expired | done, admitted_at (admitted ⇒ มีค่า), 1 ticket ที่ยังใช้ได้ต่อ (round, student), เรียง (created_at, id)
password_issuances  -- บันทึกการออกรหัสผ่านเริ่มต้น: admin_id, ขอบเขต (ชั้น/ห้อง), จำนวน, idempotency_key (ไม่เก็บรหัสผ่าน)
```

**Constraint สำคัญ (enforce ที่ DB ไม่ใช่แค่ฝั่ง app)**

- `UNIQUE(round_id, student_id)` บน `registrations` → 1 คน 1 ชุมนุมต่อรอบ
- `CHECK (registered >= 0 AND registered <= capacity)` บน `clubs`
- `UNIQUE(round_id, club_code)` บน `clubs` → ใช้เป็น key ตอน upsert จาก Excel
- `UNIQUE(actor_id, idempotency_key)` บน `registration_events` → retry ไม่เกิดซ้ำ
- `UNIQUE(login_id)` + `CHECK (login_id ~ '^[a-z0-9._-]{1,64}$')` (`users_login_id_format`) บน `users` → กฎเดียวกับ `loginIdSchema` (ตัวเล็กเท่านั้น) "Admin" กับ "admin" จึงเป็น 2 บัญชีไม่ได้แม้ผู้เขียนบางทางข้าม schema เช่นแก้ด้วย psql แก้กฎต้องแก้ทั้งสองที่ (`test/schema.test.ts` ตรวจทั้งคู่ด้วยชุดค่าเดียวกัน) migration ล้มถ้า DB เดิมมีแถวที่ผิดกฎ ทำให้ deploy หยุดที่ service `migrate` ก่อน api ขึ้น

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
2. ~~**Admin import Excel:** students, clubs, advisors → dry run → ยืนยัน → upsert ใน transaction เดียว~~ เสร็จแล้ว รวมขั้นออกรหัสผ่านเริ่มต้นให้นักเรียนที่นำเข้า (ดูหัวข้อ [Security](docs/security.md#security)) ขั้นยืนยันถือ round lock ทุกรอบของภาคเรียนและทุกรอบของภาคเรียนอื่นที่ยังไม่ปิด จึงไม่แข่งกับการลง/ยกเลิก (ดู [Excel Import/Export](docs/excel.md#excel-importexport) ข้อ 3 และเทสต์ `apps/api/test/import-commit-round-locks.test.ts`)
3. ~~**Admin จัดการรอบ:** สร้างรอบต่อชั้น กำหนด `opens_at`/`closes_at`~~ เสร็จแล้ว (สร้างทีละชั้นหรือครบ ม.1–ม.6, แก้เวลา/`max_active`, ลบรอบที่ยังไม่มีชุมนุม, สถานะคำนวณตอนอ่าน การแก้รอบถือ import lock แล้ว round lock ก่อน UPDATE และ promote คนรอเมื่อเปิดรอบที่ปิดแล้วอีกครั้ง (เป็นเปิดอยู่หรือยังไม่เปิด) ดู PR 2b ในหัวข้อ waitlist) และ**หน้าชุมนุมรายรอบ**เสร็จแล้ว:
   - `GET /api/admin/rounds/:roundId/clubs` คืนรอบ (สถานะ + ยอดรวม) และชุมนุมเรียงตามรหัส: ชื่อ, รายละเอียด, จำนวนรับ, ลงแล้ว, เหลือ, ครู (รวมเบอร์/อีเมล/LINE เฉพาะ admin และไม่ log)
   - `PATCH /api/admin/clubs/:id` แก้ได้เฉพาะชื่อ รายละเอียด จำนวนรับ (รหัสชุมนุมและ `registered` แก้ไม่ได้) ลดจำนวนรับต่ำกว่าที่ลงแล้ว → `409 capacity_below_registered` ซึ่งมาจาก `CHECK` ของ DB ไม่ใช่การเช็คใน app (ใน transaction ที่เริ่มด้วย `pg_advisory_xact_lock(round_id)` ของรอบชุมนุมนั้นเหมือนการลง/ยกเลิก จึงรอการลงที่กำลังทำอยู่ให้ commit ก่อน แล้ว UPDATE เดียวที่ `CHECK` ตัดสินด้วยค่าล่าสุดเสมอ) เพิ่มจำนวนรับระหว่างรอบเปิดได้ และคำขอที่ส่ง `capacity` จะ promote คนรอใน transaction และ round lock เดียวกันทันที (Phase 2 PR 2b ดูหัวข้อ waitlist) คำตอบเป็นชุมนุมหลัง promote ไม่รับ `idempotency_key` เหมือน endpoint ของรอบ เพราะส่งซ้ำได้ผลเดิม (ส่งซ้ำไม่มีที่ว่างเหลือให้ promote อีก)
   - หน้า `/admin/clubs` เลือกรอบให้เองตอนเปิดหน้า (รอบที่เปิดอยู่ ถ้ามีหลายรอบเอารอบที่ปิดเร็วสุด ถ้าไม่มีเอารอบที่จะเปิดเร็วสุด ถ้าไม่มีอีกเอารอบที่ปิดล่าสุด เลือกครั้งเดียว ไม่สลับเองทีหลัง) → ตาราง → แก้ในฟอร์มโดยส่งเฉพาะช่องที่เปลี่ยน poll ทุก 5 วินาทีระหว่างรอบเปิด และรอบที่ยังไม่เปิดถามใหม่ตอนถึง `opens_at` ด้วยตัวตั้งเวลาเดียวกับหน้านักเรียน (`apps/web/src/lib/round-refetch.ts`) จึงเริ่ม poll เองโดยไม่ต้องโหลดหน้าใหม่ รายละเอียดแสดงเป็นข้อความล้วน
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
   - **Lock:** ทุก transaction ลง/ยกเลิกเริ่มด้วย `pg_advisory_xact_lock(round_id)` (แบบ bigint ตัวเดียว ซึ่งเป็นคนละ key space กับ `pg_advisory_xact_lock(1, 1)` แบบ int4 สองตัวของ import จึงไม่ชนกัน) ขั้นยืนยัน import ก็ถือ round lock ทุกรอบของภาคเรียนตัวเองและทุกรอบของภาคเรียนอื่นที่ยังไม่ปิดด้วย (ดู [Excel Import/Export](docs/excel.md#excel-importexport) ข้อ 3) การลงในรอบที่ยังไม่ปิดจึงเรียงกับ import ด้วย lock ของรอบ และล็อกแถว `student_profiles` ของตัวเองแบบ `FOR SHARE` ก่อน INSERT เพื่อไม่ให้ import ที่กำลังย้ายชั้นนักเรียนคนนั้นแทรกกลาง
   - **Rate limit:** 30 ครั้ง/นาที ต่อนักเรียน นับรวมการลงและยกเลิก (คลิกจริงไม่กี่ครั้งบวก retry อัตโนมัติ) store ใน memory ตามเครื่องเดียว นับเฉพาะ request ที่ผ่าน guard และ validation แล้ว
   - **Log:** เฉพาะ student id, round id, club id และผล (`registered`/`already_held`/`replayed`/`cancelled` หรือรหัส error) ไม่ log ชื่อนักเรียน ชุมนุม หรือครู
   - logic เป็นฟังก์ชันที่รับ DB client ของ transaction (`registerForClub`, `cancelRegistration`) route เป็นคนเปิด transaction Phase 2 จึงประกอบหลายขั้นใน transaction เดียวได้
   - **หน้าเว็บ (S3, `apps/web/src/pages/student/`):** `/student/clubs` มีหัวรอบ (ภาคเรียน ชั้น สถานะ เวลาเปิด/ปิดเป็นเวลาไทย) ชุมนุมที่ลงไว้แสดงเด่นด้านบนพร้อมลิงก์ไปหน้าผลของฉัน รายการเป็นการ์ดเรียงลงมา (นักเรียนส่วนใหญ่ใช้มือถือ) มีรหัส ชื่อ ชื่อครู ที่เหลือ/จำนวนรับ ป้าย "เต็ม" และรายละเอียดเป็นข้อความล้วนที่คงการขึ้นบรรทัด ปุ่มลงกดได้เฉพาะรอบเปิดและชุมนุมยังไม่เต็ม และไม่แสดงเลยเมื่อมีชุมนุมแล้ว (การ์ดชุมนุมของฉันด้านบนบอกวิธีเปลี่ยนอยู่แล้ว ตั้งแต่ Phase 2 PR 4 ชุมนุมอื่นมีปุ่มย้ายหรือเข้ารายชื่อรอแทน และชุมนุมที่เต็มมีปุ่มเข้ารายชื่อรอแทนปุ่มลงที่กดไม่ได้ ดูหัวข้อหน้าเว็บนักเรียน (PR 4)) กดแล้วขึ้นกล่องยืนยันในการ์ดนั้นก่อนส่ง (ปิดด้วย Escape ได้ และ focus กลับไปที่ปุ่มที่กด) `/student/my-registration` แสดงชุมนุมที่ลงและเวลาที่ลง หรือ "ยังไม่ได้ลงชุมนุม" พร้อมลิงก์ไปหน้ารายการ ปุ่มยกเลิกมีเฉพาะตอนรอบเปิด และกล่องยืนยันเตือนว่าที่นั่งอาจมีคนอื่นลงแทน ปิดกล่องแล้ว focus กลับไปที่ปุ่มยกเลิก ถ้ายกเลิกสำเร็จ (ปุ่มหายไป) focus ไปที่ข้อความผลซึ่งมีลิงก์ไปเลือกชุมนุมใหม่ ทุก error code มีข้อความไทย (`club_full`, `already_registered`, `round_not_open`, `not_registered`, `idempotency_key_reused`, `rate_limited`, `not_found`, `student_profile_missing`)
   - **Idempotency ฝั่งเว็บ:** สร้าง key ใหม่ (`crypto.randomUUID()`) ทุกครั้งที่กดยืนยัน ถ้าไม่รู้ผล (ไม่ได้คำตอบจาก server เพราะเน็ตหลุด, ได้ 5xx หรือคำตอบอ่านไม่ได้) ปุ่ม "ลองอีกครั้ง" ส่งคำขอเดิมด้วย key เดิม server จึงตอบซ้ำแทนการทำสองครั้ง คำตอบ 4xx ถือว่าจบแล้ว กดใหม่ได้ key ใหม่ ปุ่มทั้งหมดปิดระหว่างรอคำตอบ และทุกคำตอบ (สำเร็จหรือไม่) โหลดข้อมูลทั้งสองหน้าใหม่
   - **Polling:** หน้ารายการ poll ทุก 5 วินาทีเฉพาะรอบเปิด รอบที่ยังไม่เปิดตั้งเวลาโหลดใหม่ตอนถึง `opens_at` ตามนาฬิกาเครื่อง (ห่างไม่เกิน 30 วินาทีเผื่อนาฬิกาช้า ไม่ถี่กว่า 2 วินาทีเผื่อนาฬิกาเร็ว และสุ่มเพิ่มไม่เกิน 1 วินาทีให้ทั้งชั้นไม่ยิงพร้อมกัน) หน้าจึงเปลี่ยนเป็นเปิดเองโดยไม่ต้องโหลดหน้าใหม่ รอบที่ปิดแล้วไม่ poll หน้าผลของฉันใช้ตัวตั้งเวลาเดียวกันทั้งตอนเปิดและปิดรอบ (ยกเว้นตอนอยู่ในรายชื่อรอของรอบที่เปิด ซึ่ง poll ทุก 5 วินาทีเพื่อเห็นการได้ที่ ดู PR 4) สถานะที่ใช้ตัดสินมาจาก server เสมอ (ตัวตั้งเวลาอยู่ที่ `apps/web/src/lib/round-refetch.ts` ใช้ร่วมกับหน้า `/admin/clubs`)
5. ~~**กติกาที่ DB:** 1 คน 1 ชุมนุม, ห้ามเกิน capacity, เฉพาะชั้นตัวเอง, เฉพาะช่วงเปิดรอบ~~ เสร็จแล้ว (S2): `UNIQUE(round_id, student_id)`, `CHECK` + `UPDATE ... WHERE registered < capacity`, ชั้นและช่วงเปิดเป็นเงื่อนไขของ `INSERT ... SELECT`/`DELETE` ตามนาฬิกา DB
6. ~~**Idempotency + event log**~~ เสร็จแล้ว (S2): ทุกการลง/ยกเลิกเขียน `registration_events` พร้อม `idempotency_key` ใน transaction เดียวกัน (ตาราง append-only ด้วย trigger)
7. **Admin export:** รายชื่อแบบ **รายชุมนุม** และ **รายห้อง** เลือกได้ทั้ง **Excel** และ **PDF** (รายละเอียดดูหัวข้อ [Export รายชื่อ](docs/excel.md#export-รายชื่อ)) ทั้ง Excel (A6a) และ PDF (A6b) **เสร็จแล้ว**
8. **Ops:** Dockerfile, `docker-compose.yml`, Caddy HTTPS, `/api/health`, migration script แยก, graceful shutdown, backup `pg_dump` ไป S3, runbook (deploy/backup/restore/เปิด-ปิดเครื่อง) แบ่งเป็น O1 image → O2 compose production + Caddy HTTPS/limits → O3 backup/restore → O4 runbook EC2 → O5 load test
   - ~~**O1 image**~~ เสร็จแล้ว: `Dockerfile` (target `api`, `web`), `Caddyfile`, `.dockerignore`, `scripts/smoke-images.sh` และ CI job `images` รายละเอียดดู [Infra และ Deployment](docs/operations.md#infra-และ-deployment)
   - ~~**O2 compose production**~~ เสร็จแล้ว: `compose.prod.yml` (postgres, migrate, api, web พร้อม healthcheck, memory limit, log rotation, network แยก), `deploy/production.env.example`, Caddy HTTPS + HSTS + จำกัดขนาด body, ตั้ง pool/timeout ของ DB ผ่าน env (`DB_*`), `scripts/smoke-compose.sh` ใน CI job `images` รายละเอียดดู [Compose ของ production (O2)](docs/operations.md#compose-ของ-production-o2)
   - ~~**O3 backup/restore**~~ เสร็จแล้ว: `scripts/backup.sh` (`pg_dump` custom format ใน container → ตรวจทั้งไฟล์ → S3 ด้วย SSE-S3 ผ่าน AWS CLI ของ host, ไฟล์ในเครื่อง 600, `flock` กันรันซ้อน, `--local-only`, `--include-certs`), `scripts/restore.sh` (ต้อง `--yes`, กู้ลง DB ใหม่แล้วสลับชื่อใน transaction เดียว → migrate → รอ healthy, `--target-db` ซ้อมกู้โดยไม่แตะ production, `--certs`), ตัวอย่าง IAM policy (ไม่มีสิทธิ์ลบ) และ lifecycle ใน `deploy/`, `scripts/smoke-backup.sh` (MinIO) ใน CI job `images` รายละเอียดดู [Backup และ Restore (O3)](docs/operations.md#backup-และ-restore-o3)
9. ~~**Test:** concurrency test + invariant `clubs.registered` = จำนวน registration จริง~~ เสร็จแล้ว (S2): `apps/api/test/registration-concurrency.test.ts` (500 นักเรียนแย่ง 30 ที่ → 200 พอดี 30 ที่เหลือ `club_full` 470, คนเดียวกดหลายชุมนุมพร้อมกันได้ชุมนุมเดียว, key เดียวกันพร้อมกันเกิดผลครั้งเดียว, ยกเลิกแข่งกับลง, ยกเลิกแล้วคนอื่นแย่งที่ว่าง) และตัวตรวจ invariant `registrationInvariantViolations` (`apps/api/test/support/registration.ts`: `registered` = จำนวนแถว, อยู่ใน 0..capacity, 1 คน 1 แถวต่อรอบ, ชั้นนักเรียน = ชั้นรอบ, ชุมนุมอยู่ในรอบเดียวกัน, register − cancel ตรงกับที่นั่งทั้งรายคนและรายชุมนุม, event ล่าสุดตรงกับชุมนุมที่ถือ) รันหลังทุกเทสต์ของไฟล์ลง/ยกเลิก
   - **วัดจริงในเทสต์** (เครื่องพัฒนา 4 vCPU ไม่ใช่สเปค production, pool 20, ผ่าน `app.inject` ใน process เดียว ไม่มี network, 4 รอบ): 500 request พร้อมกันจบทั้งหมดใน 2.4–2.6 วินาที (เฉลี่ย ~5 ms ต่อ request เพราะเรียงกันด้วย lock ของรอบ) ต้อง load test บนเครื่องจริง ข้อควรระวัง: ทุก transaction ในรอบเรียงกันด้วย lock และ request ที่รอ connection จาก pool เกิน 5 วินาที (`connectionTimeoutMillis`) จะได้ 500 ถ้าเครื่องจริงช้ากว่านี้หลายเท่า ต้องปรับ pool/timeout (ตั้งได้ด้วย env `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS` ฯลฯ ไม่ต้อง build ใหม่) หรือเปิด queue (Phase 3)

**ยังไม่อยู่ใน Phase 1:** queue, waitlist, เปลี่ยนชุมนุมแบบ atomic, admin เพิ่ม/ลบ/ย้ายนักเรียนแทน

> ถ้าต้องใช้จริงก่อนมี queue ให้เปิดรอบทีละชั้นและเหลื่อมเวลา เพื่อคุม load
>
> Migration แรกควรสร้างตารางของ phase หลัง (`waitlist_entries`, `queue_tickets`, event types ครบ) ไว้ก่อน แต่ยังไม่ต้องเขียน logic

### Phase 2: เปลี่ยนชุมนุม + Waitlist + Admin แก้แทน

**Locking:** ทุก write transaction ในรอบเริ่มด้วย `SELECT pg_advisory_xact_lock($round_id)` → serialize ต่อรอบ ไม่มี deadlock และ logic ง่าย (แลกกับการไม่ขนานข้ามชุมนุม ซึ่งที่ ~450 คนต่อรอบน่าจะรับได้ ต้อง load test) **ใช้ตั้งแต่ Phase 1 แล้ว** กับการลง/ยกเลิก admin แก้ชุมนุม และขั้นยืนยัน import และกับการเปลี่ยนชุมนุม เข้า/ออก waitlist, admin เพิ่ม/ย้าย/ลบนักเรียนแทน และ admin ลบรายชื่อรอของ Phase 2 (ล็อกรอบเดียว เพราะชุมนุมเดิมและใหม่อยู่ในรอบเดียวกัน ส่วน promote ไม่ล็อกเอง รันท้าย transaction ที่ถือ lock ของรอบอยู่แล้ว: ยกเลิก เปลี่ยน admin แก้ชุมนุม admin แก้รอบ admin ย้าย/ลบนักเรียน และยืนยัน import ซึ่งรันทีละรอบที่ล็อกไว้ เรียง id เดิม) admin แก้รอบถือ import lock ก่อน round lock (ดู PR 2b) (ถือทุกรอบของภาคเรียนและรอบที่ยังไม่ปิดของภาคเรียนอื่น เรียง id ต่อจาก import lock) (`apps/api/src/services/round-lock.ts`) endpoint ของ Phase 2 ต้องใช้ helper เดียวกัน ถ้าต้องถือหลายรอบต้องล็อกเรียง id และให้ได้ครบก่อนแตะแถวใด ไม่อย่างนั้นอาจเกิด deadlock กับ import

**การตัดสินใจของ Phase 2** (ยืนยันแล้ว)

1. นักเรียนที่มีชุมนุมแล้ว**เข้า waitlist ของชุมนุมอื่นได้** เมื่อถูก promote จะย้ายแบบ atomic เหมือนเปลี่ยนชุมนุม: ที่เดิมว่าง แล้วคิวของชุมนุมเดิมถูก promote ต่อเป็นทอด (ปิดข้อ 1 ใน [รายการที่ยังเปิดอยู่](#รายการที่ยังเปิดอยู่))
2. นักเรียนรู้ว่าถูก promote **จากหน้าเว็บเท่านั้น** (polling) ไม่มีการแจ้งเตือนทางอื่น (อีเมล, LINE, push)
3. **หน้า admin ดู event log อยู่ใน Phase 2** (ย้ายมาจาก Phase 4)
4. **Export รายชื่อไม่รวม waitlist** มีเฉพาะคนที่ได้ชุมนุมแล้ว

**เปลี่ยนชุมนุมแบบ atomic** (เสร็จแล้ว ใน `changeRegistration` ของ `apps/api/src/services/registrations.ts`)

- `PUT /api/student/registration` body `{ "clubId": 15, "idempotencyKey": "<16–128 ตัว A-Z a-z 0-9 _ ->" }` (strict แบบเดียวกับการลง: ใส่ `studentId`, `fromClubId`, `roundId` หรือ field อื่น = `400`) ตอบ `200 { "registration": { "club": { "id", "clubCode", "name" }, "registeredAt" } }` รูปเดียวกับการลง ชุมนุมเดิมอ่านจาก DB เสมอ ไม่รับจาก client guard, JSON อย่างเดียว และ rate limit 30 ครั้ง/นาทีใช้ร่วมกับการลง/ยกเลิก
- ลำดับใน transaction เดียว ทีละ statement:

```sql
BEGIN;
SELECT round_id, pg_advisory_xact_lock(round_id::bigint) FROM clubs WHERE id = $new;  -- ไม่มี → 404
SELECT ... FROM registration_events WHERE actor_id = $student AND idempotency_key = $key;  -- เคยทำแล้ว → ตอบซ้ำ
SELECT 1 FROM student_profiles WHERE user_id = $student FOR SHARE;
WITH target AS (  -- ชั้นตรงกับรอบ + เป็นรอบที่นักเรียนเห็น + is_open ตาม statement_timestamp()
  ...
), held AS (      -- ชุมนุมที่ถืออยู่ในรอบนั้น (อ่านใน statement เดียวกัน)
  SELECT club_id FROM registrations WHERE round_id = target.round_id AND student_id = $student
), seated AS (    -- +1 ที่ใหม่
  UPDATE clubs SET registered = registered + 1
  WHERE id = $new AND round_id = $round AND is_open AND <held มีและไม่ใช่ $new>
    AND registered < capacity
    AND NOT EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.club_id = clubs.id AND w.round_id = clubs.round_id)
  RETURNING club_code, name
) SELECT round_id, is_open, held.club_id AS from_club_id, seated.* ...;  -- ไม่ได้ที่ → ROLLBACK ตอบตามลำดับด้านล่าง
UPDATE clubs SET registered = registered - 1 WHERE id = $old AND round_id = $round;  -- -1 ที่เดิม
UPDATE registrations SET club_id = $new, created_at = DEFAULT
WHERE round_id = $round AND student_id = $student AND club_id = $old;  -- ต้องได้ 1 แถวพอดี
INSERT INTO registration_events (..., 'change', club_id = $new, from_club_id = $old, actor_id = $student, idempotency_key = $key);
COMMIT;
```

- **ลำดับคำตอบ** (ตัดสินใต้ round lock ทั้งหมด): `404` ไม่มีชุมนุม → key เดิม: ตอบซ้ำ `200` หรือ `409 idempotency_key_reused` → `403 student_profile_missing` → `404 not_found` ชุมนุมที่นักเรียนไม่เห็น (ชั้นอื่น รอบอื่น เลือกรอบแบบ S1 ด้วยนาฬิกา DB ไม่บอกว่ามีอยู่จริง) → ขอเปลี่ยนไปชุมนุมที่ถืออยู่แล้ว = `200` registration เดิม ไม่เขียน event (ตอบได้แม้รอบปิด เหมือนการลงซ้ำ) → `409 round_not_open` → `409 not_registered` (ยังไม่มีชุมนุมในรอบนี้ ต้องใช้การลง) → `409 club_full` (เต็ม หรือมีคนรอใน waitlist) `round_not_open` มาก่อน `not_registered` และ `club_full` ตรงกับการลง (`round_not_open` ก่อน `already_registered`/`club_full`) และการยกเลิก (`round_not_open` ก่อน `not_registered`): นอกช่วงเปิดตอบ "ยังไม่เปิด" เสมอไม่ว่าถืออะไรอยู่
- **ห้ามแซงคิว:** เงื่อนไข `NOT EXISTS (… waitlist_entries …)` อยู่ใน UPDATE ที่จองที่นั่งเลย ชุมนุมที่มีคนรอจึงตอบ `club_full` แม้มีที่ว่าง การลง (`POST`) มีเงื่อนไขเดียวกันแล้ว (ดูหัวข้อ waitlist ด้านล่าง)
- **Idempotency:** แบบเดียวกับการลง key เดิม + ชุมนุมเดิม → `200` ด้วยสถานะปัจจุบัน ไม่เขียนซ้ำ (ตอบได้แม้รอบปิด) key เดิมกับชุมนุมอื่น หรือ key ของการลง/ยกเลิก (และกลับกัน) → `409 idempotency_key_reused` คำขอที่ถูกปฏิเสธไม่ทิ้ง event จึงลองใหม่ด้วย key เดิมได้
- **ทำไม UPDATE แทน DELETE + INSERT:** แถว registration ไม่หลุดจาก `UNIQUE(round_id, student_id)` ระหว่าง transaction เลย และ api ต้องการสิทธิ์เพิ่มแค่ `UPDATE` **รายคอลัมน์** `club_id`, `created_at` (migration `20261120000000_change-registration-grants.sql` พร้อม `SELECT` บน `waitlist_entries` สำหรับเงื่อนไขกันแซงคิว) `round_id`/`student_id` ยังแก้ไม่ได้ด้วยสิทธิ์ของ DB เอง ถ้า api มีช่องโหว่ก็ย้ายที่นั่งไปให้นักเรียนอื่นหรือรอบอื่นไม่ได้ (`apps/api/test/db-role.test.ts` ตรวจสิทธิ์รายคอลัมน์ทั้งหมดแบบตรงทุกตัว)
- **`registeredAt`** หลังเปลี่ยน = เวลาที่ได้ชุมนุมใหม่ (`created_at = DEFAULT` คือ `now()` นาฬิกาเดียวกับที่การลงใช้ตอน INSERT) แถวเดิม (id เดิม)
- **สลับที่กันไม่ได้:** ที่ใหม่ถูกจองก่อนคืนที่เดิมเสมอ นักเรียนจึงไม่มีช่วงที่ไม่มีที่นั่ง ผลคือ 2 คนในชุมนุมที่เต็มทั้งคู่ที่ขอสลับกันพร้อมกันได้ `club_full` ทั้งคู่ ไม่ว่าใครรันก่อน (ตามกติกา "ที่ใหม่เต็ม = อยู่ที่เดิม") ต้องยกเลิกแล้วลงใหม่ หรือรอผ่าน waitlist
- **Log:** id และผลเท่านั้น (`student change` มี `clubId`, `fromClubId`, `outcome: changed`/`already_held`/`replayed` หรือรหัส error) ไม่ log ชื่อ
- **Test:** `apps/api/test/registration-change.test.ts` (ย้ายสำเร็จ, เต็ม/มีคนรอ → อยู่ที่เดิม, ลำดับ error, 404 ทุกแบบ, idempotency, guard/validation/415/rate limit ร่วม, log) และกลุ่ม `changing club` ใน `registration-concurrency.test.ts` (40 คนย้ายเข้าชุมนุมที่ว่าง 5 ที่ → ได้ 5 พอดี ที่เหลืออยู่ที่เดิม, เปลี่ยนแข่งกับการลงและยกเลิกที่นั่งเดียวกัน → ไม่เกิน capacity และยอดตรง, สลับที่ → `club_full` ทั้งคู่, key เดียวกันพร้อมกัน → เกิดผลครั้งเดียว, คนเดียวกดหลายชุมนุมพร้อมกัน → ถือที่เดียว) ตัวตรวจ invariant นับที่นั่งจากตาราง seat effect ต่อชนิด event (`register` +1, `cancel` −1, `change` +1 ที่ใหม่ −1 ที่เดิม, `waitlist_promote` และ `admin_assign` +1 ที่ใหม่ −1 ที่เดิมถ้ามี, `admin_remove` −1, `waitlist_join`/`waitlist_leave` 0) ทั้งรายคนและรายชุมนุม event ล่าสุดต้องเป็นตัวที่ให้ชุมนุมที่ถืออยู่ และชนิด event ที่ไม่มีในตารางถือว่าผิด

**กติกา waitlist**

1. ลงชุมนุมที่เต็ม → `409 club_full` + ให้เลือกเข้ารายชื่อรอ
2. ห้ามลงตรงถ้าชุมนุมมีคนรอ (กันแซงคิว) บังคับทั้งการลงและการเปลี่ยนชุมนุมแล้ว
3. เข้า waitlist ได้ 1 ชุมนุมต่อรอบ (เข้าใหม่ต้องออกจากอันเดิม = เสียลำดับ) คนที่มีชุมนุมอยู่แล้วก็เข้าได้ (การตัดสินใจข้อ 1)
4. มีที่ว่าง (ยกเลิก/admin ลบ/เพิ่ม capacity/คนย้ายออก) → promote คนรอที่ `created_at` เก่าสุดอัตโนมัติ
5. คนที่ถูก promote ถ้ามีชุมนุมอยู่แล้ว = เปลี่ยนแบบ atomic (ที่เดิมว่างและ promote ต่อเป็นทอด) ถ้ายังไม่มี = ลงใหม่
6. ปิดรอบ → หยุด promote (ก่อนปิด promote ทั้งตอนเปิดอยู่และตอนยังไม่เปิด: คนรอมีในรอบที่ยังไม่เปิดได้เฉพาะเมื่อ admin เลื่อนรอบที่เคยเปิดแล้วกลับไปเป็นยังไม่เปิด และตอนถึง `opens_at` ไม่มี write ใดเรียก engine จึงต้อง promote ตั้งแต่ตอนที่ admin เพิ่มจำนวนรับ ดูรายการที่ยังเปิดอยู่ข้อ 18)
7. ทุก join/leave/promote เขียนลง `registration_events`
8. นักเรียนเห็นสถานะและลำดับที่จากหน้าเว็บ (poll) เท่านั้น ไม่มีแจ้งเตือนทางอื่น และ export ไม่รวม waitlist

**Promote loop:** ท้ายทุก endpoint ที่ทำให้เกิดที่ว่างใช้ฟังก์ชันเดียวกัน วนหาคนรอที่เก่าสุดในชุมนุมที่มีที่ว่างจนไม่มีใครถูก promote entry ถูกลบทันทีที่ promote จึงไม่วนไม่รู้จบ

**Waitlist ของนักเรียน (PR 2a)** (เสร็จแล้ว: `apps/api/src/services/waitlist.ts` เข้า/ออก, `waitlist-promote.ts` promote engine, migration `20261121000000_waitlist-grants.sql`)

- **เข้า:** `POST /api/student/waitlist` body `{ "clubId": 12, "idempotencyKey": "..." }` (strict: ใส่ `studentId`, `roundId`, `fromClubId` หรือ field อื่น = `400`) ตอบ `200 { "waitlist": { "club": { "id", "clubCode", "name" }, "position": 1, "joinedAt" } }` `position` 1 = คนถัดไปที่จะได้ชุมนุมนั้น
- **ออก:** `POST /api/student/waitlist/leave` body `{ "idempotencyKey": "..." }` ตอบ `200 { "waitlist": null }` ออกจาก entry ของตัวเองในรอบที่นักเรียนเห็น (เลือกรอบแบบการยกเลิกด้วยนาฬิกา DB) → event `waitlist_leave` พร้อม `club_id` ที่ออก การออกไม่ทำให้เกิดที่ว่าง จึงไม่ promote ใคร
- ทั้งสอง endpoint ใช้ guard, JSON อย่างเดียว และ rate limit 30 ครั้ง/นาทีร่วมกับการลง/เปลี่ยน/ยกเลิก นักเรียนมาจาก JWT เท่านั้น
- **ลำดับคำตอบของการเข้า** (ตัดสินใต้ round lock ทั้งหมด เหมือนการลง/เปลี่ยน): `404` ไม่มีชุมนุม → key เดิม: ตอบซ้ำ `200` หรือ `409 idempotency_key_reused` → `403 student_profile_missing` → `404 not_found` ชุมนุมที่นักเรียนไม่เห็น (ชั้นอื่น รอบอื่น เลือกรอบแบบ S1 ด้วยนาฬิกา DB) → รออยู่ในคิวชุมนุมนี้แล้ว = `200` entry เดิมพร้อมลำดับปัจจุบัน ไม่เขียน event (ตอบได้แม้รอบปิด เหมือนการลงซ้ำ) → `409 round_not_open` → `409 already_in_club` (ถือชุมนุมนี้อยู่แล้ว) → `409 waitlist_not_needed` (ชุมนุมมีที่ว่างที่การลงจะได้ทันที คือว่างและไม่มีคนรอ ให้ลงหรือเปลี่ยนตรง) → เขียน
- **ลำดับคำตอบของการออก:** `403 student_profile_missing` (ต้องรู้ชั้นก่อนเลือกรอบ เหมือนการยกเลิก) → key เดิม: ตอบซ้ำหรือ `409 idempotency_key_reused` → `409 round_not_open` (นอกช่วงเปิด หรือชั้นนี้ไม่มีรอบเลย) → `409 not_waitlisted` → ลบ
- **ใครเข้าได้:** คนที่ยังไม่มีชุมนุม และคนที่ถือชุมนุมอื่นอยู่ (การตัดสินใจข้อ 1) ชุมนุมที่มีที่ว่างแต่มีคนรอแล้ว (หลัง PR 2b เกิดได้ทางเดียว คือ admin เปิดรอบที่ปิดแล้วอีกครั้ง ดูข้อ 17 ใน [รายการที่ยังเปิดอยู่](#รายการที่ยังเปิดอยู่)) เข้าคิวได้ เพราะการลงตรงจะได้ `club_full` นักเรียนจึงไม่ติดวนระหว่าง `club_full` กับ `waitlist_not_needed`
- **ย้ายคิว = เสียลำดับ:** ถ้ารอชุมนุมอื่นอยู่แล้ว การเข้าคิวใหม่ลบ entry เดิมแล้วเพิ่ม entry ใหม่ท้ายคิวใน transaction เดียว (`DELETE` แล้ว `INSERT` คนละ statement เพราะ data-modifying CTE สอง statement ที่แตะ slot `UNIQUE(round_id, student_id)` เดียวกันไม่มีลำดับที่แน่นอน) เขียน event `waitlist_join` **ตัวเดียว** `club_id` = ชุมนุมใหม่ `from_club_id` = ชุมนุมที่สละคิว (`UNIQUE(actor_id, idempotency_key)` ให้มี event ที่มี key ได้ตัวเดียวต่อคำขอ) กลับไปคิวเดิมทีหลังก็ต่อท้ายใหม่ api ไม่มีสิทธิ์ `UPDATE` บน `waitlist_entries` เลย (ย้ายได้ทางลบ + เพิ่มเท่านั้น)
- **ลำดับคิว:** `(created_at, id)` ทุกที่ (อ่าน ลำดับที่ และ promote) `created_at` ของการเข้าคิวคือ `clock_timestamp()` ที่ INSERT ซึ่งรันหลังได้ round lock แล้ว ลำดับคิวจึงเท่ากับลำดับที่ได้ lock แม้ transaction ที่เริ่มก่อน (และ `now()` เก่ากว่า) จะได้ lock ทีหลัง (เทสต์ตรวจตรงนี้) `id` ตัดสินกรณีเวลาเท่ากัน `position` = 1 + จำนวน entry ของชุมนุมเดียวกันที่อยู่ก่อน ใช้ index `(club_id, round_id, created_at, id)`
- **นาฬิกา:** การตัดสินลำดับคำตอบอ่านใน statement เดียวกับการเช็คชุมนุมที่เห็น (`statement_timestamp()`) และ INSERT ของ entry ตรวจช่วงเปิดอีกครั้งด้วยนาฬิกาของตัวเอง ถ้าได้ 0 แถว (รอบปิดระหว่างสอง statement) ตอบ `round_not_open` และ ROLLBACK รวมการลบ entry เดิม
- **Idempotency:** แบบเดียวกับการลง key เดิม + ชนิดเดียวกัน (+ ชุมนุมเดียวกันสำหรับการเข้า) → `200` ด้วย entry **ปัจจุบัน** ในรอบที่คำขอแรกทำ (เช่น เข้าด้วย key A → ออก → ส่ง key A ซ้ำ ได้ `{ "waitlist": null }`) ตอบได้แม้รอบปิด key เดิมกับชุมนุมอื่น หรือข้ามชนิดคำขอ (ลง/เปลี่ยน/ยกเลิก/เข้า/ออก) → `409 idempotency_key_reused` คำขอที่ถูกปฏิเสธไม่ทิ้ง event
- **Promote engine** (`promoteWaitlist(client, { roundId, actorId })`): เรียกท้าย**การยกเลิกและการเปลี่ยนชุมนุม**ของนักเรียน (หลัง event ของคำขอเอง ใน transaction และ round lock เดียวกัน ไม่เรียกตอนตอบซ้ำหรือถูกปฏิเสธ) และท้าย**การแก้ชุมนุมของ admin ที่ส่ง `capacity`** **การแก้รอบของ admin** และ**การยืนยัน import** (PR 2b ด้านล่าง) และ**การย้าย/ลบนักเรียนของ admin** (PR 3a ด้านล่าง) แต่ละรอบของ loop:
  1. statement เดียว: หา entry ที่เก่าสุด `(created_at, id)` ในบรรดาชุมนุมของรอบที่ `registered < capacity` (หัวคิวของแต่ละชุมนุมที่ว่างผ่าน index แล้วเอาอันที่เก่าสุด) เฉพาะเมื่อรอบยังไม่ปิดตามนาฬิกา DB (`statement_timestamp() < closes_at` เปิดอยู่หรือยังไม่เปิดก็ได้ กติกาข้อ 6) และชั้นของนักเรียนตรงกับรอบ แล้ว `DELETE ... RETURNING` entry นั้นพร้อมชุมนุมที่นักเรียนถืออยู่ ทุกรอบลบ entry หนึ่งตัว loop จึงจบแน่นอน
  2. `UPDATE clubs SET registered = registered + 1 ... AND registered < capacity` (ไม่มีเงื่อนไขคนรอ เพราะคนที่ได้คือหัวคิวเอง)
  3. ถ้าถือชุมนุม Y อยู่: −1 ที่ Y แล้วย้ายแถว registration (`club_id`, `created_at = DEFAULT`) แบบเดียวกับการเปลี่ยน Y จึงว่างและรอบถัดไปอาจ promote หัวคิวของ Y ต่อ (promote เป็นทอด) ถ้ายังไม่มีชุมนุม: INSERT registration
  4. event `waitlist_promote` `club_id` = ชุมนุมใหม่, `from_club_id` = Y หรือ NULL, `actor_id` = คนที่ทำให้เกิดที่ว่าง (นักเรียนที่ยกเลิก/เปลี่ยน หรือ admin ที่แก้ชุมนุม/แก้รอบ/ยืนยัน import/ย้ายหรือลบนักเรียน), `idempotency_key` = NULL (key อยู่ที่ event ของคำขอเอง และ NULL ไม่ชนกันใน UNIQUE)
  - ไม่ล็อกแถว `student_profiles`: import ที่จะย้ายชั้นนักเรียนได้ถือ lock ของทุกรอบที่ยังไม่ปิด (รวมรอบนี้จนกว่าจะปิด) จึงแทรกกลางไม่ได้ และตั้งแต่ PR 2b import ปฏิเสธการย้ายชั้นของคนที่อยู่ในคิวของรอบนั้นอยู่แล้ว การเช็คชั้นใน engine จึงเป็นแค่ด่านสำรอง วนซ้ำได้ (A ใน X รอ Y, B ใน Y รอ X) ก็จบเพราะ entry ถูกลบทุกรอบ
- **คำตอบหลัง promote:** การยกเลิกและการเปลี่ยนตอบด้วย registration **หลัง promote ทั้งหมดใน transaction** ถ้าทอดวนกลับมาถึงคนที่ส่งคำขอ (เช่น A ถือ Y รอ W, P ถือ W รอ Y, A ยกเลิก Y → P ย้ายมา Y → W ว่าง → A ได้ W) คำตอบของการยกเลิกคือ W พร้อม `promotedFromWaitlist: true` ไม่ใช่ `null`
- **ส่วนอ่าน (S1 เพิ่ม field ไม่เปลี่ยนของเดิม):** `GET /api/student/round` และ `/clubs` มี `waitlist: { club, position, joinedAt } | null` (entry ของตัวเองในรอบที่เลือก) `registration` มี `promotedFromWaitlist` (event ล่าสุดของนักเรียนในรอบที่ย้ายที่นั่งเป็น `waitlist_promote` เรียงตาม `id` เพราะ event ใน transaction เดียวกันมี `created_at` เท่ากัน หน้าเว็บจึงบอก "ได้จากคิว" ได้แม้โหลดหน้าใหม่ และกลับเป็น `false` เมื่อนักเรียนลง/เปลี่ยนเอง) ซึ่งคำตอบของการลง/เปลี่ยน/ยกเลิกก็มีด้วย ชุมนุมแต่ละตัวใน `/clubs` มี `waitlistCount` (จำนวนเท่านั้น ไม่มีชื่อ) ทั้งหมดอ่านใน read-only snapshot เดียวเหมือนเดิม
- **Error ใหม่ (409 ทั้งหมด):** `already_in_club`, `waitlist_not_needed`, `not_waitlisted`
- **Log:** id และผลเท่านั้น (`waitlisted`/`already_waiting`/`left_waitlist`/`replayed` หรือรหัส error) การยกเลิก/เปลี่ยนที่ promote ใครเพิ่ม `promoted` (จำนวน) และ `promotions` (student id, club id, from club id) ไม่ log ชื่อ
- **Test:** `apps/api/test/waitlist.test.ts` (เข้า/ออกทุกคำตอบตามลำดับ, ย้ายคิวเสียลำดับด้วย event เดียว, ลำดับคิว = ลำดับ lock, idempotency ข้ามชนิดคำขอ, promote หลังยกเลิก/เปลี่ยน, ย้ายคนที่ถือชุมนุมอื่น, promote เป็นทอด B → C, ทอดวนกลับถึงคนยกเลิก/คนเปลี่ยน, วงวน 2 คน, ลำดับข้ามชุมนุม, ไม่ promote หลังปิดรอบ, ลำดับที่เลื่อนขึ้น, ลง/เปลี่ยนเข้าชุมนุมที่มีคนรอ → `club_full`, ส่วนอ่าน, guard/validation/415/rate limit ร่วม, log) และกลุ่ม `waitlist` ใน `registration-concurrency.test.ts` (500 คนลงหรือเข้าคิว, 10 คนยกเลิกพร้อมกันกับ 50 คนรอ, key เดียวกันพร้อมกัน, เข้าคิวแข่งกับยกเลิก) ตัวตรวจ invariant เพิ่ม: ไม่มีใครรอชุมนุมที่ตัวเองถือ, รอบที่ยังไม่ปิด (เปิดอยู่หรือยังไม่เปิด) ไม่มีชุมนุมที่มีทั้งที่ว่างและคนรอ, ชั้นของคนรอตรงกับรอบ (จนกว่ารอบจะปิด), event ของ waitlist ต่อกันถูก (join ที่ย้ายคิวต้องบอกคิวเดิม, leave/promote ต้องตามหลัง join ของชุมนุมเดียวกัน) และ replay event แล้วได้ entry ตรงกับตาราง, `waitlist_promote` เท่านั้นที่ไม่มี key และ actor เป็นคนอื่นได้ (ตั้งแต่ PR 3a `admin_*` มี actor เป็นบัญชี admin ได้ด้วย แต่ต้องมี key) ตรวจแล้วว่าเทสต์จับได้จริงด้วยการแก้โค้ดให้ผิดทีละแบบ (เอา `NOT EXISTS` ออกจากการลง, ไม่ promote หลังยกเลิกหรือหลังเปลี่ยน, ใช้ `now()` แทน `clock_timestamp()`, promote ไม่ดูช่วงเปิดรอบ, เรียงคิวกลับด้าน, เลือกหัวคิวข้ามชุมนุมผิดลำดับ, `promotedFromWaitlist` จาก event เก่าสุด, ไม่เช็คที่ว่างตอนเข้า, ไม่ลบคิวเดิมตอนย้าย) ทุกแบบมีเทสต์ล้ม

**Promote หลัง admin แก้ชุมนุม แก้รอบ และยืนยัน import (PR 2b)** (เสร็จแล้ว: `apps/api/src/services/clubs.ts` `updateClub`, `rounds.ts` `updateRound`, `import-commit.ts` `commitImport`, `import-plan.ts` `findHeldSeats`)

- **`PATCH /api/admin/clubs/:id`:** หลัง UPDATE ใน transaction และ round lock เดียวกัน (ล็อกก่อนอ่านอะไรเหมือนเดิม) ถ้าคำขอส่ง `capacity` จะเรียก `promoteWaitlist` ของรอบนั้น โดย `actor_id` = admin จาก session คนรอได้ที่นั่งไม่เกิน min(ที่นั่งที่เพิ่ม, จำนวนคนรอ) ตามลำดับคิว ทั้งในรอบที่เปิดอยู่และรอบที่ยังไม่เปิด คนที่ถือชุมนุมอื่นอยู่ถูกย้ายและคิวของชุมนุมเดิม promote ต่อเป็นทอด คำขอที่ไม่ส่ง `capacity` (แก้แค่ชื่อ/รายละเอียด) ไม่ทำให้เกิดที่ว่าง จึงไม่เรียก engine (และไม่ promote ในชุมนุมอื่นในนามของ admin) ลดจำนวนรับไม่ทำให้มีใครได้ที่นั่ง หลังปิดรอบไม่ promote ใคร (engine ดูนาฬิกา DB เอง) คำตอบอ่านชุมนุมใหม่หลัง promote (`registered`/`remaining` เป็นค่าหลัง promote เพราะทอดอาจย้ายคนออกจากชุมนุมนี้ด้วย จึงคำนวณจากจำนวนที่ promote ไม่ได้) error ใน engine ไม่ถูกแปลงเป็น `capacity_below_registered`
- **`PATCH /api/admin/rounds/:id`:** ใน transaction เดียว ถือ import lock (`lockImport`) ก่อน แล้ว `lockRound` ของรอบนั้น แล้วจึง `UPDATE rounds` และเรียก `promoteWaitlist` ทุกครั้งที่แก้สำเร็จ โดย `actor_id` = admin จาก session เพราะการแก้เวลาอาจเปิดรอบที่ปิดแล้วอีกครั้ง (หลังปิดรอบ admin เพิ่มจำนวนรับได้แต่ไม่มีใครถูก promote) ถ้าไม่ promote รอบที่ยังไม่ปิดจะมีชุมนุมที่มีทั้งที่ว่างและคนรอ ทั้งเมื่อแก้แล้วรอบเปิดอยู่และเมื่อแก้แล้วรอบยังไม่เปิด (รอบที่ยังไม่เปิดถึง `opens_at` เองโดยไม่มี write) แก้แล้วรอบยังปิดอยู่ engine ไม่ promote ใคร (ดูนาฬิกา DB เอง) error เดิมทั้งหมด (`404`, validation, `CHECK closes_at > opens_at`) ตอบเหมือนเดิม และ error ใน engine ไม่ถูกแปลงเป็น validation error คำตอบอ่านรอบใหม่หลัง promote (`totalRegistered` นับคนที่ได้ที่นั่งแล้ว) **ลำดับ lock:** import ถือ `FOR SHARE` บนแถว `rounds` ทุกแถวแล้วรอ round lock ถ้าการแก้รอบถือ round lock แล้วรอแถวนั้นจะ deadlock กัน การถือ import lock ก่อนทำให้การแก้รอบกับ import (และการออกรหัสผ่านเริ่มต้น) ทำทีละงาน ผลที่เห็นได้: การแก้รอบรอการลง/ยกเลิกที่กำลังทำในรอบนั้น และรอ import ที่กำลังยืนยันอยู่ให้ commit ก่อน (ทั้งคู่สั้น) การสร้างและลบรอบไม่ต้องเปลี่ยน เพราะรอบใหม่และรอบที่ลบได้ไม่มีชุมนุม
- **ยืนยัน import:** หลังเขียนแผน (`applyImportPlan`) เรียก `promoteWaitlist` ทีละรอบตาม id ที่ `lockRoundsForImport` คืน (เรียงจากน้อยไปมาก lock ถือครบอยู่แล้ว จึงไม่ล็อกเพิ่ม) `actor_id` = admin ที่ยืนยัน promote ทั้งรอบที่เปิดอยู่และรอบที่ยังไม่เปิด รอบที่ปิดแล้ว engine ข้ามเอง ไฟล์ที่ถูกปฏิเสธ (`422`) ไม่ promote ใคร คำตอบของ commit ไม่เพิ่ม field (ยังเป็น schema เดียวกับ preview) จะเพิ่มเมื่อหน้าเว็บต้องแสดง ส่วน admin เห็นผลจากหน้าชุมนุม
- **ไม่มี deadlock:** engine ไม่ล็อกเอง เขียนเฉพาะแถว `clubs`/`registrations`/`waitlist_entries` ของรอบที่ transaction ถือ lock อยู่ และแตะ `rounds`/`users`/`student_profiles` ผ่าน foreign key (`FOR KEY SHARE`) กับอ่านชั้นแบบไม่ล็อกเท่านั้น จึงไม่มีการรอแบบใหม่ (เหตุผลเต็มใน `round-lock.ts`)
- **ย้ายชั้นของคนที่อยู่ในคิว:** import ปฏิเสธการย้ายชั้นของนักเรียนที่มี waitlist entry ในรอบของภาคเรียนที่ import หรือในรอบที่ยังไม่ปิดของภาคเรียนอื่น เหมือนคนที่ถือที่นั่ง (ทั้ง dry run และ commit ใช้โค้ดเดียวกัน) error ของแถวมีรูปแบบเดิม ข้อความบอกว่าอยู่ในรายชื่อรอ ถ้ามีทั้งที่นั่งและคิวในรอบเดียวกันจะบอกที่นั่ง entry ในรอบที่ปิดแล้วของภาคเรียนอื่นไม่ใช่เหตุให้ปฏิเสธ (ดู [docs/excel.md](docs/excel.md))
- **Log:** `club.update` และ `round.update` ของ admin เพิ่ม `promoted` (จำนวน) และ `promotedStudentIds` เมื่อมีคนถูก promote log ของ `import committed` เพิ่ม `promoted` และ `promotedByRound` (`roundId`, `count`) ไม่มีชื่อ
- **Test:** `apps/api/test/admin-promote.test.ts` (PATCH เพิ่ม N ที่ มี M คนรอ → promote min(N, M) ตามลำดับ actor = admin key NULL, คำตอบเป็นค่าหลัง promote, ย้ายคนที่ถือชุมนุมอื่นแล้ว promote ต่อในชุมนุมนั้น, ไม่ promote หลังปิดรอบ/ลดจำนวนรับ/แก้แค่ชื่อ, PATCH แข่งกับยกเลิกและเข้าคิว → 10 คนแรกตามลำดับได้ที่ ยอดตรง, import เพิ่มจำนวนรับในรอบที่เปิด → promote ตามลำดับ, รอบที่ปิดแล้ว/ไฟล์ถูกปฏิเสธ → ไม่ promote, หลายรอบ → promote ทุกรอบ, log, แก้รอบ: ปิดรอบ → เพิ่มจำนวนรับ (ไม่ promote) → เปิดรอบใหม่ → promote ตามลำดับ actor = admin key NULL, ยอดรวมในคำตอบเป็นค่าหลัง promote, เปิดรอบที่ปิดแล้วใหม่เป็นยังไม่เปิด → promote ตามลำดับเหมือนกัน, แก้แล้วยังปิด/ถูก CHECK ปฏิเสธ → ไม่ promote, ข้อ 18: รอบที่มีคนรอถูกเลื่อนกลับเป็นยังไม่เปิดด้วย PATCH รอบ แล้ว PATCH จำนวนรับหรือยืนยัน import ที่เพิ่มจำนวนรับ → promote ตามลำดับทันที actor = admin key NULL, การแก้รอบรอ import ที่กำลังยืนยันบน import lock, import รอการแก้รอบที่รอ round lock อยู่บน import lock โดยไม่ deadlock, เปิดรอบใหม่แข่งกับนักเรียนลง/เข้าคิว → 5 คนแรกตามลำดับได้ที่ ยอดตรง) กลุ่ม `waitlist entries` ใน `import-commit-round-locks.test.ts` (commit ปฏิเสธการย้ายชั้นของคนในคิวภาคเรียนนี้ ภาคเรียนอื่นที่เปิดอยู่/ยังไม่เปิด และตอนที่การเข้าคิว commit ระหว่างที่ import รอ lock ย้ายได้เมื่อคิวอยู่ในรอบที่ปิดแล้ว) และกลุ่ม `a student on a waitlist` ใน `admin-import.test.ts` (dry run แบบเดียวกัน ใส่ entry ตรงลงตาราง) ตัวตรวจ invariant รันหลังทุกเทสต์ของ `admin-promote.test.ts` และ `import-commit-round-locks.test.ts` (ยอมให้ actor ของ `waitlist_promote` เป็น admin อยู่แล้ว) ตรวจแล้วว่าเทสต์จับได้จริงด้วยการแก้โค้ดให้ผิดทีละแบบ (เอา promote ออกจาก `updateClub`, เรียก engine ทุก PATCH, อ่านชุมนุมก่อน promote, เอา promote ออกจาก `commitImport`, เอา waitlist ออกจากกติกาย้ายชั้น, เอา promote ออกจาก `updateRound`, อ่านรอบก่อน promote, ใส่เงื่อนไข `opens_at` กลับเข้า engine ซึ่งเทสต์ข้อ 18 และการเปิดรอบใหม่เป็นยังไม่เปิดล้มทั้ง 3 ตัว, เอา `lockImport` ออกจาก `updateRound` ซึ่งเทสต์เห็น import รอที่ round lock แทน import lock และถ้าไม่ตรวจตรงนั้นก็ได้ deadlock `40P01` จริง) ทุกแบบมีเทสต์ล้ม

**Admin ดูรายชื่อ เพิ่ม/ย้าย/ลบนักเรียนแทน (PR 3a)** (เสร็จแล้วฝั่ง API: `apps/api/src/services/club-members.ts`, `routes/admin-club-members.ts`, schema ใน `packages/shared/src/club-members.ts` หน้าเว็บทำแล้วใน PR 5a ดูด้านล่าง)

- **ดูรายชื่อ:** `GET /api/admin/clubs/:id/members` ตอบ `200 { "club": { "id", "roundId", "clubCode", "name", "capacity", "registered", "remaining" }, "members": [{ "studentId", "loginId", "fullName", "classroom", "seatNo", "registeredAt", "source" }] }` เรียงแบบ export รายชุมนุม (ชั้น → ห้องแบบตัวเลข `classroom-order.ts` → เลขที่ → รหัสนักเรียน) `source` = ได้ที่นั่งมาอย่างไร จาก event ล่าสุดที่ย้ายที่นั่งของนักเรียนในรอบ: `student` (ลง/เปลี่ยนเอง), `waitlist` (promote), `admin` (admin จัดให้) หรือ `null` ถ้าไม่มี event (ไม่มี writer ไหนของ api ทำให้เกิด) อ่านใน read-only snapshot เดียว ไม่มี side effect ไม่มีข้อมูลติดต่อครู ไม่มีชุมนุม = `404`
- **เพิ่ม/ย้าย:** `POST /api/admin/clubs/:id/members` body `{ "loginId": "<รหัสนักเรียน>", "idempotencyKey": "..." }` (strict: ใส่ `studentId`, `roundId`, `fromClubId` หรือ field อื่น = `400`, `loginId` ผ่าน `loginIdSchema` จึงเป็นตัวเล็กเสมอ) ตอบ `200 { "club": { ... }, "member": { ... } | null }` ทั้งสองอ่าน**หลัง promote** ทั้งหมดใน transaction (ทอดอาจย้ายนักเรียนคนนั้นออกจากชุมนุมนี้อีก เช่น ถูกย้ายมาขณะรอชุมนุม W แล้ว W ว่างจากทอด คำตอบจึงเป็น `member: null`)
- **ลบ:** `POST /api/admin/clubs/:id/members/remove` body เดียวกัน (POST เพราะรับ idempotency key แบบ `/cancel`) ตอบรูปเดียวกัน (`member: null` หลังลบ)
- **ลำดับคำตอบของการเพิ่ม/ย้าย** (ตัดสินใต้ round lock ของรอบของชุมนุมทั้งหมด): `404` ไม่มีชุมนุม → key เดิม: ตอบซ้ำ `200` หรือ `409 idempotency_key_reused` → `404 not_found` ไม่มี login นี้ เป็นบัญชี admin หรือเป็นนักเรียนที่ไม่มี profile (`student_profile_missing` เป็น 403 ที่เขียนถึงนักเรียนเอง) → `409 student_not_in_round_grade` (ชั้นของนักเรียนไม่ตรงกับรอบ อ่านพร้อม `FOR SHARE` บน `student_profiles` แบบการลง) → ถือชุมนุมนี้อยู่แล้ว = `200` ไม่เขียน event → `409 club_full` → เขียน
- **ลำดับคำตอบของการลบ:** `404` ไม่มีชุมนุม → key เดิม → `404 not_found` นักเรียน → `409 not_registered` (ไม่ได้ถือชุมนุมนี้ ไม่ว่าจะถือชุมนุมอื่นหรือไม่มีเลย) → ลบ **ไม่ตรวจชั้น** เพราะหลังปิดรอบ import ภาคเรียนถัดไปอาจเลื่อนชั้นนักเรียนแล้ว และการแก้รายชื่อเก่าคืองานหลักของ endpoint นี้ (ไม่ล็อกแถว profile ด้วย เพราะไม่ได้ตัดสินอะไรจากชั้น)
- **การตัดสินใจ (ยืนยันแล้ว):**
  1. เพิ่มเข้าชุมนุมที่เต็ม → `409 club_full` ไม่ขยายจำนวนรับให้เอง (`CHECK` ของ DB ห้ามเกินอยู่แล้ว) admin เพิ่มจำนวนรับก่อนด้วย `PATCH /api/admin/clubs/:id` ซึ่ง promote คนรอก่อนตามลำดับคิว
  2. ทำได้ในรอบทุกสถานะ (ยังไม่เปิด เปิดอยู่ ปิดแล้ว) เพราะการแก้รายชื่อหลังปิดรอบคืองานหลัก ส่วนการ promote หลังลบ/ย้ายออกยังเกิดเฉพาะก่อนรอบปิด (engine ดูนาฬิกา DB เอง)
  3. การจองที่นั่งของ admin มีแค่ `registered < capacity` **ไม่มีเงื่อนไข "ไม่มีคนรอ"** แบบการลงของนักเรียน: รอบที่ยังไม่ปิด ชุมนุมที่มีคนรอเต็มเสมออยู่แล้ว (invariant) และหลังปิดรอบ admin ใส่คนลงที่ว่างได้แม้มี entry ค้าง
  4. นักเรียนต้องเป็นนักเรียนที่ชั้นตรงกับรอบของชุมนุม ระบุด้วย `loginId` (รหัสนักเรียนที่ admin อ่านจากรายชื่อ) ไม่ใช่ id ของ DB
- **ย้าย:** ถ้านักเรียนถือชุมนุมอื่นในรอบเดียวกัน จองที่ใหม่ก่อน (+1, 0 แถว = `club_full` แล้ว ROLLBACK ไม่เสียที่เดิม) แล้วคืนที่เดิม (−1) และย้ายแถว registration ด้วย `moveRegistration` ตัวเดียวกับการเปลี่ยน (`created_at = DEFAULT`) ถ้ายังไม่มีชุมนุม INSERT registration ใหม่
- **Event:** คำขอละหนึ่งตัว `admin_assign` (`club_id` = ชุมนุมที่จัดให้, `from_club_id` = ชุมนุมเดิมเมื่อย้าย ไม่อย่างนั้น NULL) หรือ `admin_remove` (`club_id` = ชุมนุมที่ลบออก) `student_id` = นักเรียน `actor_id` = admin จาก session และ `idempotency_key` ของคำขอ
- **Waitlist entry ของชุมนุมที่จัดให้:** ถ้านักเรียนรอชุมนุมนี้อยู่ entry ถูกลบใน transaction เดียวกัน (ถือและรอชุมนุมเดียวกันพร้อมกันไม่ได้ engine ถือว่าเป็น invariant ที่พัง) entry ของชุมนุมอื่นยังอยู่ (ถือชุมนุมหนึ่งแล้วรออีกชุมนุมได้ การตัดสินใจข้อ 1) ในรอบที่ยังไม่ปิดเกิดไม่ได้จริงเพราะชุมนุมที่มีคนรอเต็มเสมอ จึงเกิดหลังปิดรอบเท่านั้น **ไม่เขียน event ของ waitlist แยก** เพราะ `UNIQUE(actor_id, idempotency_key)` ให้มี event ที่มี key ได้ตัวเดียวต่อคำขอ และ event `waitlist_leave` ที่ไม่มี key โดย actor เป็น admin จะทำให้ดูเหมือนนักเรียนออกเองและไปก้าวก่ายงานลบคิวโดย admin ของ PR 3b `admin_assign` เข้าชุมนุมที่นักเรียนรออยู่จึงเป็นบันทึกว่า entry นั้นจบ (ตัวตรวจ invariant replay แบบนี้ ดูด้านล่าง)
- **Promote:** หลังย้าย (ชุมนุมเดิมมีที่ว่าง) และหลังลบ เรียก `promoteWaitlist(client, { roundId, actorId: admin })` ท้าย transaction หลัง event ของคำขอ คนรอที่เก่าสุดของชุมนุมที่ว่างได้ที่ (actor = admin, key NULL) และทอดต่อได้ตามปกติ หลังปิดรอบไม่มีใครถูก promote การเพิ่มนักเรียนที่ยังไม่มีชุมนุมไม่ทำให้เกิดที่ว่าง จึงไม่เรียก engine (ไม่ promote ในชุมนุมอื่นในนามของ admin แบบเดียวกับ `PATCH` ที่ไม่ส่ง `capacity`)
- **Idempotency:** key ของ admin ค้นด้วย `actor_id` = admin คนนั้น (ไม่ชนกับ key ของนักเรียนหรือ admin คนอื่น) คำขอเดียวกัน = ชนิดเดียวกัน + ชุมนุมเดียวกัน + นักเรียนคนเดียวกัน (เทียบ `loginId` จึงตัดสินได้ทันทีหลัง lock ก่อนหานักเรียน) → `200` ด้วยสถานะ**ปัจจุบัน** (เช่น เพิ่มด้วย key A → ลบ → ส่ง key A ซ้ำ ได้ `member: null`) อย่างอื่นที่ใช้ key ซ้ำ (นักเรียนอื่น ชุมนุมอื่น เพิ่ม↔ลบ รวมชุมนุมของรอบอื่นที่ round lock ไม่ชนกัน ซึ่ง `UNIQUE` เป็นด่านสุดท้าย) → `409 idempotency_key_reused` คำขอที่ถูกปฏิเสธไม่ทิ้ง event จึงลองใหม่ด้วย key เดิมได้ (เช่น `club_full` → เพิ่มจำนวนรับ → ส่ง key เดิม)
- **Lock:** round lock เดียวของรอบของชุมนุม ถือก่อนอ่านอะไร (CLAUDE.md กฎข้อ 3) แล้ว `FOR SHARE` บน profile (เฉพาะการเพิ่ม/ย้าย) เหมือนการลง ไม่ deadlock กับ import ด้วยเหตุผลเดียวกับการลง รวมในรอบที่ปิดแล้วของภาคเรียนอื่นที่ import ไม่ล็อก (row lock เดียวที่ใช้ร่วมกับ import คือแถว profile และการเพิ่มไม่รออะไรที่ import ถืออยู่ รายละเอียดใน `round-lock.ts`)
- **สิทธิ์ DB:** `club_app` มีครบแล้ว (`registrations` SELECT/INSERT/DELETE + UPDATE `club_id`, `created_at`, `waitlist_entries` DELETE, `registration_events` INSERT) ไม่ต้องมี migration ใหม่ เทสต์รันด้วย `club_app` จึงพิสูจน์ด้วย
- **Rate limit:** เพิ่มและลบใช้งบเดียวกัน 120 ครั้ง/นาที ต่อ admin (คนกดไม่ถึงสองครั้งต่อวินาที แต่กันปุ่มค้างหรือ script ไม่ให้ต่อคิว write บน round lock ที่นักเรียนใช้ลง) นับหลัง guard และ validation
- **Log:** บรรทัด `logAdminChange` หลัง commit `audit: club.member_assign`/`club.member_remove` มี `adminId`, `clubId`, `roundId`, `studentId` (id ของ DB), `outcome` (`assigned`/`moved`/`already_held`/`removed`/`replayed`), `fromClubId` เมื่อย้าย, `promoted` และ `promotedStudentIds` เมื่อมีคนได้ที่ ไม่ log ชื่อ รหัสนักเรียน (`loginId`) หรือชื่อชุมนุม คำขอที่ถูกปฏิเสธไม่มีบรรทัดนี้ (เหมือน admin write อื่น)
- **Test:** `apps/api/test/admin-members.test.ts` (รายชื่อ: ลำดับห้องแบบตัวเลขและเลขที่, field และยอด, `source` ทั้งสามแบบ, ไม่มีข้อมูลติดต่อครู, 404, admin เท่านั้น; เพิ่ม: ใหม่/ย้าย (event, `from_club_id`, actor = admin, ยอด), ถือแล้ว = 200 ไม่มี event, เต็ม → `club_full` ไม่มีอะไรเปลี่ยน (ย้ายแล้วเต็ม = อยู่ที่เดิม), ชั้นไม่ตรง, login ไม่มี/admin/ไม่มี profile = 404, `loginId` ตัวใหญ่, รอบปิดแล้วและยังไม่เปิด, entry ของชุมนุมที่จัดให้ถูกลบ ของชุมนุมอื่นอยู่ต่อ, คนที่ entry ถูกลบเข้าคิวอื่นได้โดย `from_club_id` = NULL, ย้ายแล้ว promote คนรอของชุมนุมเดิม (actor = admin key NULL), ทอดที่ย้ายนักเรียนออกจากชุมนุมนี้อีก → คำตอบ `member: null`, รอบปิดไม่ promote; ลบ: promote คนรอเก่าสุด, `not_registered`, 404, รอบปิดลบได้ไม่ promote, ลบที่นั่งเก่าของคนที่ถูกเลื่อนชั้นแล้ว; idempotency: ตอบซ้ำด้วยสถานะปัจจุบัน, ตอบซ้ำหลังลบ = `member: null`, key ซ้ำข้ามนักเรียน/ชุมนุม/ชนิด/รอบ, key เดียวกันในรอบอื่นที่ commit ระหว่างที่คำขอนี้รอ row lock (ผ่านการค้น key มาแล้วทั้งคู่ `UNIQUE` ตัดสิน → `409`), ถูกปฏิเสธแล้วลองใหม่ด้วย key เดิม, key เดียวพร้อมกัน 10 ครั้ง → เกิดผลครั้งเดียว; concurrency: admin เพิ่ม 15 คนแข่งกับนักเรียน 30 คนลงชิง 5 ที่สุดท้าย → ได้ 5 พอดีไม่เกิน, admin ลบ 3 + ยกเลิก 3 + เข้าคิวใหม่ 6 พร้อมกัน → 6 คนแรกของคิวได้ที่ตามลำดับ คนใหม่ต่อท้าย; body strict 400, JSON อย่างเดียว 415, guard 401/403, rate limit ร่วมต่อ admin, log ไม่มีชื่อ/รหัสนักเรียน/ชื่อชุมนุม) และ `packages/shared/test/requests.test.ts` (`clubMemberRequestSchema`) ตัวตรวจ invariant เพิ่ม: seat effect ของ `admin_assign` (+1, −1 ที่เดิมถ้ามี) และ `admin_remove` (−1), `from_club_id` มีได้ใน `admin_assign`, actor ของ `admin_*` ต้องเป็นบัญชี admin และมี key, และ replay ของ waitlist นับ `admin_assign` เข้าชุมนุมที่นักเรียนรออยู่ ณ ตอนนั้นเป็นการจบ entry (คือเมื่อ event ก่อนหน้าล่าสุดในบรรดา event ของ waitlist และ `admin_assign` เข้าชุมนุมเดียวกันเป็น join ของชุมนุมนั้น) ทั้งใน replay และในกฎ "event ของ waitlist ต่อกันถูก" ตรวจแล้วว่าเทสต์จับได้จริงด้วยการแก้โค้ดให้ผิดทีละแบบ (ไม่ promote หลังลบ, ไม่ promote หลังย้าย, ไม่ตรวจชั้น, ไม่ลบ entry ของชุมนุมที่จัดให้, ลบ entry ทุกชุมนุมของนักเรียน, ไม่มี `registered < capacity`, idempotency ไม่ดูนักเรียน/ไม่ดูชนิด, ย้ายแล้วไม่บันทึก `from_club_id`, actor เป็นนักเรียน, อ่านคำตอบก่อน promote, ลบโดยไม่ดูชุมนุม, ไม่แปลง unique violation ของ key เป็น `idempotency_key_reused`, ไม่มี rate limit, ไม่เรียงรายชื่อ, ตัวตรวจไม่นับ `admin_assign` เป็นการจบ entry) ทุกแบบมีเทสต์ล้ม

**Admin ดูรายชื่อรอ ลบรายชื่อรอแทน และดู event log (PR 3b)** (เสร็จแล้วฝั่ง API: `apps/api/src/services/club-waitlist.ts`, `services/event-log.ts`, routes ใน `routes/admin-club-members.ts` และ `routes/admin-events.ts`, schema ใน `packages/shared/src/club-members.ts` และ `event-log.ts`, migration `20261122000000_event-log-round-index.sql` หน้าเว็บรายชื่อรอทำแล้วใน PR 5a และหน้า event log ใน PR 5b ซึ่งเพิ่ม filter `loginId` ใน API ด้วย ดูด้านล่าง)

- **ดูรายชื่อรอ:** `GET /api/admin/clubs/:id/waitlist` ตอบ `200 { "club": { "id", "roundId", "clubCode", "name", "capacity", "registered", "remaining" }, "entries": [{ "position", "studentId", "loginId", "fullName", "classroom", "seatNo", "joinedAt", "heldClub": { "id", "clubCode", "name" } | null }] }` เรียงตามคิว `(created_at, id)` แบบเดียวกับ promote engine `position` 1..n (1 = คนถัดไป) `heldClub` = ชุมนุมที่คนรอถืออยู่ในรอบนั้น (ถ้าถูก promote จะย้ายออกจากชุมนุมนี้) อ่านใน read-only snapshot เดียว ไม่มี side effect ไม่มีชุมนุม = `404` admin เท่านั้น
- **ลบรายชื่อรอแทน (ปิดข้อ 19):** `POST /api/admin/clubs/:id/waitlist/remove` body `{ "loginId", "idempotencyKey" }` (strict แบบ PR 3a: ใส่ `studentId`, `roundId`, `clubId` หรือ field อื่น = `400`) ตอบ `200` **รูปเดียวกับ GET** (รายชื่อรอทั้งคิวหลังลบ อ่านใต้ round lock เดียวกัน) เพราะลำดับของคนอื่นเลื่อนขึ้น หน้าเว็บต้องแสดงคิวใหม่อยู่แล้ว
- **ลำดับคำตอบของการลบรายชื่อรอ** (ตัดสินใต้ round lock ของรอบของชุมนุม): `404` ไม่มีชุมนุม → key เดิม: ตอบซ้ำ `200` หรือ `409 idempotency_key_reused` → `404 not_found` นักเรียน (กติกาเดียวกับ PR 3a: login ไม่มี, เป็น admin, ไม่มี profile) → `409 not_waitlisted` (ไม่ได้รอชุมนุม**นี้** entry ของชุมนุมอื่นในรอบและของรอบอื่นไม่ถูกแตะ) → ลบ
- **การตัดสินใจ:**
  1. ลบได้ในรอบทุกสถานะ รวมรอบที่ปิดแล้ว ซึ่งคือเหตุผลของ endpoint นี้: หลังปิดรอบไม่มีใครถูก promote และนักเรียนออกเองไม่ได้ entry จึงค้าง ทั้งในรายชื่อรอและเป็นเหตุให้ import ภาคเรียนเดียวกันเปลี่ยนชั้นนักเรียนคนนั้นไม่ได้ (เทสต์พิสูจน์ด้วย preview: ก่อนลบได้ error "อยู่ในรายชื่อรอ..." หลังลบ `errors: []`)
  2. ไม่ตรวจชั้น (import อาจเลื่อนชั้นนักเรียนแล้วหลังปิดรอบ เหมือนการลบที่นั่ง) ไม่ล็อกแถว profile
  3. **ไม่ promote:** การลบคนรอไม่ทำให้เกิดที่ว่าง (รอบที่ยังไม่ปิด ชุมนุมที่มีคนรอเต็มเสมอ) คนรอข้างหลังแค่เลื่อนลำดับ
- **Event:** คำขอละหนึ่งตัว `waitlist_leave` (`club_id` = ชุมนุมนี้, `student_id` = นักเรียน, `actor_id` = admin จาก session, `idempotency_key` ของคำขอ) ชนิดเดียวกับที่นักเรียนออกเอง แยกกันด้วย actor (ไม่เพิ่มชนิด event ใหม่ ไม่ต้องแก้ CHECK ของ DB)
- **Idempotency:** แบบ PR 3a (helper เดียวกันใน `club-members.ts`): key ค้นด้วย `actor_id` = admin คนนั้น คำขอเดียวกัน = ชนิด (`waitlist_leave`) + ชุมนุม + นักเรียน → `200` ด้วยคิว**ปัจจุบัน** (ลบด้วย key A → นักเรียนเข้าคิวใหม่ → ส่ง key A ซ้ำ ได้ `200` และนักเรียนยังอยู่ท้ายคิว ไม่ถูกลบซ้ำ) อย่างอื่นที่ใช้ key ซ้ำ (นักเรียนอื่น ชุมนุมอื่น หรือ key ของ admin เพิ่ม/ลบสมาชิก และกลับกัน แม้นักเรียนและชุมนุมเดียวกัน) → `409 idempotency_key_reused` คำขอที่ถูกปฏิเสธ (`not_waitlisted`) ไม่ทิ้ง event จึงลองใหม่ด้วย key เดิมได้ key ของนักเรียนไม่ชนกับของ admin (`UNIQUE(actor_id, idempotency_key)`)
- **Lock และสิทธิ์ DB:** round lock เดียวของรอบของชุมนุม ถือก่อนอ่านอะไร ไม่ถือ row lock อื่น (รายละเอียดใน `round-lock.ts`) `club_app` มีสิทธิ์ครบแล้ว (`waitlist_entries` DELETE, `registration_events` INSERT)
- **Rate limit:** ใช้งบเดียวกับ admin เพิ่ม/ย้าย/ลบสมาชิก 120 ครั้ง/นาที ต่อ admin (route อยู่ใน plugin เดียวกันจึงใช้ limiter ตัวเดียวกัน) เพราะเป็นการแก้รายชื่อของชุมนุมแบบหนึ่งคลิกต่อนักเรียน บน round lock เดียวกับที่นักเรียนใช้ลง แยกงบไม่ได้ช่วยอะไรนอกจากให้ script ต่อคิว write ได้เป็นสองเท่า
- **Log:** บรรทัด `logAdminChange` หลัง commit `audit: club.waitlist_remove` มี `adminId`, `clubId`, `roundId`, `studentId` (id ของ DB), `outcome` (`removed`/`replayed`) ไม่ log ชื่อ รหัสนักเรียน หรือชื่อชุมนุม GET ไม่มีบรรทัดของตัวเอง
- **Event log:** `GET /api/admin/events` query (strict ทุกตัวเป็น optional รวมกันแบบ AND): `roundId`, `studentId`, `loginId` (รหัสนักเรียน ตัด/แปลงตัวเล็กด้วย `loginIdSchema` เพิ่มใน PR 5b ส่งคู่กับ `studentId` ต้องตรงทั้งคู่ ดูหัวข้อ PR 5b), `clubId` (ตรงกับ `club_id` **หรือ** `from_club_id` จึงเห็นการเปลี่ยน/ย้าย/promote ที่ออกจากชุมนุมนั้น และการเข้าคิวที่ทิ้งคิวของชุมนุมนั้น), `before` (cursor = `nextBefore` ของหน้าก่อน), `limit` (ค่าเริ่มต้น 50 สูงสุด 200) ชื่อ parameter ที่ไม่รู้จัก ค่าที่ไม่ใช่ตัวเลข ส่งซ้ำ หรือเกินขอบ = `400` ตอบ `200 { "events": [{ "id", "createdAt", "eventType", "round": { "id", "term", "grade" }, "student": { "id", "loginId", "fullName", "classroom", "seatNo" }, "club": { "id", "clubCode", "name" } | null, "fromClub": { ... } | null, "actor": { "id", "loginId", "fullName", "role" } }], "nextBefore": number | null }` ใหม่ไปเก่าด้วย `id DESC` id ที่ไม่มีอยู่ได้หน้าว่าง ไม่ใช่ 404
  - **ไม่ส่ง `idempotency_key`** (เป็น token ลองใหม่ของ client ไม่มีประโยชน์กับคนอ่าน log) `classroom`/`seatNo` เป็นค่า**ปัจจุบัน**ของนักเรียน ไม่ใช่ ณ เวลาที่เกิด event (import อาจย้ายห้องแล้ว) promote มี `actor` = คนที่ทำให้ที่ว่าง (นักเรียนที่ยกเลิก/เปลี่ยน หรือ admin) และไม่มี key
  - **Keyset pagination:** `WHERE id < $before ORDER BY id DESC LIMIT limit + 1` แถวเกินหนึ่งแถวบอกว่ามีหน้าถัดไป (`nextBefore` = id สุดท้ายของหน้า ไม่มีแล้ว = `null` ไม่ต้อง count) event ใหม่ที่เขียนระหว่างอ่านแต่ละหน้าได้ id สูงกว่า cursor จึงไม่ทำให้หน้าถัดไปซ้ำหรือหลุด (เทสต์เขียน event ใหม่คั่นทุกหน้า) ข้อยกเว้นเดียว: event ของอีกรอบที่ได้ id ก่อนแต่ commit ทีหลังหน้าแรก จะโผล่ในหน้าถัดไปหรือการโหลดหน้าแรกครั้งใหม่ (ในรอบเดียวกัน id เรียงตามลำดับ commit เพราะ writer ถือ round lock) ไม่ใช้ `created_at` เพราะ event ใน transaction เดียวมีเวลาเดียวกัน
  - **SQL:** WHERE มีเฉพาะ filter ที่ส่งมา แต่ละตัวเป็น fragment คงที่ ค่าส่งเป็น parameter (`$1, $2`) เสมอ จึงเป็น statement เดียวกับที่ `EXPLAIN` ไว้ อ่านอย่างเดียว statement เดียว ไม่มี side effect ไม่มี log ของตัวเองนอกจาก request line ซึ่งมีแค่ path และชื่อ parameter (`log.ts`)
  - **Index (EXPLAIN บนข้อมูลสมมติ 100,800 event ใน 60 รอบ 1,200 ชุมนุม 5,000 นักเรียน รันใน Testcontainers ด้วย SQL ของ service ตรงๆ):** ไม่มี filter และ `before` ใช้ primary key ถอยหลัง (~0.5 ms) ส่วน `roundId` ของรอบเก่า index เดิม `(round_id, created_at)` ให้ลำดับ `id` ไม่ได้ planner จึงเดิน primary key ถอยหลังผ่าน event ของรอบอื่นทั้งหมด (ตัดทิ้ง 99,120 แถว 4.2 ms และโตตามจำนวน event) migration ใหม่**แทนที่** index นั้นด้วย `(round_id, id)` → index scan ถอยหลังเฉพาะของรอบ 0.3 ms แทนที่ไม่ใช่เพิ่ม เพราะไม่มี query ไหนของ api เรียงหรือกรอง event ด้วย `created_at` (ทุกที่เรียงด้วย `id`) จำนวน index ที่ทุก INSERT ต้องเขียนใต้ round lock จึงเท่าเดิม และ `round_id` ยังเป็นคอลัมน์แรก ใช้กับ foreign key ได้ (subquery "event ล่าสุดของนักเรียนในรอบ" ที่หน้า polling ใช้ plan เดิม: BitmapAnd ของ student กับ round) `studentId` และ `clubId` (BitmapOr ของ `club_id` กับ `from_club_id`) ใช้ index เดิม อ่านไม่กี่ร้อยแถวแล้ว sort ต่ำกว่า 2 ms จึงไม่เพิ่ม index ผสมกันใช้ BitmapAnd (ต่ำกว่า 0.5 ms) ตัวเลขเป็นของเครื่อง dev ไม่ใช่ load test และสคริปต์ที่ใช้วัดไม่ได้เก็บไว้ใน repo **ตอน deploy:** migration นี้ `DROP INDEX` + `CREATE INDEX` (ไม่ใช่ `CONCURRENTLY` เพราะ node-pg-migrate รันใน transaction) จึงล็อก `registration_events` แบบ ACCESS EXCLUSIVE ช่วงสั้นๆ (ไม่ถึงวินาทีที่ปริมาณนี้) ไม่ควร deploy ระหว่างรอบเปิดลงทะเบียน
- **ตัวตรวจ invariant:** กฎ actor ยอมให้ `waitlist_leave` เป็นคำขอที่มี key ของนักเรียนเอง**หรือ**ของบัญชี admin เท่านั้น (บัญชีนักเรียนอื่นหรือไม่มี key = ผิด มีเทสต์ที่ตัวตรวจต้องจับได้) กฎ replay ของ waitlist และ "event ของ waitlist ต่อกันถูก" ไม่ต้องแก้ เพราะนับ `waitlist_leave` ทุกตัวเป็นการจบ entry ของชุมนุมที่ระบุอยู่แล้วไม่ว่าใครเป็น actor (การลบที่ไม่เขียน event หรือลบ entry ผิดชุมนุมจะทำให้ replay ไม่ตรงกับตาราง)
- **Test:** `apps/api/test/admin-waitlist.test.ts` (ลำดับคิวและ position, field ครบรวม `heldClub` และยอด, เฉพาะชุมนุมนี้, คิวว่าง, GET ไม่เขียนอะไร, 404, admin เท่านั้น; ลบ: คนอื่นเลื่อนขึ้น event `waitlist_leave` actor = admin มี key, ไม่ promote, รอชุมนุมอื่นในรอบ → `not_waitlisted` entry นั้นอยู่ต่อ, entry ของรอบอื่นอยู่ต่อ, ไม่ได้รอ → `not_waitlisted`, 404 ทุกแบบ, รอบปิดแล้ว (นักเรียนออกเองได้ `round_not_open`) และยังไม่เปิด, ข้อ 19 ด้วย import preview ของภาคเรียนเดียวกัน, นักเรียนที่ถูกเลื่อนชั้นแล้ว, เข้าคิวใหม่ได้ที่ท้ายคิว; idempotency: ตอบซ้ำด้วยคิวปัจจุบันไม่ลบซ้ำ, key ซ้ำข้ามนักเรียน/ชุมนุม/ชนิด (ทั้งสองทาง รวมนักเรียนและชุมนุมเดียวกัน), key ของนักเรียนไม่ใช่ replay ของ admin, ถูกปฏิเสธแล้วลองใหม่, key เดียวพร้อมกัน 10 ครั้ง; ตัวตรวจจับ `waitlist_leave` ของบัญชีนักเรียนอื่นและของ admin ที่ไม่มี key; concurrency: การลบรอ round lock ก่อนอ่านหรือลบอะไร (ถือ lock ค้างไว้แล้วดูว่าคิวยังไม่เปลี่ยน), admin ลบพร้อมกับนักเรียนออกเอง 10 คู่ → สำเร็จฝั่งละครั้ง, admin ลบ 4 คนแข่งกับยกเลิก 3 (promote) และเข้าคิวใหม่ 4 → ที่นั่งไม่เกิน คนที่ลบได้ไม่มีที่ คนที่ promote ก่อนได้ `not_waitlisted` และได้ที่ คิวที่เหลือเรียงตามเดิม คนใหม่ต่อท้าย; body strict 400, 415, 401/403, rate limit ร่วมกับ member write ต่อ admin, log ไม่มีชื่อ/รหัสนักเรียน/ชื่อชุมนุม) และ `apps/api/test/admin-events.test.ts` (seed ทุกชนิด event ผ่าน API ใน 2 รอบ: รูปคำตอบทุก field, promote ที่ actor เป็นนักเรียนและเป็น admin key NULL, `admin_assign` ที่มี `fromClub`, `waitlist_leave` ทั้งของนักเรียนและ admin, ไม่มี idempotency key ในคำตอบ, filter แต่ละตัวและผสม, `clubId` ตรงกับ `from_club_id`, id ที่ไม่มีได้หน้าว่าง, ไล่ทุกหน้าครบไม่ซ้ำ, หน้าสุดท้ายพอดี `nextBefore: null`, เขียน event ใหม่คั่นระหว่างหน้า, ค่าเริ่มต้น 50 สูงสุด 200, query strict/ขอบ/ส่งซ้ำ 400, admin เท่านั้น, log ไม่มีชื่อหรือค่า filter, `EVENT_TYPES` ตรงกับ CHECK ของ DB) และ `packages/shared/test/requests.test.ts` ตรวจแล้วว่าเทสต์จับได้จริงด้วยการแก้โค้ดให้ผิดทีละแบบ (ไม่ถือ round lock, ลบ entry ทุกอันของนักเรียน, ลบโดยไม่ดูชุมนุม, ไม่เขียน event, ไม่ค้น key, idempotency ไม่ดูชนิด/ไม่ดูนักเรียน, ไม่เรียงคิว, ไม่ join ชุมนุมที่ถือ, ไม่มี rate limit, log `loginId`, ตัวตรวจไม่รู้จัก admin เป็น actor ของ `waitlist_leave` หรือยอม actor ใดก็ได้, `clubId` ไม่ดู `from_club_id`, cursor `<=`, เรียงเก่าไปใหม่, `nextBefore` ไม่ใช้แถวเกิน, ไม่กรอง round, filter รวมด้วย OR) ทุกแบบมีเทสต์ล้ม ส่วน "ลบแล้วเรียก promote" สังเกตไม่ได้จากสถานะที่ถูกต้องใดเลย (ชุมนุมที่มีคนรอในรอบที่ยังไม่ปิดเต็มเสมอ และหลังปิดรอบ engine ไม่ promote) จึงไม่มีเทสต์ที่แยกได้ เทสต์แค่ยืนยันว่าไม่มี `waitlist_promote` และที่นั่งไม่เปลี่ยน

**หน้าเว็บนักเรียน: ย้ายชุมนุมและรายชื่อรอ (PR 4)** (เสร็จแล้ว: `apps/web/src/pages/student/` `ClubCard.tsx`, `WaitlistCard.tsx`, `LeaveWaitlistPanel.tsx`, `student-ui.ts` และเทสต์ `StudentWaitlist.test.tsx`, E2E `e2e/tests/waitlist.spec.ts`)

- **ปุ่มของแต่ละการ์ดใน `/student/clubs`** (ตัดสินด้วย `clubOffer` ใน `student-ui.ts` จากข้อมูลของ server ชุมนุมที่ "ลงได้ตรง" คือมีที่ว่างและไม่มีคนรอ ตรงกับเงื่อนไขของ API):

  | สถานะ | ชุมนุมที่ถืออยู่ | ชุมนุมที่รออยู่ | ชุมนุมที่ลงได้ตรง | ชุมนุมที่เต็มหรือมีคนรอ |
  |---|---|---|---|---|
  | รอบเปิด ยังไม่มีชุมนุม | – | ป้าย "รออยู่ ลำดับที่ N" | ลงชุมนุม | เข้ารายชื่อรอ |
  | รอบเปิด มีชุมนุมแล้ว | ป้าย "ชุมนุมของฉัน" | ป้าย "รออยู่ ลำดับที่ N" | ย้ายมาชุมนุมนี้ | เข้ารายชื่อรอ |
  | ยังไม่เปิด/ปิดแล้ว ยังไม่มีชุมนุม | – | ป้าย | ลงชุมนุม (กดไม่ได้) | เข้ารายชื่อรอ (กดไม่ได้) |
  | ยังไม่เปิด/ปิดแล้ว มีชุมนุมแล้ว | ป้าย | ป้าย | ไม่มีปุ่ม | ไม่มีปุ่ม |

  การ์ดแสดง "มีคนรอ N คน" เมื่อ `waitlistCount > 0` (จำนวนเท่านั้น) ปุ่มมีชื่อสำหรับ screen reader เป็นข้อความที่เห็นตามด้วยรหัสและชื่อชุมนุม (เช่น "ย้ายมาชุมนุมนี้ A100 ...") จึงแยกได้ทุกการ์ด
- **กล่องยืนยัน** อยู่ในการ์ดแบบเดียวกับการลง (`role="alertdialog"`, Escape ปิดได้ยกเว้นระหว่างรอคำตอบ, focus กลับไปที่ปุ่มของการ์ด ซึ่งเป็น ref เดียวไม่ว่าปุ่มจะเป็นแบบไหน หลัง refetch ปุ่มย้ายที่ได้ `club_full` จึงกลายเป็นปุ่มเข้ารายชื่อรอและ focus กลับไปถูกที่): การย้ายบอกว่าจะออกจากชุมนุมเดิมก็ต่อเมื่อได้ที่ใหม่แล้วเท่านั้น ถ้าชุมนุมใหม่เต็มก่อนยังอยู่ที่เดิม การเข้ารายชื่อรอบอกจำนวนคนรอตอนนี้และว่าผลแจ้งที่หน้าเว็บเท่านั้น ถ้าถือชุมนุมอยู่เตือนว่าได้ที่แล้วจะถูกย้ายออกจากชุมนุมเดิมทันที (การตัดสินใจข้อ 1) และถ้ารอชุมนุมอื่นอยู่เตือนว่าลำดับเดิมจะหายไป (รอได้ทีละ 1 ชุมนุม) ลงหรือย้ายแล้วได้ `club_full` ข้อความบอกว่ายังอยู่ที่เดิมและกล่องมีปุ่ม "เข้ารายชื่อรอชุมนุมนี้" ที่เปิดกล่องยืนยันการเข้ารายชื่อรอ (คำขอใหม่ key ใหม่) ตามกติกา waitlist ข้อ 1
- **Entry ของตัวเอง** แสดงเป็นการ์ด "รายชื่อรอของฉัน" ใต้การ์ดชุมนุมของฉันทั้งสองหน้า: ชุมนุม, "ลำดับที่ N", เวลาที่เข้า (เวลาไทย) และสิ่งที่จะเกิดเมื่อได้ที่ (ลงให้เอง หรือย้ายออกจากชุมนุมเดิม) ปุ่ม "ออกจากรายชื่อรอ" มีเฉพาะรอบเปิด กล่องยืนยันเตือนว่าลำดับจะหายและเข้าใหม่ต้องต่อท้าย กล่องอยู่นอกการ์ดเหมือนกล่องยกเลิก คำตอบ `not_waitlisted` (เช่น เพิ่งได้ที่) จึงยังอยู่บนจอแม้ refetch แล้ว entry หายไป รอบที่ปิดแล้วบอกว่าจะไม่มีการให้ที่จากรายชื่อรออีก
- **ได้ที่จากรายชื่อรอ:** เมื่อ `registration.promotedFromWaitlist` เป็น true ทั้งสองหน้าขึ้น "ได้ที่ในชุมนุม X จากรายชื่อรอแล้ว" จากข้อมูลโดยตรง (ไม่เทียบกับค่าก่อนหน้า) จึงยังอยู่หลังโหลดหน้าใหม่และหายเองเมื่อนักเรียนลง/ย้ายเอง ข้อความอยู่ใน `role="status"` ที่ mount ไว้ตลอด screen reader จึงอ่านเมื่อ poll นำผลมา (polite) โดยไม่ย้าย focus ยกเว้น focus อยู่ที่ปุ่ม "ออกจากรายชื่อรอ" (หรือข้อความเข้ารายชื่อรอ) ที่ poll ทำให้หายไป ซึ่ง focus จะมาที่ข้อความนี้ (แก้ใน PR 5c ดูด้านล่าง) ตั้งแต่ PR 5c ข้อความเข้ารายชื่อรอหายไปเมื่อข้อมูลล่าสุดไม่มี entry นั้นแล้ว จึงไม่ขึ้นคู่กับข้อความนี้
- **Polling:** หน้ารายการ poll ทุก 5 วินาทีระหว่างรอบเปิดเหมือนเดิม หน้าผลของฉัน poll ทุก 5 วินาทีเฉพาะตอนรอบเปิด**และ**มี entry ในรายชื่อรอ (ไม่อย่างนั้นการได้ที่จะเห็นเมื่อโหลดใหม่เท่านั้น เพราะไม่มีแจ้งทางอื่น การตัดสินใจข้อ 2) นอกนั้นใช้ตัวตั้งเวลาตามเวลาเปิด/ปิดรอบแบบเดิม
- **Idempotency และการรอคำตอบ:** แบบเดียวกับการลง/ยกเลิก (Phase 1 ข้อ 4) ทุกหน้ามี mutation เดียว (`useStudentWrite`) ที่ส่งตามชนิด (ลง/ย้าย/เข้า/ออก/ยกเลิก) ส่งเฉพาะ `clubId` กับ `idempotencyKey` (body ของ API เป็น strict) key ใหม่ทุกครั้งที่กดยืนยัน "ลองอีกครั้ง" ใช้ key เดิมเฉพาะเมื่อไม่รู้ผล (เน็ตหลุด, 5xx, คำตอบอ่านไม่ได้) 4xx ถือว่าจบ ปุ่มทั้งหน้าปิดระหว่างรอ ทุกคำตอบโหลดข้อมูลทั้งสองหน้าใหม่ คำตอบที่สำเร็จเขียน `registration` หรือ `waitlist` ลง cache ทันที และ focus ไปที่ข้อความผล (ปุ่มที่กดหายไปแล้ว) ข้อความผลมาจากคำตอบ ไม่ใช่จากชุมนุมที่เลือก เพราะการย้าย/ยกเลิกอาจ promote เป็นทอดจนนักเรียนได้ชุมนุมที่ตัวเองรอ และ key ที่ตอบซ้ำตอบด้วยสถานะปัจจุบัน
- **ข้อความ error** อยู่ที่ `WRITE_MESSAGES` ใน `student-ui.ts` ที่เดียว แยกตามชนิดคำขอ: ย้าย (`club_full` ยังอยู่ที่เดิม + เสนอรายชื่อรอ, `not_registered` ให้กดลงแทน, `round_not_open`, `not_found`), เข้า (`already_in_club`, `waitlist_not_needed` ให้ลงหรือย้ายตรง, `round_not_open`, `not_found`), ออก (`not_waitlisted`, `round_not_open`) และของเดิม `club_full` ของการลงเพิ่มว่าเข้ารายชื่อรอได้ `already_registered` ชี้ไปที่ปุ่มย้าย ทุกชนิดมีข้อความเมื่อไม่รู้ผลและข้อความสำรอง

**หน้าเว็บ admin: รายชื่อสมาชิกและรายชื่อรอ (PR 5a)** (เสร็จแล้ว: `apps/web/src/pages/admin-clubs/` `ClubMembersPanel.tsx`, `MemberTables.tsx`, `AddMemberForm.tsx`, `club-members-ui.ts` และเทสต์ `ClubMembersPanel.test.tsx`, E2E `e2e/tests/admin-members.spec.ts` ใช้ API ของ PR 3a/3b ไม่แก้ API หรือ schema)

- **เปิดจากตารางชุมนุม:** แต่ละแถวของ `/admin/clubs` มีปุ่ม "รายชื่อ" (ชื่อสำหรับ screen reader "รายชื่อชุมนุม <รหัส>" แบบปุ่มแก้ไข) เปิดกล่องรายชื่อของชุมนุมนั้นใต้ตาราง หน้าเก็บแค่ id ของชุมนุมที่เปิด (ไม่ใช่ snapshot) แล้วอ่านชุมนุมจากรายการที่ poll อยู่ และ key กล่องด้วย id แบบเดียวกับฟอร์มแก้ไข เปิดได้ทีละอย่าง: เปิดรายชื่อปิดฟอร์มแก้ไขและกลับกัน เปลี่ยนรอบปิดทั้งสอง
- **สิ่งที่แสดง:** ที่นั่ง (รับ · ลงแล้ว · เหลือ) จาก `club` ในคำตอบของรายชื่อสมาชิก, **สมาชิก (N คน)** ห้อง เลขที่ รหัสนักเรียน ชื่อ เวลาที่ได้ที่ (เวลาไทย) และที่มาเป็นป้าย (`student` ลงเอง, `waitlist` ได้จากรายชื่อรอ, `admin` ผู้ดูแลจัดให้, `null` ไม่ทราบ), **รายชื่อรอ (N คน)** ลำดับ ห้อง เลขที่ รหัส ชื่อ เวลาที่เข้ารอ และชุมนุมที่ถืออยู่ (หรือ "—") จำนวนคนรอแสดงในกล่องนี้เท่านั้น ไม่เพิ่ม field ใน `AdminClub` ชื่อทั้งหมดมาจากไฟล์ import จึงแสดงเป็น text node เท่านั้น
- **แก้ได้ทุกสถานะของรอบ** (ยังไม่เปิด เปิดอยู่ ปิดแล้ว) ตาม PR 3a การตัดสินใจข้อ 2 และ PR 3b ข้อ 1 ปุ่มและฟอร์มไม่ดู `status` เลย รอบที่ปิดแล้วมีข้อความว่ายังแก้ได้แต่จะไม่มีใครได้ที่จากรายชื่อรออีก
- **เพิ่ม/ย้าย:** ช่อง "รหัสนักเรียน" + ปุ่ม "เพิ่มเข้าชุมนุม" ตรวจและ normalize ด้วย `loginIdSchema` ก่อนส่ง (ตัวเล็ก ตัดช่องว่าง แบบหน้า login) คำอธิบายใต้ช่องบอกว่านักเรียนที่ถือชุมนุมอื่นในรอบนี้จะถูกย้ายมา (ได้ที่ใหม่ก่อนจึงออกจากที่เดิม) ถ้ารอชุมนุมนี้อยู่ชื่อจะออกจากรายชื่อรอ และชุมนุมที่เต็มต้องเพิ่มจำนวนรับก่อนด้วยปุ่ม "แก้ไข" คำตอบของ API แยกไม่ได้ว่าเพิ่มใหม่ ย้าย หรือถืออยู่แล้ว ข้อความผลจึงเป็นแบบเดียว "บันทึกแล้ว: <รหัส> <ชื่อ> อยู่ในชุมนุม <ชุมนุม>" และ `member: null` (ทอดของ promote ย้ายนักเรียนต่อไปชุมนุมที่รออยู่) มีข้อความของตัวเองว่าตอนนี้นักเรียนไม่ได้อยู่ในชุมนุมนี้ เพราะถูกย้ายต่อไปชุมนุมที่รออยู่
- **นำออก:** ทุกแถวของทั้งสองตารางมีปุ่ม "นำออก" (ชื่อ "นำออก <รหัส> <ชื่อ>") เปิดกล่องยืนยันใต้แถว ใช้ `WritePanel` ตัวเดียวกับหน้านักเรียน (`apps/web/src/components/WritePanel.tsx`, `role="alertdialog"` รับ focus ตอนเปิด Escape ปิดได้ยกเว้นระหว่างรอคำตอบ) ปิดแล้ว focus กลับไปที่ปุ่มที่เปิด สำเร็จแล้วแถวหายไป focus จึงไปที่ข้อความผล (`role="status"` ที่ mount ไว้ตลอด) ข้อความยืนยันการนำสมาชิกออกตัดสินด้วย `status === 'closed'` (ไม่ใช่ `!== 'open'` เพราะ engine promote จนกว่ารอบจะปิด รอบที่ยังไม่เปิดก็ promote): รอบที่ยังไม่ปิดบอกว่าคนรอลำดับแรก (ถ้ามี) จะได้ที่แทนอัตโนมัติ รอบที่ปิดแล้วบอกว่าไม่มีใครได้ที่และที่นั่งว่างไว้ การนำออกจากรายชื่อรอบอกว่าไม่ทำให้ใครได้ที่ คนข้างหลังเลื่อนขึ้นหนึ่งลำดับ คำปฏิเสธที่ refetch ทำให้แถวหายไปด้วย (เช่น `not_registered` เพราะ admin อีกคนเพิ่งนำออก) แสดงไว้เหนือรายการแทน
- **Idempotency key:** แบบ `useStudentWrite` แต่ผูก key กับสิ่งที่ขอ (ชนิด + ชุมนุม + `loginId` ที่ normalize แล้ว) ใน ref ไม่ใช่ใน variables ของ mutation (ซึ่ง `reset()` ล้างทุกครั้งที่ปิดกล่อง): ส่งคำขอเดิมซ้ำหลังไม่รู้ผล (เน็ตหลุด, 5xx, คำตอบอ่านไม่ได้) ใช้ key เดิม server จึงตอบซ้ำแทนการทำสองครั้ง ส่วนคำขออื่น (นักเรียนอื่น รหัสที่แก้แล้ว ชนิดอื่น) ได้ key ใหม่ และคำตอบใดๆ จาก server (2xx หรือ 4xx) ปิดคำขอนั้น คำขอถัดไปจึงได้ key ใหม่ แก้รหัสในช่องแล้วจึงไม่ได้ `409 idempotency_key_reused` จาก key เก่า mutation เดียวทั้งกล่อง ปุ่มทั้งกล่องปิดระหว่างรอ
- **Refresh:** ทุกคำตอบ (สำเร็จหรือถูกปฏิเสธ) invalidate `CLUBS_QUERY_KEY` ทั้ง prefix และรายการรอบ เพราะการย้ายคืนที่ในชุมนุมเดิม การนำออกอาจ promote เป็นทอดข้ามชุมนุม และการเพิ่มลบ entry รอของนักเรียน key ของรายชื่อคือ `[...CLUBS_QUERY_KEY, 'members' | 'waitlist', clubId]` จึงไม่ชนกับ `[...CLUBS_QUERY_KEY, roundId]` ของตาราง (ตัวที่สามเป็น string กับ number) invalidate ครั้งเดียวจึงได้ทั้งตัวเลขในตารางและทุกรายการที่เปิด คำตอบที่สำเร็จเขียนลง cache ทันทีเฉพาะส่วนที่บอกครบ: ที่นั่งของชุมนุม (และเอาแถวที่นำออกแล้วออก) และคิวทั้งคิวหลังนำออกจากรายชื่อรอ
- **Polling:** รายชื่อทั้งสอง poll ด้วย `refetchWhileOpen` ของรอบจากรายการชุมนุมที่ poll อยู่ ทุก `CLUBS_POLL_INTERVAL_MS` เท่าตาราง (รอบเปิดทุก 5 วินาที รอบที่ยังไม่เปิดถามอีกครั้งตอนถึงเวลาเปิด รอบปิดแล้วไม่ poll)
- **ข้อความ error** อยู่ที่ `club-members-ui.ts` ที่เดียว แยกตามชนิด: เพิ่ม (`club_full` ให้เพิ่มจำนวนรับก่อนด้วยปุ่ม "แก้ไข" นักเรียนยังอยู่ที่เดิม, `student_not_in_round_grade`), นำสมาชิกออก (`not_registered`), นำออกจากรายชื่อรอ (`not_waitlisted`) และที่ใช้ร่วมกัน `not_found` (code เดียวทั้งชุมนุมและนักเรียน จึงเป็นข้อความเดียว "ไม่พบนักเรียนรหัสนี้หรือชุมนุมนี้"), `validation_error`, `idempotency_key_reused`, `rate_limited`, `forbidden`, `unauthorized` (และกลับไปหน้า login) ทุกชนิดมีข้อความเมื่อไม่รู้ผลและข้อความสำรอง
- **Test:** `ClubMembersPanel.test.tsx` (mock API แบบมี state ในหน่วยความจำ: รายชื่อ/ยอด/ป้ายที่มาทั้งสี่แบบ/ชุมนุมที่ถือ, เปิดได้ทีละกล่องและปิดเมื่อเปลี่ยนรอบ, เพิ่มด้วยรหัสตัวใหญ่ → ส่งตัวเล็ก, ย้ายแล้วตัวเลขของชุมนุมเดิมในตารางลดด้วย, `member: null`, ทุก error code, รหัสผิดรูปแบบไม่ส่ง, key เดิมหลังเน็ตหลุด key ใหม่หลังแก้รหัสและหลังได้คำตอบ, นำออกพร้อม focus ไปที่ข้อความผล, ข้อความยืนยันของรอบปิดแล้ว/ยังไม่เปิด, Escape และปุ่มไม่นำออกคืน focus, คำปฏิเสธที่แถวหายไป, ลองอีกครั้งด้วย key เดิม, คิวเลื่อนขึ้นหลังนำออก, คำตอบซ้ำที่ยังอยู่ในชุมนุม/คิว, session หมดอายุ, โหลดไม่สำเร็จแล้วลองใหม่, poll เฉพาะรอบที่ยังไม่ปิด) ตรวจแล้วว่าเทสต์ key จับได้จริงด้วยการแก้โค้ดให้ผิด 3 แบบ (key ใหม่ทุกครั้ง, ไม่ผูก key กับรหัส, ไม่ล้าง key หลังได้คำตอบ) ทุกแบบมีเทสต์ล้ม E2E: admin เพิ่มนักเรียน (พิมพ์รหัสตัวใหญ่) ย้ายไปอีกชุมนุม แล้วนำออก (ตรวจที่นั่งและ event `admin_assign` ×2 โดยตัวที่สองมี `from_club_id` แล้ว `admin_remove` actor = admin) และนักเรียนเข้ารายชื่อรอในเบราว์เซอร์ของตัวเองแล้ว admin นำออก (ไม่มี entry เหลือ event `waitlist_leave` actor = admin)

**หน้าเว็บ admin: ประวัติการลงทะเบียน (PR 5b)** (เสร็จแล้ว: `apps/web/src/pages/admin-events/` `AdminEventsPage.tsx`, `EventsTable.tsx`, `StudentCodeFilter.tsx`, `event-ui.ts` และเทสต์ `AdminEventsPage.test.tsx`, E2E `e2e/tests/admin-events.spec.ts` ฝั่ง API เพิ่ม filter `loginId` ใน `packages/shared/src/event-log.ts` และ `apps/api/src/services/event-log.ts`)

- **เมนู "ประวัติการลงทะเบียน"** (`/admin/events`) โหลดแยก chunk ด้วย `lazyPage` แบบหน้าอื่น นักเรียนที่เปิด URL นี้ถูกส่งกลับหน้าแรกก่อนดาวน์โหลดหน้า (เทสต์ใน `routes.lazy.test.tsx`)
- **ตาราง** (ชื่อสำหรับ screen reader "ประวัติการลงทะเบียน" ข้อความทั้งหมดเป็น text node): เวลา (เวลาไทย `formatThaiDateTime`), เหตุการณ์ (ชื่อภาษาไทยของทั้ง 8 ชนิดใน `EVENT_TYPE_LABELS` เป็น `Record<EventType, string>` ชนิดใหม่ใน `packages/shared` จึง typecheck ไม่ผ่านจนกว่าจะมีชื่อ), รอบ (ภาคเรียน ม.ชั้น), นักเรียน (รหัสเป็นปุ่ม ชื่อ ห้อง/เลขที่ ข้อความเหนือตารางบอกว่าห้องและเลขที่เป็นค่า**ปัจจุบัน**ตาม API ไม่ใช่ ณ เวลาที่เกิด), ชุมนุม (มี `fromClub` = "จาก X → Y" การเข้ารายชื่อรอที่มี `fromClub` = "จากรายชื่อรอ X → Y" เพราะสิ่งที่ทิ้งคือคิว ไม่ใช่ที่นั่ง ไม่มีชุมนุม = "—"), ผู้ทำ (ชื่อ + "ผู้ดูแลระบบ" / "นักเรียนคนนี้เอง" / "นักเรียนคนอื่น" และ `waitlist_promote` มีหมายเหตุว่าเป็นผู้ที่ทำให้มีที่ว่าง ระบบให้ที่อัตโนมัติ ไม่ใช่นักเรียนที่ได้ที่)
- **ตัวกรอง** อยู่ใน state ของ component เท่านั้น **ไม่ใส่ใน URL ของหน้าหรือ search params** เพราะรหัสนักเรียนจะไปอยู่ในประวัติของเบราว์เซอร์ (URL ของ `fetch` ไม่เข้าประวัติ) โหลดหน้าใหม่ตัวกรองจึงหาย ซึ่งตั้งใจ: รอบ ("ทุกรอบ" + รายการจาก `fetchRounds()` key เดียวกับหน้าอื่น) ชุมนุม (มีเมื่อเลือกรอบ จาก `fetchRoundClubs` key เดียวกับหน้าชุมนุม cache จึงใช้ร่วมกัน "ทุกชุมนุม" เป็นค่าเริ่มต้น ล้างเมื่อเปลี่ยนรอบ) และรหัสนักเรียน (ช่องของตัวเองมีปุ่ม "กรอง" และ "ล้างรหัส" ตรวจและ normalize ด้วย `loginIdSchema` ก่อนส่ง รหัสผิดรูปแบบขึ้นข้อความไทยและไม่ส่ง ส่งช่องว่าง = เอาตัวกรองนี้ออก ฟอร์มไม่มี `name` และ `preventDefault` เสมอ จึงไม่มีทาง submit รหัสเข้า URL) กดรหัสนักเรียนในแถวกรองเฉพาะคนนั้นและย้าย focus ไปที่ช่องรหัส (ปุ่มที่กดหายไประหว่างโหลด) ตัวกรองที่ใช้อยู่แสดงเป็นข้อความเดียว พร้อมปุ่ม "ล้างตัวกรองทั้งหมด" (focus ไปที่ช่องรอบ)
- **ค่าเริ่มต้นเป็น "ทุกรอบ"** ไม่ใช่รอบที่หน้าชุมนุมเลือกให้ (`preferredRound`): log เรียงใหม่ไปเก่าอยู่แล้ว สิ่งที่เพิ่งเกิดในทุกรอบจึงอยู่บนสุด และโหลดได้ทันทีพร้อมรายการรอบ ไม่ต้องรอรายการรอบแล้วยิงซ้ำหลังเลือกรอบให้
- **แบ่งหน้า:** `useInfiniteQuery` ใช้ `nextBefore` เป็น page param ส่ง `before` เฉพาะหน้าถัดไป ไม่ส่ง `limit` (ใช้ค่าเริ่มต้น 50 ของ API) parameter เรียงคงที่ (`roundId`, `clubId`, `loginId`, `before`) ไม่ส่งตัวที่ไม่ได้ตั้ง ปุ่ม "โหลดเพิ่ม" มีเมื่อ `nextBefore` ไม่ใช่ `null` ระหว่างโหลดเป็น `aria-disabled` (ไม่ใช่ `disabled` ซึ่งทำ focus หลุด) และไม่รับกดซ้ำ แถวต่อท้ายตารางโดย focus อยู่ที่ปุ่มเดิม หน้าสุดท้าย ปุ่มกลายเป็น "แสดงครบแล้ว" และ focus ย้ายไปที่ข้อความนั้น (`tabIndex={-1}`) แทนที่จะหลุดไป body ปุ่ม "โหลดใหม่" อยู่นอกส่วนที่โหลด (ไม่หายระหว่างโหลด) ใช้ `resetQueries` ให้เหลือแค่หน้าใหม่สุด (`refetch` จะขอทุกหน้าที่โหลดไว้ซ้ำ) **ไม่ poll** และไม่ refetch ตอนกลับมาที่หน้าต่าง (จะขอทุกหน้าซ้ำเช่นกัน) เปลี่ยนตัวกรองใดๆ เริ่มจากหน้าแรก query ใช้ `gcTime: 0` จึงไม่ค้างใน cache เมื่อไม่มีใครดู: กลับไปตัวกรองเดิมก็เริ่มหน้าแรกใหม่ (ไม่ใช่ refetch ทุกหน้าที่เคยโหลด) และ event ของนักเรียนไม่ค้างในหน่วยความจำหลังเปลี่ยนตัวกรอง
- **สถานะ:** กำลังโหลด, ว่าง ("ไม่มีเหตุการณ์ตามตัวกรองนี้"), โหลดไม่สำเร็จพร้อม "ลองใหม่" ข้อความ error อยู่ที่ `event-ui.ts`: `validation_error` (ตัวกรองไม่ถูกต้อง), `forbidden`, `unauthorized` และข้อความสำรอง route นี้ไม่มี rate limit จึงไม่มีข้อความของ `rate_limited` หน้าถัดไปโหลดไม่สำเร็จ แถวที่โหลดแล้วยังอยู่ ข้อความ error ขึ้นเหนือปุ่ม "โหลดเพิ่ม" ซึ่งกดลองใหม่ได้
- **การตัดสินใจ: เพิ่ม filter `loginId` ใน API** (ผู้ใช้เลือก) เพื่อให้ admin พิมพ์รหัสนักเรียนได้ตรงๆ แทนที่จะต้องรู้ `studentId` (id ของ DB ที่ไม่มีที่ไหนแสดง) `loginId: loginIdSchema.optional()` ใน `eventLogQuerySchema` ยัง strict รวมกับ filter อื่นแบบ AND รวมถึง `studentId` (ส่งทั้งคู่ต้องตรงทั้งคู่ ขัดกัน = หน้าว่าง) รหัสที่ไม่มีบัญชี หรือเป็นรหัสของ admin = `200` หน้าว่าง (แบบ id ที่ไม่มีอยู่ ไม่ใช่ 404) รูปแบบผิด ว่าง เกิน 64 ตัว หรือส่งซ้ำ = `400` SQL เป็น fragment คงที่ `e.student_id = (SELECT id FROM users WHERE login_id = $n)` ค่าเป็น parameter
- **Plan (EXPLAIN ANALYZE บนข้อมูลสมมติขนาดเดียวกับ PR 3b: 100,800 event ใน 60 รอบ 1,200 ชุมนุม 5,000 นักเรียน รันใน Testcontainers ด้วย SQL ที่ service สร้างจริง สคริปต์ไม่ได้เก็บใน repo):** subquery เป็น InitPlan ค้น `users_login_id_key` (unique index) ครั้งเดียว แล้ว Bitmap Index Scan ของ `registration_events_student_id_idx` เหมือน `studentId` แล้ว sort ตาม `id DESC` + limit (~0.2 ms สำหรับนักเรียนที่มี event มากสุดในชุดนี้ ราว 40 ตัว) ใส่ `roundId` ด้วยเป็น BitmapAnd ของ index นักเรียนกับ `(round_id, id)` (~0.1 ms) ใส่ `before` ใช้ bitmap scan เดิม (อ่าน 38 แถว เหลือ 21 ~0.15 ms) รหัสที่ไม่มีบัญชีได้ NULL จาก InitPlan จึงไม่อ่าน `registration_events` เลย (~0.07 ms) ไม่ต้องเพิ่ม index ตัวเลขเป็นของเครื่อง dev ไม่ใช่ load test
- **ความเป็นส่วนตัว:** รหัสนักเรียนอยู่ใน query string ของ `GET /api/admin/events` เท่านั้น request log ของ api มีแค่**ชื่อ** parameter (`log.ts` แก้คอมเมนต์ให้บอกว่า route นี้รับข้อมูลส่วนตัวใน query และนั่นคือเหตุผลที่ไม่ log ค่า) Caddy ไม่มี access log (คงไว้แบบนั้น) เทสต์ log ส่งรหัสตัวใหญ่มีช่องว่างและรหัสผิดรูปแบบ (`400`) แล้วตรวจว่าไม่มีทั้งค่าที่ส่งและค่าที่ normalize แล้วใน log หน้าเว็บไม่ใส่รหัสใน URL ของหน้า (E2E ตรวจ `page.url()` ทั้งตัวเล็กและตัวใหญ่) ดู [docs/security.md](docs/security.md)
- **Test:** API `admin-events.test.ts` (กรองด้วย `loginId`, ตัวใหญ่/มีช่องว่าง, รหัสที่ไม่มี/ของ admin = หน้าว่าง, AND กับ `roundId`, ขัดกับ `studentId` = หน้าว่าง, รูปแบบผิด/ว่าง/ยาวเกิน/ส่งซ้ำ = 400, ไล่หน้าด้วย `nextBefore` ของ `loginId`, log ไม่มีค่า) ตรวจแล้วว่าเทสต์จับได้ด้วยการแก้ subquery ให้ผิด และ shared `requests.test.ts` หน้าเว็บ `AdminEventsPage.test.tsx` (mock fetch ที่อ่าน query string ได้ แบ่งหน้าในหน่วยความจำ: ทุกคอลัมน์ใหม่ไปเก่า, ชื่อของทุกชนิด, `fromClub` ทั้งสามแบบและ "—", ผู้ทำทั้งสามแบบและ promote, `<i>` ในชื่อเป็น text, กรองด้วยรอบ/ชุมนุม/รหัส (normalize)/กดรหัสในแถว, รหัสผิดรูปแบบไม่ส่ง, query มีเฉพาะตัวกรองที่ตั้ง, URL ของหน้าไม่มีรหัส, ล้างรหัส/ล้างทั้งหมด, "โหลดเพิ่ม" ส่ง `before` และ focus, หน้าสุดท้ายไม่มีปุ่ม, เปลี่ยนตัวกรองแล้วเปลี่ยนกลับเริ่มหน้าแรก, "โหลดใหม่" ขอหน้าเดียว, หน้าถัดไปล้มแล้วลองใหม่, กดซ้ำระหว่างโหลด, ว่าง, error ทุก code) ตรวจแล้วว่าเทสต์จับได้ด้วยการแก้โค้ดให้ผิด 5 แบบ (ไม่มี `gcTime: 0`, โหลดใหม่ด้วย `refetch`, ไม่ย้าย focus, รับกดซ้ำ, ไม่ล้างชุมนุมเมื่อเปลี่ยนรอบ) ทุกแบบมีเทสต์ล้ม E2E: นักเรียนลงชุมนุมในเบราว์เซอร์ของตัวเอง แล้ว admin เปิดเมนู พิมพ์รหัสตัวใหญ่ เห็นแถวเดียวของ event นั้น และ URL ของหน้าไม่มีรหัส

**หน้าเว็บนักเรียน: เรื่องที่ค้างจาก PR 4 (PR 5c)** (เสร็จแล้ว: `apps/web/src/pages/student/` `StudentClubsPage.tsx`, `MyRegistrationPage.tsx`, `WaitlistCard.tsx`, `student-ui.ts`, `focus-rescue.ts` และเทสต์ `StudentWaitlist.test.tsx`, E2E `e2e/tests/waitlist.spec.ts` ไม่แก้ API หรือ schema)

- **ข้อความเข้ารายชื่อรอไม่ค้าง:** เดิมข้อความ "เข้ารายชื่อรอชุมนุม X แล้ว ลำดับที่ N" อยู่ต่อตราบที่ mutation ยังสำเร็จ พอ poll เห็นว่าได้ที่ หน้าจึงบอกทั้ง "รออยู่ลำดับที่ N" และ "ได้ที่แล้ว" ตอนนี้ข้อความของการเข้ารายชื่อรอแสดงเฉพาะเมื่อข้อมูลล่าสุดยังมี entry ของชุมนุมเดียวกับในคำตอบ (`isNoticeOutdated` ใน `student-ui.ts`) ถ้าได้ที่ ถูก admin นำออก หรือ entry เป็นของชุมนุมอื่นแล้ว ข้อความก็หายไป ตัดสินจากข้อมูลตอน render ไม่ `reset()` mutation (ซึ่งจะทำให้กล่องยืนยันเดิมเปิดขึ้นมาอีก เพราะกล่องปิดด้วย `isSuccess`) และไม่มี effect ที่เขียน state ลำดับที่ในข้อความยังเป็นของตอนเข้า (การ์ดรายชื่อรอแสดงลำดับล่าสุด) ข้อความของชนิดอื่นไม่เปลี่ยน (ลง ย้าย รวม "ย้ายชุมนุมแล้ว และได้ที่จากรายชื่อรอต่อ" ออก ยกเลิก และคำตอบ `waitlist: null` ของการเข้า)
- **focus ไม่หลุดไป body:** ถ้า poll ทำให้ปุ่ม "ออกจากรายชื่อรอ" หายไปตอนที่ปุ่มมี focus (ได้ที่แล้ว admin นำออก หรือรอบไม่เปิดแล้ว) ทั้งสองหน้าย้าย focus ไปที่ข้อความ "ได้ที่ในชุมนุม … จากรายชื่อรอแล้ว" ถ้ามี ไม่อย่างนั้นไปที่หัวข้อ h1 ของหน้า ข้อความเข้ารายชื่อรอที่หายไปตอนมี focus (หน้ารายการ) ใช้กติกาเดียวกัน และถ้าได้ที่ก่อนคำตอบของการเข้าจะแสดง focus หลังเขียนสำเร็จไปที่ข้อความได้ที่แทน ข้อความได้ที่จึงมี `tabIndex={-1}` (ยังอยู่ใน `role="status"` ที่ mount ไว้ตลอด) ใช้ hook เดียว `useFocusRescue` (`focus-rescue.ts`) ทั้งสองหน้า: ref callback ของปุ่ม (React 19) คืน cleanup ที่ React เรียกก่อนเอา node ออกจาก DOM จึงยังดู `document.activeElement` ได้ว่า node นั้นมี focus ไหม (ไม่พึ่ง blur เพราะ browser ไม่จำเป็นต้องยิง blur ให้ node ที่ถูกเอาออก) แล้วตรวจใน effect หลัง commit ว่า focus ตกไปที่ body จริงก่อนย้าย **ย้ายเฉพาะเมื่อสิ่งที่หายไปมี focus อยู่** ไม่แย่ง focus จากที่อื่น และการกดปุ่มออกจากรายชื่อรอซึ่งเอาปุ่มออกเพื่อเปิดกล่องยืนยันยังได้ focus ที่กล่องเหมือนเดิม (effect ของกล่องซึ่งเป็นลูกทำงานก่อน)
- **Test:** `StudentWaitlist.test.tsx` เพิ่ม: ข้อความเข้ารายชื่อรอหายเมื่อ poll เห็นการได้ที่ และเมื่อ entry ถูกนำออกโดยไม่ได้ที่, focus จากข้อความเข้ารายชื่อรอไปข้อความได้ที่, ได้ที่ก่อนคำตอบของการเข้าแสดง, focus จากปุ่มออกจากรายชื่อรอไปข้อความได้ที่ทั้งสองหน้า, ไปที่ h1 เมื่อ entry ถูกนำออกหรือรอบปิดทั้งสองหน้า, ไม่ย้าย focus เมื่อปุ่มไม่มี focus และกล่องยืนยันการออกยังได้ focus เมื่อเปิดจากปุ่มที่มี focus ทุกเทสต์ของสองเรื่องนี้ล้มก่อนแก้ (ยกเว้นสองเทสต์สุดท้ายที่กันการแก้เกินซึ่งผ่านทั้งก่อนและหลัง ตรวจแล้วว่าจับได้จริง: เทสต์ที่ไม่ย้าย focus ล้มเมื่อลบเงื่อนไข "สิ่งที่หายไปมี focus อยู่" ออกจาก hook และเทสต์กล่องยืนยันล้มเมื่อลบการตรวจว่า focus ตกไปที่ body) E2E ใน `waitlist.spec.ts` (เทสต์เดิมของการได้ที่จากรายชื่อรอ): กด Tab จากข้อความเข้ารายชื่อรอไปที่ปุ่มออกจากรายชื่อรอ แล้วเมื่อ poll เห็นการได้ที่ ข้อความได้ที่มี focus และข้อความเข้ารายชื่อรอหายไป (ล้มก่อนแก้ใน Chromium จริง)

**API เพิ่ม** (ใช้ prefix `/api/student/...` แบบเดียวกับ Phase 1)

| Method | Path | ทำอะไร |
|---|---|---|
| PUT | `/api/student/registration` | เปลี่ยนชุมนุมแบบ atomic (**เสร็จแล้ว** ทั้ง API และหน้าเว็บ PR 4) |
| POST | `/api/student/waitlist` | เข้ารายชื่อรอ (**เสร็จแล้ว** ทั้ง API และหน้าเว็บ PR 4) |
| POST | `/api/student/waitlist/leave` | ออกจากรายชื่อรอ (POST เพราะรับ idempotency key แบบเดียวกับ `/cancel`) (**เสร็จแล้ว** ทั้ง API และหน้าเว็บ PR 4) |
| GET | `/api/student/round`, `/api/student/clubs` | เพิ่มสถานะ waitlist + ลำดับที่ในคำตอบเดิม หน้าเว็บจึง poll endpoint เดียว (**เสร็จแล้ว** ทั้ง API และหน้าเว็บ PR 4) |
| GET | `/api/admin/clubs/:id/members` | admin ดูรายชื่อสมาชิกของชุมนุม (**เสร็จแล้ว** ทั้ง API PR 3a และหน้าเว็บ PR 5a) |
| POST | `/api/admin/clubs/:id/members` | admin เพิ่มหรือย้ายนักเรียนเข้าชุมนุมแทน (`admin_assign`) (**เสร็จแล้ว** ทั้ง API PR 3a และหน้าเว็บ PR 5a) |
| POST | `/api/admin/clubs/:id/members/remove` | admin ลบนักเรียนออกจากชุมนุมแทน (`admin_remove`, POST เพราะรับ idempotency key) (**เสร็จแล้ว** ทั้ง API PR 3a และหน้าเว็บ PR 5a) |
| GET | `/api/admin/clubs/:id/waitlist` | admin ดูรายชื่อรอ (**เสร็จแล้ว** ทั้ง API PR 3b และหน้าเว็บ PR 5a) |
| POST | `/api/admin/clubs/:id/waitlist/remove` | admin ลบนักเรียนออกจากรายชื่อรอแทน (`waitlist_leave` actor = admin, ทุกสถานะรอบ) (**เสร็จแล้ว** ทั้ง API PR 3b และหน้าเว็บ PR 5a) |
| GET | `/api/admin/events` | admin ดู event log กรองด้วยรอบ/นักเรียน (id หรือรหัสนักเรียน `loginId`)/ชุมนุม แบ่งหน้าด้วย cursor (**เสร็จแล้ว** ทั้ง API PR 3b และหน้าเว็บ `/admin/events` PR 5b ซึ่งเพิ่ม `loginId`) |

Admin เพิ่ม/ลบ/ย้ายนักเรียนแทน บันทึกเป็น `admin_assign`/`admin_remove` พร้อม `actor_id` (API เสร็จแล้วใน PR 3a หน้าเว็บใน PR 5a ดูด้านบน) และหน้า admin ดู event log (การตัดสินใจข้อ 3: API เสร็จแล้วใน PR 3b หน้าเว็บใน PR 5b ดูด้านบน)

**Test ที่ต้องมี** (ข้อ 1–5 มีแล้ว: กลุ่ม `waitlist` ใน `registration-concurrency.test.ts` และ `waitlist.test.ts` สำหรับ API ของนักเรียน `admin-promote.test.ts` สำหรับ promote หลัง admin แก้ชุมนุม/ยืนยัน import `admin-members.test.ts` สำหรับ admin เพิ่ม/ย้าย/ลบแทน และ `admin-waitlist.test.ts`/`admin-events.test.ts` สำหรับรายชื่อรอและ event log ของ admin)

1. 500 request แย่ง 1 ชุมนุม capacity 30 → `registered = 30` พอดี (ลง ถ้า `club_full` เข้าคิว: ได้ 30 รอ 470 ไม่ซ้ำ)
2. ที่เต็ม + 50 คนรอ ยกเลิกพร้อมกัน 10 คน → 10 คนแรกตามลำดับถูก promote ไม่ซ้ำ (อีก 40 คนลำดับ 1..40 ตามเดิม)
3. promote เป็นทอด (B ว่าง → คนรอ B ย้ายมาจาก C → คนรอ C เข้า C)
4. ยิงคำสั่งซ้ำด้วย `idempotency_key` เดียวกัน → เกิดผลครั้งเดียว (เข้า/ออก ทั้งส่งซ้ำทีหลังและส่งพร้อมกัน)
5. Invariant: `clubs.registered` = จำนวน registration จริง, ไม่มีนักเรียนมี 2 registration (และ invariant ของ waitlist ข้างบน) รันหลังทุกเทสต์

### Phase 3: Queue คุมจำนวนคนเข้า

**เป้าหมาย:** ต่อรอบมีนักเรียนที่เลือกชุมนุมได้พร้อมกันไม่เกิน `rounds.max_active` คนที่เหลือรอคิวตามลำดับที่เข้า (กติกาธุรกิจข้อ 4)

**การตัดสินใจของ Phase 3** (ยืนยันแล้ว)

1. **route ที่ต้องมี ticket `admitted`** (ทำใน Q2): `GET /api/student/clubs` และการเขียนที่เอาที่นั่ง (ลง เปลี่ยน เข้ารายชื่อรอ) ส่วน `GET /api/student/round` (ผลของฉัน) ยกเลิก และออกจากรายชื่อรอ ไม่ต้องมี ticket เพราะไม่เอาที่นั่งของใคร
2. **ไม่ admit เกิน `max_active` ต่อรอบ:** การเขียนของคิวทุกตัวถือ queue lock ของรอบ (`pg_advisory_xact_lock(2, round_id)` ใน `round-lock.ts`) แล้วนับและ admit ใน statement เดียว เลือก ticket ที่รออยู่ด้วย `FOR UPDATE SKIP LOCKED` เรียง `(created_at, id)`
3. **หมดอายุ:** ticket (รอหรือ admitted) ที่ `last_seen_at` เก่ากว่า idle timeout (default 60 วินาที) เป็น `expired` และ ticket ที่ admitted แล้วหมดอายุเมื่อ `admitted_at` เก่ากว่า admission TTL (default 10 นาที) แม้ยัง poll อยู่ ทั้งสองค่ามาจาก env (`QUEUE_IDLE_TIMEOUT_SECONDS`, `QUEUE_ADMISSION_TTL_SECONDS` ตรวจด้วย Zod ตอน boot) เป็นค่าประเมินที่ต้องปรับหลัง load test (O5) ทุกการตัดสินเรื่องเวลาใช้นาฬิกา DB
4. **ลงสำเร็จแล้ว ticket ยังเป็น admitted** จนหมดอายุ นักเรียนจึงยังเปลี่ยนชุมนุมได้ และกดปล่อยเองก่อนได้ (`done`)
5. **เข้าคิวได้เฉพาะตอนรอบเปิด** (นาฬิกา DB กติกาช่วงเปิดเดียวกับการลง) ลำดับคือเวลาที่เข้า `created_at` = `clock_timestamp()` หลังได้ queue lock (เหตุผลเดียวกับ `waitlist_entries`) ลำดับคิวจึงตรงกับลำดับ lock
6. **`max_active` เป็น NULL = รอบนั้นไม่มีคิว** (ทำใน Q4 ตอนนี้ยัง NOT NULL)
7. **Load test เลื่อนไปทำบนเครื่อง EC2 พร้อม O5**

**Q1: API ของคิว** (เสร็จแล้ว: `apps/api/src/services/queue.ts`, `routes/student-queue.ts`, `packages/shared/src/queue.ts`, migration `20261123000000_queue-tickets.sql`)

| Method | Path | ทำอะไร |
|---|---|---|
| POST | `/api/student/queue/join` | เข้าคิวของรอบที่นักเรียนเห็น มี ticket ที่ยังไม่หมดอายุอยู่แล้ว = ตอบ ticket เดิม (นับเป็น heartbeat ด้วย ตอบได้แม้รอบปิด) ไม่มี = ticket ใหม่ท้ายคิว แล้ว admit ทันทีถ้ามีที่ |
| POST | `/api/student/queue/heartbeat` | หน้าเว็บ poll ทุก 3–5 วินาที: อัปเดต `last_seen_at` → expire ticket ที่หมดอายุของรอบ → admit ได้ถึง `max_active - admitted` แทน `GET /queue/status` เดิม เพราะเขียน และ endpoint อ่านต้องไม่มี side effect |
| POST | `/api/student/queue/done` | ปล่อย ticket (รอหรือ admitted) เป็น `done` ไม่มี ticket = ตอบสถานะปัจจุบัน ไม่ใช่ error ไม่ admit ใคร ที่ว่างไปถึงคนถัดไปตอน heartbeat/join ครั้งต่อไป |
| GET | `/api/student/queue` | อ่านอย่างเดียวใน read-only snapshot: ไม่ expire ไม่ admit และ**ไม่นับเป็น heartbeat** |

- **คำตอบ (ทั้ง 4 endpoint):** `200 { "round": <รอบแบบ GET /api/student/round> | null, "ticket": null | { "status": "waiting", "position": 3 } | { "status": "admitted", "admittedUntil": "<ISO>" } | { "status": "expired" } | { "status": "done" } }` `ticket` คือ ticket ล่าสุดของนักเรียนในรอบนั้นตามนาฬิกา DB (ticket ที่เลย timeout แสดงเป็น `expired` แม้ยังไม่มีการเขียนใดเปลี่ยนแถว) `null` = ยังไม่เคยเข้าคิว `position` 1 = คนถัดไปที่จะได้ (ticket ที่รอและยังไม่หมดอายุข้างหน้า + 1) `admittedUntil` = เวลาที่ TTL หมด (idle timeout ทำให้หมดก่อนได้ถ้าหยุด heartbeat) ไม่ส่ง `max_active` จำนวน admitted หรือข้อมูลของนักเรียนคนอื่น `round` เป็นข้อมูลที่นักเรียนเห็นอยู่แล้ว ใส่ไว้ให้หน้ารอคิว poll endpoint เดียว
- **เลือกรอบ:** กติกาเดียวกับ S1 (Phase 1 ข้อ 4) ด้วยนาฬิกา DB นักเรียนและรอบมาจาก session เท่านั้น body ของ POST ทั้งสามต้องเป็น JSON `{}` แบบ strict (ใส่ `studentId`, `roundId`, `position` = `400`, ไม่มี body หรือเป็น text = `400`, form = `415`) เพื่อคงการกัน CSRF แบบ JSON-only เหมือนการเขียนอื่น query ของ GET เป็น strict
- **Error:** `409 round_not_open` (join ตอนรอบยังไม่เปิด/ปิดแล้ว หรือชั้นไม่มีรอบ และไม่มี ticket เดิม), `409 not_in_queue` (heartbeat ไม่มี ticket ที่ยังไม่หมดอายุ: ไม่เคยเข้า ปล่อยแล้ว หรือหมดอายุ รวมถึง heartbeat ที่มาช้าเกิน idle timeout ซึ่งถือว่าหมดอายุเสมอ ไม่ขึ้นกับว่ามีคนอื่นเขียนก่อนหรือไม่ หรือชั้นไม่มีรอบ), `403` admin / ยังไม่เปลี่ยนรหัสครั้งแรก / `student_profile_missing`, `401` ไม่มี session, `429` เกิน rate limit
- **ลำดับใน transaction ของการเขียน:** `BEGIN` → เลือกรอบ (นาฬิกา DB) → `pg_advisory_xact_lock(2, round_id)` → expire ticket ที่หมดอายุของรอบ → การเปลี่ยนของคำขอเอง (heartbeat/ticket ใหม่/done) → admit (join, heartbeat) → อ่านคำตอบ → `COMMIT` statement ที่ admit:

```sql
WITH room AS (
  SELECT GREATEST(
    COALESCE((SELECT r.max_active FROM rounds r WHERE r.id = $1
              AND statement_timestamp() >= r.opens_at AND statement_timestamp() < r.closes_at), 0)
    - (SELECT count(*) FROM queue_tickets a WHERE a.round_id = $1 AND a.status = 'admitted'),
    0) AS slots
), next AS (
  SELECT w.id FROM queue_tickets w WHERE w.round_id = $1 AND w.status = 'waiting'
  ORDER BY w.created_at, w.id LIMIT (SELECT slots FROM room) FOR UPDATE SKIP LOCKED
)
UPDATE queue_tickets SET status = 'admitted', admitted_at = statement_timestamp()
WHERE id = ANY (ARRAY(SELECT id FROM next));
```

- **ทำไมไม่เกิน `max_active`:** การเขียนของคิวในรอบเดียวกันเรียงกันด้วย queue lock การนับ admitted และการ admit อยู่ใน statement เดียวหลัง expire ภายใต้ lock เดียวกัน จึงไม่มี admission ใดดันจำนวนเกิน `max_active` ที่มันอ่าน รอบที่ไม่เปิดมี 0 ที่ (ไม่ admit ใครในรอบที่ลงไม่ได้) admin ลด `max_active` ต่ำกว่าจำนวน admitted ได้ (แก้รอบไม่ถือ queue lock): คนที่ admitted แล้วไม่ถูกเตะออก แต่ไม่มีใครถูก admit เพิ่มจนกว่าจะต่ำกว่าค่าใหม่ (`GREATEST(..., 0)`) invariant ที่รับประกันจึงเป็น "ไม่มี admission ใดทำให้เกิน" ซึ่ง enforce ด้วย lock + statement ที่มีเงื่อนไข ส่วน "1 คน 1 ticket ที่ยังใช้ได้ต่อรอบ" enforce ที่ DB ด้วย partial unique index `queue_tickets_live_ticket_idx` และ ticket เดินหน้าอย่างเดียว (waiting → admitted → expired/done) ด้วย trigger `queue_tickets_forward_only` (ticket ที่จบแล้วกลับมาไม่ได้ เข้าใหม่ = ticket ใหม่ท้ายคิว และ `admitted_at` แก้ไม่ได้หลัง admit จึงยืด TTL ไม่ได้) และ `CHECK` admitted ⇒ มี `admitted_at`
- **ไม่มี deadlock:** queue lock อยู่คนละ key space กับ round lock (bigint ตัวเดียว) และ import lock `(1, 1)` transaction ของคิวถือแค่ lock นี้ตัวเดียว ไม่ถืออะไรก่อน เขียนเฉพาะ `queue_tickets` (ไม่มี writer อื่น) และแตะ `rounds`/`student_profiles` ด้วยการอ่านธรรมดากับ FK check (`FOR KEY SHARE`) เท่านั้น ไม่แตะตารางที่นั่ง จึงไม่เกิดวงรอกับ round/import lock (รายละเอียดใน `round-lock.ts`) ถ้าวันหนึ่งต้องถือทั้งสองแบบ ให้ถือ queue lock ทีหลังสุด
- **Idempotent โดยโครงสร้าง:** ไม่แตะที่นั่ง จึงไม่รับ `idempotency_key` และไม่เขียน `registration_events` (CLAUDE.md กฎข้อ 7): join ซ้ำได้ ticket เดิม (ไม่มีแถวที่สอง), heartbeat ซ้ำแค่เลื่อน `last_seen_at`, done ซ้ำตอบสถานะ `done` เดิม
- **Rate limit (ต่อนักเรียน store ใน memory):** heartbeat + GET รวมกัน 60 ครั้ง/นาที (poll 12–20 ครั้ง/นาที เผื่อสองแท็บและ retry) join + done รวมกัน 20 ครั้ง/นาที แยกจากงบ 30 ครั้ง/นาทีของการลง/เปลี่ยน/ยกเลิก/waitlist การ poll จึงไม่กินงบการเลือกชุมนุม
- **Log:** student id, round id, ผล (`queued`/`already_queued`/`seen`/`released`/`no_live_ticket` หรือรหัส error), สถานะ ticket และจำนวนที่ expire/admit ในคำขอนั้น ไม่ log ชื่อ
- **สำหรับ Q2:** `hasAdmittedTicket(db, { roundId, studentId }, settings)` อ่านอย่างเดียว ไม่ถือ lock ใช้นิยาม "ยังไม่หมดอายุ" เดียวกับ heartbeat (ticket ที่เลยเวลาไม่นับแม้แถวยังเป็น `admitted`) เรียกใน transaction ที่ถือ round lock ได้
- **สิทธิ์ DB:** `club_app` ได้ `SELECT`, `INSERT` และ `UPDATE` เฉพาะ `status`, `last_seen_at`, `admitted_at` ไม่มี `DELETE` (ticket ที่จบอยู่เป็นประวัติ) และแก้ `created_at` (ลำดับคิว) `student_id` `round_id` ไม่ได้ index ใช้ของเดิม (`queue_tickets_admission_idx`) EXPLAIN ANALYZE บนข้อมูลสมมติ 30,000 ticket บนเครื่องพัฒนา (ไม่ใช่สเปค production ไม่มี load พร้อมกัน) ทุก statement ใช้ index และต่ำกว่า 0.5 ms (บันทึกใน `queue.ts`) เป็นตัวเลขประกอบการเลือก index เท่านั้น ยังไม่ใช่ผล load test (O5)
- **Test:** `apps/api/test/queue.test.ts` (admit ทันทีเมื่อมีที่, ลำดับและ position, join ซ้ำ, รอบไม่เปิด/ไม่มีรอบ, หมดอายุแล้วไปท้ายคิว, done แล้วเข้าใหม่, idle expiry, TTL expiry, heartbeat ช้าถูกปฏิเสธเสมอ, heartbeat ไม่มี ticket, รอบปิดไม่ admit, admin ลด `max_active`, done ทุกกรณี, GET ไม่มี side effect, `hasAdmittedTicket`, trigger/CHECK, guard/body/415, rate limit แยกงบ, log ไม่มีชื่อ) และ `queue-concurrency.test.ts` (500 คน join พร้อมกัน `max_active` 30 → admitted 30 พอดี รอ 470 ลำดับ 1..470 ไม่ซ้ำไม่ขาด โดยมี connection แยกสุ่มอ่านจำนวน admitted ตลอดเวลาว่าไม่เกิน 30, คนน้อยกว่า `max_active` ได้ทุกคน, done 10 คนแข่งกับ heartbeat 490 คน → ได้ 10 คนถัดไปตามลำดับคิว, คนเดียวกด join 20 ครั้งพร้อมกันได้ ticket เดียว) ตัวตรวจ invariant `queueInvariantViolations` (`test/support/queue.ts`: 1 ticket ที่ใช้ได้ต่อคนต่อรอบ, `admitted_at` ตรงกับสถานะ, admitted ≤ `max_active`, ไม่มีคนรอที่อยู่หน้าคน admitted, ticket อยู่ในรอบของชั้นตัวเอง) รันหลังทุกเทสต์ เวลาใช้การย้อนแถวใน DB แทนการรอ

**ที่เหลือของ Phase 3**

| งาน | สถานะ |
|---|---|
| Q1 API ของคิว (join/heartbeat/done/GET) | **เสร็จแล้ว** |
| Q2 บังคับ ticket `admitted` ที่ `GET /api/student/clubs` และการลง/เปลี่ยน/เข้ารายชื่อรอ (ใช้ `hasAdmittedTicket`) | ยังไม่ทำ |
| Q3 หน้าเว็บรอคิว (heartbeat ทุก 3–5 วินาที, ปุ่มปล่อยคิว) | ยังไม่ทำ |
| Q4 หน้า admin: จำนวนคนรอ/เข้าแล้วต่อรอบ, แก้ `max_active` ระหว่างรอบเปิด และ `max_active` เป็น NULL ได้ (= ไม่มีคิว) ทั้ง migration และ API | ยังไม่ทำ |
| Q5 E2E (`max_active` = 1: คนที่สองรอจนคนแรกปล่อยคิว) และเอกสาร (README, CLAUDE.md, docs/operations.md) | ยังไม่ทำ |
| Q6 load test บน EC2 พร้อม O5: ปรับ `max_active` (เริ่ม ~150), pool size, `QUEUE_*` | เลื่อนไปพร้อม O5 |

> **ข้อจำกัด:** queue/promote ยังไม่ได้ออกแบบสำหรับหลาย instance ยึดเครื่องเดียวไว้

### Phase 4: ปรับแต่ง

- หน้า "ประวัติของฉัน" (จาก `registration_events`)
- แบนเนอร์ผลลัพธ์ (เช่น "คุณได้ชุมนุม B แล้ว ย้ายจาก C") เพราะไม่มีระบบแจ้งเตือน
- ปรับ UX, (ถ้าต้องการ) teacher login โดยเพิ่ม role `teacher` + `club_advisors.user_id`

## เอกสารเพิ่มเติม

รายละเอียดที่ใช้เฉพาะงานบางเรื่อง แยกไว้ใน `docs/` เพื่อให้ไฟล์นี้อ่านจบได้:

- [docs/excel.md](docs/excel.md): template และกติกา import Excel, export รายชื่อเป็น Excel/PDF
- [docs/security.md](docs/security.md): รหัสผ่าน, session, rate limit, database role ของ api, การแจ้งช่องโหว่
- [docs/operations.md](docs/operations.md): image (O1), compose ของ production (O2), backup/restore (O3), environment variables, ค่าใช้จ่ายและ runbook, dependency audit

## Testing

- **Vitest + Testcontainers** ใช้ Postgres จริง ห้าม mock และต่อด้วย role `club_app` เหมือน api ใน production (`appConnectionUri` ใน `apps/api/test/support/postgres.ts`)
- **`packages/shared`:** เทสต์ schema ตรงๆ (Vitest ไม่ต้องใช้ DB, `packages/shared/test/`) เพราะเป็นด่านแรกที่ตรวจข้อมูลจากภายนอกทุก request และทุกแถวของไฟล์ import: การ normalize (login ID ตัวเล็ก, รหัสชุมนุมตัวใหญ่), strict object ที่ต้องปฏิเสธ field เกิน (`studentId`, `grade` ใน request ที่ไม่ควรมี), ช่วงเวลารอบเทียบเป็นเวลาจริงไม่ใช่ข้อความ, และ cell ของ Excel (ชั้น "ม.1", เลขที่ที่ไม่ใช่จำนวนเต็ม, เบอร์ที่ขาด 0 นำหน้า, อักขระควบคุม) ตรวจแล้วว่าเทสต์จับได้จริงด้วยการแก้ schema ให้ผิด 7 แบบ (ไม่ lower-case, เทียบเวลาเป็นข้อความ, ยอมเวลาเท่ากัน, ไม่บังคับ 0 นำหน้าเบอร์, request ไม่ strict, ปฏิเสธการขึ้นบรรทัดในรายละเอียด, ยอมจุดทศนิยม) ทุกแบบมีเทสต์ล้ม
- **Concurrency test** (ตัวหลัก): 500 request แย่ง 1 ชุมนุม ต้องไม่เกิน capacity และไม่มีลงซ้ำ
- **Invariant check:** `clubs.registered` = จำนวน `registrations` จริง, ไม่มีนักเรียนมี 2 registration
- **E2E (`e2e/`, `pnpm e2e`):** Playwright เปิด Chromium จริงกับ web (vite dev server) + api (จาก source แบบ `NODE_ENV=production` ต่อ DB ด้วย `club_app`) + Postgres ใน container (Testcontainers) ที่ `e2e/global-setup.ts` สร้าง migrate ด้วย CLI จริง (`src/migrate.ts`) ใส่ข้อมูลสมมติ แล้วลบทิ้งหลังรัน เป็นที่เดียวที่ web กับ api รันด้วยกันจริงก่อน deploy ครอบคลุม: ไม่มี session ถูกส่งไป login, นักเรียนเปิดหน้า admin ถูกส่งกลับหน้าของตัวเอง, admin เห็นรอบและชุมนุม, นักเรียนลงชุมนุมแล้วยกเลิก (ตรวจใน DB ด้วยว่า `registered` กลับเป็น 0 และมี event `register` กับ `cancel`), ชุมนุมเต็มไม่มีปุ่มลงแต่มีปุ่มเข้ารายชื่อรอ, นักเรียน A เข้ารายชื่อรอชุมนุมที่นั่งเดียวที่ B ถืออยู่ แล้ว B ยกเลิกในเบราว์เซอร์อีกตัว หน้าของ A ขึ้นข้อความได้ที่จากรายชื่อรอเองจากการ poll โดยไม่โหลดหน้าใหม่ (ตรวจ event `waitlist_join` กับ `waitlist_promote`), ย้ายชุมนุมในขั้นเดียว (ตรวจที่นั่งทั้งสองชุมนุมและ event `register` กับ `change`), admin เพิ่มนักเรียนเข้าชุมนุม ย้ายไปอีกชุมนุม แล้วนำออกจากหน้ารายชื่อ (ตรวจที่นั่งและ event `admin_assign` สองตัวกับ `admin_remove`), admin นำนักเรียนที่เข้ารายชื่อรอเองออกจากรายชื่อรอ (ตรวจว่าไม่มี entry เหลือและ event `waitlist_leave` มี actor เป็น admin), login ครั้งแรกต้องเปลี่ยนรหัสก่อนเข้าหน้าอื่นและรหัสเดิมใช้ไม่ได้อีก ตรวจแล้วว่าจับบั๊กได้ (ปุ่มลงชุมนุมกดได้แม้เต็ม หรือเอาการเช็ก role ออก ทำให้เทสต์ล้ม) port 3910 (api) และ 5910 (web) ไม่ชนกับ `pnpm dev` (เปลี่ยนได้ด้วย `E2E_API_PORT`/`E2E_WEB_PORT`) ไม่อยู่ใน `pnpm test` เพราะต้องมีเบราว์เซอร์ ในเครื่องต้องมี Chromium ของ Playwright 1.63 (`pnpm --filter @club-registration/e2e exec playwright install chromium`) CI รันเป็น job `e2e` ทุก PR และทุก push เข้า `main` โดยติดตั้งเฉพาะ headless shell (`--only-shell`) และรัน `playwright install-deps` เฉพาะเมื่อเบราว์เซอร์เปิดไม่ได้ เพราะ image ของ runner มี library ครบแล้ว (`--with-deps` ทุกรอบเคยใช้เวลากับ apt 9.5 นาที) ถ้าล้มดู log ของ server ใน `e2e/test-results/servers/` และภาพหน้าจอใน `e2e/test-results/artifacts/` (gitignored)
- **Coverage (`pnpm test:coverage`):** `@vitest/coverage-v8` วัดทุกไฟล์ใน `src/` ของ `apps/api`, `apps/web` และ `packages/shared` รวมไฟล์ที่ไม่มีเทสต์ไหน import (นับเป็น 0%) CI job `check` รันตัวนี้แทน `pnpm test` และล้มถ้าต่ำกว่า `coverage.thresholds` ใน vitest config ของ package นั้น thresholds ตั้งไว้ที่ระดับล่าสุดที่วัดได้ (ปัดลง) ให้ขึ้นได้อย่างเดียว เพิ่มเทสต์แล้วปรับขึ้น ห้ามลดเพื่อให้ผ่าน ไฟล์ที่ 0% คือ entry point ที่รันเป็น process แยก ซึ่ง Vitest ไม่ได้วัด (วัดเฉพาะโค้ดใน process ของเทสต์): `server.ts`, `migrate.ts`, `create-admin.ts` รันใน smoke test และ E2E ส่วน `seed-dev.ts`, `generate-template.ts`, `dev/generate-sample-import.ts` เป็นเครื่องมือ dev ส่วน logic หลักที่ไฟล์เหล่านี้เรียก (`createAdmin`, `runMigrations`, `seedDemoAccounts`) มีเทสต์แยก รายงาน HTML อยู่ที่ `<package>/coverage/` (gitignored)
- **Load test** บนสเปคเครื่องจริงก่อนวันใช้งาน (500 virtual users แย่งชุมนุมเดียว)
- **Dry run** กับข้อมูลจำลองก่อนใช้จริง และมีแผน rollback/fallback (เช่น ลงด้วยกระดาษถ้าระบบล่ม)

## รายการที่ยังเปิดอยู่

| # | เรื่อง | Default ถ้ายังไม่ตอบ |
|---|---|---|
| 1 | ~~คนที่มีชุมนุมแล้วเข้า waitlist เพื่อย้ายได้ไหม~~ | **ปิดแล้ว:** ได้ ถูก promote แล้วย้ายแบบ atomic (ที่เดิมว่างและ promote ต่อเป็นทอด) ดู [Phase 2](#phase-2-เปลี่ยนชุมนุม--waitlist--admin-แก้แทน) การตัดสินใจข้อ 1 |
| 2 | Excel template จริงของโรงเรียน | ใช้คอลัมน์ที่เดาไว้ แล้วปรับทีหลัง |
| 3 | Domain สำหรับ HTTPS | รับจาก env (`SITE_ADDRESS` ใน `deploy/production.env` ทำแล้วใน O2) ขั้นตอน DNS อยู่ใน O4 |
| 4 | Elastic IP vs อัปเดต DNS ตอน boot | อัปเดต DNS (ถ้ามี domain) |
| 5 | Queue อยู่ Phase 3 ไหม | Phase 3 (ย้ายขึ้นได้ถ้ากังวลวันจริง) |
| 6 | ~~สร้าง PDF ด้วยอะไร~~ | **ปิดแล้ว:** spike ผ่าน ใช้ `pdfkit` + ฟอนต์ Sarabun (OFL) ฝั่ง server (ดูหัวข้อ [Export รายชื่อ](docs/excel.md#export-รายชื่อ)) |
| 7 | Export รายห้องต้องแยกตามรอบไหม | แยกตามรอบ (1 รอบ = 1 ชั้นอยู่แล้ว) |

**เรื่องที่ค้างจากงานที่ทำแล้ว** (เจอระหว่างรีวิว ไม่ block การใช้งาน Phase 1 ข้อที่ขีดฆ่าแก้แล้วหรือปิดด้วยการตัดสินใจ)

| # | เรื่อง | ผลกระทบ | ทางที่คิดไว้ |
|---|---|---|---|
| 8 | ~~รอบของภาคเรียนเก่ายังเปิดอยู่ตอน import ภาคเรียนใหม่ย้ายชั้นนักเรียน~~ | ~~นักเรียนยังถือที่นั่งในรอบเก่าและยกเลิกเองไม่ได้~~ | **แก้แล้ว:** import ปฏิเสธการย้ายชั้นเมื่อมีที่นั่งในรอบที่ยังไม่ปิดของภาคเรียนอื่น และขั้นยืนยันล็อกรอบเหล่านั้นด้วย (ดู [Excel Import/Export](docs/excel.md#excel-importexport) ข้อ 3) |
| 9 | ~~ออกรหัสผ่านเริ่มต้นพร้อมกับยืนยัน import~~ | ~~deadlock 40P01 admin เห็น 500~~ | **แก้แล้ว:** การออกรหัสผ่านถือ import lock ก่อน row lock ทั้งสองงานจึงทำทีละงาน (ดู [Security](docs/security.md#security)) |
| 10 | ~~เลขหน้า PDF นับต่อทั้งไฟล์~~ | ~~export ทั้งรอบแล้วพิมพ์แยกให้ครูแต่ละคน เลขหน้าจะไม่เริ่มที่ 1~~ | **แก้แล้ว:** นับใหม่ต่อชุมนุม/ห้อง ("หน้า 1/2" ของชุมนุม/ห้องนั้น ดู [Export รายชื่อ](docs/excel.md#export-รายชื่อ)) |
| 11 | ~~export ทั้งรอบที่ไม่มีข้อมูลตอบ `404 nothing_to_export`~~ | ~~แค่ข้อความในหน้าเว็บ~~ | **ปิดแล้ว:** คง 404 ตามที่ตั้งใจ |
| 12 | ~~ปุ่ม "ลองอีกครั้ง" ของนักเรียนใช้ idempotency key เดิมกับ 5xx ด้วย (ไม่ใช่แค่ network error)~~ | ~~ปลอดภัย เพราะ 500 ของ API rollback แล้ว และ 502/504 จาก proxy ก็ไม่รู้ผลเหมือนกัน~~ | **ปิดแล้ว:** คงไว้ตามที่ตั้งใจ |
| 13 | ~~เก็บกวาดหน้าเว็บ~~ | ~~ไม่กระทบการทำงาน~~ | **แก้แล้ว:** helper แสดงรอบอยู่ที่ `apps/web/src/lib/round-display.ts`, focus กลับปุ่มยกเลิก (หรือข้อความผลเมื่อยกเลิกสำเร็จ) และกล่องยืนยันปิดด้วย Escape ได้, ไม่แสดงปุ่ม "ลงชุมนุม" เมื่อมีชุมนุมแล้ว, `/admin/clubs` เลือกรอบให้เองและเริ่ม poll ตอนรอบเปิดด้วยตัวตั้งเวลาเดียวกับหน้านักเรียน (`lib/round-refetch.ts`) |
| 14 | ~~bundle JS ของหน้าเว็บ ~566 kB (Vite เตือนเกิน 500 kB)~~ | ~~โหลดครั้งแรกช้าบนมือถือเน็ตช้า~~ | **แก้แล้ว:** หน้าเมนูทุกหน้าโหลดแยก chunk ด้วย `React.lazy` หลังผ่าน `RequireSession` (นักเรียนไม่โหลดหน้า admin และกลับกัน) และ React แยก chunk ที่ cache ข้าม deploy ได้ entry เหลือ 279 kB (gzip 84) + React 219 kB (gzip 68) โหลดคู่กัน chunk ที่หาย (deploy ทับ) ขึ้นข้อความพร้อมปุ่มโหลดหน้าใหม่ (`apps/web/src/components/PageOutlet.tsx`) |
| 15 | arm64 ยังไม่เคย build/รันจริง | CI build แค่ amd64 ส่วน t4g เป็น arm64 | ตรวจตอน O4: build บนเครื่องจริงแล้วรัน smoke |
| 16 | Caddy เขียนทับ `X-Forwarded-For` เสมอ (ถือว่าตัวเองเป็นด่านแรก ไม่ได้ตั้ง `trusted_proxies`) | ถ้า deploy หลัง load balancer ของ platform (ALB, PaaS) api จะเห็น IP ของ LB แทนนักเรียนทุกคน rate limit ของ login (ต่อ IP และ IP + รหัสผู้ใช้) จะนับทุกคนรวมเป็นก้อนเดียว วันจริงอาจโดน `429` กันทั้งโรงเรียน (EC2 เครื่องเดียวที่ Caddy รับตรงจาก internet ไม่มีปัญหานี้) | ตอน deploy หลัง LB: ตั้ง `trusted_proxies` ของ Caddy เป็นช่วง IP ของ LB ของ platform นั้น และให้ api เชื่อ `X-Forwarded-For` ตามจำนวน hop หรือช่วง IP ของ proxy (Fastify `trustProxy` ตอนนี้ `TRUST_PROXY` เป็นแค่ `true`/`false` ซึ่งเอาค่าซ้ายสุด และ LB ส่วนใหญ่ต่อท้าย header ที่ client ส่งมาแทนการเขียนทับ ค่าซ้ายสุดจึงปลอมได้) แล้วทดสอบว่าปลอม IP ไม่ได้ **ยังไม่ตัดสิน deploy target:** คง image `web` (Caddy) ไว้ หรือรวมเป็น image เดียวให้ Fastify เสิร์ฟไฟล์ static ตัดสินเมื่อรู้ว่าจะ deploy ที่ไหน |
| 17 | ~~admin เปิดรอบที่ปิดแล้วอีกครั้ง (แก้ `closes_at`) ไม่ promote~~ | ~~ถ้าหลังปิดรอบ admin เพิ่มจำนวนรับแล้วเปิดรอบนั้นใหม่ จะมีชุมนุมที่มีทั้งที่ว่างและคนรอในรอบที่เปิด การลงตรงได้ `club_full`~~ | **แก้แล้ว:** การแก้รอบถือ import lock → round lock → `UPDATE rounds` แล้ว promote ใน transaction เดียว (ดู PR 2b ในหัวข้อ waitlist) |
| 18 | ~~รอบที่ยังไม่เปิดถึงเวลาเปิดเองโดยมีทั้งที่ว่างและคนรอ~~ | ~~คนรอมีได้เฉพาะในรอบที่เคยเปิดแล้ว ถ้า admin เลื่อนรอบนั้นกลับเป็นยังไม่เปิด (`opens_at` ในอนาคต) แล้วเพิ่มจำนวนรับ (engine ไม่ promote ในรอบที่ยังไม่เปิด) พอถึง `opens_at` รอบจะเปิดเองโดยไม่มี write ใดเรียก engine การลงตรงได้ `club_full` (เข้าคิวได้) จนกว่าจะมีคนยกเลิก/เปลี่ยน หรือ admin แก้รอบ/จำนวนรับของรอบนั้นอีกครั้งหลังรอบเปิด~~ | **แก้แล้ว:** engine promote จนกว่ารอบจะปิด (ยังไม่เปิดก็ promote) ตามกติกา waitlist ข้อ 6 การเพิ่มจำนวนรับ (แก้ชุมนุมหรือยืนยัน import) และการแก้รอบในรอบที่ยังไม่เปิดจึงส่งที่นั่งให้คนรอทันที ตอนถึง `opens_at` รอบจึงไม่มีชุมนุมที่มีทั้งที่ว่างและคนรอ นักเรียนยังลง/ยกเลิก/เข้า-ออกคิวในรอบที่ยังไม่เปิดไม่ได้เหมือนเดิม (ดู PR 2b ในหัวข้อ waitlist) |
| 19 | ~~entry ค้างใน waitlist ของรอบที่ปิดแล้ว~~ | ~~หลังปิดรอบไม่มีใครถูก promote entry จึงค้างอยู่ (นักเรียนออกเองก็ไม่ได้เพราะรอบปิด) ไม่กระทบที่นั่งหรือ export แต่รายชื่อรอยังแสดงคนเหล่านี้ และ import ภาคเรียนเดียวกันเปลี่ยนชั้นนักเรียนคนนั้นไม่ได้~~ | **แก้แล้ว (PR 3b):** admin ลบ entry ได้ด้วย `POST /api/admin/clubs/:id/waitlist/remove` ในรอบทุกสถานะ (event `waitlist_leave` actor = admin) หรือเพิ่มนักเรียนเข้าชุมนุมที่รอ (PR 3a ลบ entry ให้) |

## ขั้นตอนถัดไป

**เลื่อนไว้จนกว่าจะมีเครื่อง EC2** (Phase 1 ข้อ 8 ที่เหลือ ตัดสินใจทำงานบน local ไปก่อน):

- **O4 runbook EC2 + DNS:** สร้างเครื่อง t4g.small, IAM role + bucket จริง, ติดตั้ง Docker และ AWS CLI, swap หรือ build เฉพาะตอนไม่มีรอบเปิด (RAM 2 GB), อัปเดต DNS ตอน boot, ตั้งเวลา `scripts/backup.sh` (systemd timer/cron) พร้อมแจ้งเตือนเมื่อล้ม
- **O5 load test** บนสเปคเครื่องจริง: ตัดสิน `DB_POOL_MAX`, timeout, memory limit และค่า Postgres และตัดสินว่าต้องดึง queue (Phase 3) ขึ้นมาก่อนไหม (รวมเวลาที่การลงทะเบียนต้องรอ import commit ของไฟล์ 2,500 คน)

**ทำบน local ตามลำดับ:**

1. ~~แก้ข้อ 13–14 ใน [รายการที่ยังเปิดอยู่](#รายการที่ยังเปิดอยู่) (หน้าเว็บ)~~ เสร็จแล้ว
2. ทดสอบทั้งระบบด้วยมือตาม checklist บนเครื่อง arm64 (ปิดข้อ 15)
3. เริ่ม **Phase 2** แล้ว (เปลี่ยนชุมนุมแบบ atomic, API waitlist ของนักเรียน, promote หลัง admin แก้ชุมนุม/import (PR 2b) API ของ admin เพิ่ม/ย้าย/ลบแทน (PR 3a) API ของ admin ดู/ลบรายชื่อรอและดู event log (PR 3b) หน้าเว็บนักเรียนของการย้ายชุมนุมและ waitlist (PR 4) หน้าเว็บ admin ดู/แก้รายชื่อสมาชิกและรายชื่อรอ (PR 5a) หน้าเว็บ admin ดูประวัติการลงทะเบียน (PR 5b) และเรื่องที่ค้างจาก PR 4 สองเรื่อง (PR 5c) เสร็จ งานหน้าเว็บของ Phase 2 ครบแล้ว) ทั้งที่ Phase 1 ยังเหลือ O4/O5 เพราะสองข้อนั้นต้องใช้เครื่องจริง Phase 2 ไม่ได้พึ่ง O4/O5 แต่ต้องรัน O5 ซ้ำหลัง Phase 2 เพราะการเลื่อนคิวทำให้ transaction ในรอบยาวขึ้น

## License

โค้ดใน repo นี้ใช้ [MIT License](LICENSE) ยกเว้นฟอนต์ Sarabun ใน `apps/api/assets/fonts/` ซึ่งใช้ SIL Open Font License 1.1 ตาม [`OFL.txt`](apps/api/assets/fonts/OFL.txt) ที่อยู่คู่กัน และ dependency จาก npm ซึ่งใช้ license ของแต่ละ package
