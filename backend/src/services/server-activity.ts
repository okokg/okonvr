/**
 * Tracks server background activities for UI status display.
 * Lightweight: just a map of activity name → status string.
 */

interface Activity {
  status: string;
  progress?: string;   // e.g. "12/46"
  startedAt: number;
}

const activities = new Map<string, Activity>();

/** Set an activity as running. */
export function setActivity(name: string, status: string, progress?: string) {
  activities.set(name, { status, progress, startedAt: activities.get(name)?.startedAt || Date.now() });
}

/** Clear a completed activity. */
export function clearActivity(name: string) {
  activities.delete(name);
}

/** Get all current activities for the status endpoint. */
export function getActivities(): Record<string, { status: string; progress?: string; elapsed: number }> {
  const now = Date.now();
  const result: Record<string, { status: string; progress?: string; elapsed: number }> = {};
  for (const [name, act] of activities) {
    result[name] = {
      status: act.status,
      progress: act.progress,
      elapsed: Math.round((now - act.startedAt) / 1000),
    };
  }
  return result;
}
