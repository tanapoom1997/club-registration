import type { Role } from '@club-registration/shared';

export type MenuItem = { path: string; label: string; description: string };

// Phase 1 menus only. Later phases add their own entries rather than shipping dead links now.
export const MENUS: Readonly<Record<Role, readonly MenuItem[]>> = Object.freeze({
  student: [
    {
      path: 'clubs',
      label: 'ชุมนุมในชั้นของฉัน',
      description: 'ดูรายการชุมนุม ครูที่ปรึกษา ที่ว่างที่เหลือ และลงทะเบียน',
    },
    {
      path: 'my-registration',
      label: 'ผลของฉัน',
      description: 'ดูชุมนุมที่ลงทะเบียนไว้ และยกเลิกระหว่างที่รอบเปิดอยู่',
    },
  ],
  admin: [
    {
      path: 'rounds',
      label: 'รอบลงทะเบียน',
      description: 'สร้างรอบต่อชั้น กำหนดเวลาเปิด–ปิด',
    },
    {
      path: 'import',
      label: 'นำเข้า Excel',
      description: 'นำเข้านักเรียน ชุมนุม และครู (ตรวจก่อน แล้วค่อยยืนยัน)',
    },
    {
      path: 'clubs',
      label: 'ชุมนุม',
      description:
        'ดูจำนวนรับ จำนวนที่ลงแล้ว และครูรายรอบ แก้ชื่อ รายละเอียด และจำนวนรับ ดู/แก้รายชื่อสมาชิกและรายชื่อรอ',
    },
    {
      path: 'export',
      label: 'ส่งออกรายชื่อ',
      description: 'ดาวน์โหลดรายชื่อรายชุมนุมหรือรายห้องเป็น Excel หรือ PDF',
    },
    {
      path: 'initial-passwords',
      label: 'รหัสผ่านเริ่มต้น',
      description: 'สุ่มรหัสผ่านให้นักเรียนแล้วดาวน์โหลดเป็น Excel (ดาวน์โหลดซ้ำไม่ได้)',
    },
  ],
});

export const ROLE_LABELS: Readonly<Record<Role, string>> = Object.freeze({
  student: 'นักเรียน',
  admin: 'ผู้ดูแลระบบ',
});
