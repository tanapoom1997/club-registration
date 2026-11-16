# club-registration

ระบบลงทะเบียนชุมนุมของโรงเรียน สำหรับนักเรียน ~2,500 คน แบ่งรอบตามชั้น ม.1–ม.6 รอบละ ~400–450 คน

> **สถานะ:** Phase 1 ทำ Auth + role guard เสร็จแล้ว (login, บังคับเปลี่ยนรหัสครั้งแรก, logout, `create-admin`, หน้า FE ตาม role) admin จัดการรอบลงทะเบียนได้แล้ว (`/api/admin/rounds` + หน้า `/admin/rounds`) นำเข้า Excel ได้แล้วทั้งขั้นตรวจ (dry run) และขั้นยืนยัน (`/api/admin/import/preview`, `/api/admin/import/commit` + หน้า `/admin/import`) ออกรหัสผ่านเริ่มต้นให้นักเรียนเป็นไฟล์ Excel ได้แล้ว (`/api/admin/students/password-status`, `/api/admin/students/initial-passwords` + หน้า `/admin/initial-passwords`) และดู/แก้ชุมนุมรายรอบได้แล้ว (`/api/admin/rounds/:roundId/clubs`, `/api/admin/clubs/:id` + หน้า `/admin/clubs`) ต่อจาก monorepo, migration แรก และ `GET /api/health` ยังไม่มี logic ลงทะเบียน เอกสารนี้คือแผนและข้อกำหนดของโปรเจกต์
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
- **ดูแลง่าย ต้นทุนต่ำ** Docker image เดียวบน EC2 เครื่องเดียว คาดว่าไม่เกิน ~$40 ต่อปี (ประเมิน ยังไม่ได้ตรวจราคาจริง)

