import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsEmail, IsInt, IsNumber, IsOptional, IsString,
  Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class CreateDoctorDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) @MaxLength(72) password!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiProperty({ example: 'Cardiology' }) @IsString() @MinLength(2) @MaxLength(80) specialisation!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) qualification?: string;
  @ApiPropertyOptional({ minimum: 5, maximum: 120, default: 15 })
  @IsOptional() @IsInt() @Min(5) @Max(120) slotDurationMin?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) consultFee?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(600) bio?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
}

export class UpdateDoctorDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) specialisation?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) qualification?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(5) @Max(120) slotDurationMin?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) consultFee?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(600) bio?: string;
}

export class AvailabilityWindowDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 = Sunday' })
  @IsInt() @Min(0) @Max(6) weekday!: number;
  @ApiProperty({ example: '09:00' }) @Matches(HHMM, { message: 'startTime must be HH:MM' }) startTime!: string;
  @ApiProperty({ example: '13:00' }) @Matches(HHMM, { message: 'endTime must be HH:MM' }) endTime!: string;
  @ApiPropertyOptional({ example: '2026-01-01' }) @IsOptional() @IsString() effectiveFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() effectiveTo?: string;
}

export class SetAvailabilityDto {
  @ApiProperty({ type: [AvailabilityWindowDto] })
  @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => AvailabilityWindowDto)
  windows!: AvailabilityWindowDto[];
}
