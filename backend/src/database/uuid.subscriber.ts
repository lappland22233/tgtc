import { randomUUID } from 'crypto';
import { EntitySubscriberInterface, EventSubscriber, InsertEvent } from 'typeorm';

/** SQLite 没有 PostgreSQL 的 uuid 默认函数；由应用在插入前统一补齐 UUID。 */
@EventSubscriber()
export class UuidSubscriber implements EntitySubscriberInterface {
  beforeInsert(event: InsertEvent<unknown>): void {
    const entity = event.entity as { id?: string } | undefined;
    if (entity && !entity.id && event.metadata.primaryColumns.some((column) => column.propertyName === 'id')) {
      entity.id = randomUUID();
    }
  }
}
