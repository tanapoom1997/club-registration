# CLAUDE.md

ระบบลงทะเบียนชุมนุมโรงเรียน (นักเรียน ~2,500 คน, รอบละ ~450 concurrent) แผนเต็ม สถาปัตยกรรม data model และ roadmap อยู่ใน [README.md](README.md) อ่านก่อนเริ่มงานทุกครั้ง ไฟล์นี้เก็บเฉพาะกติกาการทำงานที่ต้องไม่หลุด

**สถานะ:** ยังอยู่ช่วงวางแผน ยังไม่มีโค้ด เมื่อ scaffold เสร็จให้อัปเดตหัวข้อ Commands ให้ตรงกับของจริง

## กฎที่ห้ามละเมิด

1. **Invariant ต้อง enforce ที่ DB** (UNIQUE, CHECK, `UPDATE ... WHERE registered < capacity`) ห้ามพึ่งการเช็คใน app อย่างเดียว
2. **ใช้ SQL ตรงๆ ผ่าน `pg`** ไม่เพิ่ม ORM, Redis หรือ dependency ใหญ่ โดยไม่ถามก่อน (เหตุผลอยู่ใน README หัวข้อ Tech Stack)
3. **ทุก write transaction ในรอบเริ่มด้วย `pg_advisory_xact_lock(round_id)`** (Phase 2 เป็นต้นไป)
4. **ห้าม mock Postgres ในเทสต์** ใช้ Testcontainers เสมอ การเปลี่ยนแปลงที่แตะ logic ลง/ยกเลิก/เปลี่ยน/waitlist ต้องมี concurrency test และ invariant check คู่กัน
5. **ไม่เชื่อ role หรือ `student_id` จาก client** ใช้ค่าจาก JWT เท่านั้น
6. **`apps/web` กับ `apps/api` ห้าม import กัน** คุยผ่าน HTTP และ `packages/shared` เท่านั้น
7. **ทุก endpoint เขียนต้อง idempotent** รับ `idempotency_key` และเขียน `registration_events`
8. **Export CSV/Excel ต้อง escape** ค่าที่ขึ้นต้นด้วย `=`, `+`, `-`, `@`
9. **ห้ามใส่ข้อมูลจริงใน repo**: ไฟล์ .xlsx ของนักเรียน, `.env*`, `*.dump`, รหัสผ่าน, secret ข้อมูลทดสอบใช้ข้อมูลสมมติเท่านั้น (`templates/` เก็บได้เฉพาะไฟล์เปล่า)
10. **ห้ามใส่ secret/PII ใน log**
11. **ห้าม `dangerouslySetInnerHTML`** กับข้อความที่ admin กรอก

## Commands

> ยังไม่มี รายการนี้คือเป้าหมายตาม README ปรับให้ตรงของจริงเมื่อ scaffold

```bash
pnpm install
pnpm -r typecheck
pnpm -r test            # Vitest + Testcontainers (ต้องมี Docker)
pnpm --filter api dev
pnpm --filter web dev
```

## การทำงาน

- ทำทีละ Phase ตาม README อย่าข้ามไปทำของ Phase หลัง ยกเว้น migration แรกที่สร้างตารางครบทุก phase ไว้ก่อน
- ตัวเลข performance ใน README เป็นการประเมิน ห้ามอ้างเป็นข้อเท็จจริงจนกว่าจะ load test
- ก่อนบอกว่างานเสร็จ ต้องรัน typecheck และ test จริง แล้วรายงานผลตามที่เห็น
- ถ้าต้องตัดสินใจที่ขัดกับ README (เปลี่ยน stack, เปลี่ยนกติกาธุรกิจ) ให้ถามก่อนและอัปเดต README ในงานเดียวกัน

## ภาษาและสไตล์

- คุยและเขียนเอกสารเป็นภาษาไทย ส่วนโค้ด ชื่อตัวแปร ชื่อตาราง และ commit message เป็นภาษาอังกฤษ
- TypeScript strict, ไม่ใช้ `any` ถ้าไม่จำเป็น
- Schema ของ request/response นิยามเป็น Zod ใน `packages/shared` ที่เดียว
