import { Inject, Injectable, Logger } from '@nestjs/common';
import { google, calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { Db } from '@ham/db';
import type { AuthUser } from '@ham/types';
import { DB } from '../db/db.module';
import { AppError } from '../common/errors/app-error';
import { CryptoService } from '../common/crypto.service';
import { ClockService } from '../common/clock.service';
import { AuditService } from '../common/audit.service';
import { loadConfig } from '../config/env';
import type { CalendarAction } from '../queue/queue.constants';

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

/**
 * Google Calendar is strictly a downstream side effect.
 *
 * Nothing in here can fail a booking. If a doctor has never connected Google,
 * every call becomes a silent no-op; if Google is down, the queue retries and
 * the reconciler repairs the drift later. Connecting a calendar is a feature,
 * not a prerequisite for using the clinic.
 */
@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);
  private readonly config = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly clock: ClockService,
    private readonly audit: AuditService,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.GOOGLE_CLIENT_ID && this.config.GOOGLE_CLIENT_SECRET);
  }

  private oauthClient(): OAuth2Client {
    if (!this.enabled) throw AppError.calendarNotConnected();
    return new google.auth.OAuth2(
      this.config.GOOGLE_CLIENT_ID,
      this.config.GOOGLE_CLIENT_SECRET,
      this.config.GOOGLE_REDIRECT_URI,
    );
  }

  /**
   * `access_type=offline` with `prompt=consent` is what guarantees a refresh
   * token comes back. Without the explicit prompt, Google returns one only on
   * the very first authorisation and silently omits it afterwards — which
   * breaks reconnection in a way that is painful to debug.
   */
  consentUrl(user: AuthUser): string {
    return this.oauthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      // Round-trips the caller so the callback knows which account to attach to.
      state: Buffer.from(JSON.stringify({ userId: user.id, role: user.role })).toString('base64url'),
    });
  }

  async handleCallback(code: string, state: string) {
    const { userId } = JSON.parse(Buffer.from(state, 'base64url').toString());
    const client = this.oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw AppError.conflict('Google did not return a refresh token. Revoke access and try again.');
    }

    client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    const primary = await calendar.calendarList.get({ calendarId: 'primary' }).catch(() => null);
    const calendarId = primary?.data.id ?? 'primary';

    // Encrypted at rest — a refresh token is a long-lived key to someone's diary.
    const encrypted = this.crypto.encrypt(tokens.refresh_token);
    const patch = {
      gcal_refresh_token: encrypted,
      gcal_calendar_id: calendarId,
      gcal_connected_at: new Date(),
    };

    const asDoctor = await this.db
      .updateTable('doctor').set(patch).where('user_id', '=', userId).executeTakeFirst();
    if (Number(asDoctor.numUpdatedRows ?? 0) === 0) {
      await this.db.updateTable('patient').set(patch).where('user_id', '=', userId).execute();
    }

    await this.audit.record({ action: 'calendar.connect', entity: 'app_user', entityId: userId });
    return { connected: true, calendarId };
  }

  async disconnect(user: AuthUser) {
    const patch = { gcal_refresh_token: null, gcal_calendar_id: null, gcal_connected_at: null };
    await this.db.updateTable('doctor').set(patch).where('user_id', '=', user.id).execute();
    await this.db.updateTable('patient').set(patch).where('user_id', '=', user.id).execute();
    await this.audit.record({ actor: user, action: 'calendar.disconnect', entity: 'app_user', entityId: user.id });
    return { connected: false };
  }

  async statusFor(user: AuthUser) {
    const row = user.doctorId
      ? await this.db.selectFrom('doctor').select(['gcal_refresh_token as t', 'gcal_connected_at as at'])
          .where('id', '=', user.doctorId).executeTakeFirst()
      : user.patientId
      ? await this.db.selectFrom('patient').select(['gcal_refresh_token as t', 'gcal_connected_at as at'])
          .where('id', '=', user.patientId).executeTakeFirst()
      : null;
    return {
      available: this.enabled,
      connected: Boolean(row?.t),
      connectedAt: row?.at ? new Date(row.at).toISOString() : null,
    };
  }

  // ------------------------------------------------------- event lifecycle --

  private async clientFor(encryptedToken: string): Promise<calendar_v3.Calendar> {
    const client = this.oauthClient();
    // Access tokens are never stored; they are refreshed on demand and held only
    // for the duration of this call.
    client.setCredentials({ refresh_token: this.crypto.decrypt(encryptedToken) });
    return google.calendar({ version: 'v3', auth: client });
  }

  /** Both parties' calendar credentials plus the details of the appointment. */
  private async partiesFor(appointmentId: string) {
    const row = await this.db
      .selectFrom('appointment')
      .innerJoin('doctor', 'doctor.id', 'appointment.doctor_id')
      .innerJoin('app_user as du', 'du.id', 'doctor.user_id')
      .innerJoin('patient', 'patient.id', 'appointment.patient_id')
      .innerJoin('app_user as pu', 'pu.id', 'patient.user_id')
      .select([
        'appointment.id as id',
        'appointment.starts_at as startsAt',
        'appointment.ends_at as endsAt',
        'appointment.state as state',
        'appointment.gcal_doctor_event_id as doctorEventId',
        'appointment.gcal_patient_event_id as patientEventId',
        'doctor.gcal_refresh_token as doctorToken',
        'doctor.gcal_calendar_id as doctorCalendarId',
        'doctor.specialisation as specialisation',
        'du.name as doctorName',
        'du.email as doctorEmail',
        'patient.gcal_refresh_token as patientToken',
        'patient.gcal_calendar_id as patientCalendarId',
        'pu.name as patientName',
        'pu.email as patientEmail',
      ])
      .where('appointment.id', '=', appointmentId)
      .executeTakeFirst();
    if (!row) throw AppError.notFound('Appointment');
    return row;
  }

  private eventBody(row: any): calendar_v3.Schema$Event {
    return {
      summary: `${row.specialisation} — ${row.doctorName}`,
      description: [
        `Patient: ${row.patientName}`,
        `Doctor: ${row.doctorName} (${row.specialisation})`,
        '',
        'Booked through the clinic portal.',
      ].join('\n'),
      start: { dateTime: new Date(row.startsAt).toISOString() },
      end: { dateTime: new Date(row.endsAt).toISOString() },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
    };
  }

  /**
   * Applies one calendar action for both parties. Called only from the worker.
   * Each side is independent: a patient with no Google account must not stop the
   * doctor's event from being written.
   */
  async sync(appointmentId: string, action: CalendarAction): Promise<{ doctor: string; patient: string }> {
    if (!this.enabled) return { doctor: 'skipped', patient: 'skipped' };
    const row = await this.partiesFor(appointmentId);

    const doctor = await this.syncOne(row, 'doctor', action).catch((e) => `error: ${e.message}`);
    const patient = await this.syncOne(row, 'patient', action).catch((e) => `error: ${e.message}`);
    return { doctor, patient };
  }

  private async syncOne(row: any, side: 'doctor' | 'patient', action: CalendarAction): Promise<string> {
    const token = side === 'doctor' ? row.doctorToken : row.patientToken;
    if (!token) return 'not-connected';

    const calendarId = (side === 'doctor' ? row.doctorCalendarId : row.patientCalendarId) ?? 'primary';
    const column = side === 'doctor' ? 'gcal_doctor_event_id' : 'gcal_patient_event_id';
    const eventId: string | null = side === 'doctor' ? row.doctorEventId : row.patientEventId;
    const api = await this.clientFor(token);

    if (action === 'DELETE') {
      if (!eventId) return 'nothing-to-delete';
      try {
        await api.events.delete({ calendarId, eventId });
      } catch (e: any) {
        // Already gone is the desired end state, not an error.
        if (e?.code !== 404 && e?.response?.status !== 404) throw e;
      }
      await this.db.updateTable('appointment').set({ [column]: null } as any)
        .where('id', '=', row.id).execute();
      return 'deleted';
    }

    if (action === 'UPDATE' && eventId) {
      // Patch rather than delete-and-insert so the invite thread survives.
      await api.events.patch({ calendarId, eventId, requestBody: this.eventBody(row) });
      return 'patched';
    }

    const created = await api.events.insert({ calendarId, requestBody: this.eventBody(row) });
    await this.db.updateTable('appointment').set({ [column]: created.data.id } as any)
      .where('id', '=', row.id).execute();
    return 'created';
  }

  /**
   * Repairs drift left by writes that failed permanently after retries:
   * a confirmed appointment missing its event gets one, and a cancelled
   * appointment still holding an event id has it removed.
   */
  async reconcile(sinceMs = 3600_000): Promise<{ repaired: number; checked: number }> {
    if (!this.enabled) return { repaired: 0, checked: 0 };
    const since = new Date(Date.now() - sinceMs);

    const rows = await this.db
      .selectFrom('appointment')
      .innerJoin('doctor', 'doctor.id', 'appointment.doctor_id')
      .select([
        'appointment.id as id',
        'appointment.state as state',
        'appointment.gcal_doctor_event_id as doctorEventId',
        'doctor.gcal_refresh_token as doctorToken',
      ])
      .where('appointment.updated_at', '>=', since)
      .where('appointment.starts_at', '>', new Date())
      .execute();

    let repaired = 0;
    for (const row of rows) {
      if (!row.doctorToken) continue;
      try {
        if (row.state === 'CONFIRMED' && !row.doctorEventId) {
          await this.sync(row.id, 'CREATE');
          repaired++;
        } else if (['CANCELLED', 'NO_SHOW'].includes(row.state) && row.doctorEventId) {
          await this.sync(row.id, 'DELETE');
          repaired++;
        }
      } catch (e) {
        this.logger.warn(`Reconcile failed for ${row.id}: ${(e as Error).message}`);
      }
    }
    return { repaired, checked: rows.length };
  }
}
