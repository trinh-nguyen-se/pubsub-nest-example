import type { View } from './view';

/** Một field sau khi đã sinh ra, đủ để dựng SDL, dựng SQL select và dựng query kéo dữ liệu. */
export type FieldMeta = {
  /** tên field trong GraphQL */
  name: string;
  /** cột tương ứng trong Postgres */
  column: string;
  /** kiểu SDL, ví dụ `String!`, `[String!]!` */
  gqlType: string;
  description: string;
};

export type EntityMeta = {
  /** tên entity trong bảng sync_change */
  name: string;
  /** bảng vật lý trong Postgres (phía CMS) */
  table: string;
  /** object type trong SDL */
  typeName: string;
  /** query kéo một bản: supplier(id: ID!) */
  queryField: string;
  /** query danh sách: suppliers(first, after) */
  listField: string;
  connectionType: string;
  fields: FieldMeta[];
  /** selection set dùng để consumer tự dựng query kéo dữ liệu */
  selection: string;
};

export type ViewContract = {
  view: View;
  schemaVersion: string;
  /** toàn bộ SDL của view này — nạp thẳng vào GraphQL server */
  sdl: string;
  entities: Record<string, EntityMeta>;
  /** field bị cấm tường minh ở view này; test hợp đồng dùng để chống rò rỉ */
  forbidden: Array<{ entity: string; field: string }>;
};
