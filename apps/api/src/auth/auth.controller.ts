import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@ham/types';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto, RegisterDto } from './dto';
import { CurrentUser, Public } from '../common/decorators';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Post('register')
  @ApiOperation({ summary: 'Register a patient account' })
  register(@Body() dto: RegisterDto) { return this.auth.register(dto); }

  @Public() @Post('login') @HttpCode(200)
  @ApiOperation({ summary: 'Exchange credentials for an access + refresh token' })
  login(@Body() dto: LoginDto) { return this.auth.login(dto.email, dto.password); }

  @Public() @Post('refresh') @HttpCode(200)
  @ApiOperation({ summary: 'Rotate a refresh token for a new access token' })
  refresh(@Body() dto: RefreshDto) { return this.auth.refresh(dto.refreshToken); }

  @Public() @Post('logout') @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a refresh token' })
  async logout(@Body() dto: RefreshDto) { await this.auth.logout(dto.refreshToken); }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user, with role-scoped ids' })
  me(@CurrentUser() user: AuthUser) { return user; }
}
