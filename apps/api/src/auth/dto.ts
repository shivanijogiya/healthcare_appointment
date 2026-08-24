import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsISO8601, IsOptional, IsString, MaxLength, MinLength, Matches } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'priya@example.test' }) @IsEmail() email!: string;
  @ApiProperty({ example: 'Passw0rd!', minLength: 8 })
  @IsString() @MinLength(8) @MaxLength(72)
  @Matches(/[A-Za-z]/, { message: 'password must contain a letter' })
  @Matches(/[0-9]/, { message: 'password must contain a number' })
  password!: string;
  @ApiProperty({ example: 'Priya Sharma' }) @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiPropertyOptional({ example: '1994-03-17' }) @IsOptional() @IsISO8601() dateOfBirth?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) gender?: string;
}

export class LoginDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty() @IsString() password!: string;
}

export class RefreshDto {
  @ApiProperty() @IsString() refreshToken!: string;
}
