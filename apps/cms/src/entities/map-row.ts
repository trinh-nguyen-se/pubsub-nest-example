import { columnOf, type EntityDefinition } from '@pubsub/contract';

/** Đọc một dòng Postgres (snake_case) thành payload GraphQL (camelCase). */
export function mapRow(
  definition: EntityDefinition,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const name of definition.fieldNames) {
    const column = columnOf(name, definition.fields[name]!);
    payload[name] = row[column] ?? null;
  }
  return payload;
}

/** node-postgres gửi mảng JS thành array literal của Postgres, không phải JSON. */
export function encodeValue(value: unknown): unknown {
  return Array.isArray(value) ? JSON.stringify(value) : value;
}
