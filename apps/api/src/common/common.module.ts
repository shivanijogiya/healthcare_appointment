import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { ClockService } from './clock.service';
import { CryptoService } from './crypto.service';

@Global()
@Module({
  providers: [AuditService, ClockService, CryptoService],
  exports: [AuditService, ClockService, CryptoService],
})
export class CommonModule {}
