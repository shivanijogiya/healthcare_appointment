import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { getDb, closeDb, type Db } from '@ham/db';

export const DB = Symbol('DB');

@Global()
@Module({
  providers: [{ provide: DB, useFactory: (): Db => getDb() }],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await closeDb();
  }
}
