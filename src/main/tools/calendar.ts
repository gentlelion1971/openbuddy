// Calendar and reminder tools and service, backed by the SQLite store.
// Also builds and parses minimal iCalendar (.ics) data for import/export.
// All code, comments, log messages and docs in this project are English only.

import {
  addEvent as storeAddEvent,
  addReminder as storeAddReminder,
  completeReminder as storeCompleteReminder,
  deleteEvent as storeDeleteEvent,
  listEvents as storeListEvents,
  listReminders as storeListReminders,
  type EventRow,
  type ReminderRow,
} from '../store.js';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reqString(args: Record<string, unknown>, name: string): string {
  const value = asString(args[name]);
  if (value === undefined) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function optString(args: Record<string, unknown>, name: string, fallback = ''): string {
  const value = args[name];
  return typeof value === 'string' ? value : fallback;
}

function optBool(args: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = args[name];
  return typeof value === 'boolean' ? value : fallback;
}

/** Parse an ISO date string; throws on invalid input. */
function parseIso(value: string, name: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${name}: ${value}`);
  return date;
}

async function run<T>(fn: () => Promise<T> | T): Promise<ToolResult> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// iCalendar helpers
// ---------------------------------------------------------------------------

/** Format a Date as an iCalendar UTC timestamp, e.g. 20261122T143000Z. */
function formatIcsDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function unescapeIcsText(text: string): string {
  return text
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** Parse an iCalendar date/time value into an ISO string.
 *  Handles UTC values ending in 'Z', floating local times (treated as local
 *  time), and date-only values (midnight UTC). Returns null when unparseable. */
function parseIcsDateTime(value: string): string | null {
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).toISOString();
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(trimmed);
  if (!dateTime) return null;
  const [, y, mo, d, h, mi, s, z] = dateTime;
  const year = Number(y);
  const month = Number(mo) - 1;
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (z === 'Z') {
    return new Date(Date.UTC(year, month, day, hour, minute, second)).toISOString();
  }
  // Floating time: interpret in the local timezone.
  return new Date(year, month, day, hour, minute, second).toISOString();
}

/** Undo iCalendar line folding: continuation lines start with a space or tab. */
function unfoldIcsLines(icsText: string): string[] {
  const raw = icsText.split(/\r\n|\n|\r/);
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Calendar service
// ---------------------------------------------------------------------------

export const calendarService = {
  listEvents(fromIso: string, toIso: string): EventRow[] {
    parseIso(fromIso, 'fromIso');
    parseIso(toIso, 'toIso');
    return storeListEvents(fromIso, toIso);
  },

  addEvent(input: {
    title: string;
    startAt: string;
    endAt?: string;
    location?: string;
    notes?: string;
  }): EventRow {
    const title = input.title.trim();
    if (!title) throw new Error('Event title must not be empty.');
    const start = parseIso(input.startAt, 'startAt');
    const end = input.endAt ? parseIso(input.endAt, 'endAt') : new Date(start.getTime() + 60 * 60 * 1000);
    if (end.getTime() <= start.getTime()) {
      throw new Error('Event endAt must be after startAt.');
    }
    return storeAddEvent({
      title,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      location: input.location ?? '',
      notes: input.notes ?? '',
      source: 'local',
    });
  },

  deleteEvent(id: string): void {
    storeDeleteEvent(id);
  },

  listReminders(includeDone = false): ReminderRow[] {
    return storeListReminders(includeDone);
  },

  addReminder(title: string, remindAt: string): ReminderRow {
    const clean = title.trim();
    if (!clean) throw new Error('Reminder title must not be empty.');
    const when = parseIso(remindAt, 'remindAt');
    return storeAddReminder(clean, when.toISOString());
  },

  completeReminder(id: string): void {
    storeCompleteReminder(id);
  },

  exportICS(fromIso: string, toIso: string): string {
    parseIso(fromIso, 'fromIso');
    parseIso(toIso, 'toIso');
    const events = storeListEvents(fromIso, toIso);
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//OpenBuddy//Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ];
    for (const event of events) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${event.id}@openbuddy`,
        `DTSTAMP:${formatIcsDate(new Date(event.createdAt))}`,
        `DTSTART:${formatIcsDate(new Date(event.startAt))}`,
        `DTEND:${formatIcsDate(new Date(event.endAt))}`,
        `SUMMARY:${escapeIcsText(event.title)}`,
      );
      if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
      if (event.notes) lines.push(`DESCRIPTION:${escapeIcsText(event.notes)}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return `${lines.join('\r\n')}\r\n`;
  },

  importICS(icsText: string): { imported: number } {
    const lines = unfoldIcsLines(icsText);
    let imported = 0;
    let current: Record<string, string> | null = null;

    const flush = (): void => {
      if (!current) return;
      const startRaw = current.dtstart;
      if (!startRaw) {
        current = null;
        return;
      }
      const startAt = parseIcsDateTime(startRaw);
      if (!startAt) {
        current = null;
        return;
      }
      let endAt: string | null = null;
      if (current.dtend) endAt = parseIcsDateTime(current.dtend);
      if (!endAt) {
        endAt = new Date(new Date(startAt).getTime() + 60 * 60 * 1000).toISOString();
      }
      storeAddEvent({
        title: current.summary ?? '(No title)',
        startAt,
        endAt,
        location: current.location ?? '',
        notes: current.description ?? '',
        source: 'ics-import',
      });
      imported += 1;
      current = null;
    };

    for (const line of lines) {
      const upper = line.toUpperCase();
      if (upper === 'BEGIN:VEVENT') {
        current = {};
        continue;
      }
      if (upper === 'END:VEVENT') {
        flush();
        continue;
      }
      if (!current) continue;
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      // The property name may carry parameters, e.g. DTSTART;TZID=America/New_York.
      const name = line.slice(0, colon).split(';')[0].trim().toLowerCase();
      const value = line.slice(colon + 1);
      if (name === 'summary' || name === 'location' || name === 'description') {
        current[name] = unescapeIcsText(value);
      } else if (name === 'dtstart' || name === 'dtend') {
        current[name] = value;
      }
    }
    flush();
    return { imported };
  },
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const calendarTools: ToolDefinition[] = [
  {
    name: 'calendar_list',
    description: 'List calendar events between two ISO dates, ordered by start time.',
    parameters: {
      type: 'object',
      properties: {
        fromIso: { type: 'string', description: 'Start of the range (ISO 8601). Defaults to now.' },
        toIso: { type: 'string', description: 'End of the range (ISO 8601). Defaults to 30 days from now.' },
      },
      required: [],
    },
    requiresConfirmation: false,
    handler: async (args, _ctx: ToolContext) =>
      run(() => {
        const now = new Date();
        const fromIso = asString(args.fromIso) ?? now.toISOString();
        const toIso = asString(args.toIso) ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        return calendarService.listEvents(fromIso, toIso);
      }),
  },
  {
    name: 'calendar_add',
    description: 'Add a calendar event. endAt defaults to one hour after startAt.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title.' },
        startAt: { type: 'string', description: 'Start time (ISO 8601).' },
        endAt: { type: 'string', description: 'End time (ISO 8601).' },
        location: { type: 'string', description: 'Event location.' },
        notes: { type: 'string', description: 'Notes for the event.' },
      },
      required: ['title', 'startAt'],
    },
    requiresConfirmation: false,
    handler: async (args, _ctx: ToolContext) =>
      run(() =>
        calendarService.addEvent({
          title: reqString(args, 'title'),
          startAt: reqString(args, 'startAt'),
          endAt: asString(args.endAt),
          location: optString(args, 'location'),
          notes: optString(args, 'notes'),
        }),
      ),
  },
  {
    name: 'calendar_delete',
    description: 'Delete a calendar event by its id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the event to delete.' },
      },
      required: ['id'],
    },
    requiresConfirmation: true,
    handler: async (args, _ctx: ToolContext) =>
      run(() => {
        const id = reqString(args, 'id');
        calendarService.deleteEvent(id);
        return { deleted: id };
      }),
  },
  {
    name: 'reminder_add',
    description: 'Add a reminder that fires at the given time.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Reminder title.' },
        remindAt: { type: 'string', description: 'Time to remind (ISO 8601).' },
      },
      required: ['title', 'remindAt'],
    },
    requiresConfirmation: false,
    handler: async (args, _ctx: ToolContext) =>
      run(() => calendarService.addReminder(reqString(args, 'title'), reqString(args, 'remindAt'))),
  },
  {
    name: 'reminder_list',
    description: 'List open reminders, ordered by reminder time. Pass includeDone true to include completed ones.',
    parameters: {
      type: 'object',
      properties: {
        includeDone: { type: 'boolean', description: 'Include completed reminders (default false).' },
      },
      required: [],
    },
    requiresConfirmation: false,
    handler: async (args, _ctx: ToolContext) =>
      run(() => calendarService.listReminders(optBool(args, 'includeDone', false))),
  },
  {
    name: 'reminder_complete',
    description: 'Mark a reminder as done by its id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the reminder to complete.' },
      },
      required: ['id'],
    },
    requiresConfirmation: false,
    handler: async (args, _ctx: ToolContext) =>
      run(() => {
        const id = reqString(args, 'id');
        calendarService.completeReminder(id);
        return { completed: id };
      }),
  },
  {
    name: 'calendar_export_ics',
    description: 'Export calendar events between two ISO dates as iCalendar (.ics) text.',
    parameters: {
      type: 'object',
      properties: {
        fromIso: { type: 'string', description: 'Start of the range (ISO 8601). Defaults to now.' },
        toIso: { type: 'string', description: 'End of the range (ISO 8601). Defaults to 30 days from now.' },
      },
      required: [],
    },
    requiresConfirmation: false,
    handler: async (args, _ctx: ToolContext) =>
      run(() => {
        const now = new Date();
        const fromIso = asString(args.fromIso) ?? now.toISOString();
        const toIso = asString(args.toIso) ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const ics = calendarService.exportICS(fromIso, toIso);
        return { ics };
      }),
  },
];
