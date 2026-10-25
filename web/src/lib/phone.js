// 国际手机号：国家/地区（区号）+ 本地号码。区号表照 my.telegram.org 登录页的列表（ISO 两位代码 + 区号），
// 中文名用浏览器自带的 Intl.DisplayNames，个别改成常用的叫法。

const RAW =
  'AF93 AL355 DZ213 AS1684 AD376 AO244 AI1264 AG1268 AR54 AM374 AW297 AU61 AT43 AZ994 BS1242 BH973 BD880 BB1246 ' +
  'BY375 BE32 BZ501 BJ229 BM1441 BT975 BO591 BQ599 BA387 BW267 BR55 VG1284 BN673 BG359 BF226 BI257 KH855 CM237 ' +
  'CA1 CV238 KY1345 CF236 TD235 CL56 CN86 FT888 CO57 KM269 CD243 CG242 CK682 CR506 HR385 CU53 CW599 CY357 CZ420 ' +
  'CI225 DK45 IO246 DJ253 DM1767 DO1809 EC593 EG20 SV503 GQ240 ER291 EE372 SZ268 ET251 FK500 FO298 FJ679 FI358 ' +
  'FR33 GF594 PF689 GA241 GM220 GE995 DE49 GH233 GI350 GR30 GL299 GD1473 GP590 GU1671 GT502 GN224 GW245 GY592 ' +
  'HT509 HN504 HK852 HU36 IS354 IN91 ID62 IR98 IQ964 IE353 IL972 IT39 JM1876 JP81 JO962 KZ7 KE254 KI686 XK383 ' +
  'KW965 KG996 LA856 LV371 LB961 LS266 LR231 LY218 LI423 LT370 LU352 MO853 MG261 MW265 MY60 MV960 ML223 MT356 ' +
  'MH692 MQ596 MR222 MU230 MX52 FM691 MD373 MC377 MN976 ME382 MS1664 MA212 MZ258 MM95 NA264 NR674 NP977 NL31 ' +
  'NC687 NZ64 NI505 NE227 NG234 NU683 NF672 KP850 MK389 MP1670 NO47 OM968 PK92 PW680 PS970 PA507 PG675 PY595 ' +
  'PE51 PH63 PL48 PT351 PR1787 QA974 RO40 RU7 RW250 RE262 SH247 KN1869 LC1758 PM508 VC1784 WS685 SM378 SA966 ' +
  'SN221 RS381 SC248 SL232 SG65 SX1721 SK421 SI386 SB677 SO252 ZA27 KR82 SS211 ES34 LK94 SD249 SR597 SE46 CH41 ' +
  'SY963 ST239 TW886 TJ992 TZ255 TH66 TL670 TG228 TK690 TO676 TT1868 TN216 TR90 TM993 TC1649 TV688 VI1340 US1 ' +
  'UG256 UA380 AE971 GB44 UY598 UZ998 VU678 VE58 VN84 WF681 YE967 ZM260 ZW263';

/** [{iso, dial}]，dial 不带 + */
export const COUNTRIES = RAW.trim()
  .split(/\s+/)
  .map((s) => ({ iso: s.slice(0, 2), dial: s.slice(2) }));

/** 几个国家共用一个区号时，从完整号码认国家默认认成谁 */
const PREFERRED = { 1: 'US', 7: 'RU', 599: 'CW' };
/** 列表最前面的常用几个，其余按中文名排 */
const COMMON = ['US', 'CN', 'HK', 'MO', 'TW', 'SG', 'MY', 'GB', 'JP', 'KR', 'RU', 'AE'];
const NAME_OVERRIDES = { HK: '中国香港', MO: '中国澳门', TW: '中国台湾', FT: '匿名号码（Fragment）' };

let displayNames = null;
try {
  displayNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
} catch {
  // 老浏览器没有 Intl.DisplayNames：只显示代码
}

export function countryName(iso) {
  if (NAME_OVERRIDES[iso]) return NAME_OVERRIDES[iso];
  try {
    return displayNames?.of(iso) || iso;
  } catch {
    return iso;
  }
}

export const countryOf = (iso) => COUNTRIES.find((c) => c.iso === iso) || COUNTRIES.find((c) => c.iso === 'US');

/** 下拉里的顺序：常用的在前，其余按中文名 */
export function sortedCountries() {
  const common = COMMON.map(countryOf);
  const rest = COUNTRIES.filter((c) => !COMMON.includes(c.iso)).sort((a, b) => countryName(a.iso).localeCompare(countryName(b.iso), 'zh-CN'));
  return [...common, ...rest];
}

/** 默认国家：美国（用户指定）。不按浏览器语言猜 */
export const defaultCountry = () => 'US';

/** 「+86 138…」「0086…」这样的完整号码拆成国家和本地号码；不是以 + 或 00 开头、认不出区号的返回 null */
export function splitInternational(raw) {
  const s = String(raw || '').trim();
  if (!/^(\+|00)/.test(s)) return null;
  const digits = s.replace(/^00/, '').replace(/\D/g, '');
  for (let n = Math.min(4, digits.length); n >= 1; n -= 1) {
    const dial = digits.slice(0, n);
    const hits = COUNTRIES.filter((c) => c.dial === dial);
    if (hits.length) return { iso: PREFERRED[dial] || hits[0].iso, digits: digits.slice(n) };
  }
  return null;
}

/** 本地号码最多几位：整个号码（含区号）不超过 15 位 */
export const maxDigits = (iso) => 15 - countryOf(iso).dial.length;

/** 本地号码分组显示：中国手机号 3-4-4，其余每 3 位一组（最后一组 1 位时并到前一组，美国号码即 3-3-4） */
export function formatNational(iso, digits) {
  const d = String(digits || '');
  if (iso === 'CN') return [d.slice(0, 3), d.slice(3, 7), d.slice(7)].filter(Boolean).join(' ');
  const groups = d.match(/.{1,3}/g) || [];
  if (groups.length > 1 && groups[groups.length - 1].length === 1) groups.splice(-2, 2, groups.at(-2) + groups.at(-1));
  return groups.join(' ');
}

/** 交给服务端的完整号码 +区号本地号码；本地号码开头的 0（国内长途前缀）去掉，意大利的号码本身带 0，不去 */
export function toE164({ iso, digits }) {
  const d = iso === 'IT' ? digits : String(digits || '').replace(/^0+/, '');
  return d ? `+${countryOf(iso).dial}${d}` : '';
}

/** 显示用：+86 138 0000 0000 */
export const formatPhone = (p) => (p.digits ? `+${countryOf(p.iso).dial} ${formatNational(p.iso, p.digits)}` : '');
