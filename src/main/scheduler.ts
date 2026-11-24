// Background scheduler: due reminders and recurring watches.
// Runs on a 60-second tick. Watches check an inbox or a web page and notify
// the user when something new arrives.
// All code, comments, log messages and docs in this project are English only.

import * as store from './store.js';
import { emailService } from './tools/email.js';
import { browserService } from './tools/browser.js';
import { cleanupAttachments } from './tools/attachments.js';

export interface SchedulerDeps {
  notify: (title: string, body: string) => void;
}

function nextRunAt(intervalMinutes: number): string {
  return new Date(Date.now() + intervalMinutes * 60_000).toISOString();
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((e) => console.error('[scheduler]', e));
    }, 60_000);
    void this.tick().catch((e) => console.error('[scheduler]', e));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    // Daily cleanup of cached email attachments (temp folder only).
    try {
      this.runAttachmentCleanup(now);
    } catch (e) {
      console.error('[scheduler] attachment cleanup failed:', e);
    }
    // Due reminders.
    for (const r of store.listReminders(false)) {
      if (new Date(r.remindAt) <= now) {
        this.deps.notify('Reminder', r.title);
        store.completeReminder(r.id);
      }
    }
    // Active watches that are due.
    for (const w of store.listWatches()) {
      if (!w.active) continue;
      if (w.nextRunAt && new Date(w.nextRunAt) > now) continue;
      const interval = Number(w.config.intervalMinutes ?? 60);
      try {
        if (w.kind === 'email') await this.runEmailWatch(w);
        else if (w.kind === 'web') await this.runWebWatch(w);
      } catch (e) {
        console.error(`[scheduler] watch ${w.name} failed:`, e);
      }
      store.markWatchRun(w.id, nextRunAt(interval));
    }
  }

  /**
   * Delete cached attachment copies older than the retention setting
   * (default 60 days, configurable in Settings). Runs at most once a day;
   * only files inside the attachments temp folder are ever deleted.
   */
  private runAttachmentCleanup(now: Date): void {
    const lastRun = store.getSetting('attachmentCleanupLastRun', '');
    if (lastRun) {
      const last = new Date(lastRun).getTime();
      if (!Number.isNaN(last) && now.getTime() - last < 24 * 60 * 60 * 1000) return;
    }
    store.setSetting('attachmentCleanupLastRun', now.toISOString());
    const result = cleanupAttachments(now);
    if (!result.skipped && result.deleted > 0) {
      console.log(
        `[scheduler] attachment cleanup: deleted ${result.deleted} file(s), freed ${(result.freedBytes / 1024).toFixed(0)} KB`,
      );
    }
  }

  private async runEmailWatch(w: store.WatchRow): Promise<void> {
    const accountId = String(w.config.accountId ?? '');
    const from = String(w.config.from ?? '');
    const keyword = String(w.config.keyword ?? '');
    const sinceMinutes = Number(w.config.intervalMinutes ?? 60);
    if (!accountId) return;
    const seenKey = `watch-seen:${w.id}`;
    const lastSeen = store.getSetting(seenKey, '');
    // listInbox + client-side filters: the inbox search is plain-text only,
    // so sender/keyword filtering is done here.
    const messages = await emailService.listInbox(accountId, 30);
    let fresh = messages.filter((m) => new Date(m.date).getTime() > Date.now() - sinceMinutes * 60_000);
    if (from) {
      const f = from.toLowerCase();
      fresh = fresh.filter((m) => m.from.toLowerCase().includes(f));
    }
    if (keyword) {
      const k = keyword.toLowerCase();
      fresh = fresh.filter((m) => `${m.subject} ${m.snippet}`.toLowerCase().includes(k));
    }
    if (fresh.length === 0) return;
    const newest = fresh[0];
    if (lastSeen && newest.uid <= Number(lastSeen)) return;
    store.setSetting(seenKey, String(newest.uid));
    const body = `${fresh.length} new message(s)${from ? ` from ${from}` : ''}${keyword ? ` matching "${keyword}"` : ''}: ${newest.subject}`;
    this.deps.notify(`Watch: ${w.name}`, body);
    // Also record it for the companion phone app, which polls notifications.
    store.addNotification('watch', `Watch: ${w.name}`, body);
  }

  private async runWebWatch(w: store.WatchRow): Promise<void> {
    const url = String(w.config.url ?? '');
    const keyword = String(w.config.keyword ?? '');
    if (!url || !keyword) return;
    const page = await browserService.fetchPageText(url);
    if (page.text.toLowerCase().includes(keyword.toLowerCase())) {
      this.deps.notify(`Watch: ${w.name}`, `Keyword "${keyword}" found on ${url}.`);
    }
  }
}
