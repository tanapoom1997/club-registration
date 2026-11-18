# Security policy

ระบบลงทะเบียนชุมนุมนี้เก็บข้อมูลของนักเรียน (ชื่อ ห้อง รหัสนักเรียน hash รหัสผ่าน) ช่องโหว่จึงกระทบเด็กจริง ขอบคุณที่ช่วยแจ้ง

_English summary: please report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository's Security tab, never in a public issue, pull request or discussion. Test only against your own local copy, never against any school's live system, and never include real personal data in a report._

## แจ้งช่องโหว่อย่างไร

- แจ้งแบบส่วนตัวผ่าน **GitHub private vulnerability reporting**: แท็บ **Security** ของ repo นี้ → **Report a vulnerability**
- **ห้ามเปิด issue, pull request หรือ discussion สาธารณะ** เกี่ยวกับช่องโหว่ที่ยังไม่ได้แก้ repo นี้เป็น Public ทุกคนเห็นทันที
- ใส่ในรายงาน:
  - ส่วนที่กระทบ (endpoint, ไฟล์, script) และ commit ที่ทดสอบ
  - ขั้นตอนทำซ้ำบนเครื่องของตัวเอง (`pnpm dev` หรือ `compose.prod.yml` ตาม README)
  - ผลกระทบที่คิดว่าเกิดได้ เช่น อ่านข้อมูลนักเรียนคนอื่นได้ หรือลงชุมนุมเกินจำนวนได้
- ไม่มี SLA ตายตัว จะตอบรับและแจ้งความคืบหน้าในรายงานนั้น เมื่อแก้แล้วจะเผยแพร่ advisory ใน repo นี้ และใส่ชื่อผู้แจ้งถ้าต้องการ

## ทดสอบอย่างไรได้บ้าง

- ทดสอบได้**เฉพาะสำเนาที่รันเองในเครื่อง** (บัญชี demo และข้อมูลสมมติจาก `seed-dev` / `generate-sample-import`) ห้ามทดสอบกับระบบที่โรงเรียนใดใช้งานจริง
- ห้ามใช้หรือแนบข้อมูลส่วนบุคคลจริงในรายงาน ถ้าบังเอิญเจอข้อมูลจริง (เช่น ใน commit เก่า) ให้หยุดตรงนั้น ไม่ดาวน์โหลดหรือเผยแพร่ต่อ แล้วแจ้งตำแหน่งที่เจอ
- ห้ามโจมตีแบบทำให้ระบบล่ม (DoS) หรือ social engineering

## เวอร์ชันที่รองรับ

แก้เฉพาะ branch `main` ซึ่งเป็นสิ่งที่ deploy ไม่มี release แยกเวอร์ชัน

## มาตรการที่มีอยู่แล้ว

สรุปอยู่ใน [README หัวข้อ Security](README.md#security) เช่น argon2id, session cookie แบบ `HttpOnly`/`SameSite=Strict`, api ต่อ DB ด้วย role ที่สิทธิ์จำกัด, container แบบ read-only ไม่มี capability และ log ที่ไม่เก็บ IP หรือข้อมูลส่วนบุคคล
