import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@ham/types';
import { CurrentUser, Roles } from '../common/decorators';
import { LeaveService } from './leave.service';
import { ProposeLeaveDto, ResolveLeaveDto } from './dto';

@ApiTags('leave')
@ApiBearerAuth()
@Controller('doctors/:doctorId/leave')
@Roles('DOCTOR', 'ADMIN')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Post()
  @ApiOperation({
    summary: 'Phase 1 — propose leave and see which patients it would strand',
    description: 'Records the leave as PROPOSED. Nothing is communicated to patients until it is resolved.',
  })
  propose(
    @CurrentUser() user: AuthUser,
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Body() dto: ProposeLeaveDto,
  ) {
    return this.leave.propose(user, doctorId, dto);
  }

  @Post(':leaveId/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Phase 2 — apply the leave with a disposition for every affected appointment',
    description: 'All-or-nothing: if any replacement slot conflicts, nothing is applied.',
  })
  @ApiResponse({ status: 409, description: 'LEAVE_CONFLICT — nothing was applied' })
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Param('leaveId', ParseUUIDPipe) leaveId: string,
    @Body() dto: ResolveLeaveDto,
  ) {
    return this.leave.resolve(user, doctorId, leaveId, dto);
  }

  @Post(':leaveId/withdraw')
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw a proposed leave that was never applied' })
  withdraw(
    @CurrentUser() user: AuthUser,
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Param('leaveId', ParseUUIDPipe) leaveId: string,
  ) {
    return this.leave.cancelProposed(user, doctorId, leaveId);
  }

  @Get()
  @ApiOperation({ summary: 'Leave history for a doctor' })
  list(@CurrentUser() user: AuthUser, @Param('doctorId', ParseUUIDPipe) doctorId: string) {
    return this.leave.list(user, doctorId);
  }
}
