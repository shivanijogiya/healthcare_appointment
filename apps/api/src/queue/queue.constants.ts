export const QUEUE = {
  LLM_PREVISIT: 'llm.previsit',
  LLM_POSTVISIT: 'llm.postvisit',
  CALENDAR_SYNC: 'calendar.sync',
  MEDICATION_FANOUT: 'medication.fanout',
  OUTBOX_DRAIN: 'outbox.drain',
  HOLD_SWEEP: 'hold.sweep',
  MEDICATION_TICK: 'medication.tick',
  CALENDAR_RECONCILE: 'calendar.reconcile',
  LLM_RETRY_SWEEP: 'llm.retry.sweep',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export type CalendarAction = 'CREATE' | 'UPDATE' | 'DELETE';

export interface CalendarSyncJob { appointmentId: string; action: CalendarAction }
export interface LlmPreVisitJob { appointmentId: string }
export interface LlmPostVisitJob { visitNoteId: string }
export interface MedicationFanoutJob { visitNoteId: string }
