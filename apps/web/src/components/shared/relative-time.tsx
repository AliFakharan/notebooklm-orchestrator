import { fa } from "@/lib/utils";
import { formatJalali, toJalali } from "@/lib/jalali";

/**
 * زمان نسبی با تقویم شمسی: «لحظاتی پیش»، «۳ دقیقه پیش» و برای قدیمی‌ترها
 * «۲۵ مهر ۱۴۰۴، ۱۴:۳۲».
 */
export function RelativeTime({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="text-muted-foreground">—</span>;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <span className="text-muted-foreground">—</span>;

  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  const time = `${fa(String(date.getHours()).padStart(2, "0"))}:${fa(String(date.getMinutes()).padStart(2, "0"))}`;
  const { jy, jm } = toJalali(date);

  let text: string;
  if (mins < 1) text = "لحظاتی پیش";
  else if (mins < 60) text = `${fa(mins)} دقیقه پیش`;
  else if (hours < 24) text = `${fa(hours)} ساعت پیش`;
  else if (days < 2) {
    const yesterday = toJalali(new Date(date.getTime() + 86_400_000));
    text =
      yesterday.jy === jy && yesterday.jm === jm
        ? `دیروز، ${time}`
        : formatJalali(date, { year: false }) + `، ${time}`;
  } else {
    text = formatJalali(date) + `، ${time}`;
  }

  return (
    <time dateTime={iso} title={formatJalali(date, { weekday: true })} className="tabular-nums">
      {text}
    </time>
  );
}
