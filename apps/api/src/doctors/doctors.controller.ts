import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@ham/types';
import { CurrentUser, Roles } from '../common/decorators';
import { DoctorsService } from './doctors.service';
import { SlotsService } from '../scheduling/slots.service';
import { CreateDoctorDto, SetAvailabilityDto, UpdateDoctorDto } from './dto';

@ApiTags('doctors')
@Controller('doctors')
export class DoctorsController {
  constructor(
    private readonly doctors: DoctorsService,
    private readonly slots: SlotsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Search doctors by specialisation or name' })
  @ApiQuery({ name: 'specialisation', required: false })
  @ApiQuery({ name: 'q', required: false })
  search(@Query('specialisation') specialisation?: string, @Query('q') q?: string) {
    return this.doctors.search(specialisation, q);
  }

  @Get('specialisations')
  @ApiOperation({ summary: 'Distinct specialisations, for the search filter' })
  specialisations() {
    return this.doctors.specialisations();
  }

  @Get(':id')
  @ApiOperation({ summary: 'One doctor’s public profile' })
  byId(@Param('id', ParseUUIDPipe) id: string) {
    return this.doctors.byId(id);
  }

  @Get(':id/availability')
  @ApiOperation({ summary: 'The doctor’s weekly working pattern' })
  availability(@Param('id', ParseUUIDPipe) id: string) {
    return this.doctors.availability(id);
  }

  @Get(':id/slots')
  @ApiOperation({ summary: 'Computed slot grid for one date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'date', required: true, example: '2026-09-01' })
  slotsFor(@Param('id', ParseUUIDPipe) id: string, @Query('date') date: string) {
    return this.slots.gridFor(id, date ?? new Date().toISOString().slice(0, 10));
  }

  @Post()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a doctor account and profile' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDoctorDto) {
    return this.doctors.create(user, dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'DOCTOR')
  @ApiOperation({ summary: 'Update a doctor profile (own profile, or any as admin)' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDoctorDto,
  ) {
    return this.doctors.update(user, id, dto);
  }

  @Put(':id/availability')
  @Roles('ADMIN', 'DOCTOR')
  @ApiOperation({ summary: 'Replace the weekly working pattern' })
  setAvailability(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetAvailabilityDto,
  ) {
    return this.doctors.setAvailability(user, id, dto);
  }
}
