import { country } from './entities/country';
import { supplier } from './entities/supplier';
import type { EntityDefinition } from './define-entity';

/**
 * Registry: nơi duy nhất khai báo "entity nào được sync".
 * Thêm entity mới = thêm một file trong entities/ và một dòng ở đây.
 */
export const registry: EntityDefinition[] = [supplier, country];

export function entityByName(name: string): EntityDefinition | undefined {
  return registry.find((entity) => entity.name === name);
}
