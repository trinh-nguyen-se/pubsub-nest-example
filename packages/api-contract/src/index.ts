export * from './view';
export * from './types';
export * from './define-entity';
export { registry, entityByName } from './registry';
export { supplier } from './entities/supplier';
export { country } from './entities/country';
export { b2b, b2c, contracts, CHANGE_TYPES, SCHEMA_VERSION } from './generated/contract.generated';
export type { ChangeTypeName } from './generated/contract.generated';

import { b2b, b2c } from './generated/contract.generated';
import type { View } from './view';
import type { ViewContract } from './types';

export const contractByView: Record<View, ViewContract> = { b2b, b2c };
