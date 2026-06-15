import { formatDistanceToNowStrict } from 'date-fns';

export function formatCountdown(date: Date): string {
  const ms = date.getTime() - Date.now();
  if (ms > 24 * 60 * 60 * 1000) {
    return formatDistanceToNowStrict(date, { addSuffix: true, unit: 'day' });
  }
  if (ms > 60 * 60 * 1000) {
    return formatDistanceToNowStrict(date, { addSuffix: true, unit: 'hour' });
  }
  return formatDistanceToNowStrict(date, { addSuffix: true, unit: 'minute' });
}
