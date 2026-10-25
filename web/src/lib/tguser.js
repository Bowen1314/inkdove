// Telegram 扫码登录（tguser）：api_id、api_hash 的格式校验（和服务端 accounts.js 一致）和接入前的提醒，添加号码和号详情的「连接」共用

export const TG_API_ID_ERROR = 'api_id 须为数字（my.telegram.org 中的 App api_id）';
export const TG_API_HASH_ERROR = '格式错误：须为 my.telegram.org 中 App api_hash 的 32 位字母数字';
export const tgApiIdError = (v) => (v.trim() && !/^\d{1,12}$/.test(v.trim()) ? TG_API_ID_ERROR : null);
export const tgApiHashError = (v) => (v.trim() && !/^[0-9a-f]{32}$/i.test(v.trim()) ? TG_API_HASH_ERROR : null);

/** 接入前的提醒 */
export const TGUSER_WARNING =
  '墨鸽将登录该帐号（「设置 → 设备」中新增「Inkdove」），接收全部私聊（含亲友）；开启自动回复时以本人身份发送。' +
  '登录状态保存在服务器数据目录，持有该数据即可操作该帐号，请妥善保管服务器及备份。第三方客户端控制的个人帐号易被 Telegram 封禁，群发或向陌生人发消息风险高；墨鸽仅回复主动来信，不支持外联。';
