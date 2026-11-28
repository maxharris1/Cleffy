// @ts-check
import { ACCOUNTS, STUB_ENTITLEMENTS, STUB_USER, VIEWPORTS } from '../../../scripts/ui/uifuzz.mjs';

console.log(VIEWPORTS['desktop-1440'].viewport.width.toFixed(0));
console.log(VIEWPORTS['iphone-se'].viewport.height.toFixed(0));
console.log(STUB_USER.role.toUpperCase());
console.log(STUB_USER.user_metadata.display_name.toUpperCase());
console.log(STUB_ENTITLEMENTS.status.toUpperCase());
console.log(STUB_ENTITLEMENTS.limits.students.toFixed(0));
console.log(ACCOUNTS.teacher.email.toUpperCase());
console.log(VIEWPORTS['ipad-landscape'].deviceScaleFactor.toFixed(0));
/** @type {boolean} */ const isMobileIpadLandscape = VIEWPORTS['ipad-landscape'].isMobile;
/** @type {boolean} */ const hasTouchIpadLandscape = VIEWPORTS['ipad-landscape'].hasTouch;
console.log(isMobileIpadLandscape, hasTouchIpadLandscape);
console.log(VIEWPORTS['ipad-portrait'].deviceScaleFactor.toFixed(0));
/** @type {boolean} */ const isMobileIpadPortrait = VIEWPORTS['ipad-portrait'].isMobile;
/** @type {boolean} */ const hasTouchIpadPortrait = VIEWPORTS['ipad-portrait'].hasTouch;
console.log(isMobileIpadPortrait, hasTouchIpadPortrait);
console.log(VIEWPORTS['ipad-mini-portrait'].deviceScaleFactor.toFixed(0));
/** @type {boolean} */ const isMobileIpadMiniPortrait = VIEWPORTS['ipad-mini-portrait'].isMobile;
/** @type {boolean} */ const hasTouchIpadMiniPortrait = VIEWPORTS['ipad-mini-portrait'].hasTouch;
console.log(isMobileIpadMiniPortrait, hasTouchIpadMiniPortrait);
console.log(VIEWPORTS['iphone-14'].deviceScaleFactor.toFixed(0));
/** @type {boolean} */ const isMobileIphone14 = VIEWPORTS['iphone-14'].isMobile;
/** @type {boolean} */ const hasTouchIphone14 = VIEWPORTS['iphone-14'].hasTouch;
console.log(isMobileIphone14, hasTouchIphone14);
console.log(VIEWPORTS['iphone-se'].deviceScaleFactor.toFixed(0));
/** @type {boolean} */ const isMobileIphoneSe = VIEWPORTS['iphone-se'].isMobile;
/** @type {boolean} */ const hasTouchIphoneSe = VIEWPORTS['iphone-se'].hasTouch;
console.log(isMobileIphoneSe, hasTouchIphoneSe);
console.log(VIEWPORTS['android-small'].deviceScaleFactor.toFixed(0));
/** @type {boolean} */ const isMobileAndroidSmall = VIEWPORTS['android-small'].isMobile;
/** @type {boolean} */ const hasTouchAndroidSmall = VIEWPORTS['android-small'].hasTouch;
console.log(isMobileAndroidSmall, hasTouchAndroidSmall);
console.log(VIEWPORTS['iphone-landscape'].deviceScaleFactor.toFixed(0));
/** @type {boolean} */ const isMobileIphoneLandscape = VIEWPORTS['iphone-landscape'].isMobile;
/** @type {boolean} */ const hasTouchIphoneLandscape = VIEWPORTS['iphone-landscape'].hasTouch;
console.log(isMobileIphoneLandscape, hasTouchIphoneLandscape);
// @ts-expect-error
console.log(VIEWPORTS['desktop-1440'].isMobile);
// @ts-expect-error
console.log(VIEWPORTS['desktop-1440'].hasTouch);
// @ts-expect-error
console.log(VIEWPORTS['desktop-1440'].deviceScaleFactor);
// @ts-expect-error
console.log(VIEWPORTS['laptop-1280'].isMobile);
// @ts-expect-error
console.log(VIEWPORTS['laptop-1280'].hasTouch);
// @ts-expect-error
console.log(VIEWPORTS['laptop-1280'].deviceScaleFactor);
