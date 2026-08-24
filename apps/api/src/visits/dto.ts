import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString,
  Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PrescriptionInputDto {
  @ApiProperty({ example: 'Amoxicillin' })
  @IsString() @MinLength(2) @MaxLength(120) drugName!: string;
  @ApiProperty({ example: '500mg' }) @IsString() @MinLength(1) @MaxLength(60) dosage!: string;
  @ApiProperty({ enum: ['OD', 'BD', 'TDS', 'QID', 'SOS'] })
  @IsIn(['OD', 'BD', 'TDS', 'QID', 'SOS']) frequency!: 'OD' | 'BD' | 'TDS' | 'QID' | 'SOS';
  @ApiProperty({ minimum: 1, maximum: 365 })
  @IsInt() @Min(1) @Max(365) durationDays!: number;
  @ApiPropertyOptional({ example: 'after food' })
  @IsOptional() @IsString() @MaxLength(200) instructions?: string;
}

export class VisitNoteDto {
  @ApiProperty({ example: 'Patient reports resolving cough. Chest clear on auscultation.' })
  @IsString() @MinLength(10) @MaxLength(8000) clinicalNotes!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) diagnosis?: string;
  @ApiPropertyOptional({ example: '2026-09-15' }) @IsOptional() @IsISO8601() followUpDate?: string;
  @ApiPropertyOptional({ type: [PrescriptionInputDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(30)
  @ValidateNested({ each: true }) @Type(() => PrescriptionInputDto)
  prescriptions?: PrescriptionInputDto[];
}
