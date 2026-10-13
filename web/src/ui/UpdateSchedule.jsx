import { useId } from 'react';
import { SCHEDULE_DAYS, SCHEDULE_MINUTE_STEP, pickToDate, scheduleTimeOk } from '../lib/update.js';
import { Field } from './common.jsx';
import { Select } from './Select.jsx';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const NEAR_DAYS = ['今天', '明天', '后天'];
const pad = (n) => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/**
 * 选预约时间：哪天（今天和之后 7 天）+ 几点 + 几分（5 分钟一档），三个都是 ui/Select，按浏览器时区。
 * 不在「1 分钟之后、7 天之内」的选项灰掉；换了日子或钟点后原来的时间不能选了，就挪到那天（那个钟点）最早能选的时间。
 * pick: {day, hour, minute}；onChange(新的 pick)；error 显示在下面。
 */
export function ScheduleFields({ pick, onChange, error }) {
  const id = useId();
  const now = new Date();
  const ok = (p) => scheduleTimeOk(pickToDate(p, now), now.getTime());

  const minutes = Array.from({ length: 60 / SCHEDULE_MINUTE_STEP }, (_, i) => i * SCHEDULE_MINUTE_STEP);
  // 原来的预约不在 5 分钟一档上（接口直接调的）时也能显示
  if (!minutes.includes(pick.minute)) minutes.push(pick.minute);
  minutes.sort((a, b) => a - b);

  const firstMinute = (p) => minutes.find((minute) => ok({ ...p, minute }));
  const firstTime = (day) => {
    for (const hour of HOURS) {
      const minute = firstMinute({ day, hour });
      if (minute !== undefined) return { day, hour, minute };
    }
    return null;
  };

  const dayOptions = Array.from({ length: SCHEDULE_DAYS }, (_, day) => {
    const d = pickToDate({ day, hour: 0, minute: 0 }, now);
    const date = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
    return { value: day, label: NEAR_DAYS[day] ? `${NEAR_DAYS[day]} · ${date}` : date, disabled: !firstTime(day) };
  });
  const hourOptions = HOURS.map((hour) => ({
    value: hour,
    label: pad(hour),
    disabled: firstMinute({ day: pick.day, hour }) === undefined,
  }));
  const minuteOptions = minutes.map((minute) => ({ value: minute, label: pad(minute), disabled: !ok({ ...pick, minute }) }));

  const setDay = (day) => {
    const next = { ...pick, day };
    onChange(ok(next) ? next : firstTime(day) || next);
  };
  const setHour = (hour) => {
    const next = { ...pick, hour };
    if (ok(next)) return onChange(next);
    const minute = firstMinute(next);
    onChange(minute === undefined ? next : { ...next, minute });
  };

  const tz = browserTimeZone();
  const dayId = `${id}-day`;
  const describedBy = error ? `${dayId}-err` : undefined;
  return (
    <Field label="更新时间" htmlFor={dayId} hint={`按这台电脑的时区${tz ? `（${tz}）` : ''}`} error={error}>
      <div className="schedule-fields">
        <Select
          id={dayId}
          className="schedule-fields__day"
          aria-label="哪一天"
          aria-describedby={describedBy}
          invalid={!!error}
          value={pick.day}
          options={dayOptions}
          onChange={setDay}
        />
        <div className="schedule-fields__time">
          <Select
            className="schedule-fields__num"
            aria-label="几点"
            invalid={!!error}
            value={pick.hour}
            options={hourOptions}
            onChange={setHour}
          />
          <span className="schedule-fields__sep" aria-hidden="true">
            :
          </span>
          <Select
            className="schedule-fields__num"
            aria-label="几分"
            invalid={!!error}
            value={pick.minute}
            options={minuteOptions}
            onChange={(minute) => onChange({ ...pick, minute })}
          />
        </div>
      </div>
    </Field>
  );
}
