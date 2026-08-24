import { Global, Module } from '@nestjs/common';
import { MailerService } from './mailer.service';
import { OutboxService } from './outbox.service';

@Global()
@Module({
  providers: [MailerService, OutboxService],
  exports: [MailerService, OutboxService],
})
export class NotificationsModule {}
