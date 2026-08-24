/** Domain events. Scheduling emits; Notifications, Calendar and LLM subscribe. */
export const DomainEvent = {
  AppointmentConfirmed: 'appointment.confirmed',
  AppointmentCancelled: 'appointment.cancelled',
  AppointmentRescheduled: 'appointment.rescheduled',
  VisitNoteSubmitted: 'visit-note.submitted',
  LeaveResolved: 'leave.resolved',
} as const;

export interface AppointmentConfirmedEvent {
  appointmentId: string;
}
export interface AppointmentCancelledEvent {
  appointmentId: string;
}
export interface AppointmentRescheduledEvent {
  appointmentId: string;
}
export interface VisitNoteSubmittedEvent {
  visitNoteId: string;
  appointmentId: string;
}
export interface LeaveResolvedEvent {
  leaveId: string;
  appointmentIds: string[];
}
