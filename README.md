# club-registration

ระบบลงทะเบียนชุมนุมของโรงเรียน สำหรับนักเรียน ~2,500 คน แบ่งรอบตามชั้น ม.1–ม.6 รอบละ ~400–450 คน

> **สถานะ:** วางแผน (ยังไม่เริ่มเขียนโค้ด) เอกสารนี้คือแผนและข้อกำหนดของโปรเจกต์
>
> **หมายเหตุ:** ตัวเลข performance ทั้งหมดเป็นการประเมินจากหลักการ ยังไม่ได้วัดจริง ต้อง load test ก่อนใช้งาน

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
| `admin` | import Excel, จัดการรอบ/ชุมนุม, export รายชื่อ, เพิ่ม/ลบ/ย้ายนักเรียนแทน, ดู event log |

ครูไม่ login ข้อมูลครูเก็บไว้ในชุมนุม (ชื่อ, เบอร์, อีเมล, LINE ID เป็น optional) และ admin export รายชื่อให้ครูแทน

## Tech Stack

| ชั้น | เลือก | เหตุผลสั้นๆ |
|---|---|---|
| ภาษา/Runtime | TypeScript (strict), Node.js 24 LTS | type safety, กลับมาแก้ปีหน้าได้ง่าย |
| Backend | Fastify + Zod (`fastify-type-provider-zod`) | เร็ว, validation + type จาก schema เดียว |
| Database | PostgreSQL + `pg` + SQL ตรงๆ | logic หลักคือ transaction/advisory lock ORM ซ่อนจนอ่านยาก |
| Migration | `node-pg-migrate` | เบา ไม่ผูกกับ ORM |
| Frontend | Vite + React + Tailwind/shadcn/ui | SPA หลัง login ไม่ต้อง SSR |
| Data fetching | TanStack Query | polling คิว/สถานะทำง่าย |
| Excel | `exceljs` | อ่าน/เขียน .xlsx |
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
users               -- นักเรียนและ admin (role: student | admin), password_hash, must_change_password
student_profiles    -- grade (1-6), classroom, seat_no
rounds              -- 1 รอบต่อชั้นต่อเทอม: term, grade, opens_at, closes_at, max_active
clubs               -- club_code, name, description, capacity, registered, round_id
club_advisors       -- ครูของชุมนุม: full_name, phone, email, line_id (optional ทั้งหมด)
registrations       -- สถานะปัจจุบัน UNIQUE(round_id, student_id)
registration_events -- log append-only: register/cancel/change/admin_*/waitlist_*, actor_id, idempotency_key
waitlist_entries    -- UNIQUE(round_id, student_id), เรียงตาม created_at
queue_tickets       -- status: waiting | admitted | expired | done
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

1. **Auth:** login รหัสนักเรียน + รหัสเริ่มต้นสุ่มรายคน, บังคับเปลี่ยนรหัสครั้งแรก, role `student`/`admin` (JWT, secret จาก env)
2. **Admin import Excel:** students, clubs, advisors → dry run → ยืนยัน → upsert ใน transaction เดียว
3. **Admin จัดการรอบ:** สร้างรอบต่อชั้น กำหนด `opens_at`/`closes_at`
4. **นักเรียน:** ดูรายการชุมนุมในชั้นตัวเอง (ครู, ที่เหลือ), ลง, ยกเลิก, ดูผลของฉัน
5. **กติกาที่ DB:** 1 คน 1 ชุมนุม, ห้ามเกิน capacity, เฉพาะชั้นตัวเอง, เฉพาะช่วงเปิดรอบ
6. **Idempotency + event log**
7. **Admin export:** รายชื่อรายชุมนุม CSV/Excel (escape ค่าที่ขึ้นต้นด้วย `=`, `+`, `-`, `@`)
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

**Template (3 sheet/ไฟล์)** — คอลัมน์เป็นการเดา ปรับตามไฟล์จริงของโรงเรียน

| Template | คอลัมน์ |
|---|---|
| students | รหัสนักเรียน, ชื่อ-สกุล, ชั้น, ห้อง, เลขที่ |
| clubs | รหัสชุมนุม, ชื่อชุมนุม, ชั้นที่เปิดรับ, จำนวนรับ, รายละเอียด |
| advisors | รหัสชุมนุม, ชื่อครู, เบอร์โทร, อีเมล, LINE ID (1 แถวต่อครู 1 คน) |

**Flow**

1. Admin อัปโหลด → **dry run** ไม่เขียน DB
2. สรุป: เพิ่มกี่แถว / อัปเดตกี่แถว / error แถวไหนเพราะอะไร
3. ยืนยัน → เขียนทั้งหมดใน transaction เดียว (error แถวเดียว = ไม่เขียนเลย)
4. **Upsert ตามรหัส** อัปโหลดซ้ำได้ไม่เกิดข้อมูลซ้ำ
5. Advisors **replace ทั้งชุดต่อชุมนุม** เพื่อให้ครูที่ถูกถอดหายจริง

**ข้อควรระวัง**

- ขนาดไฟล์ ≤ 5 MB, ตรวจ extension/MIME ฝั่ง server, ประมวลผลใน memory
- Export escape ค่าที่ขึ้นต้นด้วย `=`, `+`, `-`, `@` กัน formula injection
- ขอเฉพาะคอลัมน์ที่จำเป็น (PDPA) ไม่รับเลขบัตรประชาชน/ที่อยู่

## Security

- **รหัสผ่านเริ่มต้น:** สุ่มรายคน, เก็บเฉพาะ hash, admin ดาวน์โหลดรายการได้ครั้งเดียว, บังคับเปลี่ยนตอน login แรก ห้ามใช้เลขบัตร/วันเกิด
- **ตรวจสิทธิ์ที่ server ทุก endpoint** ไม่เชื่อ role/`student_id` จาก client ใช้ค่าจาก JWT เท่านั้น
- **Rate limit** ที่ `/auth/login` และ endpoint เขียน
- **Secret:** `JWT_SECRET`, DB password อยู่ใน env / SSM Parameter Store ห้ามอยู่ใน repo หรือ image
- **ข้อมูลติดต่อครู:** นักเรียน ~2,500 คนจะเห็น ควรให้ครูยินยอม ถ้ามีช่องทางกลางของโรงเรียนให้ใช้อันนั้น ทุกช่องเป็น optional
- **Frontend:** ห้าม `dangerouslySetInnerHTML` กับ `description` ที่ admin กรอก
- **Log:** ไม่ใส่ secret/PII พอสำหรับ debug
- **Repo:** ตั้งเป็น Private, เปิด secret scanning, `.gitignore` กัน `*.xlsx` จริง / `.env*` / `*.dump` (เว้น `templates/`)

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
| `JWT_SECRET` | secret สำหรับ sign token |
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

## ขั้นตอนถัดไป

เริ่ม **Phase 1**: scaffold monorepo → migration (ครบทุกตาราง) → auth + role guard → endpoint ลง/ยกเลิก **พร้อม concurrency test** → Excel import/export → frontend → Ops
