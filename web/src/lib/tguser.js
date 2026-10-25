// Telegram 扫码登录（tguser）：api_id、api_hash 的格式校验（和服务端 accounts.js 一致）和接入前的提醒，添加号码和号详情的「连接」共用

export const TG_API_ID_ERROR = 'api_id 只能是数字（my.telegram.org 里 App api_id 那一串）';
export const TG_API_HASH_ERROR = '格式不对：应该是 my.telegram.org 里 App api_hash 那 32 位字母数字';
export const tgApiIdError = (v) => (v.trim() && !/^\d{1,12}$/.test(v.trim()) ? TG_API_ID_ERROR : null);
export const tgApiHashError = (v) => (v.trim() && !/^[0-9a-f]{32}$/i.test(v.trim()) ? TG_API_HASH_ERROR : null);

/** 接入前的提醒 */
export const TGUSER_WARNING =
  '墨鸽会登录这个 Telegram 帐号（帐号的「设置 → 设备」里多一台「Inkdove」），收到它所有的私聊，亲友发来的也会进来；开着自动回复时，机器人以你本人的身份回复。' +
  '登录态存在服务器的数据目录里，拿到它就能用这个帐号，请保管好服务器和备份。Telegram 对第三方程序控制的个人帐号查得严，群发、给陌生人发消息很容易被封号：墨鸽只回复来找你的人，不能外联群发。';
