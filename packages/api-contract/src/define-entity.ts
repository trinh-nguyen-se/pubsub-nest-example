import { z } from 'zod';
import { VIEWS, type View } from './view';

/**
 * Khai báo một field của entity.
 *
 * `views` là bắt buộc: thêm field mới vào REST mà quên gắn nhãn thì TypeScript
 * báo đỏ, generator cũng từ chối chạy. Đây là cơ chế duy nhất khiến cost/margin
 * không thể vô tình lọt sang B2C.
 */
export type FieldConfig = {
  type: z.ZodType;
  views: readonly View[];
  description: string;
  /** mặc định snake_case(tên field) */
  column?: string;
  /** mặc định suy ra từ zod */
  gqlType?: string;
  /** khai báo tường minh "field này không bao giờ được ra view X" */
  neverFor?: readonly View[];
};

export type EntityConfig = {
  /** tên entity ghi vào sync_change */
  name: string;
  /** dạng số nhiều cho query danh sách */
  plural: string;
  typeName: string;
  table: string;
  /** có prefix thì CMS tự sinh id; không có thì client phải cấp id (ví dụ mã quốc gia) */
  idPrefix?: string;
  fields: Record<string, FieldConfig>;
};

export type EntityDefinition = EntityConfig & {
  schema: z.ZodObject<z.ZodRawShape>;
  fieldNames: string[];
};

const snake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const stripRequired = (gql: string): string => (gql.endsWith('!') ? gql.slice(0, -1) : gql);

/** zod → kiểu SDL. Cố tình nhỏ và nghiêm: gặp kiểu lạ thì ném lỗi, không đoán. */
export function zodToGql(type: z.ZodType<unknown>): string {
  if (type instanceof z.ZodNullable) return stripRequired(zodToGql(type.unwrap() as z.ZodType<unknown>));
  if (type instanceof z.ZodOptional) return stripRequired(zodToGql(type.unwrap() as z.ZodType<unknown>));
  if (type instanceof z.ZodString) return 'String!';
  if (type instanceof z.ZodBoolean) return 'Boolean!';
  // Số trong hợp đồng này luôn là số nguyên (version, allotment). Tiền dùng string.
  if (type instanceof z.ZodNumber) return 'Int!';
  if (type instanceof z.ZodArray) return `[${zodToGql(type.element as z.ZodType<unknown>)}]!`;
  throw new Error(
    `Không map được ${type.constructor.name} sang GraphQL. Thêm nhánh vào zodToGql hoặc khai báo gqlType.`,
  );
}

export function defineEntity(config: EntityConfig): EntityDefinition {
  const seen = new Set<string>();

  for (const [name, field] of Object.entries(config.fields)) {
    if (seen.has(name)) throw new Error(`${config.name}.${name}: khai báo trùng`);
    seen.add(name);

    if (field.description.trim().length === 0) {
      throw new Error(`${config.name}.${name}: thiếu description (FE đọc mô tả này)`);
    }
    if (field.views.length === 0) {
      throw new Error(`${config.name}.${name}: chưa gắn nhãn view nào`);
    }
    for (const view of field.views) {
      if (!VIEWS.includes(view)) throw new Error(`${config.name}.${name}: view lạ "${view}"`);
    }
    for (const view of field.neverFor ?? []) {
      if (field.views.includes(view)) {
        throw new Error(`${config.name}.${name}: vừa cho phép vừa cấm ở view "${view}"`);
      }
    }
  }

  // Consumer cần id để kéo bản mới nhất và version để lọc message trùng.
  for (const required of ['id', 'version']) {
    const field = config.fields[required];
    if (!field) throw new Error(`${config.name}: thiếu field bắt buộc "${required}"`);
    for (const view of VIEWS) {
      if (!field.views.includes(view)) {
        throw new Error(`${config.name}.${required}: field bắt buộc phải có ở view "${view}"`);
      }
    }
  }

  const schema = z.object(
    Object.fromEntries(Object.entries(config.fields).map(([name, field]) => [name, field.type])),
  );

  return { ...config, schema, fieldNames: Object.keys(config.fields) };
}

export function columnOf(fieldName: string, field: FieldConfig): string {
  return field.column ?? snake(fieldName);
}

export function gqlTypeOf(fieldName: string, field: FieldConfig): string {
  return field.gqlType ?? zodToGql(field.type);
}
