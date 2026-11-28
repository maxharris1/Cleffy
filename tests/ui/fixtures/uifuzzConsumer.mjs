// @ts-check
import { ACCOUNTS, STUB_ENTITLEMENTS, STUB_USER, VIEWPORTS } from '../../../scripts/ui/uifuzz.mjs';

console.log(VIEWPORTS['desktop-1440'].viewport.width.toFixed(0));
console.log(VIEWPORTS['iphone-se'].viewport.height.toFixed(0));
console.log(STUB_USER.role.toUpperCase());
console.log(STUB_USER.user_metadata.display_name.toUpperCase());
console.log(STUB_ENTITLEMENTS.status.toUpperCase());
console.log(STUB_ENTITLEMENTS.limits.students.toFixed(0));
console.log(ACCOUNTS.teacher.email.toUpperCase());
