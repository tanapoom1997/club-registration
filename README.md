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
2. ~~**Admin import Excel:** students, clubs, advisors → dry run → ยืนยัน → upsert ใน transaction เดียว~~ เสร็จแล้ว รวมขั้นออกรหัสผ่านเริ่มต้นให้นักเรียนที่นำเข้า (ดูหัวข้อ [Security](#security)) ขั้นยืนยันถือ round lock ทุกรอบของภาคเรียนและทุกรอบของภาคเรียนอื่นที่ยังไม่ปิด จึงไม่แข่งกับการลง/ยกเลิก (ดู [Excel Import/Export](#excel-importexport) ข้อ 3 และเทสต์ `apps/api/test/import-commit-round-locks.test.ts`)
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
   - **Lock:** ทุก transaction ลง/ยกเลิกเริ่มด้วย `pg_advisory_xact_lock(round_id)` (แบบ bigint ตัวเดียว ซึ่งเป็นคนละ key space กับ `pg_advisory_xact_lock(1, 1)` แบบ int4 สองตัวของ import จึงไม่ชนกัน) ขั้นยืนยัน import ก็ถือ round lock ทุกรอบของภาคเรียนตัวเองและทุกรอบของภาคเรียนอื่นที่ยังไม่ปิดด้วย (ดู [Excel Import/Export](#excel-importexport) ข้อ 3) การลงในรอบที่ยังไม่ปิดจึงเรียงกับ import ด้วย lock ของรอบ และล็อกแถว `student_profiles` ของตัวเองแบบ `FOR SHARE` ก่อน INSERT เพื่อไม่ให้ import ที่กำลังย้ายชั้นนักเรียนคนนั้นแทรกกลาง
   - **Rate limit:** 30 ครั้ง/นาที ต่อนักเรียน นับรวมการลงและยกเลิก (คลิกจริงไม่กี่ครั้งบวก retry อัตโนมัติ) store ใน memory ตามเครื่องเดียว นับเฉพาะ request ที่ผ่าน guard และ validation แล้ว
   - **Log:** เฉพาะ student id, round id, club id และผล (`registered`/`already_held`/`replayed`/`cancelled` หรือรหัส error) ไม่ log ชื่อนักเรียน ชุมนุม หรือครู
   - logic เป็นฟังก์ชันที่รับ DB client ของ transaction (`registerForClub`, `cancelRegistration`) route เป็นคนเปิด transaction Phase 2 จึงประกอบหลายขั้นใน transaction เดียวได้
   - **หน้าเว็บ (S3, `apps/web/src/pages/student/`):** `/student/clubs` มีหัวรอบ (ภาคเรียน ชั้น สถานะ เวลาเปิด/ปิดเป็นเวลาไทย) ชุมนุมที่ลงไว้แสดงเด่นด้านบนพร้อมลิงก์ไปหน้าผลของฉัน รายการเป็นการ์ดเรียงลงมา (นักเรียนส่วนใหญ่ใช้มือถือ) มีรหัส ชื่อ ชื่อครู ที่เหลือ/จำนวนรับ ป้าย "เต็ม" และรายละเอียดเป็นข้อความล้วนที่คงการขึ้นบรรทัด ปุ่มลงกดได้เฉพาะรอบเปิดและชุมนุมยังไม่เต็ม และไม่แสดงเลยเมื่อมีชุมนุมแล้ว (การ์ดชุมนุมของฉันด้านบนบอกวิธีเปลี่ยนอยู่แล้ว) กดแล้วขึ้นกล่องยืนยันในการ์ดนั้นก่อนส่ง (ปิดด้วย Escape ได้ และ focus กลับไปที่ปุ่มที่กด) `/student/my-registration` แสดงชุมนุมที่ลงและเวลาที่ลง หรือ "ยังไม่ได้ลงชุมนุม" พร้อมลิงก์ไปหน้ารายการ ปุ่มยกเลิกมีเฉพาะตอนรอบเปิด และกล่องยืนยันเตือนว่าที่นั่งอาจมีคนอื่นลงแทน ปิดกล่องแล้ว focus กลับไปที่ปุ่มยกเลิก ถ้ายกเลิกสำเร็จ (ปุ่มหายไป) focus ไปที่ข้อความผลซึ่งมีลิงก์ไปเลือกชุมนุมใหม่ ทุก error code มีข้อความไทย (`club_full`, `already_registered`, `round_not_open`, `not_registered`, `idempotency_key_reused`, `rate_limited`, `not_found`, `student_profile_missing`)
   - **Idempotency ฝั่งเว็บ:** สร้าง key ใหม่ (`crypto.randomUUID()`) ทุกครั้งที่กดยืนยัน ถ้าไม่รู้ผล (ไม่ได้คำตอบจาก server เพราะเน็ตหลุด, ได้ 5xx หรือคำตอบอ่านไม่ได้) ปุ่ม "ลองอีกครั้ง" ส่งคำขอเดิมด้วย key เดิม server จึงตอบซ้ำแทนการทำสองครั้ง คำตอบ 4xx ถือว่าจบแล้ว กดใหม่ได้ key ใหม่ ปุ่มทั้งหมดปิดระหว่างรอคำตอบ และทุกคำตอบ (สำเร็จหรือไม่) โหลดข้อมูลทั้งสองหน้าใหม่
   - **Polling:** หน้ารายการ poll ทุก 5 วินาทีเฉพาะรอบเปิด รอบที่ยังไม่เปิดตั้งเวลาโหลดใหม่ตอนถึง `opens_at` ตามนาฬิกาเครื่อง (ห่างไม่เกิน 30 วินาทีเผื่อนาฬิกาช้า ไม่ถี่กว่า 2 วินาทีเผื่อนาฬิกาเร็ว และสุ่มเพิ่มไม่เกิน 1 วินาทีให้ทั้งชั้นไม่ยิงพร้อมกัน) หน้าจึงเปลี่ยนเป็นเปิดเองโดยไม่ต้องโหลดหน้าใหม่ รอบที่ปิดแล้วไม่ poll หน้าผลของฉันใช้ตัวตั้งเวลาเดียวกันทั้งตอนเปิดและปิดรอบ สถานะที่ใช้ตัดสินมาจาก server เสมอ (ตัวตั้งเวลาอยู่ที่ `apps/web/src/lib/round-refetch.ts` ใช้ร่วมกับหน้า `/admin/clubs`)
5. ~~**กติกาที่ DB:** 1 คน 1 ชุมนุม, ห้ามเกิน capacity, เฉพาะชั้นตัวเอง, เฉพาะช่วงเปิดรอบ~~ เสร็จแล้ว (S2): `UNIQUE(round_id, student_id)`, `CHECK` + `UPDATE ... WHERE registered < capacity`, ชั้นและช่วงเปิดเป็นเงื่อนไขของ `INSERT ... SELECT`/`DELETE` ตามนาฬิกา DB
6. ~~**Idempotency + event log**~~ เสร็จแล้ว (S2): ทุกการลง/ยกเลิกเขียน `registration_events` พร้อม `idempotency_key` ใน transaction เดียวกัน (ตาราง append-only ด้วย trigger)
7. **Admin export:** รายชื่อแบบ **รายชุมนุม** และ **รายห้อง** เลือกได้ทั้ง **Excel** และ **PDF** (รายละเอียดดูหัวข้อ [Export รายชื่อ](#export-รายชื่อ)) ทั้ง Excel (A6a) และ PDF (A6b) **เสร็จแล้ว**
8. **Ops:** Dockerfile, `docker-compose.yml`, Caddy HTTPS, `/api/health`, migration script แยก, graceful shutdown, backup `pg_dump` ไป S3, runbook (deploy/backup/restore/เปิด-ปิดเครื่อง) แบ่งเป็น O1 image → O2 compose production + Caddy HTTPS/limits → O3 backup/restore → O4 runbook EC2 → O5 load test
   - ~~**O1 image**~~ เสร็จแล้ว: `Dockerfile` (target `api`, `web`), `Caddyfile`, `.dockerignore`, `scripts/smoke-images.sh` และ CI job `images` รายละเอียดดู [Infra และ Deployment](#infra-และ-deployment)
   - ~~**O2 compose production**~~ เสร็จแล้ว: `compose.prod.yml` (postgres, migrate, api, web พร้อม healthcheck, memory limit, log rotation, network แยก), `deploy/production.env.example`, Caddy HTTPS + HSTS + จำกัดขนาด body, ตั้ง pool/timeout ของ DB ผ่าน env (`DB_*`), `scripts/smoke-compose.sh` ใน CI job `images` รายละเอียดดู [Compose ของ production (O2)](#compose-ของ-production-o2)
   - ~~**O3 backup/restore**~~ เสร็จแล้ว: `scripts/backup.sh` (`pg_dump` custom format ใน container → ตรวจทั้งไฟล์ → S3 ด้วย SSE-S3 ผ่าน AWS CLI ของ host, ไฟล์ในเครื่อง 600, `flock` กันรันซ้อน, `--local-only`, `--include-certs`), `scripts/restore.sh` (ต้อง `--yes`, กู้ลง DB ใหม่แล้วสลับชื่อใน transaction เดียว → migrate → รอ healthy, `--target-db` ซ้อมกู้โดยไม่แตะ production, `--certs`), ตัวอย่าง IAM policy (ไม่มีสิทธิ์ลบ) และ lifecycle ใน `deploy/`, `scripts/smoke-backup.sh` (MinIO) ใน CI job `images` รายละเอียดดู [Backup และ Restore (O3)](#backup-และ-restore-o3)
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
3. ยืนยัน → ส่งไฟล์เดิมซ้ำพร้อม sha256 ที่ได้จากขั้นตรวจ (server ไม่เก็บไฟล์ไว้ระหว่างสองขั้น ถ้า hash ไม่ตรง = `409 import_file_mismatch`) → ตรวจและเทียบกับ DB ใหม่ แล้วเขียนทั้งหมดใน transaction เดียว (error แถวเดียว = `422 import_invalid` ไม่เขียนเลย) การยืนยันทำได้ทีละครั้งทั้งระบบ (`pg_advisory_xact_lock(1, 1)` ซึ่งการออกรหัสผ่านเริ่มต้นก็ถือด้วย ดู [Security](#security)) และต่อจากนั้นทันที ก่อนตรวจหรืออ่านอะไร จะถือ `pg_advisory_xact_lock(round_id)` ของ**ทุกรอบในภาคเรียนนั้นและทุกรอบของภาคเรียนอื่นที่ยังไม่ปิด** (เปิดอยู่หรือยังไม่เปิด ตามนาฬิกา DB) เรียง id จากน้อยไปมาก (`lockRoundsForImport` ใน `apps/api/src/services/round-lock.ts`) ตามกฎข้อ 3 ของ CLAUDE.md เพราะ import แก้จำนวนรับของชุมนุมในรอบ และชั้นของนักเรียนตัดสินว่าลงรอบไหนได้ ก่อนล็อกรอบจะล็อกแถว `rounds` ทุกแถวแบบ `FOR SHARE` ด้วย ระหว่างยืนยัน import จึงไม่มีใครแก้ช่วงเวลาของรอบ (เช่นเปิดรอบเก่าที่ปิดแล้วอีกครั้ง) ได้ การแก้/ลบรอบที่ส่งมาตอนนั้นจะรอจน import commit
   - **ทำไมต้องล็อกรอบ:** ถ้าไม่ล็อก (READ COMMITTED) นักเรียนอาจลงชุมนุมและ commit ระหว่างที่ import อ่านว่าใครลงแล้วกับตอนที่ย้ายชั้น ผลคือนักเรียนถูกย้ายไปชั้นอื่นทั้งที่ยังถือที่นั่งในรอบของชั้นเดิม เมื่อล็อกแล้ว การลงในรอบที่ import ล็อกไว้จะ commit ก่อน import อ่าน (import จึงปฏิเสธการย้ายชั้นด้วย error ของแถวนั้น) หรือรอจน import commit (แล้วเจอนักเรียนในชั้นใหม่ ได้ `404 not_found` ตามกติกา S2) เท่านั้น
   - **ไม่มี deadlock:** ลง/ยกเลิก/admin แก้ชุมนุมถือ round lock แค่ตัวเดียว import เป็น writer เดียวที่ถือหลายตัว และได้ครบตามลำดับเดียว (import lock → แถว `rounds` แบบ `FOR SHARE` → รอบเรียง id) ก่อนแตะแถวอื่นใด (เหตุผลเต็มอยู่ใน `round-lock.ts`) รอบที่สร้างในภาคเรียนหลังจาก import ล็อกไปแล้วไม่ต้องล็อก เพราะรอบใหม่ยังไม่มีชุมนุม และมีแค่ import (ซึ่งทำทีละครั้ง) ที่สร้างชุมนุมได้
   - **ผลต่อวันจริง:** ระหว่างยืนยัน import การลง/ยกเลิกในรอบที่ import ล็อกไว้ (ภาคเรียนนั้น และรอบที่ยังไม่ปิดของภาคเรียนอื่น) การแก้/ลบรอบ และการออกรหัสผ่านเริ่มต้นจะรอจน import commit (ยังไม่ได้วัดว่านานเท่าไรกับไฟล์ 2,500 คน ต้องวัดตอน load test) ควรยืนยัน import ก่อนเปิดรอบ ส่วน dry run ไม่ถือ lock ใดๆ (อ่านใน snapshot READ ONLY) จึงไม่ทำให้ใครรอ
   - **การลงในภาคเรียนอื่น:** ย้ายชั้นไม่ได้ถ้านักเรียนมีที่นั่งในรอบของภาคเรียนที่ import (ปิดแล้วหรือไม่ก็ตาม) หรือในรอบของภาคเรียนอื่นที่**ยังไม่ปิด** (เปิดอยู่หรือยังไม่เปิด) เพราะถ้าย้าย หน้าเว็บจะเลือกรอบตามชั้นใหม่ นักเรียนจะมองไม่เห็นและยกเลิกที่นั่งนั้นเองไม่ได้ error ของแถวบอกภาคเรียนและชั้นของรอบนั้น (ไม่มีชื่อนักเรียนใน log) ให้ปิดรอบนั้นก่อนแล้วนำเข้าใหม่ ส่วนที่นั่งในรอบที่ปิดแล้วของภาคเรียนอื่นเป็นประวัติ (ขึ้นชั้นทุกปี) ไม่ใช่เหตุให้ปฏิเสธ และไม่ต้องล็อก เพราะรอบที่ปิดแล้วไม่มีใครลงหรือยกเลิกได้อีก dry run ตรวจแบบเดียวกันจาก snapshot ของตัวเอง
4. **Upsert ตามรหัส** อัปโหลดซ้ำได้ไม่เกิดข้อมูลซ้ำ ครั้งที่สองรายงานว่าไม่เปลี่ยนทั้งหมด ไม่ลบนักเรียน/ชุมนุมที่ไม่มีในไฟล์ และไม่แตะ `registered`
5. Advisors **replace ทั้งชุดต่อชุมนุม** เพื่อให้ครูที่ถูกถอดหายจริง (ชุมนุมที่ไม่มีในชีต advisors คงครูเดิม)
6. นักเรียนใหม่ได้ `password_hash` เป็นค่าที่ login ไม่ได้ (`!unissued`) + `must_change_password` จนกว่า admin จะออกรหัสผ่านเริ่มต้น นักเรียนเดิมอัปเดตแค่ชื่อ/ชั้น/ห้อง/เลขที่ ไม่แตะรหัสผ่านหรือ session

**กติกาของไฟล์**

- มีชีตใดก็ได้จาก `students`, `clubs`, `advisors` ชีตที่ไม่มีในไฟล์ = ไม่แตะข้อมูลชนิดนั้น แถวแรกเป็นหัวตาราง จับคอลัมน์ตามชื่อ (ไม่สนลำดับ) คอลัมน์อื่นนอก template ไม่อ่าน ไม่เก็บ ไม่ log (PDPA)
- Admin เลือก **ภาคเรียน** ตอนอัปโหลด "ชั้นที่เปิดรับ" ของแต่ละแถวใน clubs เลือกรอบ (ภาคเรียน, ชั้น) ที่ต้องมีอยู่แล้ว ชุมนุมที่รับหลายชั้น = หลายแถวรหัสเดียวกันต่างชั้น (ที่นั่งแยกกันต่อชั้น)
- แถว advisors อ้างรหัสชุมนุม และใช้กับทุกรอบของภาคเรียนนั้นที่มีรหัสนี้ (ในไฟล์หรือใน DB)
- รหัสนักเรียน normalize แบบเดียวกับตอน login, รหัสชุมนุมเป็นตัวพิมพ์ใหญ่
- Error ที่ตรวจ (รายงานทุกจุดพร้อมชีต/แถว/คอลัมน์ ไม่หยุดที่จุดแรก): รูปแบบทุกเซลล์ตาม Zod, key ซ้ำในไฟล์, รหัสที่เป็นบัญชีที่ไม่ใช่นักเรียน, ไม่มีรอบของชั้นนั้น, จำนวนรับน้อยกว่าที่ลงแล้ว, ครูอ้างรหัสชุมนุมที่ไม่มีทั้งในไฟล์และ DB, เปลี่ยนชั้นนักเรียนที่ลงชุมนุมในรอบของภาคเรียนนี้แล้ว หรือในรอบที่ยังไม่ปิดของภาคเรียนอื่น
- สูตรไม่ถูกคำนวณ ใช้ค่าที่ Excel เก็บไว้ ถ้าไม่มีค่าเป็น error เซลล์ที่ Excel แปลงเป็นวันที่เป็น error

**ข้อควรระวัง**

- ขนาดไฟล์ ≤ 5 MB (เฉพาะ route นี้), ชีตละ ≤ 5,000 แถว, ตรวจ extension `.xlsx` + magic bytes ของ zip ฝั่ง server (ไม่เชื่อ MIME จาก browser), จำกัดขนาดหลังแตก zip (กัน zip bomb), ประมวลผลใน memory ไม่เขียนลง disk, log แค่จำนวนแถวและ sha256
- Export escape ค่าที่ขึ้นต้นด้วย `=`, `+`, `-`, `@` กัน formula injection
- ขอเฉพาะคอลัมน์ที่จำเป็น (PDPA) ไม่รับเลขบัตรประชาชน/ที่อยู่

**ไฟล์ตัวอย่างสำหรับลอง import (ข้อมูลสมมติ)**

```bash
pnpm --filter api generate-sample-import   # เขียน 3 ไฟล์ลง samples/ ที่ root (gitignored) รันซ้ำได้ข้อมูลเดิม
```

- ไม่ commit ไฟล์ .xlsx ตัวอย่าง แต่ commit ตัวสร้าง (`apps/api/src/dev/sample-import.ts`) หัวตารางมาจากนิยามคอลัมน์ใน `packages/shared/src/import.ts` เหมือน template ข้อมูลตายตัว (ไม่สุ่ม ไม่มีวันที่) ไม่ยอมรันเมื่อ `NODE_ENV=production` และไม่อยู่ใน image (`dist/dev/` ถูกลบตอน build)
- `import-all-fictional.xlsx` (3 ชีต), `import-students-only-fictional.xlsx`, `import-clubs-advisors-fictional.xlsx`
- **นักเรียน 80 คน** ม.1/ม.2 ชั้นละ 2 ห้อง ห้องละ 20 คน รวมนักเรียน demo (`demo1001`, `demo1002`, `demo2001`) ด้วยชื่อ ชั้น ห้อง เลขที่เดียวกับ `seed-dev` (อ่านจาก `DEMO_ACCOUNTS`) import แล้วบัญชี demo จึงไม่เปลี่ยนและรหัสผ่านเดิมยังใช้ได้ คนอื่นมีรหัสเป็นตัวเลขล้วน จึงไม่ชนกับบัญชี demo
- **ชุมนุม 8 รหัส (9 แถว):** C102/C202 รับ 2–3 คนไว้ลองกรณีเต็ม, C300 รับทั้ง ม.1 และ ม.2 (2 แถวรหัสเดียวกัน), C104 ไม่มีครู, C101 มีรายละเอียดหลายบรรทัด **ครู 8 แถว:** เบอร์ `000-000-000X` อีเมล `@example.com` LINE ID สมมติ (ช่องติดต่อว่างบ้าง) ไม่มีเซลล์ไหนขึ้นต้นด้วย `=`, `+`, `-`, `@`
- ลองใช้: `pnpm dev` → login `demo-admin` → สร้างรอบ ม.1 และ ม.2 ในภาคเรียนเดียวกัน → import ไฟล์ all ด้วยภาคเรียนนั้น dry run ต้องไม่มี error → ยืนยัน (นักเรียนใหม่ login ได้หลังออกรหัสผ่านเริ่มต้น) เทสต์ `apps/api/test/sample-import.test.ts` และ `sample-import-commit.test.ts` ตรวจทั้งไฟล์และ dry run + ยืนยันกับ Postgres จริง (import ซ้ำได้ไม่เปลี่ยนทั้งหมด)

**ไฟล์จริงของโรงเรียนเก็บนอก repo เสมอ:** repo เป็น Public รายชื่อนักเรียนจริง ไฟล์รหัสผ่านเริ่มต้น และไฟล์ export ที่ดาวน์โหลดมา เก็บไว้นอก checkout เช่น `~/club-registration-data/` (`chmod 700`) แม้ `.gitignore` จะกัน `*.xlsx` (นอก `templates/`), `samples/`, `*.dump`, `.env*` ไว้แล้วก็ตาม เพราะ `git add -f` ข้ามได้ CI จึงรัน `scripts/check-no-data-files.sh` เป็นขั้นแรกของ job `check`: ล้มถ้า git track `*.xlsx`, `*.xls`, `*.csv`, `*.dump`, `*.sql.gz`, `*.tar.gz` (ไม่สนตัวพิมพ์) นอก `templates/` หรือ env file (`.env*`, `*.env`, `*.env.*`) ที่ไม่ใช่ `*.example` พิมพ์แค่ path ไม่พิมพ์เนื้อหา รันในเครื่องได้ด้วยคำสั่งเดียวกัน

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
- **รูปแบบ PDF** (`apps/api/src/export/name-list-pdf.ts`, สร้างทั้งไฟล์ใน memory แล้วตอบทีเดียวเหมือน Excel): หัวเอกสารและคอลัมน์ชุดเดียวกับ Excel ชื่อชุมนุม/ห้องตัวหนาเป็นบรรทัดแรก ตารางมีเส้นและหัวตารางพื้นเทา ตัวอักษร 11pt แถวละ 17pt (ห้อง 38–40 คนจบใน 1 หน้า) รายชื่อยาวต่อหน้าถัดไปโดยขึ้นบรรทัด "<ชื่อชุมนุม/ห้อง> (ต่อ)" และพิมพ์หัวตารางซ้ำ ท้ายทุกหน้ามี "ส่งออกเมื่อ <วันเวลาไทย> น." ทางซ้าย และ "หน้า n/N" ทางขวา **นับใหม่ต่อชุมนุม/ห้อง** (N = จำนวนหน้าของชุมนุม/ห้องนั้น ไม่ใช่ทั้งไฟล์) export ทั้งรอบแล้วพิมพ์แยกให้ครูแต่ละคน ชุดของแต่ละคนจึงเริ่มที่หน้า 1 เสมอ ส่วน export ชุมนุม/ห้องเดียวเลขหน้าเหมือนนับทั้งไฟล์
  - **ข้อความไม่ล้นช่อง:** `pdfkit` ตัดบรรทัดได้แค่ที่ช่องว่าง ซึ่งชื่อไทยไม่มี จึงไม่พึ่งการตัดบรรทัด ทุกช่องเป็นบรรทัดเดียว ถ้ากว้างเกินช่องจะตัดท้ายแล้วใส่ "…" ตัดที่ขอบ grapheme (พยัญชนะไม่แยกจากสระบน/ล่างหรือวรรณยุกต์) และไม่จบด้วยสระหน้า (เ แ โ ใ ไ) เลือกตัดแทนการย่อตัวอักษรเพราะทุกแถวสูงเท่ากันและอ่านง่ายกว่า ชื่อที่ถูกตัดยังดูเต็มได้ในไฟล์ Excel บรรทัดหัวเอกสาร (เช่นรายชื่อครูหลายคน) ตัดบรรทัดที่ช่องว่างได้ไม่เกิน 3 บรรทัด (ชื่อชุมนุม 2 บรรทัด) แล้วตัดด้วย "…" แบบเดียวกัน
  - **ข้อความล้วน:** วาดเป็น glyph ไม่มีอะไรถูกตีความเป็น markup หรือสูตร (ไม่ต้อง escape แบบ Excel) ทุกข้อความอยู่ใน marked content `/Span` ที่มี `ActualText` เพื่อให้ copy/ค้นหาในโปรแกรมอ่าน PDF ได้ข้อความตรงตามที่เขียน (Sarabun วาด "ำ" เป็นนิคหิต + glyph สระอาที่ไม่มีรหัสอักษร ถ้าไม่มี `ActualText` ตัว "า" ทั้งไฟล์อาจ copy ออกมาหาย)
  - **ฟอนต์:** `apps/api/assets/fonts/Sarabun-Regular.ttf` และ `Sarabun-Bold.ttf` (SIL Open Font License 1.1, ข้อความ license อยู่ที่ `apps/api/assets/fonts/OFL.txt` ต้องแจกไปพร้อมฟอนต์) ฝังเฉพาะ glyph ที่ใช้ (subset) โมดูลหาฟอนต์จากตำแหน่งของตัวเอง (`import.meta.url` → `../../assets/fonts/`) จึงใช้ได้ทั้ง `src/` ตอน dev/test และ `dist/` หลัง `pnpm build` อ่านไฟล์ตอนโหลดโมดูล ถ้าหาไม่เจอ server ไม่ start (fail fast) Docker image `api` จึง copy `apps/api/assets/` ไปข้าง `dist/` (smoke script ตรวจทั้งไฟล์และว่า server start ได้)
  - **วัดจริงในเทสต์** (เครื่องพัฒนา 4 vCPU ไม่ใช่สเปค production, 4 รอบ): รายห้องทั้งรอบ 450 คน 12 ห้อง ได้ 12 หน้า ~99 KB ใช้ 195–300 ms ต่อ request (รวมอ่าน DB) ต้องวัดซ้ำบนเครื่องจริง
- **Spike PDF (ปิดรายการที่ยังเปิดอยู่ข้อ 6):** `pdfkit` 0.20.2 + Sarabun วางวรรณยุกต์ซ้อนบนสระบน, ป/ฝ/ฟ กับสระบน, ญ/ฐ กับสระล่าง และ "น้ำ" ถูกตำแหน่ง (ตรวจด้วยตาจากไฟล์ที่ render เป็นภาพ) จึงไม่ต้องถอยไปใช้หน้า print ของเบราว์เซอร์ ถ้าจะเปลี่ยนฟอนต์หรืออัปเกรด `pdfkit` ต้องลองกับชื่อสมมติแบบนี้ซ้ำ

## Security

- **รหัสผ่านเริ่มต้น:** สุ่มรายคน (10 ตัว ไม่มีตัวที่อ่านสับสน) ห้ามใช้เลขบัตร/วันเกิด ไม่มีที่ไหนเก็บรหัสจริง: admin เลือกชั้น (ห้องเดียวหรือทั้งชั้น ครั้งละไม่เกิน 1 ชั้น) แล้วกดออกรหัส server สุ่มและ hash (argon2id) แล้วตอบเป็นไฟล์ .xlsx ทันที (1 ชีตต่อห้อง, `Cache-Control: no-store`, ชื่อไฟล์มีแค่ชั้น/ห้อง) ไฟล์นั้นคือสำเนาเดียว ทำหาย = ออกใหม่ ซึ่งทำให้รหัสเดิมใช้ไม่ได้ทันทีและ bump `session_version` ออกให้ได้เฉพาะนักเรียนที่ `must_change_password` ยังเป็นจริง นักเรียนที่ตั้งรหัสเองแล้วจะไม่ถูกเขียนทับ (การรีเซ็ตรหัสที่ลืมของนักเรียนที่ใช้งานแล้วยังไม่มี) บังคับเปลี่ยนตอน login แรก
  - hash ก่อนเปิด transaction (จำกัดทำพร้อมกัน 2 งานทั้ง server ให้ login ยังได้ thread) แล้วใน transaction สั้นๆ ถือ import lock (`pg_advisory_xact_lock(1, 1)`) ก่อน จากนั้น lock แถวที่ยังมีสิทธิ์ด้วย `SELECT … FOR NO KEY UPDATE` เขียนเฉพาะแถวนั้น ไฟล์มีเฉพาะคนที่ถูกเขียนจริง นักเรียนที่เปลี่ยนรหัสระหว่างนั้นถูกข้าม admin สองคนออกขอบเขตเดียวกันพร้อมกัน → นักเรียนแต่ละคนมีรหัสที่ใช้ได้รหัสเดียว คือรหัสในไฟล์ของ request ที่ commit ทีหลัง
  - **ไม่ชนกับการยืนยัน import:** ทั้งสองงาน lock แถว `users`/`student_profiles` หลายแถวโดยไม่เรียงลำดับเดียวกัน ถ้าถือพร้อมกันอาจ deadlock (40P01 = 500) การออกรหัสจึงถือ import lock ก่อนแตะแถวใด สองงานนี้จึงไม่เคยถือ row lock พร้อมกัน งานที่มาทีหลังรอจนอีกงาน commit (เฉพาะ transaction สั้นๆ ไม่รวมการ hash) ลำดับ lock ทั้งระบบและเหตุผลว่าไม่ deadlock กับการลงทะเบียนอยู่ใน `apps/api/src/services/round-lock.ts` เทสต์: `apps/api/test/initial-passwords-import-lock.test.ts`
  - `idempotencyKey` ถูกเก็บใน `password_issuances` คู่กับการออก ส่ง key เดิมซ้ำ = `409 idempotency_key_reused` (ไม่ออกซ้ำ เพราะการออกซ้ำทำให้ไฟล์ที่อาจพิมพ์ไปแล้วใช้ไม่ได้) หน้าเว็บสร้าง key ใหม่ทุกครั้งที่กดยืนยัน
  - log เฉพาะ admin id, ขอบเขต, จำนวน และเวลา ไม่ log ชื่อ รหัสนักเรียน หรือรหัสผ่าน rate limit 20 ครั้ง/10 นาที ต่อ admin
  - วัดจริงในเทสต์ (เครื่องพัฒนา 4 vCPU ไม่ใช่สเปค production, 4 รอบ): ออกรหัส 450 คนใช้ 6.6–7.1 วินาทีต่อ request เกือบทั้งหมดคือ hash ส่วน transaction + สร้างไฟล์ใช้ไม่ถึง 0.1 วินาที ต้องวัดซ้ำบนเครื่องจริง
- **ตรวจสิทธิ์ที่ server ทุก endpoint** ไม่เชื่อ role/`student_id` จาก client ใช้ค่าจาก JWT เท่านั้น
- **Rate limit** ที่ `/auth/login` และ endpoint เขียน (ลง/ยกเลิกของนักเรียน 30 ครั้ง/นาที ต่อนักเรียน)
- **Session:** JWT (HS256, อายุ 2 ชม.) อยู่ใน cookie `HttpOnly; Secure; SameSite=Strict; Path=/api` ไม่เก็บใน `localStorage` ทุก request เช็ค `users.session_version` กับค่าใน token → logout หรือเปลี่ยนรหัส = token เก่าทุกเครื่องใช้ไม่ได้ทันที (สำคัญกับคอมห้องแล็บที่ใช้ร่วมกัน) และถ้า role ใน DB เปลี่ยน token เดิมก็ใช้ไม่ได้
- **บังคับเปลี่ยนรหัสครั้งแรก:** ถ้า `must_change_password` ทุก route ตอบ `403 password_change_required` ยกเว้น `/auth/me`, `/auth/change-password`, `/auth/logout`
- **CSRF:** `SameSite=Strict` + endpoint เขียนรับเฉพาะ JSON (form ข้ามเว็บส่ง `application/json` ไม่ได้ถ้าไม่ผ่าน CORS preflight ซึ่งเราไม่เปิด) ส่วน route อัปโหลด (multipart ซึ่ง form ข้ามเว็บส่งได้) ตรวจเพิ่มว่า `Sec-Fetch-Site` เป็น `same-origin`/`none` หรือถ้าไม่มี header นี้ `Origin` (ถ้าส่งมา) ต้องตรงกับ host (`apps/api/src/http/same-origin.ts`) ไม่ผ่าน = `403`
- **Rate limit login:** 10 ครั้ง/15 นาที ต่อ IP + รหัสผู้ใช้ (คนอื่นแกล้งล็อกบัญชีนักเรียนจากที่อื่นไม่ได้) และ 600 ครั้ง/นาที ต่อ IP ที่ตั้งสูงเพราะทั้งโรงเรียนอาจออก NAT IP เดียว **ต้องปรับตอน load test** store อยู่ใน memory ใช้ได้เพราะเป็นเครื่องเดียว และหลัง Caddy ต้องตั้ง `TRUST_PROXY=true` ไม่อย่างนั้นทุก request จะมี IP ของ Caddy และนับรวมเป็นก้อนเดียว
- **เวลาตอบของ login ไม่บอกว่ามีบัญชีไหม:** login ที่ไม่มีผู้ใช้ และบัญชีที่ยังไม่ได้ออกรหัส (`!unissued` นักเรียนที่ import แล้วแต่ admin ยังไม่ออกรหัสเริ่มต้น) หรือ hash ที่ใช้ไม่ได้ ยังคำนวณ argon2 ด้วยค่าเดียวกับการตรวจรหัสจริงหนึ่งรอบ (`spendVerifyWork` ใน `apps/api/src/auth/password.ts` ทุกทางที่ `verifyPassword` ตอบ "ไม่ตรง" โดยไม่ต้อง derive) เวลาตอบจึงไม่บอกว่ารหัสนักเรียนไหนมีอยู่จริงหรือยังรอรหัส เทสต์เทียบ median ของเวลาแบบสลับกันไปมา (`apps/api/test/support/timing.ts`) ต้องได้อย่างน้อยครึ่งหนึ่งของการใส่รหัสผิด ก่อนแก้ บัญชีที่ยังไม่ออกรหัสตอบเร็วกว่าราว 14 เท่า (ประมาณ 2 ms เทียบกับ 29 ms ผ่าน HTTP)
- **Admin คนแรก:** `pnpm --filter api create-admin <login_id>` สุ่มรหัส 16 ตัว แสดงครั้งเดียว เก็บแค่ hash และต้องเปลี่ยนตอน login แรก
- **Secret:** `JWT_SECRET`, DB password อยู่ใน env / SSM Parameter Store ห้ามอยู่ใน repo หรือ image บนเครื่องเก็บใน `deploy/production.env` (`chmod 600`, gitignored ด้วย `*.env`) ที่ทำจาก `deploy/production.env.example` ซึ่งไม่มีค่าจริง
- **ข้อมูลติดต่อครู** (เบอร์, อีเมล, LINE ID ทุกช่องเป็น optional): เห็นเฉพาะ admin (หน้า `/admin/clubs`) **นักเรียนเห็นแค่ชื่อครู** query ฝั่งนักเรียนไม่ SELECT คอลัมน์ติดต่อเลย (ใช้ `ADVISOR_NAMES_JOIN` ใน `services/clubs.ts` ตัวเดียวกับ export รายชุมนุม) และ response schema ของนักเรียนไม่มีช่องเหล่านี้ (serializer ตัดช่องที่ไม่อยู่ใน schema ทิ้งอีกชั้น) ถ้าวันหนึ่งจะให้นักเรียน ~2,500 คนเห็นช่องทางติดต่อ ต้องให้ครูยินยอมก่อน และใช้ช่องทางกลางของโรงเรียนถ้ามี
- **Frontend:** ห้าม `dangerouslySetInnerHTML` กับ `description` ที่ admin กรอก
- **Log:** ไม่ใส่ secret/PII พอสำหรับ debug serializer ของ logger อยู่ที่ `apps/api/src/log.ts` ที่เดียว (ใช้กับ logger ทุกตัวของ app รวมตัวที่เทสต์ใช้): request log มีแค่ method, path (ไม่มี query string), host และ**ชื่อ** query parameter (`queryKeys` ไม่มีค่า ชื่อที่ไม่ใช่รูปแบบตัวแปร เช่น ตัวเลขหรือภาษาไทย นับเป็น `queryKeysOmitted` เท่านั้น) เพราะบรรทัดนี้เขียนก่อน validate ถึง route จะไม่รับข้อมูลส่วนตัวใน query แต่ client ที่ส่งผิดก็ใส่รหัสผ่านหรือรหัสนักเรียนมาได้ **ไม่มี IP** (IP คู่กับ request id และ student id ชี้ตัวเครื่อง/บ้านนักเรียนได้ Caddy ก็ไม่เก็บ access log ด้วยเหตุผลเดียวกัน) error log เก็บ field แบบ allowlist error จาก Postgres เก็บแค่ `code`, `constraint`, `table`, `column` ฯลฯ ไม่เก็บ `detail`/`where` (มีค่าของแถว) และ data exception (class 22) ไม่เก็บ message เพราะ Postgres ใส่ค่าที่ส่งมาไว้ใน message (เทสต์ `apps/api/test/logging.test.ts`)
- **Audit ของ admin:** สร้าง/แก้/ลบรอบ และแก้ชุมนุม ไม่มีตาราง audit ของตัวเอง (ไม่รับ `idempotency_key` เพราะส่งซ้ำได้ผลเดิม) จึงเขียน log หนึ่งบรรทัดหลัง commit ผ่าน `logAdminChange` (`apps/api/src/http/audit-log.ts`) มี `audit` (`round.create`, `round.create_batch`, `round.update`, `round.delete`, `club.update`), `adminId`, id ที่แก้, ชื่อ field ที่ส่งมา (`changed`) และค่าที่ไม่ใช่ข้อความหลังแก้ (เวลาเปิด/ปิด, `maxActive`, `capacity`) ไม่ log ชื่อหรือคำอธิบายชุมนุม (admin พิมพ์เองอาจมีชื่อคน) คำขอที่ถูกปฏิเสธไม่มีบรรทัดนี้ ค้นด้วย `dcp logs api | grep '"audit"'` **ข้อจำกัด:** อยู่ได้นานเท่าที่ log rotation ของ container เก็บ (5 × 10 MB ใน `compose.prod.yml`) พอสำหรับตรวจย้อนวันลงทะเบียน ไม่ใช่บันทึกระยะยาว ถ้าต้องการต้องเพิ่มตาราง audit
- **Database role ของ api (least privilege):** api ต่อ DB ด้วย role `club_app` ไม่ใช่เจ้าของ DB (`POSTGRES_USER` ซึ่งเป็น superuser) migration `20261119000000_app-role.sql` สร้าง role แบบ `NOLOGIN` และ grant เฉพาะคำสั่งที่ api ใช้จริงรายตาราง: `registration_events` และ `password_issuances` ได้แค่ `SELECT`/`INSERT` (append-only ด้วยสิทธิ์อีกชั้นนอกจาก trigger), `registrations`/`club_advisors` ไม่มี `UPDATE`, `users` ลบไม่ได้, ไม่มีสิทธิ์ `TRUNCATE`, สร้าง/แก้ตาราง, อ่าน `pgmigrations` หรือใช้ `COPY … TO PROGRAM`/อ่านไฟล์บนเครื่อง DB ถ้า api มีช่องโหว่ (เช่น SQL injection) ความเสียหายจึงจำกัดอยู่แค่สิ่งที่ api ทำได้อยู่แล้ว
  - `migrate` ต่อด้วยเจ้าของ (`DATABASE_URL`) รัน migration แล้วตั้ง login ให้ `club_app` จาก `APP_DB_PASSWORD` ทุกครั้งที่ `up` (`apps/api/src/migrate.ts`) โดยส่งแค่ SCRAM verifier ที่คำนวณใน Node ไม่ส่งรหัสจริงไปกับ `ALTER ROLE` log ของ Postgres จึงไม่มีรหัส เปลี่ยนรหัส = แก้ `APP_DB_PASSWORD` ใน env file แล้ว `up` ใหม่
  - api ใน production (`NODE_ENV=production`) **ไม่ยอม start** ถ้า `DATABASE_URL` เป็น superuser, เจ้าของตาราง หรือสร้างของใน schema `public` ได้ (log `refusing to start` exit 1) ส่วนตอน DB ยังต่อไม่ได้ (หลัง reboot) จะรอและลองใหม่ทุก 2 วินาทีโดยยังไม่เปิดพอร์ต
  - role อยู่ระดับ cluster ไม่ใช่ระดับ DB ชื่อจึงตายตัว (`club_app`) dump มี `GRANT` ของ role นี้ไปด้วย restore ลง DB ใหม่บน server เดิมจึงได้สิทธิ์ครบ ส่วน server ที่สร้างใหม่ (volume ว่าง ยังไม่มี role) `scripts/restore.sh` สร้าง `club_app` แบบ `NOLOGIN` ก่อน `pg_restore` แล้ว migrate หลังสลับ DB ตั้ง login ให้ (smoke-backup ตรวจทั้งสองกรณี)
  - **ตารางใหม่ต้อง grant ใน migration เดียวกับที่สร้าง** และแก้รายการใน `apps/api/test/db-role.test.ts` ซึ่งเทียบสิทธิ์ทั้งหมดของ `club_app` กับรายการที่คาดไว้แบบตรงทุกตาราง (ตารางใหม่ที่ลืม grant หรือ grant เกินจึงล้ม) เทสต์ทั้งชุดรัน api และ fixture ด้วย `club_app` (ยกเว้น `TRUNCATE` ระหว่างเทสต์และ `seed-dev` ซึ่งเป็นเครื่องมือ dev) คำสั่งที่ไม่ได้ grant จึงล้มในเทสต์ก่อนถึง production
  - **dev ยังใช้เจ้าของ:** `pnpm dev` ใช้ `DATABASE_URL` เดียวใน `.env` ทั้ง migrate และ api (ไม่ตั้ง `APP_DB_PASSWORD` ก็ได้) การตรวจสิทธิ์จึงอยู่ที่เทสต์และ smoke ไม่ใช่ตอน dev
- **Backup:** dump มีข้อมูลส่วนบุคคลทั้งหมดและ hash รหัสผ่าน เก็บใน bucket private (Block Public Access) เข้ารหัส SSE-S3 role ของเครื่องเขียน/อ่านได้เฉพาะ prefix ของ backup ลบไม่ได้ ไฟล์ในเครื่อง 600 และไม่พิมพ์เนื้อหาออก log (ดู [Backup และ Restore (O3)](#backup-และ-restore-o3))
- **Repo เป็น Public:** ห้ามมีข้อมูลจริงทุกชนิด (นักเรียน ครู domain จริง IP ชื่อ bucket) เปิด secret scanning และ push protection แล้ว `.gitignore` กัน `*.xlsx` จริง / `samples/` / `.env*` / `*.dump` / `*.dump.partial` / `caddy-data-*.tar.gz` (เว้น `templates/`) และ CI ตรวจซ้ำด้วย `scripts/check-no-data-files.sh` (กัน `git add -f` ดู [Excel Import/Export](#excel-importexport)) ไฟล์จริงเก็บนอก repo ถ้าเผลอ push secret ต้อง rotate ทันที ลบจาก history ไม่พอ

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
- **web:** `Caddyfile` ที่ root อ่าน env 2 ตัว (ตารางข้างล่าง) cache: ไฟล์ใน `/assets/` มี hash ในชื่อ ได้ `Cache-Control: public, max-age=31536000, immutable` เฉพาะไฟล์ที่มีจริง (ไฟล์ที่ไม่มี = 404 ไม่ fallback เป็น `index.html` แท็บที่เปิดค้างไว้ข้าม deploy แล้วขอ chunk ของหน้าเก่าจะได้ 404 และหน้าเว็บขึ้นข้อความพร้อมปุ่มโหลดหน้าใหม่) ที่เหลือรวม `index.html` เป็น `no-cache` (revalidate ด้วย ETag deploy ใหม่จึงเห็นทันที) บีบอัด zstd/gzip ไม่เขียน access log (จะมี IP และ path ของนักเรียนทุกคน) Caddy เขียนทับ `X-Forwarded-For` ที่ client ส่งมาเอง api จึงตั้ง `TRUST_PROXY=true` ได้โดยปลอม IP ไม่ได้ (ใช้ได้เมื่อ Caddy รับตรงจาก internet ถ้าอยู่หลัง load balancer ดู [รายการที่ยังเปิดอยู่](#รายการที่ยังเปิดอยู่) ข้อ 16)
- **Security headers ของหน้าเว็บ** (เฉพาะที่ไม่ใช่ `/api/*` ซึ่งใช้ของ `@fastify/helmet` ใน api อยู่แล้ว ไม่ซ้ำกัน): `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` (ไม่มี `'unsafe-inline'`/`'unsafe-eval'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` ปิดกล้อง ไมค์ ตำแหน่ง การจ่ายเงิน USB ตรวจใน Chromium จริงแล้วว่าไม่มี CSP violation (login, เปลี่ยนรหัส, หน้า admin, ดาวน์โหลด template และดาวน์โหลดแบบ blob รวม chunk ของหน้าที่โหลดทีหลังซึ่งเป็น same-origin จึงผ่าน `script-src 'self'`) zod ทดสอบ eval ด้วย `new Function` ตอนสร้าง schema ซึ่ง CSP รายงานเป็น violation ทุกหน้า หน้าเว็บจึง import `@club-registration/shared/zod-jitless` เป็นอันแรกใน `main.tsx` เพื่อปิด JIT ของ zod ก่อน (api ไม่ import จึงยังใช้ JIT) HSTS ใส่เฉพาะตอนเป็น HTTPS (ดู [O2](#compose-ของ-production-o2)) ส่วน `upgrade-insecure-requests` ไม่ใส่ เพราะหน้าเว็บโหลดทุกอย่างแบบ relative จาก origin เดียวกันอยู่แล้ว
- **Multi-arch:** เครื่องจริงเป็น t4g (arm64) และ build บนเครื่องเองด้วย `docker compose build` ไม่มี registry ส่วน CI build แค่ amd64 เพื่อพิสูจน์ว่า Dockerfile ใช้ได้ **arm64 ยังไม่ได้ทดสอบ** (native binary ของ rolldown, lightningcss, Tailwind ที่ใช้ตอน build เว็บต้องมีของ arm64 ใน lockfile) ต้องรัน smoke script บนเครื่องจริงครั้งแรก
- **Smoke test:** `scripts/smoke-images.sh` (ต้องมีแค่ Docker และ curl) build ทั้งสอง image สร้าง network แล้วรัน postgres → `node dist/migrate.js` (เจ้าของ DB ตั้ง login ให้ `club_app`) → `create-admin` (`club_app`) → api ที่ต่อด้วยเจ้าของ DB ต้องไม่ยอม start → api (`club_app`) → web บนพอร์ตว่าง แล้วตรวจผ่าน Caddy: `/api/health` 200 และ DB up, `/` เป็น SPA พร้อม security headers, deep link (`/student/clubs`) ได้ `index.html`, asset ที่มี hash ได้ 200 + immutable + บีบอัด, asset ที่ไม่มีได้ 404, `/api/nonexistent` ได้ JSON 404 ของ api, `/api/*` มี CSP ของ helmet ตัวเดียว, admin ที่สร้าง login ผ่าน Caddy ได้ (argon2id ใน image), ทั้งสอง container รันเป็น non-root, image api มีฟอนต์ OFL และ template ตรงที่ api หา ไม่มี `src`/เทสต์/dev dependency และ `docker stop` api จบเองภายใน 5 วินาทีด้วย exit code 0, ไม่มี entry point ของ dev ใน image api, `/data` กับ `/config` ของ image web ว่าง, ไม่มี HSTS บน HTTP ธรรมดา, health listener ของ Caddy ตอบใน container ลบ container/network เสมอด้วย `trap` secret ทุกตัวสุ่มต่อรอบและไม่พิมพ์ออกมา CI รันเป็น job `images` ทุก PR และทุก push เข้า `main`

image เดี่ยวๆ นอก compose (เช่นตอนแก้ `Dockerfile`):

```bash
docker build --target api -t club-registration-api .
docker build --target web -t club-registration-web .
docker run --rm -e DATABASE_URL -e APP_DB_PASSWORD club-registration-api node dist/migrate.js   # DATABASE_URL = เจ้าของ DB
docker run --rm -it -e DATABASE_URL club-registration-api node dist/create-admin.js <login_id>   # DATABASE_URL = club_app
```

### Compose ของ production (O2)

`compose.prod.yml` คือ stack ของเครื่องจริง ใช้คู่กับ env file ที่ทำจาก `deploy/production.env.example` เสมอ ส่วน `docker-compose.yml` เป็น Postgres ของ dev อย่างเดียว (ใช้กับ `pnpm dev`/เทสต์ ไม่เปลี่ยน) ไฟล์ production ตั้ง project name เป็น `club-registration-prod` container, volume และ network จึงไม่ชนกับของ dev

| Service | Image | ทำอะไร | Port บน host | Network | Restart | Memory limit |
|---|---|---|---|---|---|---|
| `postgres` | `postgres:18.7-alpine@sha256:…` (major เดียวกับเทสต์ pin tag + digest แบบหลาย arch) | DB + volume `postgres-data` healthcheck `pg_isready` ผ่าน TCP | ไม่มี | `backend` | `unless-stopped` | 512 MiB |
| `migrate` | image ของ `api` (ตัวเดียวกัน ไม่ build แยก) | `node dist/migrate.js` ด้วยเจ้าของ DB (ตั้ง login ของ `club_app` ด้วย) แล้วจบ | ไม่มี | `backend` | `"no"` | 192 MiB |
| `api` | build target `api` | Fastify ต่อ DB ด้วย `club_app` (`APP_DATABASE_URL`) รอ postgres healthy และ migrate จบด้วย 0 ก่อน start, `init: true`, `NODE_ENV=production`, `TRUST_PROXY=true`, healthcheck จาก image | ไม่มี | `backend` + `frontend` | `unless-stopped` | 512 MiB |
| `web` | build target `web` | Caddy (HTTPS, SPA, proxy `/api/*`) รอ api healthy | 80, 443, 443/udp (HTTP/3) | `frontend` | `unless-stopped` | 192 MiB |

- **Network:** `backend` เป็น `internal` (ไม่มีทางออก internet) Postgres จึงออกนอกเครื่องไม่ได้ และ Caddy อยู่แค่ `frontend` จึงไม่เห็น Postgres เลย มีแค่ `web` ที่เปิดพอร์ตบน host
- **Hardening ทุก container** (`x-hardening` ใน `compose.prod.yml` ใส่ด้วย `<<: *hardening`): `cap_drop: [ALL]` (ไม่มี service ไหนต้องใช้ capability: postgres รันเป็น user ของตัวเอง api และ Caddy เป็น user ใน `Dockerfile` และ Docker ให้ process ธรรมดา bind 80/443 ได้ ส่วน binary ของ Caddy มี `cap_net_bind_service` แบบ permitted อย่างเดียวจึงยัง start ได้), `no-new-privileges` (setuid/file capability ให้อะไรเพิ่มไม่ได้) และ `read_only` (root filesystem เขียนไม่ได้ แต่ละ service เขียนได้แค่ volume ของตัวเองและ tmpfs ที่ระบุ: postgres `/var/run/postgresql` กับ `/tmp`, api และ web `/tmp` 16 MB ซึ่งนับรวมใน memory limit) ถ้าเพิ่ม service ใหม่ต้องใส่ `<<: *hardening` ด้วย
  - **postgres รันเป็น uid 70 (`postgres` ของ image alpine) ตั้งแต่ต้น** (`user: '70:70'`) แทนที่ entrypoint จะเริ่มเป็น root เพื่อ chown แล้วค่อยลดสิทธิ์ `/var/lib/postgresql` ของ image เป็นของ postgres อยู่แล้ว และ volume ที่สร้างตอน start แบบ root ก็เป็นของ postgres ทั้งหมด (ลองแล้ว: volume ที่สร้างด้วย root entrypoint เปิดต่อแบบ uid 70 ได้ข้อมูลครบ) `dcp exec postgres` จึงเป็น user postgres ด้วย ซึ่งพอสำหรับ `pg_dump`/`psql` ผ่าน socket ของ backup และ restore
  - smoke-compose ตรวจจาก container จริง: ทุก service read-only + `CapDrop` = `ALL` + `no-new-privileges`, process หลักของ postgres/api/web มี `CapEff` เป็น 0 และเขียน `/` ไม่ได้, postgres เป็น uid 70
- **Volume:** `postgres-data` (ข้อมูลทั้งหมด), `caddy-data` (`/data`: ใบรับรองและ ACME account) และ `caddy-config` (`/config`) อยู่ใน `/var/lib/docker/volumes/club-registration-prod_*` **ห้าม `down -v`** เป็นกิจวัตร: ลบ DB ทั้งก้อน และถ้าใบรับรองหายต้องขอใหม่ ขอใหม่ซ้ำหลายครั้งติด rate limit ของ Let's Encrypt (รอเป็นสัปดาห์) backup ของทั้งสองอย่างดู [Backup และ Restore (O3)](#backup-และ-restore-o3)
- **Fail fast:** ตัวแปรที่จำเป็น (`SITE_ADDRESS`, `POSTGRES_*`, `DATABASE_URL`, `APP_DB_PASSWORD`, `APP_DATABASE_URL`, `JWT_SECRET`) ใช้ `${VAR:?…}` ขาดตัวไหน compose ไม่ยอมรันและบอกชื่อ ส่วน `DB_*` ไม่ตั้งได้ (ค่าว่าง = default ของ api)
- **Log rotation:** ทุก service ใช้ `json-file` ไฟล์ละ 10 MB เก็บ 5 ไฟล์ (สูงสุด ~50 MB ต่อ container) วันที่คนเยอะดิสก์ไม่เต็มเพราะ log
- **Migrate:** รันทุกครั้งที่ `up` migration ที่ใช้แล้วถูกข้าม จึงไม่มีผลถ้าไม่มีของใหม่ ถ้า migrate ล้ม api ไม่ start (container เดิมของ api ยังรันต่อถ้ามี) ดูสาเหตุด้วย `logs migrate` ซึ่งเป็น JSON บรรทัดเดียวต่อผล (`apps/api/src/run-migrations.ts`): `migrations applied` พร้อมชื่อ migration ที่รันในรอบนั้น (`applied`), `no pending migrations` หรือ `migration failed` พร้อม `firstNotApplied` (ปกติคือตัวที่ล้ม) และ `err` ที่ผ่าน allowlist เดียวกับ log ของ api (`code`, `constraint`, `table` ฯลฯ ไม่มี `detail` ของ Postgres ที่มีค่าในแถว) log ของ node-pg-migrate เองยังปิดไว้ เพราะพิมพ์ SQL ทั้งไฟล์ และตอน error พิมพ์ข้อความของ DB ที่อาจมีค่าในแถว ใช้ image เดียวกับ api เสมอ (`image: club-registration-prod-api`) build แค่ api ก็ไม่มีทางได้ migration เก่ากว่า server
- **หลัง reboot:** Docker start `postgres`, `api`, `web` เองตาม `unless-stopped` (ไม่ผ่าน compose จึงไม่รอกันตาม `depends_on`) ไม่เป็นไรเพราะ api รอ DB เอง: ตอน start ต้องตรวจ role ของ DB ก่อน (ดู [Security](#security)) ถ้ายังต่อไม่ได้จะ log `database not reachable yet` แล้วลองใหม่ทุก 2 วินาทีโดยยังไม่เปิดพอร์ต (Caddy ตอบ 502 ช่วงนั้น) พอ Postgres พร้อมก็เปิดเอง ถ้า DB ล่มหลัง start แล้ว `/api/health` ตอบ 503 จนกลับมา `migrate` ไม่รันซ้ำ (ไม่จำเป็น เพราะ migration ทำไปแล้วตอน deploy)

**ตั้งค่าครั้งแรกบนเครื่อง** (การเตรียม EC2, DNS และ firewall อยู่ใน O4)

```bash
cp deploy/production.env.example deploy/production.env   # gitignored (*.env)
chmod 600 deploy/production.env
# แก้ไฟล์: SITE_ADDRESS=<domain จริง>, POSTGRES_PASSWORD=$(openssl rand -hex 24),
#          APP_DB_PASSWORD=$(openssl rand -hex 24) (คนละค่ากับ POSTGRES_PASSWORD), JWT_SECRET=$(openssl rand -base64 48)
# เก็บสำเนา secret ไว้นอกเครื่องด้วย (เช่น password manager) ไม่มี POSTGRES_PASSWORD = เปิด DB ไม่ได้
alias dcp='docker compose -f compose.prod.yml --env-file deploy/production.env'
dcp build                       # build บนเครื่องเอง ไม่มี registry
dcp up -d --wait                # postgres → migrate → api → web รอจน healthy ทุกตัว
dcp run --rm --no-deps api node dist/create-admin.js <login_id>   # admin คนแรก แสดงรหัสครั้งเดียว
```

- password ของ DB ทั้งสองตัวใช้ hex เพราะถูกใส่ลงใน `DATABASE_URL`/`APP_DATABASE_URL` (template ประกอบ URL จาก `POSTGRES_*` และ `APP_DB_PASSWORD` ให้เองด้วย `${…}` ของ env file) อักษรอย่าง `@ / : #` จะทำให้ URL เสีย migrate ไม่รับ `APP_DB_PASSWORD` ที่ไม่ใช่ hex ตัวเล็กอย่างน้อย 32 ตัว
- **env file ที่ทำก่อนมี `club_app`:** เพิ่ม `APP_DB_PASSWORD` และ `APP_DATABASE_URL` ตาม template (ไม่อย่างนั้น compose ไม่ยอมรันและบอกชื่อตัวแปร) แล้ว `dcp up -d --wait` ตามปกติ migrate จะสร้าง role, grant และตั้งรหัสให้เอง
- `run --no-deps` สำคัญ: ไม่อย่างนั้น compose จะ start `migrate` ซ้ำก่อน
- ค่า `POSTGRES_*` มีผลแค่ตอนสร้าง volume ครั้งแรก เปลี่ยนใน env file ทีหลังไม่เปลี่ยนรหัสใน DB (ต้อง `ALTER ROLE` เองแล้วแก้ env file ให้ตรง) ต่างจาก `APP_DB_PASSWORD` ที่ migrate ตั้งใหม่ทุก `up`

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

**Smoke test ของ compose:** `scripts/smoke-compose.sh` (ต้องมี Docker + Compose v2 และ curl) สร้าง env file ชั่วคราวจาก `deploy/production.env.example` ด้วย secret สุ่ม (ไม่พิมพ์ออกมา) แล้ว `build` + `up -d --wait` ด้วย project name ไม่ซ้ำและ `SITE_ADDRESS=localhost` (CA ภายในของ Caddy ไม่ต้องใช้ internet) พอร์ต host 18080/18443 (ตั้งด้วย `SMOKE_HTTP_PORT`, `SMOKE_HTTPS_PORT`) curl เชื่อ CA ที่ copy ออกมาจาก container ด้วย `--cacert` แทนการปิดการตรวจ (`-k`) chain ที่เสียจึงยัง fail ตรวจ: ทุก service healthy, migrate จบด้วย 0 ครั้งเดียวและ restart policy `no`, HTTP → 308 ไป HTTPS path เดิมโดยไม่มี HSTS, HTTPS `/` เป็น SPA พร้อม HSTS + CSP, `/api/health` 200 พร้อม HSTS ตัวเดียว, connection ของ api ใน `pg_stat_activity` เป็น `club_app` อย่างเดียว, postgres/api/migrate ไม่เปิดพอร์ต host, web ไปถึง api แต่ไม่ถึง postgres, api ไปถึง web:80 แต่ไม่ถึง health listener, ค่า `shared_buffers`/`max_connections` ที่ใช้จริง, heap limit ของ api, log rotation และ memory limit ทุก service, `create-admin` ผ่าน `run --rm --no-deps` แล้ว login ผ่าน HTTPS ได้ (ไม่ start migrate ซ้ำ), body 7 MiB ได้ 413 จาก Caddy (body ว่าง) ส่วน 100 KiB ยังถึง api (413 JSON ของ api), restart api แล้ว login ได้, `down` (ไม่มี `-v`) แล้ว `up` ใหม่: migrate รันซ้ำจบด้วย 0, login ได้ (volume DB อยู่), CA และใบรับรองของ site เป็นไฟล์เดิม (volume `/data` อยู่ ไม่ขอใหม่) ลบทุกอย่าง (`down -v` + image) ด้วย `trap` ไม่แตะ DB ของ dev CI รันต่อจาก `smoke-images.sh` ใน job `images` ถ้า build หลัง proxy ที่ดักถอด TLS ให้ตั้ง `EXTRA_CA_FILE=<pem>` script จะเพิ่ม build secret ผ่าน override ชั่วคราว (`compose.prod.yml` ไม่ต้องใช้)

**ยังไม่อยู่ใน O2:** เตรียม EC2/security group/DNS และเปิด-ปิดเครื่อง (O4), backup `pg_dump` ไป S3 และซ้อม restore (ทำแล้วใน O3), ตัวเลข pool/memory/Postgres จริงจาก load test (O5) และ arm64 ยังไม่ได้รันจริง (ต้องรันทั้งสอง smoke script บนเครื่องจริงครั้งแรก)

### Backup และ Restore (O3)

DB ทั้งก้อนอยู่ใน volume `postgres-data` บน EBS ของเครื่องเดียว backup จึงเป็นทางเดียวที่จะกลับมาได้เมื่อเครื่อง/ดิสก์พัง เผลอ `down -v` หรือข้อมูลเสียจาก import ผิด ใช้ 2 script บน host (ต้องรันจาก checkout ของ repo บนเครื่อง production ไม่อยู่ใน image) และ `scripts/lib/backup-common.sh` ที่ใช้ร่วมกัน

**อะไรถูก backup ไปไหน**

| | ไฟล์ | ที่เก็บ |
|---|---|---|
| DB | `pg_dump --format=custom` ของ `POSTGRES_DB` ทั้งก้อน (ทุกตาราง รวม `pgmigrations`, `registration_events`, `password_hash`) ชื่อ `<db>-<YYYYmmddTHHMMSSZ>.dump` (เวลา UTC) | `BACKUP_DIR` บนเครื่อง (เก็บ `BACKUP_KEEP_LOCAL` ไฟล์ล่าสุด) และ `BACKUP_S3_URI/<ชื่อเดียวกัน>` |
| ใบรับรอง (เลือกได้ `--include-certs`) | tar.gz ของ volume `caddy-data` (`/data` ของ Caddy: ใบรับรอง + key ของ ACME account) ชื่อ `caddy-data-<เวลา>.tar.gz` | ที่เดียวกัน |

- **ไม่ต้องหยุดระบบ:** `pg_dump` อ่านจาก snapshot เดียวที่สอดคล้องกันทั้งก้อน (ถือแค่ `ACCESS SHARE` ไม่ขวางการลง/ยกเลิก) รันระหว่างรอบเปิดได้ ใช้เวลาไม่กี่วินาที (DB สมมติ 40 คนในเทสต์ได้ไฟล์ ~37 KB ขนาดจริงของ 2,500 คนยังไม่ได้วัด)
- **ไม่ต้องเปิดพอร์ต DB และไม่ต้องลง Postgres client บน host:** `pg_dump`/`pg_restore`/`psql` รันใน container `postgres` ผ่าน `docker compose exec -T` ไฟล์วิ่งผ่าน stdin/stdout
- **ตรวจก่อนเก็บ:** `pg_restore --list` แล้วอ่านทั้งไฟล์อีกรอบ (`pg_restore --file=/dev/null` แปลงเป็น SQL ทิ้ง ไม่เขียนลง DB ไหน) เพราะ `--list` อ่านแค่สารบัญที่หัวไฟล์ ไฟล์ที่ถูกตัดครึ่งยังผ่าน `--list` ได้ (ทดลองแล้ว) ไฟล์ที่ไม่ผ่านถูกลบทิ้งและไม่ upload เขียนเป็น `.partial` ก่อนแล้วค่อย rename เมื่อผ่าน ไฟล์ที่ค้างจากการล้มจึงไม่ถูกนับเป็น backup
- **S3:** `aws s3 cp --sse AES256` (SSE-S3 ทุก object ไม่พึ่งค่า default ของ bucket) แล้วตรวจว่า object มีอยู่และขนาดเท่าไฟล์ในเครื่อง ไม่ลบอะไรใน S3 เอง (role ไม่มีสิทธิ์ลบ) object เก่าหมดอายุด้วย lifecycle rule ของ bucket
- **AWS CLI ของ host** (O4 ติดตั้ง) ใช้ IAM role ของ instance ไม่มี access key บนเครื่อง ไม่ใช้ container `aws-cli` เพราะ IMDSv2 ตั้ง hop limit = 1 เป็นค่าเริ่มต้น container จึงขอ credential จาก instance metadata ไม่ได้ ตัวแปร `AWS_*` (`AWS_REGION`, `AWS_ENDPOINT_URL` ฯลฯ) ส่งผ่านถึง `aws` ตรงๆ (เทสต์ใช้ `AWS_ENDPOINT_URL` ชี้ไป MinIO)
- **ข้อมูลส่วนบุคคล:** dump มีชื่อนักเรียนและ hash รหัสผ่าน script สร้างไฟล์ด้วย `umask 077` (ไฟล์ 600 ในไดเรกทอรี 700) ไม่พิมพ์เนื้อหา dump หรือแถวในตารางออก log เลย (log มีแค่ชื่อไฟล์ ขนาด จำนวนแถวต่อตาราง และผลตรวจ invariant) ตัดบรรทัด `DETAIL`/`CONTEXT` ของ error จาก Postgres ซึ่งอาจยกค่าในแถวมา bucket ต้องเป็น private ห้ามคัดลอก dump ไปเครื่องส่วนตัว `.gitignore` กัน `*.dump`, `*.dump.partial`, `caddy-data-*.tar.gz` อีกชั้น
- **กันรันซ้อน:** `flock` บน `BACKUP_DIR/.lock` ร่วมกันทั้ง backup และ restore รันไม่ซ้อนกันเด็ดขาด (ตัวที่สองจบทันทีด้วย exit 3 ไม่รอ) ไม่ถามอะไร จึงใช้กับ cron/systemd timer ได้ (ตั้งเวลาเป็นงาน O4)

**ใช้งาน** (บนเครื่อง ในโฟลเดอร์ repo ใช้ `deploy/production.env` เป็นค่าเริ่มต้น เปลี่ยนด้วย `PROD_ENV_FILE`)

```bash
scripts/backup.sh                    # dump → ตรวจ → upload S3 → ตรวจ object → ลบไฟล์ในเครื่องที่เกิน BACKUP_KEEP_LOCAL
scripts/backup.sh --include-certs    # + archive ใบรับรองของ Caddy (ก่อนทิ้ง/สร้างเครื่องใหม่)
scripts/backup.sh --local-only       # S3 ล่มหรือไม่มีเน็ต: เก็บในเครื่องอย่างเดียว

scripts/restore.sh --target-db drill_check latest        # ซ้อม: กู้ลง DB ชั่วคราว ไม่แตะ production แล้วลบทิ้ง
scripts/restore.sh --target-db drill_check --keep latest # ซ้อมแล้วเก็บ DB ไว้ตรวจเอง (ลบเองด้วย dropdb)
scripts/restore.sh --yes latest      # กู้ production จาก object ล่าสุดใน BACKUP_S3_URI
scripts/restore.sh --yes latest-local                     # S3 ล่ม: จากไฟล์ล่าสุดใน BACKUP_DIR
scripts/restore.sh --yes s3://example-club-backups/prod/club_registration-20261117T153000Z.dump
scripts/restore.sh --yes /var/backups/club-registration/club_registration-20261117T153000Z.dump
scripts/restore.sh --certs --yes latest                   # คืน volume ใบรับรองของ Caddy
```

| Exit code | backup.sh | restore.sh |
|---|---|---|
| 0 | สำเร็จ | สำเร็จ |
| 1 | ล้ม (dump/ตรวจไม่ผ่าน ไม่มีอะไรถูกเก็บหรือ upload) | ล้ม (ดูข้อความ ถ้าล้มหลังหยุด api/web จะ `up` กลับให้เอง) |
| 2 | ใช้ผิด/ตั้งค่าไม่ครบ (เช่นไม่มี `BACKUP_S3_URI` และไม่ใส่ `--local-only`) | ใช้ผิด หรือ**ไม่มี `--yes`** (ปฏิเสธพร้อมบอกว่าจะเขียนทับอะไร ไม่แตะอะไรเลย) |
| 3 | มี backup/restore อื่นถือ lock อยู่ | เหมือนกัน |
| 4 | upload ไม่สำเร็จ แต่ไฟล์ที่ตรวจแล้วอยู่ในเครื่อง (บอกคำสั่ง `aws s3 cp` ให้ upload ทีหลัง) | – |

**Restore production ทำอย่างไร (ได้ข้อมูลเก่าทั้งก้อนหรือใหม่ทั้งก้อน ไม่มีผสม)**

1. resolve ต้นทาง (`latest` = ชื่อล่าสุดตาม timestamp ใน S3) ถ้าไม่มี `--yes` ปฏิเสธที่นี่ (exit 2) ก่อนเปลี่ยนอะไร
2. ดาวน์โหลดลงไดเรกทอรีชั่วคราวใน `BACKUP_DIR` (700, ลบทิ้งตอนจบ) start `postgres` ถ้ายังไม่รัน (เช่นเครื่องใหม่ volume ว่าง) แล้วตรวจไฟล์แบบเดียวกับตอน backup **ไฟล์เสีย/ถูกตัด = จบตรงนี้ ยังไม่หยุดอะไร**
3. หยุด `web` และ `api` (ไม่มีใครเขียนข้อมูลที่กำลังจะถูกแทน)
4. `pg_restore --no-owner --exit-on-error --single-transaction` ลง**DB ใหม่ที่ว่าง** `<db>_restoring` ล้ม = ลบ DB นั้นทิ้งแล้ว `up` stack เดิมกลับ production ไม่ถูกแตะ ตรวจด้วยว่าเป็น dump ของแอปนี้ (มี `pgmigrations` และ `users`)
5. ใน transaction เดียว: rename `<db>` → `<db>_before_restore` และ `<db>_restoring` → `<db>` (Postgres ทำ `ALTER DATABASE … RENAME` ใน transaction ได้) DB ที่ api ใช้จึงเป็นของเก่าทั้งก้อนหรือของ backup ทั้งก้อนเท่านั้น
6. `compose run --rm migrate` (dump อาจมาจาก schema ที่เก่ากว่าโค้ดปัจจุบัน) แล้ว `up -d --wait` รอจนทุก service healthy พิมพ์จำนวนแถวต่อตารางและผลตรวจ invariant (`registered` = จำนวน registration)

- **ทำไมไม่ `pg_restore --clean --if-exists` ลง DB เดิม:** `--clean` drop เฉพาะ object ที่อยู่ใน dump ถ้า DB ปัจจุบันมีตารางจาก migration ใหม่กว่า dump ตารางนั้นจะค้างพร้อมข้อมูลหลัง backup ขณะที่ `pgmigrations` ถูกย้อนเป็นของเก่า (= ข้อมูลผสม และ migrate รอบถัดไปชนกับตารางที่มีอยู่แล้ว) การกู้ลง DB ใหม่แล้วสลับชื่อไม่มีปัญหานี้ และยังเหลือ DB เดิมไว้ย้อนกลับได้
- DB เดิมเก็บเป็น `<db>_before_restore` จนถึง restore ครั้งถัดไป (มีข้อมูลส่วนบุคคล ลบเมื่อยืนยันข้อมูลที่กู้แล้ว: `dcp exec postgres dropdb -U club club_registration_before_restore`) ถ้าต้องย้อนกลับ: หยุด api/web แล้วสลับชื่อกลับด้วย `psql` แบบเดียวกับข้อ 5
- ถ้า migrate ล้มหลังสลับ: ข้อมูลเป็นของ backup แล้วแต่ api ไม่ start (ตาม `depends_on` ของ compose) ดู `dcp logs migrate`
- ไม่ต้องกู้ role ของ Postgres: user เดียวที่แอปใช้ถูกสร้างจาก `POSTGRES_*` ใน env file ตอนสร้าง volume (`--no-owner` ทำให้ทุก object เป็นของ user นั้น)
- **ซ้อม restore (`--target-db`)** ทำข้อ 2 และ 4 ลง DB ชื่อที่ให้ (ห้ามเป็นชื่อ production, `postgres`, `template*`) ไม่หยุด api ไม่ migrate ไม่สลับอะไร แล้วพิมพ์จำนวนแถวและผล invariant และลบ DB นั้นทิ้ง (เว้นแต่ `--keep`) ถ้า DB ชื่อนั้นมีอยู่แล้วต้องใส่ `--yes` **ควรซ้อมทุกเดือนและก่อนเปิดรอบทุกครั้ง** backup ที่ไม่เคยลองกู้ = ยังไม่รู้ว่ามี backup
- **ใบรับรอง (`--certs`):** หยุด `web` → ลบของใน `/data` → แตกไฟล์ด้วย container ชั่วคราวจาก image `web` (user `caddy` เจ้าของ volume) → start `web` อย่างเดียว (`--no-deps`) ใช้ตอนสร้างเครื่องใหม่ เพื่อไม่ต้องขอใบรับรองใหม่จนติด rate limit ของ Let's Encrypt (ไม่จำเป็นถ้าเครื่องเดิมยังอยู่ เพราะ volume ยังอยู่) **ลำดับบนเครื่องใหม่:** `dcp build` → `restore.sh --certs --yes latest` → `restore.sh --yes latest` Caddy จึงเจอใบรับรองเดิมตั้งแต่ start ครั้งแรก
- **ล้มกลางทาง:** ถ้าล้มหลังหยุด api/web แต่ก่อนสลับ DB script จะ `up -d --wait` ให้เองเฉพาะเมื่อเดิมมันรันอยู่ (เครื่องใหม่ที่ยังไม่เคยรันจะไม่ถูก start บน DB ว่าง) และไม่ start ให้หลังสลับแล้วถ้า migrate ล้ม

**S3 และสิทธิ์ (ทำครั้งเดียว จากเครื่อง admin ด้วยสิทธิ์ admin ของบัญชี AWS ส่วนการสร้าง IAM role/instance profile ให้ EC2 อยู่ใน O4)** ชื่อ bucket, account id และ region จริงอยู่แค่ใน `deploy/production.env` บนเครื่องและในบัญชี AWS ห้าม commit ตัวอย่างใช้ `example-club-backups` และ prefix `prod`

```bash
BUCKET=example-club-backups      # ชื่อจริงห้าม commit
aws s3api create-bucket --bucket "$BUCKET" --region <region> \
  --create-bucket-configuration LocationConstraint=<region>
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration file://deploy/s3-lifecycle.example.json
sed "s/example-club-backups/$BUCKET/g" deploy/s3-backup-policy.example.json >/tmp/club-backup-policy.json
aws iam put-role-policy --role-name <ชื่อ role ของ EC2> --policy-name club-backup \
  --policy-document file:///tmp/club-backup-policy.json
```

- **Policy ของ role (`deploy/s3-backup-policy.example.json`, least privilege):** `s3:ListBucket` บน bucket โดยมีเงื่อนไข `s3:prefix` = `prod/*` (ใช้หา `latest` และตรวจ object), `s3:PutObject` + `s3:GetObject` (+ `s3:AbortMultipartUpload` สำหรับ upload ไฟล์ใหญ่ที่ล้มกลางทาง) บน `prod/*` เท่านั้น **ไม่มี `s3:DeleteObject`** หรือสิทธิ์ของ bucket อื่น/สิทธิ์ตั้งค่า bucket ถ้าเครื่องถูกยึด ผู้บุกรุกลบ backup ไม่ได้ ส่วนการเขียนทับ object เดิม (`PutObject` ทำได้) ป้องกันด้วย **versioning** (เวอร์ชันเก่ายังอยู่) เปลี่ยน prefix ต้องแก้ทั้งสองไฟล์ JSON และ `BACKUP_S3_URI` ให้ตรงกัน เทสต์รันทั้ง backup และ restore ด้วย user ที่มีแค่ policy นี้ (ใน MinIO) และตรวจว่าลบและ list นอก prefix ไม่ได้
- **เข้ารหัส:** SSE-S3 (AES-256 ฝั่ง AWS ทุก object, script ส่ง `--sse AES256` เอง) ระหว่างทางเป็น HTTPS ของ AWS CLI ถ้าต้องการคุมกุญแจเอง/ดู audit การถอดรหัสใช้ SSE-KMS ได้ (ต้องเพิ่มสิทธิ์ `kms:` ใน policy) ไม่ได้ทำใน O3
- **Retention (`deploy/s3-lifecycle.example.json`):** object ใต้ `prod/` หมดอายุ 400 วัน (ครอบคลุม 1 ปีการศึกษาและรอบถัดไป เพราะระบบใช้ปีละ 2–4 ครั้ง ถ้าตั้งสั้นเช่น 90 วัน ช่วงระหว่างเทอมอาจไม่เหลือ backup เลย) เวอร์ชันที่ถูกเขียนทับ/หมดอายุถูกลบจริงหลัง 30 วัน และล้าง multipart ที่ค้าง 7 วัน **ปรับตามนโยบาย PDPA ของโรงเรียน** (เก็บข้อมูลนักเรียนไม่นานกว่าที่จำเป็น) ไฟล์ในเครื่องเก็บ `BACKUP_KEEP_LOCAL` ไฟล์ล่าสุด (default 7)

**ถ้า S3 ใช้ไม่ได้** (network, สิทธิ์, AWS ล่ม): `backup.sh` ปกติจบด้วย exit 4 แต่ไฟล์ที่ตรวจแล้วอยู่ใน `BACKUP_DIR` และข้อความบอกคำสั่ง `aws s3 cp … --sse AES256` ให้ upload ซ้ำเมื่อ S3 กลับมา (หรือรอรอบถัดไป) ถ้ารู้ล่วงหน้าว่าใช้ไม่ได้ใช้ `--local-only` (exit 0) restore ใช้ `latest-local` หรือ path ของไฟล์ได้โดยไม่แตะ S3 ข้อจำกัด: สำเนาในเครื่องอยู่บน EBS เดียวกับ DB ป้องกันข้อมูลเสียหาย/ลบผิดได้ แต่ไม่ช่วยถ้า EBS หรือเครื่องหาย

**RPO/RTO (ประเมิน ยังไม่ได้วัดบนเครื่องจริง)**

- **RPO (ข้อมูลที่อาจหาย) = เวลานับจาก backup ที่สำเร็จล่าสุด** ตอนนี้ยังรันด้วยมือ (หลังปิดรอบตาม runbook) ถ้าเครื่องพังระหว่างรอบเปิด การลง/ยกเลิกตั้งแต่ backup ล่าสุดหายทั้งหมด O4 จะตั้ง timer (เสนอ: ทุก 15 นาทีระหว่างรอบเปิด และวันละครั้งนอกนั้น) RPO จึงจะเหลือ ≤ ~15 นาที ระหว่างนี้ให้รัน `backup.sh` เองก่อนและหลังเปิดรอบ ก่อนยืนยัน import และก่อน deploy ที่มี migration
- **RTO (เวลากลับมาใช้ได้):** เครื่องเดิมยังอยู่ (DB เสีย/ลบผิด): smoke test กู้ข้อมูลสมมติ 40 คนจาก S3 จนทุก service healthy ใน 13 วินาที บนเครื่องพัฒนา ข้อมูลจริงหลักสิบ MB น่าจะเป็นหลักนาที เครื่องใหม่ทั้งหมด: เตรียม EC2 + `git clone` + env file + `dcp build` + restore ตาม O4 ประเมิน ~30–60 นาที (ส่วนใหญ่คือ build บน t4g.small) ยังไม่ได้ลองจริง

**Smoke test:** `scripts/smoke-backup.sh` (ต้องมี Docker + Compose v2, curl, `flock`) ใช้ stack จริงจาก `compose.prod.yml` (`SITE_ADDRESS=:80`, project name ไม่ซ้ำ, พอร์ต 18081/18444 ตั้งด้วย `SMOKE_BACKUP_HTTP_PORT`/`SMOKE_BACKUP_HTTPS_PORT`) กับ MinIO ที่ pin tag + digest เป็น S3 (MinIO เลิกออก image เอง จึงใช้ build ชุมชนสุดท้ายของ Bitnami `bitnamilegacy/minio` เฉพาะในเทสต์) เปิด SSE-S3 ด้วย KMS key ในตัว สร้าง bucket ที่เปิด versioning + lifecycle ตามไฟล์ตัวอย่าง และ user ที่มีแค่ policy ตามไฟล์ตัวอย่าง credential ทั้งหมดสุ่มต่อรอบและไม่พิมพ์ ข้อมูลสมมติ: admin จาก `create-admin` ที่เปลี่ยนรหัสผ่าน API จริง, รอบ, 5 ชุมนุม + ครู, นักเรียน 40 คน, ลง 30 คนพร้อม `registered` และ event ที่ตรงกัน ตรวจ (ลำดับเดียวกับลำดับบนเครื่องใหม่): (1) backup → object ชื่อ `<db>-<UTC>.dump` มีอยู่ เข้ารหัส (`ServerSideEncryption: AES256`) ขนาดตรงไฟล์ในเครื่อง ไฟล์ 600 ไดเรกทอรี 700 archive ใบรับรองครบ policy ลบ object และ list นอก prefix ไม่ได้ lock กันรันซ้อน (exit 3 ไม่มี dump เพิ่ม) (2) แก้ข้อมูลหลัง backup → `restore.sh latest` ไม่มี `--yes` ได้ exit 2 ข้อมูลและ api ไม่เปลี่ยน → `down -v` ลบทั้ง stack และ volume → `restore.sh --certs` (ไม่มี `--yes` ถูกปฏิเสธ ไม่สร้างอะไร มี `--yes` ได้ `/data` คืนลง volume ใหม่) → `restore.sh --yes latest` → api/web healthy, migrate จบด้วย 0, จำนวนแถวและ checksum ของทุกตารางเท่ากับตอน backup, invariant ผ่าน, `club_app` ยังมีสิทธิ์เขียน (ไม่ใช่แก้) event log และแก้ชุมนุมได้, admin login ผ่าน Caddy ด้วยรหัสที่เปลี่ยนก่อน backup (3) ซ้อมลง scratch DB: ข้อมูลตรง backup, production และ api ไม่ถูกแตะ, DB ที่มีอยู่แล้วต้อง `--yes`, ไม่มี `--keep` ลบทิ้ง, ชื่อ production ถูกปฏิเสธ (4) dump ที่ถูกตัดครึ่งและไฟล์ขยะถูกปฏิเสธด้วย exit 1 ก่อนหยุดอะไร api ไม่ถูก restart ข้อมูลไม่เปลี่ยน ส่วน dump ที่สมบูรณ์แต่เป็นของ DB อื่น ล้มหลังหยุด api/web แล้ว ข้อมูลไม่เปลี่ยนและ stack กลับมา healthy เอง (5) S3 ต่อไม่ได้ → exit 4 พร้อมไฟล์ในเครื่อง, `--local-only` exit 0 ไม่ upload, เก็บไฟล์ในเครื่องแค่ `BACKUP_KEEP_LOCAL` (6) output ของทุก script ไม่มีชื่อสมมติหรือ hash รหัสผ่าน ใช้ AWS CLI ของ host ถ้ามี (runner `ubuntu-24.04` ของ GitHub ติดตั้งไว้แล้ว) ถ้าไม่มีใช้ image `amazon/aws-cli` ที่ pin ไว้ผ่าน wrapper เฉพาะในเทสต์ (`SMOKE_AWS_CONTAINER=1` บังคับใช้) ลบทุกอย่างด้วย `trap` CI รันต่อจาก `smoke-compose.sh` ใน job `images` ส่วน shellcheck ของ script ทุกตัว (ทุกไฟล์ `*.sh` ที่ git track และไฟล์ที่ไม่มีนามสกุลแต่ขึ้นต้นด้วย shebang ของ sh/bash) รันใน job `check` ด้วย `scripts/lint-shell.sh` (`pnpm lint:sh`) ใช้ shellcheck ของ Ubuntu 24.04 (0.9.0) และ `.shellcheckrc` ให้ตาม `source` ไปที่ `scripts/lib/` ถ้าในเครื่องไม่มี shellcheck ใช้ `docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable scripts/*.sh scripts/lib/*.sh` แทนได้ (`stable` อาจใหม่กว่า 0.9.0 ของ CI จึงอาจเจอ finding ที่ CI ไม่เจอ ผลของ CI คือตัวตัดสิน) script ทั้งหมดเขียนสำหรับ Linux (GNU coreutils/findutils, `flock` จาก util-linux)

**ยังไม่อยู่ใน O3:** ตั้งเวลา backup ด้วย systemd timer/cron, ติดตั้ง AWS CLI, สร้าง IAM role/instance profile และ bucket จริง, แจ้งเตือนเมื่อ backup ล้ม (O4) และยังไม่ได้ทดสอบกับ S3 จริง/IAM role จริงของ EC2 (เทสต์ใช้ MinIO) ต้องลอง `backup.sh` + ซ้อม `--target-db` บนเครื่องจริงครั้งแรก

### Environment variables

| Env | ใช้ที่ | ความหมาย |
|---|---|---|
| `DATABASE_URL` | api, migrate, create-admin | connection string ใน production: migrate ใช้ของเจ้าของ DB (`DATABASE_URL` ใน env file) ส่วน api และ create-admin ได้ `APP_DATABASE_URL` (`club_app`) จาก `compose.prod.yml` ตอน dev ใช้ตัวเดียวกันหมด |
| `APP_DB_PASSWORD` | migrate | รหัสของ `club_app` (hex ตัวเล็ก ≥ 32 ตัว สร้างด้วย `openssl rand -hex 24`) migrate ตั้งให้ทุกครั้ง ไม่ตั้ง = ไม่แตะ login ของ role (dev) `compose.prod.yml` บังคับให้ตั้ง |
| `APP_DATABASE_URL` | env file ของ production | URL ของ `club_app` ที่ compose ส่งให้ api เป็น `DATABASE_URL` ประกอบจาก `APP_DB_PASSWORD` ใน template แล้ว |
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
| `BACKUP_S3_URI` | `backup.sh`, `restore.sh` | `s3://<bucket>/<prefix>` ที่เก็บ backup (เช่น `s3://example-club-backups/prod` ชื่อจริงห้าม commit) ว่าง = `backup.sh` ไม่ยอมรันถ้าไม่ใส่ `--local-only` |
| `BACKUP_AWS_REGION` | `backup.sh`, `restore.sh` | region ของ bucket (export เป็น `AWS_REGION`) ว่าง = ใช้ค่าของ AWS CLI เอง |
| `BACKUP_DIR` | `backup.sh`, `restore.sh` | ที่เก็บสำเนาในเครื่อง default `/var/backups/club-registration` (script ตั้งเป็น 700 ไฟล์ 600) และไฟล์ lock `.lock` |
| `BACKUP_KEEP_LOCAL` | `backup.sh` | จำนวนสำเนาในเครื่องที่เก็บ (ล่าสุด) default 7 ของใน S3 หมดอายุด้วย lifecycle |
| `PROD_ENV_FILE` | `backup.sh`, `restore.sh` | env file ที่ใช้ default `deploy/production.env` (ตั้งใน environment ของ shell ไม่ใช่ในไฟล์) |

- `DB_*` ทั้ง 4 ตัว (O2) เป็นจำนวนเต็มบวก timeout ไม่เกิน 600000 (ไม่ยอม `0` ซึ่ง `pg` แปลว่าไม่จำกัด) ค่าว่างหรือไม่ตั้ง = default ซึ่งเท่ากับค่าเดิมก่อนตั้งได้ ค่าผิด = ไม่ start และบอกแค่ชื่อตัวแปร ตรวจด้วย Zod ใน `apps/api/src/config.ts` (`migrate` ไม่ใช้ pool จึงไม่สนตัวแปรเหล่านี้) **ค่า default ยังเป็นค่าประเมิน** ตัดสินด้วย load test (O5)
- `GOMEMLIMIT` (web) และ `NODE_OPTIONS` (api) ตั้งไว้ใน `compose.prod.yml` ให้ตรงกับ memory limit ไม่ได้อยู่ใน env file
- `BACKUP_*` อยู่ใน env file เดียวกันแต่ compose ไม่อ่าน script อ่านเป็นข้อมูล (ไม่ `source` ไฟล์) ค่าใน environment ของ shell ชนะค่าในไฟล์ ตัวแปร `AWS_*` (`AWS_REGION`, `AWS_ENDPOINT_URL` ฯลฯ) ส่งผ่านถึง AWS CLI ตรงๆ และ `COMPOSE_PROJECT_NAME` ใช้เลือก stack อื่นได้ (smoke test ใช้)

**ออกแบบให้ portable:** migration เป็นคำสั่งแยก (`node dist/migrate.js`), `GET /api/health` เช็ค DB, graceful shutdown (SIGTERM), log JSON ออก stdout, ไม่เก็บ state บน disk ของ app

### Portability, ค่าใช้จ่าย และ runbook

ย้ายไปที่อื่น = เปลี่ยน 3 อย่าง: ใครให้ Postgres, ใครทำ HTTPS, ใครเก็บ env/secret

| Infra | วิธี |
|---|---|
| EC2 / VPS อื่น | Compose ไฟล์เดิม |
| PaaS (Render/Railway/Fly) | ชี้ Dockerfile (target `api`/`web`) + Postgres ของ platform (ไม่แนะนำสำหรับวันจริง) |
| ECS/App Runner | push image ไป ECR + RDS + ALB, `TRUST_PROXY=true` |

ทุกทางที่มี load balancer ของ platform อยู่หน้า Caddy/api ต้องตั้งเรื่อง IP ของ client ก่อน ดู [รายการที่ยังเปิดอยู่](#รายการที่ยังเปิดอยู่) ข้อ 16

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

1. 1–2 วันก่อนเปิดรอบ: start เครื่อง → `scripts/backup.sh` (ก่อนแตะอะไร) → `apt upgrade` + อัปเดตตาม [ขั้นตอนอัปเดต](#compose-ของ-production-o2) (`git pull` → `build` → `up -d --wait` build บนเครื่องเอง ไม่มี registry) → ซ้อมกู้ `scripts/restore.sh --target-db drill_check latest` → ลองเปิดเว็บและ login (ขั้นตอนเต็มบน EC2 อยู่ใน O4)
2. วันจริง: เฝ้า log/CPU/RAM และรัน `scripts/backup.sh` เป็นระยะระหว่างรอบเปิด (จนกว่า O4 จะตั้ง timer ให้) ถ้าต้องกู้ดู [Backup และ Restore (O3)](#backup-และ-restore-o3)
3. หลังปิดรอบ: export รายชื่อ → `scripts/backup.sh --include-certs` → ตรวจว่า exit 0 และมี object ใหม่ (`aws s3 ls <BACKUP_S3_URI>/` เห็นไฟล์ชื่อเวลาล่าสุด) → stop เครื่อง (exit 4 = upload ไม่สำเร็จ ห้าม stop จนกว่าจะ upload ได้)
4. Compose ตั้ง `restart: unless-stopped` (ยกเว้น `migrate` ที่รันครั้งเดียวต่อ `up`)

**ความเสี่ยงที่ยอมรับ:** เครื่องเดียว = single point of failure ต้องมี backup + runbook สั้นๆ pool ของ `pg` (default 20 ปรับด้วย `DB_POOL_MAX`) และ memory limit ใน `compose.prod.yml` ต้องเหมาะกับ RAM 2 GB ยังเป็นค่าประเมินจนกว่าจะ load test (O5)

### Dependency audit

- **Gate:** `pnpm audit:deps` (`pnpm audit --audit-level high`) อ่านแค่ `pnpm-lock.yaml` ไม่ต้อง install ล้มเมื่อมี advisory ระดับ high/critical ส่วน moderate/low แสดงในผลแต่ไม่ล้ม รันใน `.github/workflows/audit.yml` ทุก PR, push เข้า `main` และทุกวัน 08:23 น. (advisory ที่ออกหลัง merge ไม่ทำให้ repo เปลี่ยน จึงต้องมีรอบตามเวลา ถ้ารอบตามเวลาล้ม GitHub ส่งอีเมลหาคนที่แก้ schedule ล่าสุด)
- **Ignore:** ทำได้เฉพาะ advisory ที่ยังไม่มีเวอร์ชันแก้และเข้าไม่ถึง app ใส่ GHSA ใน `auditConfig.ignoreGhsas` ของ `pnpm-workspace.yaml` พร้อมเหตุผล และลบทันทีที่มีเวอร์ชันแก้ ห้ามลด `--audit-level` เพื่อให้ผ่าน ตอนนี้ ignore 1 ตัว: `picomatch` ≤ 4.0.7 ReDoS (GHSA-fc5q-39xc-vjpf) ยังไม่มีเวอร์ชันแก้ และอยู่แค่ใน dev tooling (vite, vitest, eslint, tailwind) ซึ่งใช้ pattern จาก config ของ repo เอง ไม่ใช่จาก request หรือไฟล์ที่อัปโหลด
- **Moderate ที่ยังเปิดอยู่** (ณ 2026-11-18 ทุกตัวแก้ได้เฉพาะ major ใหม่ที่ package แม่ยังไม่ขยับไป การบังคับด้วย `overrides` ข้าม major เสี่ยงกว่าตัวช่องโหว่เอง รอ package แม่อัปเดตผ่าน Dependabot):
  - `uuid` 8.3.2 ผ่าน `exceljs` (production) ช่องโหว่อยู่ที่ v3/v5/v6 เมื่อส่ง `buf` เข้าไป
  - `glob` 10.x/13.x ผ่าน `node-pg-migrate` (production, ใช้หาไฟล์ migration ใน repo) และ `testcontainers` (dev)
  - `minimatch` 9.x/10.x ผ่าน `eslint`, `node-pg-migrate` และ `testcontainers` ใช้กับ pattern ของ repo เอง
- **Dependabot** (`.github/dependabot.yml`): เปิด PR อัปเดต npm (minor/patch รวมเป็น PR เดียว major แยก PR) และ GitHub Actions (อัปเดต SHA ที่ pin ไว้) ทุกวันจันทร์ ข้าม major ของ `typescript` (pin 6.0.x) และ `@types/node` (ตาม Node 24) ส่วน security update อัตโนมัติต้องเปิดที่ Settings ของ repo (Dependabot security updates) ไม่ได้มาจากไฟล์นี้ base image ใน `Dockerfile` (`ARG ...@sha256`) และ `compose.prod.yml` ยังอัปเดตด้วยมือ

## Testing

- **Vitest + Testcontainers** ใช้ Postgres จริง ห้าม mock และต่อด้วย role `club_app` เหมือน api ใน production (`appConnectionUri` ใน `apps/api/test/support/postgres.ts`)
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

**เรื่องที่ค้างจากงานที่ทำแล้ว** (เจอระหว่างรีวิว ไม่ block การใช้งาน Phase 1 ข้อที่ขีดฆ่าแก้แล้วหรือปิดด้วยการตัดสินใจ)

| # | เรื่อง | ผลกระทบ | ทางที่คิดไว้ |
|---|---|---|---|
| 8 | ~~รอบของภาคเรียนเก่ายังเปิดอยู่ตอน import ภาคเรียนใหม่ย้ายชั้นนักเรียน~~ | ~~นักเรียนยังถือที่นั่งในรอบเก่าและยกเลิกเองไม่ได้~~ | **แก้แล้ว:** import ปฏิเสธการย้ายชั้นเมื่อมีที่นั่งในรอบที่ยังไม่ปิดของภาคเรียนอื่น และขั้นยืนยันล็อกรอบเหล่านั้นด้วย (ดู [Excel Import/Export](#excel-importexport) ข้อ 3) |
| 9 | ~~ออกรหัสผ่านเริ่มต้นพร้อมกับยืนยัน import~~ | ~~deadlock 40P01 admin เห็น 500~~ | **แก้แล้ว:** การออกรหัสผ่านถือ import lock ก่อน row lock ทั้งสองงานจึงทำทีละงาน (ดู [Security](#security)) |
| 10 | ~~เลขหน้า PDF นับต่อทั้งไฟล์~~ | ~~export ทั้งรอบแล้วพิมพ์แยกให้ครูแต่ละคน เลขหน้าจะไม่เริ่มที่ 1~~ | **แก้แล้ว:** นับใหม่ต่อชุมนุม/ห้อง ("หน้า 1/2" ของชุมนุม/ห้องนั้น ดู [Export รายชื่อ](#export-รายชื่อ)) |
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
