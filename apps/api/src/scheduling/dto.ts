import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsIn, IsISO8601, IsInt, IsOptional, IsString,
  IsUUID, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class HoldDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() doctorId!: string;
  @ApiProperty({ example: '2026-09-01T03:30:00.000Z', description: 'Slot start, ISO 8601 UTC' })
  @IsISO8601() startsAt!: string;
}

export class IntakeDto {
  @ApiProperty({ example: 'Sharp chest pain when climbing stairs, worse in the evening.' })
  @IsString() @MinLength(10) @MaxLength(4000) symptomsText!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(3650) durationDays?: number;
  @ApiPropertyOptional({ minimum: 1, maximum: 10 })
  @IsOptional() @IsInt() @Min(1) @Max(10) severity?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) existingMeds?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) allergies?: string;
}

export class CancelDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class RescheduleDto {
  @ApiProperty() @IsISO8601() startsAt!: string;
}

export class ProposeLeaveDto {
  @ApiProperty() @IsISO8601() startsAt!: string;
  @ApiProperty() @IsISO8601() endsAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class DispositionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() appointmentId!: string;
  @ApiProperty({ enum: ['REBOOK_SAME_DOCTOR', 'REASSIGN_DOCTOR', 'CANCEL'] })
  @IsIn(['REBOOK_SAME_DOCTOR', 'REASSIGN_DOCTOR', 'CANCEL'])
  action!: 'REBOOK_SAME_DOCTOR' | 'REASSIGN_DOCTOR' | 'CANCEL';
  @ApiPropertyOptional({ description: 'Required for REBOOK_SAME_DOCTOR and REASSIGN_DOCTOR' })
  @IsOptional() @IsISO8601() newStartsAt?: string;
  @ApiPropertyOptional({ description: 'Required for REASSIGN_DOCTOR' })
  @IsOptional() @IsUUID() newDoctorId?: string;
}

export class ResolveLeaveDto {
  @ApiProperty({ type: [DispositionDto] })
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => DispositionDto)
  dispositions!: DispositionDto[];
}
