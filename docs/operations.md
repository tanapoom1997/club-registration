# Infra และ Deployment

Docker image 2 ตัวจาก `Dockerfile` เดียวที่ root (multi-stage) ทั้งสอง target ใช้ขั้น `pnpm install` ร่วมกัน BuildKit จึงลงครั้งเดียวและ cache ให้ทั้งคู่ และ pin base image ไว้ที่เดียว

- **`api`** (Node): Fastify ตอบเฉพาะ `/api/*` ไม่เสิร์ฟหน้าเว็บ (ไม่ใช้ `@fastify/static`)
- **`web`** (Caddy): เสิร์ฟไฟล์ build ของ React (static + SPA fallback) และ reverse proxy `/api/*` ไปที่ api browser เห็น origin เดียว จึงไม่ต้องมี CORS

```
EC2 (t4g.small) ──► web: Caddy (HTTPS อัตโนมัติเมื่อมี domain)
                      ├─ ไฟล์ React ใน /srv + SPA fallback
                      └─► api: Fastify (/api/*) ──► postgres (container + volume)
```

## Image (O1)

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
- **web:** `Caddyfile` ที่ root อ่าน env 2 ตัว (ตารางข้างล่าง) cache: ไฟล์ใน `/assets/` มี hash ในชื่อ ได้ `Cache-Control: public, max-age=31536000, immutable` เฉพาะไฟล์ที่มีจริง (ไฟล์ที่ไม่มี = 404 ไม่ fallback เป็น `index.html` แท็บที่เปิดค้างไว้ข้าม deploy แล้วขอ chunk ของหน้าเก่าจะได้ 404 และหน้าเว็บขึ้นข้อความพร้อมปุ่มโหลดหน้าใหม่) ที่เหลือรวม `index.html` เป็น `no-cache` (revalidate ด้วย ETag deploy ใหม่จึงเห็นทันที) บีบอัด zstd/gzip ไม่เขียน access log (จะมี IP และ path ของนักเรียนทุกคน) Caddy เขียนทับ `X-Forwarded-For` ที่ client ส่งมาเอง api จึงตั้ง `TRUST_PROXY=true` ได้โดยปลอม IP ไม่ได้ (ใช้ได้เมื่อ Caddy รับตรงจาก internet ถ้าอยู่หลัง load balancer ดู [รายการที่ยังเปิดอยู่](../README.md#รายการที่ยังเปิดอยู่) ข้อ 16)
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

## Compose ของ production (O2)

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
- **หลัง reboot:** Docker start `postgres`, `api`, `web` เองตาม `unless-stopped` (ไม่ผ่าน compose จึงไม่รอกันตาม `depends_on`) ไม่เป็นไรเพราะ api รอ DB เอง: ตอน start ต้องตรวจ role ของ DB ก่อน (ดู [Security](security.md#security)) ถ้ายังต่อไม่ได้จะ log `database not reachable yet` แล้วลองใหม่ทุก 2 วินาทีโดยยังไม่เปิดพอร์ต (Caddy ตอบ 502 ช่วงนั้น) พอ Postgres พร้อมก็เปิดเอง ถ้า DB ล่มหลัง start แล้ว `/api/health` ตอบ 503 จนกลับมา `migrate` ไม่รันซ้ำ (ไม่จำเป็น เพราะ migration ทำไปแล้วตอน deploy)

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

## Backup และ Restore (O3)

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

## Environment variables

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
| `QUEUE_IDLE_TIMEOUT_SECONDS` | api | ticket คิว (รอหรือ admitted) ที่ไม่ได้ heartbeat นานเกินนี้หมดอายุ ที่ไปถึงคนถัดไป default `60` (15–3600) หน้าเว็บ poll ทุก 3–5 วินาที (README Phase 3) |
| `QUEUE_ADMISSION_TTL_SECONDS` | api | นักเรียนที่ admitted แล้วเลือกชุมนุมได้นานสุดเท่านี้ (heartbeat ก็ไม่ต่อ) default `600` (60–7200) |
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
- `QUEUE_*` ทั้ง 2 ตัว (Phase 3 Q1) เป็นวินาที จำนวนเต็มในช่วงที่ระบุ ค่าว่างหรือไม่ตั้ง = default ค่าผิด = ไม่ start และบอกแค่ชื่อตัวแปร (Zod ใน `apps/api/src/config.ts`) **ค่า default เป็นค่าประเมิน** ปรับหลัง load test บน EC2 (O5) พร้อม `max_active` ของรอบ
- `GOMEMLIMIT` (web) และ `NODE_OPTIONS` (api) ตั้งไว้ใน `compose.prod.yml` ให้ตรงกับ memory limit ไม่ได้อยู่ใน env file
- `BACKUP_*` อยู่ใน env file เดียวกันแต่ compose ไม่อ่าน script อ่านเป็นข้อมูล (ไม่ `source` ไฟล์) ค่าใน environment ของ shell ชนะค่าในไฟล์ ตัวแปร `AWS_*` (`AWS_REGION`, `AWS_ENDPOINT_URL` ฯลฯ) ส่งผ่านถึง AWS CLI ตรงๆ และ `COMPOSE_PROJECT_NAME` ใช้เลือก stack อื่นได้ (smoke test ใช้)

**ออกแบบให้ portable:** migration เป็นคำสั่งแยก (`node dist/migrate.js`), `GET /api/health` เช็ค DB, graceful shutdown (SIGTERM), log JSON ออก stdout, ไม่เก็บ state บน disk ของ app

## Portability, ค่าใช้จ่าย และ runbook

ย้ายไปที่อื่น = เปลี่ยน 3 อย่าง: ใครให้ Postgres, ใครทำ HTTPS, ใครเก็บ env/secret

| Infra | วิธี |
|---|---|
| EC2 / VPS อื่น | Compose ไฟล์เดิม |
| PaaS (Render/Railway/Fly) | ชี้ Dockerfile (target `api`/`web`) + Postgres ของ platform (ไม่แนะนำสำหรับวันจริง) |
| ECS/App Runner | push image ไป ECR + RDS + ALB, `TRUST_PROXY=true` |

ทุกทางที่มี load balancer ของ platform อยู่หน้า Caddy/api ต้องตั้งเรื่อง IP ของ client ก่อน ดู [รายการที่ยังเปิดอยู่](../README.md#รายการที่ยังเปิดอยู่) ข้อ 16

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

## Dependency audit

- **Gate:** `pnpm audit:deps` (`pnpm audit --audit-level high`) อ่านแค่ `pnpm-lock.yaml` ไม่ต้อง install ล้มเมื่อมี advisory ระดับ high/critical ส่วน moderate/low แสดงในผลแต่ไม่ล้ม รันใน `.github/workflows/audit.yml` ทุก PR, push เข้า `main` และทุกวัน 08:23 น. (advisory ที่ออกหลัง merge ไม่ทำให้ repo เปลี่ยน จึงต้องมีรอบตามเวลา ถ้ารอบตามเวลาล้ม GitHub ส่งอีเมลหาคนที่แก้ schedule ล่าสุด)
- **Ignore:** ทำได้เฉพาะ advisory ที่ยังไม่มีเวอร์ชันแก้และเข้าไม่ถึง app ใส่ GHSA ใน `auditConfig.ignoreGhsas` ของ `pnpm-workspace.yaml` พร้อมเหตุผล และลบทันทีที่มีเวอร์ชันแก้ ห้ามลด `--audit-level` เพื่อให้ผ่าน ตอนนี้ ignore 1 ตัว: `picomatch` ≤ 4.0.7 ReDoS (GHSA-fc5q-39xc-vjpf) ยังไม่มีเวอร์ชันแก้ และอยู่แค่ใน dev tooling (vite, vitest, eslint, tailwind) ซึ่งใช้ pattern จาก config ของ repo เอง ไม่ใช่จาก request หรือไฟล์ที่อัปโหลด
- **Moderate ที่ยังเปิดอยู่** (ณ 2026-11-18 ทุกตัวแก้ได้เฉพาะ major ใหม่ที่ package แม่ยังไม่ขยับไป การบังคับด้วย `overrides` ข้าม major เสี่ยงกว่าตัวช่องโหว่เอง รอ package แม่อัปเดตผ่าน Dependabot):
  - `uuid` 8.3.2 ผ่าน `exceljs` (production) ช่องโหว่อยู่ที่ v3/v5/v6 เมื่อส่ง `buf` เข้าไป
  - `glob` 10.x/13.x ผ่าน `node-pg-migrate` (production, ใช้หาไฟล์ migration ใน repo) และ `testcontainers` (dev)
  - `minimatch` 9.x/10.x ผ่าน `eslint`, `node-pg-migrate` และ `testcontainers` ใช้กับ pattern ของ repo เอง
- **Dependabot** (`.github/dependabot.yml`): เปิด PR อัปเดต npm (minor/patch รวมเป็น PR เดียว major แยก PR) และ GitHub Actions (อัปเดต SHA ที่ pin ไว้) ทุกวันจันทร์ ข้าม major ของ `typescript` (pin 6.0.x) และ `@types/node` (ตาม Node 24) ส่วน security update อัตโนมัติต้องเปิดที่ Settings ของ repo (Dependabot security updates) ไม่ได้มาจากไฟล์นี้ base image ใน `Dockerfile` (`ARG ...@sha256`) และ `compose.prod.yml` ยังอัปเดตด้วยมือ
