export const PASSWORD_MESSAGES = Object.freeze({
  // The toggle's visible text; its accessible name adds the field, so each toggle on a page is
  // told apart (and the visible text starts the name: WCAG label in name).
  show: 'แสดง',
  hide: 'ซ่อน',
  showField: (field: string) => `แสดง${field}`,
  hideField: (field: string) => `ซ่อน${field}`,
  // Under the current password on the forced first change: it is the one just used to log in.
  initialPasswordHint: 'รหัสผ่านเริ่มต้นที่ได้รับจากครูหรือผู้ดูแลระบบ (รหัสเดียวกับที่เพิ่งใช้เข้าสู่ระบบ)',
});