> ทั้งหมดเป็นดีไซน์ตามแผน ยังไม่ได้ implement ดูความคืบหน้าที่หัวข้อ [Roadmap](#roadmap)

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

ครูไม่ login ข้อมูลครูเก็บไว้ในชุมนุม (ชื่อ, เบอร์, อีเมล, LINE ID เป็น optional) และ admin export รายชื่อให้ครูแทน

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
| PDF | ยังไม่เลือก | ต้องวางภาษาไทยถูกต้อง ดูรายการที่ยังเปิดอยู่ข้อ 6 |
| Test | Vitest + Testcontainers | concurrency test ต้องใช้ Postgres จริง ห้าม mock |
| Repo | pnpm workspaces (monorepo เดียว) | แชร์ Zod/type, PR เดียวแก้ได้ทั้งระบบ |
| Deploy | Docker image เดียว + Compose + Caddy บน EC2 | เครื่องเดียว ดูแลง่าย |

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
│   ├── api/        # Fastify + pg + migrations
│   └── web/        # Vite + React
├── packages/
│   └── shared/     # Zod schema + type ที่ใช้ร่วมกัน
├── templates/      # Excel template เปล่า (ไม่มีข้อมูลจริง)
├── Dockerfile
├── docker-compose.yml
├── Caddyfile
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

**จุดวิกฤต: การจองที่นั่ง**

```sql
BEGIN;
INSERT INTO registrations (round_id, student_id, club_id) VALUES (...);  -- ซ้ำ → unique_violation
UPDATE clubs SET registered = registered + 1
WHERE id = $club AND round_id = $round AND registered < capacity;        -- 0 rows → ROLLBACK "เต็ม"
INSERT INTO registration_events (...);
COMMIT;
```

- **Idempotent:** client retry เจอ unique violation → ถ้าเป็นชุมนุมเดิมตอบ 200 พร้อมผลเดิม
- ต้องเช็คใน app ด้วยว่าอยู่ในช่วง `opens_at`–`closes_at` และ `student.grade = round.grade`

## Roadmap

### Phase 1: ลงทะเบียนได้จริงและปลอดภัย

**เป้าหมาย:** admin เตรียมข้อมูล → นักเรียนลง/ยกเลิกถูกกติกา → admin ได้รายชื่อ

1. ~~**Auth:** login รหัสนักเรียน + รหัสเริ่มต้นสุ่มรายคน, บังคับเปลี่ยนรหัสครั้งแรก, role `student`/`admin` (JWT, secret จาก env)~~ เสร็จแล้ว
2. ~~**Admin import Excel:** students, clubs, advisors → dry run → ยืนยัน → upsert ใน transaction เดียว~~ เสร็จแล้ว รวมขั้นออกรหัสผ่านเริ่มต้นให้นักเรียนที่นำเข้า (ดูหัวข้อ [Security](#security))
3. ~~**Admin จัดการรอบ:** สร้างรอบต่อชั้น กำหนด `opens_at`/`closes_at`~~ เสร็จแล้ว (สร้างทีละชั้นหรือครบ ม.1–ม.6, แก้เวลา/`max_active`, ลบรอบที่ยังไม่มีชุมนุม, สถานะคำนวณตอนอ่าน) และ**หน้าชุมนุมรายรอบ**เสร็จแล้ว:
   - `GET /api/admin/rounds/:roundId/clubs` คืนรอบ (สถานะ + ยอดรวม) และชุมนุมเรียงตามรหัส: ชื่อ, รายละเอียด, จำนวนรับ, ลงแล้ว, เหลือ, ครู (รวมเบอร์/อีเมล/LINE เฉพาะ admin และไม่ log)
   - `PATCH /api/admin/clubs/:id` แก้ได้เฉพาะชื่อ รายละเอียด จำนวนรับ (รหัสชุมนุมและ `registered` แก้ไม่ได้) ลดจำนวนรับต่ำกว่าที่ลงแล้ว → `409 capacity_below_registered` ซึ่งมาจาก `CHECK` ของ DB ไม่ใช่การเช็คใน app (UPDATE เดียว รอ row lock เดียวกับการลง จึงนับคนที่เพิ่ง commit เสมอ) เพิ่มจำนวนรับระหว่างรอบเปิดได้ (Phase 2 ต้อง promote waitlist ใน transaction เดียวกัน) ไม่รับ `idempotency_key` เหมือน endpoint ของรอบ เพราะส่งซ้ำได้ผลเดิม
   - หน้า `/admin/clubs` เลือกรอบ → ตาราง → แก้ในฟอร์มโดยส่งเฉพาะช่องที่เปลี่ยน poll ทุก 5 วินาทีเฉพาะรอบที่เปิดอยู่ (รอบที่เพิ่งเปิดระหว่างดูหน้าอยู่ต้องโหลดหน้าใหม่) รายละเอียดแสดงเป็นข้อความล้วน
4. **นักเรียน:** ดูรายการชุมนุมในชั้นตัวเอง (ครู, ที่เหลือ), ลง, ยกเลิก, ดูผลของฉัน
5. **กติกาที่ DB:** 1 คน 1 ชุมนุม, ห้ามเกิน capacity, เฉพาะชั้นตัวเอง, เฉพาะช่วงเปิดรอบ
6. **Idempotency + event log**
7. **Admin export:** รายชื่อแบบ **รายชุมนุม** และ **รายห้อง** เลือกได้ทั้ง **Excel** และ **PDF** (รายละเอียดดูหัวข้อ [Export รายชื่อ](#export-รายชื่อ))
8. **Ops:** Dockerfile, `docker-compose.yml`, Caddy HTTPS, `/api/health`, migration script แยก, graceful shutdown, backup `pg_dump` ไป S3, runbook (deploy/backup/restore/เปิด-ปิดเครื่อง)
9. **Test:** concurrency test + invariant `clubs.registered` = จำนวน registration จริง

**ยังไม่อยู่ใน Phase 1:** queue, waitlist, เปลี่ยนชุมนุมแบบ atomic, admin เพิ่ม/ลบ/ย้ายนักเรียนแทน

> ถ้าต้องใช้จริงก่อนมี queue ให้เปิดรอบทีละชั้นและเหลื่อมเวลา เพื่อคุม load
>
> Migration แรกควรสร้างตารางของ phase หลัง (`waitlist_entries`, `queue_tickets`, event types ครบ) ไว้ก่อน แต่ยังไม่ต้องเขียน logic

### Phase 2: เปลี่ยนชุมนุม + Waitlist + Admin แก้แทน

**Locking:** ทุก write transaction ในรอบเริ่มด้วย `SELECT pg_advisory_xact_lock($round_id)` → serialize ต่อรอบ ไม่มี deadlock และ logic ง่าย (แลกกับการไม่ขนานข้ามชุมนุม ซึ่งที่ ~450 คนต่อรอบน่าจะรับได้ ต้อง load test)

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
3. ยืนยัน → ส่งไฟล์เดิมซ้ำพร้อม sha256 ที่ได้จากขั้นตรวจ (server ไม่เก็บไฟล์ไว้ระหว่างสองขั้น ถ้า hash ไม่ตรง = `409 import_file_mismatch`) → ตรวจและเทียบกับ DB ใหม่ แล้วเขียนทั้งหมดใน transaction เดียว (error แถวเดียว = `422 import_invalid` ไม่เขียนเลย) การยืนยันทำได้ทีละครั้งทั้งระบบ (`pg_advisory_xact_lock`)
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
- **PDF:** ขนาด A4 แนวตั้ง ฝังฟอนต์ไทยที่ license อนุญาตให้แจกจ่าย (เช่น OFL) ท้ายหน้ามีวันเวลาที่ export (เวลาไทย) และเลขหน้า
- **Excel:** escape ค่าที่ขึ้นต้นด้วย `=`, `+`, `-`, `@` (และ tab/CR) เหมือนข้อมูลอื่น ใช้ `escapeCellText` จาก `apps/api/src/export/escape-cell.ts` ตัวเดียวกับไฟล์รหัสผ่านเริ่มต้น
- ชื่อไฟล์ใช้แค่รหัสรอบ/ชุมนุม/ห้อง ไม่ใส่ชื่อนักเรียนหรือครู
- เป็น endpoint อ่าน ไม่มี side effect และต้องเป็น role `admin` เท่านั้น
- **ความเสี่ยง:** ไลบรารีสร้าง PDF ฝั่ง server บางตัววางสระบน/ล่างและวรรณยุกต์ภาษาไทยผิดตำแหน่ง ต้องลองกับชื่อสมมติที่มีสระบน/ล่างและวรรณยุกต์ก่อนเลือกไลบรารี (ดูรายการที่ยังเปิดอยู่ข้อ 6)

## Security

- **รหัสผ่านเริ่มต้น:** สุ่มรายคน (10 ตัว ไม่มีตัวที่อ่านสับสน) ห้ามใช้เลขบัตร/วันเกิด ไม่มีที่ไหนเก็บรหัสจริง: admin เลือกชั้น (ห้องเดียวหรือทั้งชั้น ครั้งละไม่เกิน 1 ชั้น) แล้วกดออกรหัส server สุ่มและ hash (argon2id) แล้วตอบเป็นไฟล์ .xlsx ทันที (1 ชีตต่อห้อง, `Cache-Control: no-store`, ชื่อไฟล์มีแค่ชั้น/ห้อง) ไฟล์นั้นคือสำเนาเดียว ทำหาย = ออกใหม่ ซึ่งทำให้รหัสเดิมใช้ไม่ได้ทันทีและ bump `session_version` ออกให้ได้เฉพาะนักเรียนที่ `must_change_password` ยังเป็นจริง นักเรียนที่ตั้งรหัสเองแล้วจะไม่ถูกเขียนทับ (การรีเซ็ตรหัสที่ลืมของนักเรียนที่ใช้งานแล้วยังไม่มี) บังคับเปลี่ยนตอน login แรก
  - hash ก่อนเปิด transaction (จำกัดทำพร้อมกัน 2 งานทั้ง server ให้ login ยังได้ thread) แล้วใน transaction สั้นๆ lock แถวที่ยังมีสิทธิ์ด้วย `SELECT … FOR NO KEY UPDATE` เขียนเฉพาะแถวนั้น ไฟล์มีเฉพาะคนที่ถูกเขียนจริง นักเรียนที่เปลี่ยนรหัสระหว่างนั้นถูกข้าม admin สองคนออกขอบเขตเดียวกันพร้อมกัน → นักเรียนแต่ละคนมีรหัสที่ใช้ได้รหัสเดียว คือรหัสในไฟล์ของ request ที่ commit ทีหลัง
  - `idempotencyKey` ถูกเก็บใน `password_issuances` คู่กับการออก ส่ง key เดิมซ้ำ = `409 idempotency_key_reused` (ไม่ออกซ้ำ เพราะการออกซ้ำทำให้ไฟล์ที่อาจพิมพ์ไปแล้วใช้ไม่ได้) หน้าเว็บสร้าง key ใหม่ทุกครั้งที่กดยืนยัน
  - log เฉพาะ admin id, ขอบเขต, จำนวน และเวลา ไม่ log ชื่อ รหัสนักเรียน หรือรหัสผ่าน rate limit 20 ครั้ง/10 นาที ต่อ admin
  - วัดจริงในเทสต์ (เครื่องพัฒนา 4 vCPU ไม่ใช่สเปค production, 4 รอบ): ออกรหัส 450 คนใช้ 6.6–7.1 วินาทีต่อ request เกือบทั้งหมดคือ hash ส่วน transaction + สร้างไฟล์ใช้ไม่ถึง 0.1 วินาที ต้องวัดซ้ำบนเครื่องจริง
- **ตรวจสิทธิ์ที่ server ทุก endpoint** ไม่เชื่อ role/`student_id` จาก client ใช้ค่าจาก JWT เท่านั้น
- **Rate limit** ที่ `/auth/login` และ endpoint เขียน
- **Session:** JWT (HS256, อายุ 2 ชม.) อยู่ใน cookie `HttpOnly; Secure; SameSite=Strict; Path=/api` ไม่เก็บใน `localStorage` ทุก request เช็ค `users.session_version` กับค่าใน token → logout หรือเปลี่ยนรหัส = token เก่าทุกเครื่องใช้ไม่ได้ทันที (สำคัญกับคอมห้องแล็บที่ใช้ร่วมกัน) และถ้า role ใน DB เปลี่ยน token เดิมก็ใช้ไม่ได้
- **บังคับเปลี่ยนรหัสครั้งแรก:** ถ้า `must_change_password` ทุก route ตอบ `403 password_change_required` ยกเว้น `/auth/me`, `/auth/change-password`, `/auth/logout`
- **CSRF:** `SameSite=Strict` + endpoint เขียนรับเฉพาะ JSON (form ข้ามเว็บส่ง `application/json` ไม่ได้ถ้าไม่ผ่าน CORS preflight ซึ่งเราไม่เปิด) ส่วน route อัปโหลด (multipart ซึ่ง form ข้ามเว็บส่งได้) ตรวจเพิ่มว่า `Sec-Fetch-Site` เป็น `same-origin`/`none` หรือถ้าไม่มี header นี้ `Origin` (ถ้าส่งมา) ต้องตรงกับ host (`apps/api/src/http/same-origin.ts`) ไม่ผ่าน = `403`
- **Rate limit login:** 10 ครั้ง/15 นาที ต่อ IP + รหัสผู้ใช้ (คนอื่นแกล้งล็อกบัญชีนักเรียนจากที่อื่นไม่ได้) และ 600 ครั้ง/นาที ต่อ IP ที่ตั้งสูงเพราะทั้งโรงเรียนอาจออก NAT IP เดียว **ต้องปรับตอน load test** store อยู่ใน memory ใช้ได้เพราะเป็นเครื่องเดียว และหลัง Caddy ต้องตั้ง `TRUST_PROXY=true` ไม่อย่างนั้นทุก request จะมี IP ของ Caddy และนับรวมเป็นก้อนเดียว
- **Login ที่ไม่มีผู้ใช้** ยังคำนวณ argon2 หนึ่งรอบ เวลาตอบจึงไม่บอกว่ารหัสนักเรียนไหนมีอยู่จริง
- **Admin คนแรก:** `pnpm --filter api create-admin <login_id>` สุ่มรหัส 16 ตัว แสดงครั้งเดียว เก็บแค่ hash และต้องเปลี่ยนตอน login แรก
- **Secret:** `JWT_SECRET`, DB password อยู่ใน env / SSM Parameter Store ห้ามอยู่ใน repo หรือ image
- **ข้อมูลติดต่อครู:** นักเรียน ~2,500 คนจะเห็น ควรให้ครูยินยอม ถ้ามีช่องทางกลางของโรงเรียนให้ใช้อันนั้น ทุกช่องเป็น optional
- **Frontend:** ห้าม `dangerouslySetInnerHTML` กับ `description` ที่ admin กรอก
- **Log:** ไม่ใส่ secret/PII พอสำหรับ debug
- **Repo เป็น Public:** ห้ามมีข้อมูลจริงทุกชนิด (นักเรียน ครู domain จริง IP ชื่อ bucket) เปิด secret scanning และ push protection แล้ว `.gitignore` กัน `*.xlsx` จริง / `.env*` / `*.dump` (เว้น `templates/`) ถ้าเผลอ push secret ต้อง rotate ทันที ลบจาก history ไม่พอ

## Infra และ Deployment

Docker image ก้อนเดียว (multi-stage: build web → build api → runtime `node:24-slim`) Fastify เสิร์ฟ `/api/*` และ static ของ React ไม่ต้องมี CORS

```
EC2 (t4g.small) ──► Caddy (HTTPS อัตโนมัติ)
                      ├─► api (Fastify + static React)
                      └─► postgres (container + volume)
```

**Environment variables**

| Env | ความหมาย |
|---|---|
| `DATABASE_URL` | connection string |
| `JWT_SECRET` | secret สำหรับ sign token (≥ 32 ตัวอักษร สร้างด้วย `openssl rand -base64 48`) ขาดหรือสั้นไป = server ไม่ start |
| `PORT` | default 3000 |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | เมื่ออยู่หลัง proxy/LB |

**ออกแบบให้ portable:** migration เป็นคำสั่งแยก (`node dist/migrate.js`), `GET /api/health` เช็ค DB, graceful shutdown (SIGTERM), log JSON ออก stdout, ไม่เก็บ state บน disk ของ app

ย้ายไปที่อื่น = เปลี่ยน 3 อย่าง: ใครให้ Postgres, ใครทำ HTTPS, ใครเก็บ env/secret

| Infra | วิธี |
|---|---|
| EC2 / VPS อื่น | Compose ไฟล์เดิม |
| PaaS (Render/Railway/Fly) | ชี้ Dockerfile + Postgres ของ platform (ไม่แนะนำสำหรับวันจริง) |
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

1. 1–2 วันก่อนเปิดรอบ: start เครื่อง → `apt upgrade` + `docker compose pull` → smoke test
2. วันจริง: เฝ้า log/CPU/RAM
3. หลังปิดรอบ: export รายชื่อ → `pg_dump` ไป S3 → stop เครื่อง
4. Compose ตั้ง `restart: unless-stopped`

**ความเสี่ยงที่ยอมรับ:** เครื่องเดียว = single point of failure ต้องมี backup + runbook สั้นๆ ตั้ง pool ของ `pg` (เริ่ม ~20) ให้เหมาะกับ RAM 2 GB

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
| 3 | Domain สำหรับ HTTPS | รับจาก env, ใส่ขั้นตอน DNS ใน README |
| 4 | Elastic IP vs อัปเดต DNS ตอน boot | อัปเดต DNS (ถ้ามี domain) |
| 5 | Queue อยู่ Phase 3 ไหม | Phase 3 (ย้ายขึ้นได้ถ้ากังวลวันจริง) |
| 6 | สร้าง PDF ด้วยอะไร | ทำ spike ก่อน: ลองไลบรารีสร้าง PDF ฝั่ง server + ฟอนต์ไทย OFL กับชื่อที่มีสระบน/ล่างและวรรณยุกต์ ถ้าวางผิดให้ถอยไปใช้หน้า print ของเบราว์เซอร์ (CSS `@media print`) แล้วให้ admin กด "บันทึกเป็น PDF" เพิ่ม dependency ต้องถามก่อนตามกฎ |
| 7 | Export รายห้องต้องแยกตามรอบไหม | แยกตามรอบ (1 รอบ = 1 ชั้นอยู่แล้ว) |

## ขั้นตอนถัดไป

ทำต่อใน **Phase 1** โดยทำฝั่ง admin ให้ครบก่อน: export → แล้วจึง endpoint ลง/ยกเลิก **พร้อม concurrency test** และหน้านักเรียน → Ops (scaffold, migration แรก, auth + role guard, จัดการรอบ, import Excel, รหัสผ่านเริ่มต้น และหน้าชุมนุม เสร็จแล้ว)
