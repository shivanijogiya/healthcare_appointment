import { Controller, Delete, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@ham/types';
import { CurrentUser, Public } from '../common/decorators';
import { CalendarService } from './calendar.service';
import { loadConfig } from '../config/env';

@ApiTags('calendar')
@Controller('calendar')
export class CalendarController {
  private readonly config = loadConfig();
  constructor(private readonly calendar: CalendarService) {}

  @Get('status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Whether Google Calendar is configured and connected' })
  status(@CurrentUser() user: AuthUser) {
    return this.calendar.statusFor(user);
  }

  @Get('connect')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Google consent URL for the signed-in user' })
  connect(@CurrentUser() user: AuthUser) {
    return { url: this.calendar.consentUrl(user) };
  }

  @Public()
  @Get('callback')
  @ApiExcludeEndpoint()
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    // Google redirects the browser here, so this returns a redirect rather than
    // JSON and cannot carry a bearer token — the signed `state` identifies the user.
    try {
      await this.calendar.handleCallback(code, state);
      return res.redirect(`${this.config.APP_URL}/calendar?connected=1`);
    } catch (e) {
      return res.redirect(
        `${this.config.APP_URL}/calendar?error=${encodeURIComponent((e as Error).message)}`,
      );
    }
  }

  @Delete('disconnect')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Forget the stored Google refresh token' })
  disconnect(@CurrentUser() user: AuthUser) {
    return this.calendar.disconnect(user);
  }
}
