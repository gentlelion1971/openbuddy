// Built-in tools that do not need external services: tasks, reminders,
// calendar events and memory. Registered alongside the email, calendar,
// browser and file tools.
// All code, comments, log messages and docs in this project are English only.

import * as store from '../store.js';
import type { ToolDefinition } from './types.js';

export const builtinTools: ToolDefinition[] = [
  {
    name: 'task_create',
    description: 'Create a to-do task.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        dueAt: { type: 'string', description: 'Optional due date/time in ISO format' },
      },
      required: ['title'],
    },
    requiresConfirmation: false,
    handler: async (args) => {
      const task = store.createTask(String(args.title), null, (args.dueAt as string | undefined) ?? null);
      return { ok: true, data: { id: task.id, title: task.title } };
    },
  },
  {
    name: 'reminder_create',
    description: 'Create a reminder for a date and time.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What to be reminded about' },
        remindAt: { type: 'string', description: 'Date/time in ISO format' },
      },
      required: ['title', 'remindAt'],
    },
    requiresConfirmation: false,
    handler: async (args) => {
      const r = store.addReminder(String(args.title), String(args.remindAt));
      return { ok: true, data: { id: r.id, remindAt: r.remindAt } };
    },
  },
  {
    name: 'event_create',
    description: 'Add a calendar event.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startAt: { type: 'string', description: 'Start in ISO format' },
        endAt: { type: 'string', description: 'End in ISO format' },
        location: { type: 'string' },
      },
      required: ['title', 'startAt', 'endAt'],
    },
    requiresConfirmation: false,
    handler: async (args) => {
      const e = store.addEvent({
        title: String(args.title),
        startAt: String(args.startAt),
        endAt: String(args.endAt),
        location: (args.location as string | undefined) ?? '',
        notes: '',
        source: 'local',
      });
      return { ok: true, data: { id: e.id } };
    },
  },
  {
    name: 'memory_set',
    description: 'Remember a fact about the user for future chats.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short label, e.g. Home address' },
        value: { type: 'string', description: 'The fact to remember' },
      },
      required: ['key', 'value'],
    },
    requiresConfirmation: false,
    handler: async (args, ctx) => {
      const row = store.setMemory(ctx.projectId ? 'project' : 'global', ctx.projectId, String(args.key), String(args.value));
      return { ok: true, data: { id: row.id } };
    },
  },
];
