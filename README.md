# club-registration

ระบบลงทะเบียนชุมนุมของโรงเรียน สำหรับนักเรียน ~2,500 คน แบ่งรอบตามชั้น ม.1–ม.6 รอบละ ~400–450 คน

> **สถานะ:** Phase 1 ฟีเจอร์ครบแล้ว (admin: รอบ, import Excel, รหัสผ่านเริ่มต้น, ชุมนุม, export Excel/PDF; นักเรียน: ดูชุมนุม, ลง/ยกเลิก พร้อม concurrency test 500 request) งาน Ops ทำ image, compose production + HTTPS และ backup/restore เสร็จแล้ว เหลือ runbook EC2 + DNS แล้ว load test บนเครื่องจริง ดู [Roadmap](#roadmap) และ [รายการที่ยังเปิดอยู่](#รายการที่ยังเปิดอยู่)
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
waitlist_entries    -- UNIQUE(round_id, student_id), เรียงตาม created_at
queue_tickets       -- status: waiting | admitted | expired | done
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
3. ~~**Admin จัดการรอบ:** สร้างรอบต่อชั้น กำหนด `opens_at`/`closes_at`~~ เสร็จแล้ว (สร้างทีละชั้นหรือครบ ม.1–ม.6, แก้เวลา/`max_active`, ลบรอบที่ยังไม่มีชุมนุม, สถานะคำนวณตอนอ่าน) และ**หน้าชุมนุมรายรอบ**เสร็จแล้ว:
   - `GET /api/admin/rounds/:roundId/clubs` คืนรอบ (สถานะ + ยอดรวม) และชุมนุมเรียงตามรหัส: ชื่อ, รายละเอียด, จำนวนรับ, ลงแล้ว, เหลือ, ครู (รวมเบอร์/อีเมล/LINE เฉพาะ admin และไม่ log)
   - `PATCH /api/admin/clubs/:id` แก้ได้เฉพาะชื่อ รายละเอียด จำนวนรับ (รหัสชุมนุมและ `registered` แก้ไม่ได้) ลดจำนวนรับต่ำกว่าที่ลงแล้ว → `409 capacity_below_registered` ซึ่งมาจาก `CHECK` ของ DB ไม่ใช่การเช็คใน app (ใน transaction ที่เริ่มด้วย `pg_advisory_xact_lock(round_id)` ของรอบชุมนุมนั้นเหมือนการลง/ยกเลิก จึงรอการลงที่กำลังทำอยู่ให้ commit ก่อน แล้ว UPDATE เดียวที่ `CHECK` ตัดสินด้วยค่าล่าสุดเสมอ) เพิ่มจำนวนรับระหว่างรอบเปิดได้ (Phase 2 ต้อง promote waitlist ใน transaction เดียวกัน) ไม่รับ `idempotency_key` เหมือน endpoint ของรอบ เพราะส่งซ้ำได้ผลเดิม
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
   - **หน้าเว็บ (S3, `apps/web/src/pages/student/`):** `/student/clubs` มีหัวรอบ (ภาคเรียน ชั้น สถานะ เวลาเปิด/ปิดเป็นเวลาไทย) ชุมนุมที่ลงไว้แสดงเด่นด้านบนพร้อมลิงก์ไปหน้าผลของฉัน รายการเป็นการ์ดเรียงลงมา (นักเรียนส่วนใหญ่ใช้มือถือ) มีรหัส ชื่อ ชื่อครู ที่เหลือ/จำนวนรับ ป้าย "เต็ม" และรายละเอียดเป็นข้อความล้วนที่คงการขึ้นบรรทัด ปุ่มลงกดได้เฉพาะรอบเปิดและชุมนุมยังไม่เต็ม และไม่แสดงเลยเมื่อมีชุมนุมแล้ว (การ์ดชุมนุมของฉันด้านบนบอกวิธีเปลี่ยนอยู่แล้ว) กดแล้วขึ้นกล่องยืนยันในการ์ดนั้นก่อนส่ง (ปิดด้วย Escape ได้ และ focus กลับไปที่ปุ่มที่กด) `/student/my-registration` แสดงชุมนุมที่ลงและเวลาที่ลง หรือ "ยังไม่ได้ลงชุมนุม" พร้อมลิงก์ไปหน้ารายการ ปุ่มยกเลิกมีเฉพาะตอนรอบเปิด และกล่องยืนยันเตือนว่าที่นั่งอาจมีคนอื่นลงแทน ปิดกล่องแล้ว focus กลับไปที่ปุ่มยกเลิก ถ้ายกเลิกสำเร็จ (ปุ่มหายไป) focus ไปที่ข้อความผลซึ่งมีลิงก์ไปเลือกชุมนุมใหม่ ทุก error code มีข้อความไทย (`club_full`, `already_registered`, `round_not_open`, `not_registered`, `idempotency_key_reused`, `rate_limited`, `not_found`, `student_profile_missing`)
   - **Idempotency ฝั่งเว็บ:** สร้าง key ใหม่ (`crypto.randomUUID()`) ทุกครั้งที่กดยืนยัน ถ้าไม่รู้ผล (ไม่ได้คำตอบจาก server เพราะเน็ตหลุด, ได้ 5xx หรือคำตอบอ่านไม่ได้) ปุ่ม "ลองอีกครั้ง" ส่งคำขอเดิมด้วย key เดิม server จึงตอบซ้ำแทนการทำสองครั้ง คำตอบ 4xx ถือว่าจบแล้ว กดใหม่ได้ key ใหม่ ปุ่มทั้งหมดปิดระหว่างรอคำตอบ และทุกคำตอบ (สำเร็จหรือไม่) โหลดข้อมูลทั้งสองหน้าใหม่
   - **Polling:** หน้ารายการ poll ทุก 5 วินาทีเฉพาะรอบเปิด รอบที่ยังไม่เปิดตั้งเวลาโหลดใหม่ตอนถึง `opens_at` ตามนาฬิกาเครื่อง (ห่างไม่เกิน 30 วินาทีเผื่อนาฬิกาช้า ไม่ถี่กว่า 2 วินาทีเผื่อนาฬิกาเร็ว และสุ่มเพิ่มไม่เกิน 1 วินาทีให้ทั้งชั้นไม่ยิงพร้อมกัน) หน้าจึงเปลี่ยนเป็นเปิดเองโดยไม่ต้องโหลดหน้าใหม่ รอบที่ปิดแล้วไม่ poll หน้าผลของฉันใช้ตัวตั้งเวลาเดียวกันทั้งตอนเปิดและปิดรอบ สถานะที่ใช้ตัดสินมาจาก server เสมอ (ตัวตั้งเวลาอยู่ที่ `apps/web/src/lib/round-refetch.ts` ใช้ร่วมกับหน้า `/admin/clubs`)
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

**Locking:** ทุก write transaction ในรอบเริ่มด้วย `SELECT pg_advisory_xact_lock($round_id)` → serialize ต่อรอบ ไม่มี deadlock และ logic ง่าย (แลกกับการไม่ขนานข้ามชุมนุม ซึ่งที่ ~450 คนต่อรอบน่าจะรับได้ ต้อง load test) **ใช้ตั้งแต่ Phase 1 แล้ว** กับการลง/ยกเลิก admin แก้ชุมนุม และขั้นยืนยัน import (ถือทุกรอบของภาคเรียนและรอบที่ยังไม่ปิดของภาคเรียนอื่น เรียง id ต่อจาก import lock) (`apps/api/src/services/round-lock.ts`) endpoint ของ Phase 2 ต้องใช้ helper เดียวกัน ถ้าต้องถือหลายรอบต้องล็อกเรียง id และให้ได้ครบก่อนแตะแถวใด ไม่อย่างนั้นอาจเกิด deadlock กับ import

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
- **E2E (`e2e/`, `pnpm e2e`):** Playwright เปิด Chromium จริงกับ web (vite dev server) + api (จาก source แบบ `NODE_ENV=production` ต่อ DB ด้วย `club_app`) + Postgres ใน container (Testcontainers) ที่ `e2e/global-setup.ts` สร้าง migrate ด้วย CLI จริง (`src/migrate.ts`) ใส่ข้อมูลสมมติ แล้วลบทิ้งหลังรัน เป็นที่เดียวที่ web กับ api รันด้วยกันจริงก่อน deploy ครอบคลุม: ไม่มี session ถูกส่งไป login, นักเรียนเปิดหน้า admin ถูกส่งกลับหน้าของตัวเอง, admin เห็นรอบและชุมนุม, นักเรียนลงชุมนุมแล้วยกเลิก (ตรวจใน DB ด้วยว่า `registered` กลับเป็น 0 และมี event `register` กับ `cancel`), ชุมนุมเต็มกดไม่ได้, login ครั้งแรกต้องเปลี่ยนรหัสก่อนเข้าหน้าอื่นและรหัสเดิมใช้ไม่ได้อีก ตรวจแล้วว่าจับบั๊กได้ (ปุ่มลงชุมนุมกดได้แม้เต็ม หรือเอาการเช็ก role ออก ทำให้เทสต์ล้ม) port 3910 (api) และ 5910 (web) ไม่ชนกับ `pnpm dev` (เปลี่ยนได้ด้วย `E2E_API_PORT`/`E2E_WEB_PORT`) ไม่อยู่ใน `pnpm test` เพราะต้องมีเบราว์เซอร์ ในเครื่องต้องมี Chromium ของ Playwright 1.63 (`pnpm --filter @club-registration/e2e exec playwright install chromium`) CI รันเป็น job `e2e` ทุก PR และทุก push เข้า `main` โดยติดตั้งเฉพาะ headless shell (`--only-shell`) และรัน `playwright install-deps` เฉพาะเมื่อเบราว์เซอร์เปิดไม่ได้ เพราะ image ของ runner มี library ครบแล้ว (`--with-deps` ทุกรอบเคยใช้เวลากับ apt 9.5 นาที) ถ้าล้มดู log ของ server ใน `e2e/test-results/servers/` และภาพหน้าจอใน `e2e/test-results/artifacts/` (gitignored)
- **Coverage (`pnpm test:coverage`):** `@vitest/coverage-v8` วัดทุกไฟล์ใน `src/` ของ `apps/api`, `apps/web` และ `packages/shared` รวมไฟล์ที่ไม่มีเทสต์ไหน import (นับเป็น 0%) CI job `check` รันตัวนี้แทน `pnpm test` และล้มถ้าต่ำกว่า `coverage.thresholds` ใน vitest config ของ package นั้น thresholds ตั้งไว้ที่ระดับล่าสุดที่วัดได้ (ปัดลง) ให้ขึ้นได้อย่างเดียว เพิ่มเทสต์แล้วปรับขึ้น ห้ามลดเพื่อให้ผ่าน ไฟล์ที่ 0% คือ entry point ที่รันเป็น process แยก ซึ่ง Vitest ไม่ได้วัด (วัดเฉพาะโค้ดใน process ของเทสต์): `server.ts`, `migrate.ts`, `create-admin.ts` รันใน smoke test และ E2E ส่วน `seed-dev.ts`, `generate-template.ts`, `dev/generate-sample-import.ts` เป็นเครื่องมือ dev ส่วน logic หลักที่ไฟล์เหล่านี้เรียก (`createAdmin`, `runMigrations`, `seedDemoAccounts`) มีเทสต์แยก รายงาน HTML อยู่ที่ `<package>/coverage/` (gitignored)
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

## ขั้นตอนถัดไป

**เลื่อนไว้จนกว่าจะมีเครื่อง EC2** (Phase 1 ข้อ 8 ที่เหลือ ตัดสินใจทำงานบน local ไปก่อน):

- **O4 runbook EC2 + DNS:** สร้างเครื่อง t4g.small, IAM role + bucket จริง, ติดตั้ง Docker และ AWS CLI, swap หรือ build เฉพาะตอนไม่มีรอบเปิด (RAM 2 GB), อัปเดต DNS ตอน boot, ตั้งเวลา `scripts/backup.sh` (systemd timer/cron) พร้อมแจ้งเตือนเมื่อล้ม
- **O5 load test** บนสเปคเครื่องจริง: ตัดสิน `DB_POOL_MAX`, timeout, memory limit และค่า Postgres และตัดสินว่าต้องดึง queue (Phase 3) ขึ้นมาก่อนไหม (รวมเวลาที่การลงทะเบียนต้องรอ import commit ของไฟล์ 2,500 คน)

**ทำบน local ตามลำดับ:**

1. ~~แก้ข้อ 13–14 ใน [รายการที่ยังเปิดอยู่](#รายการที่ยังเปิดอยู่) (หน้าเว็บ)~~ เสร็จแล้ว
2. ทดสอบทั้งระบบด้วยมือตาม checklist บนเครื่อง arm64 (ปิดข้อ 15)
3. เริ่ม **Phase 2** (เปลี่ยนชุมนุม + waitlist + admin แก้แทน) ทั้งที่ Phase 1 ยังเหลือ O4/O5 เพราะสองข้อนั้นต้องใช้เครื่องจริง Phase 2 ไม่ได้พึ่ง O4/O5 แต่ต้องรัน O5 ซ้ำหลัง Phase 2 เพราะการเลื่อนคิวทำให้ transaction ในรอบยาวขึ้น

## License

โค้ดใน repo นี้ใช้ [MIT License](LICENSE) ยกเว้นฟอนต์ Sarabun ใน `apps/api/assets/fonts/` ซึ่งใช้ SIL Open Font License 1.1 ตาม [`OFL.txt`](apps/api/assets/fonts/OFL.txt) ที่อยู่คู่กัน และ dependency จาก npm ซึ่งใช้ license ของแต่ละ package
